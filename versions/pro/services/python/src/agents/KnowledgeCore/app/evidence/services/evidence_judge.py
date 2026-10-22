"""LLM 证据相关性复核（Evidence Judge）.

检索后对候选证据逐条判定"能否支撑当前查询"，剔除不相关证据，
使 applicability 成为真正的 Context Precision（业界 RAGAS 同思路）。

设计约束：
- 宁缺毋滥：无法判定/输出缺失的证据视为不相关
- 优雅降级：LLM 不可用/超时/输出解析异常 → 不过滤 + warning，不中断检索主链路
  （判定覆盖不足一半时视为 judge 失败，避免误杀全部证据）
- 只读：judge 不写任何表
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

import httpx

from app.core.config import get_settings
from app.core.database import get_session_factory
from app.core.request_context import get_trace_id, log_access_json

# 每条证据截断长度（控制 prompt 体积与成本）
# 2026-08-19：300 → 1500。RAG 层证据文本以 T3.1 打包的 context_prefix + 可回答
# 问题清单开头，300 字符常常只剩前缀、正文没进 judge 视野，导致主题对口的证据
# 被以"没看到所需信息"为由整批误杀（40 条 qa golden 实测 answerable 大面积 HF=0）。
MAX_CONTENT_CHARS = 1500
# 单次 judge 最多携带的证据条数（超出分批）
MAX_ITEMS_PER_CALL = 15
# 判定覆盖低于该比例 → 视为 judge 失败，降级不过滤
MIN_COVERAGE_RATIO = 0.5

JUDGE_SYSTEM = (
    "你是严谨的知识证据审核员。任务是判断候选证据能否支撑用户的查询。\n"
    "注意：证据文本是从完整文档切片中截取的片段，可能被截断——开头可能是该切片的"
    "位置说明或可回答问题清单，正文可能未完整展示。\n"
    "对每条证据输出一个 JSON 对象，格式："
    '{"index": 证据编号, "relevant": true或false, "reason": "一句话理由"}。\n'
    "规则：\n"
    "- 证据内容能直接回答或支撑查询 → relevant=true\n"
    "- 证据主题与查询直接对应（同一知识点/同一小节），即使截断片段中未见完整答案，"
    "也视为支撑 → relevant=true\n"
    "- 证据与查询明显无关、仅是不同主题的背景铺垫 → relevant=false\n"
    "只输出 JSON，不要输出其他内容。"
)


class EvidenceJudgeError(Exception):
    """LLM judge 调用失败（调用方应降级处理）."""


class EvidenceJudge:
    """OpenAI 兼容协议的证据相关性判定器（MiMo）."""

    def __init__(
        self,
        api_url: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        timeout: float = 60.0,
        max_tokens: int = 4096,
    ):
        settings = get_settings()
        self._api_url = (api_url or settings.LLM_API_URL).rstrip("/")
        self._api_key = api_key or settings.LLM_API_KEY
        self._model = model or settings.LLM_MODEL
        self._timeout = timeout
        self._max_tokens = max_tokens

    # ── 对外入口 ─────────────────────────────────────────────────────

    async def judge(self, query: str, items: list[dict[str, Any]]) -> dict[str, Any]:
        """判定证据相关性，返回：

        - kept:     保留的证据（related）
        - rejected: 剔除的证据（含 reason）
        - used_llm: 是否真正使用了 LLM（False = 降级未判定）
        - warning:  降级原因（无则 None）
        """
        if not items:
            return {"kept": [], "rejected": [], "used_llm": True, "warning": None}
        if not self._api_url or not self._api_key:
            return {
                "kept": items, "rejected": [],
                "used_llm": False,
                "warning": "LLM judge 未配置（LLM_API_URL/LLM_API_KEY 为空），跳过相关性复核",
            }

        try:
            verdicts: dict[int, bool] = {}
            reasons: dict[int, str] = {}
            for start in range(0, len(items), MAX_ITEMS_PER_CALL):
                batch = items[start : start + MAX_ITEMS_PER_CALL]
                batch_verdicts, batch_reasons = await self._judge_batch(query, batch, start)
                verdicts.update(batch_verdicts)
                reasons.update(batch_reasons)

            # 覆盖不足一半 → 判定不可信，降级
            if len(verdicts) < max(1, len(items) * MIN_COVERAGE_RATIO):
                return {
                    "kept": items, "rejected": [],
                    "used_llm": True,
                    "warning": f"LLM judge 判定覆盖不足（{len(verdicts)}/{len(items)}），跳过相关性复核",
                }
        except EvidenceJudgeError as e:
            return {
                "kept": items, "rejected": [],
                "used_llm": False,
                "warning": f"LLM judge 不可用，跳过相关性复核: {e}",
            }
        except Exception as e:  # noqa: BLE001 — 复核层不因任何异常中断主链路
            return {
                "kept": items, "rejected": [],
                "used_llm": False,
                "warning": f"LLM judge 异常，跳过相关性复核: {e}",
            }

        kept: list[dict[str, Any]] = []
        rejected: list[dict[str, Any]] = []
        for i, item in enumerate(items):
            if verdicts.get(i, False):  # 缺失判定 → 不相关（宁缺毋滥）
                kept.append(item)
            else:
                item["judge_reason"] = reasons.get(i) or "未获判定，宁缺毋滥剔除"
                rejected.append(item)
        return {"kept": kept, "rejected": rejected, "used_llm": True, "warning": None}

    # ── 内部：单批调用与解析 ─────────────────────────────────────────

    async def _judge_batch(
        self,
        query: str,
        batch: list[dict[str, Any]],
        offset: int,
    ) -> tuple[dict[int, bool], dict[int, str]]:
        """调用 LLM 判定一批证据，返回 (index→relevant, index→reason).

        index 为全局序号（offset + 批内序号）。
        """
        numbered = [
            f"[{offset + i}] 来源: {self._source_tag(it)}\n"
            f"{str(it.get('content') or '')[:MAX_CONTENT_CHARS]}"
            for i, it in enumerate(batch)
        ]
        prompt = (
            f"用户查询：{query}\n\n"
            f"候选证据（共 {len(batch)} 条，编号从 {offset} 开始）：\n\n"
            + "\n\n".join(numbered)
            + "\n\n请逐条判定并输出 JSON 数组或 JSON 对象列表。"
        )

        content = await self._chat(JUDGE_SYSTEM, prompt)
        verdicts, reasons = self._parse(content, offset, len(batch))
        return verdicts, reasons

    @staticmethod
    def _source_tag(item: dict[str, Any]) -> str:
        src = item.get("metadata", {}).get("source")
        doc = item.get("metadata", {}).get("doc", {})
        if doc:
            return f"{src or 'unknown'}/{doc.get('source_name') or doc.get('title') or 'doc'}"
        return src or "unknown"

    async def _chat(self, system: str, prompt: str) -> str:
        """OpenAI 兼容 chat completion，返回 content 文本."""
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        body = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": self._max_tokens,
            "temperature": 0.1,
        }
        last_err: Exception | None = None
        for attempt in range(3):
            started = time.perf_counter()
            try:
                async with httpx.AsyncClient(timeout=self._timeout, trust_env=False) as client:
                    resp = await client.post(self._api_url, headers=headers, json=body)
                if resp.status_code >= 400:
                    last_err = EvidenceJudgeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
                    continue
                data = resp.json()
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                if not content:
                    last_err = EvidenceJudgeError("LLM 返回空内容")
                    continue
                self._schedule_usage(started, data.get("usage") or {})
                return content
            except EvidenceJudgeError:
                raise
            except Exception as e:  # noqa: BLE001 — 网络/超时重试
                last_err = e
        raise EvidenceJudgeError(f"重试 3 次仍失败: {last_err}")

    # ── T2.2 LLM 记账：fire-and-forget，失败静默，绝不影响主流程 ──────────

    def _schedule_usage(self, started: float, usage: dict[str, Any]) -> None:
        import asyncio

        latency_ms = int((time.perf_counter() - started) * 1000)
        try:
            asyncio.create_task(self._record_usage(usage, latency_ms))
        except RuntimeError:
            pass  # 没有运行中的事件循环（不应发生在异步调用路径中）

    async def _record_usage(self, usage: dict[str, Any], latency_ms: int) -> None:
        row = {
            "trace_id": get_trace_id(), "service": "knowledgecore", "feature": "evidence_judge",
            "model": self._model, "in_tokens": usage.get("prompt_tokens"),
            "out_tokens": usage.get("completion_tokens"), "latency_ms": latency_ms,
        }
        settings = get_settings()
        if not settings.MYSQL_HOST or not settings.MYSQL_DB:
            # 无 MySQL 连接（本地/测试常见）：降级为结构化日志输出
            log_access_json(event="llm_usage", **row)
            return
        try:
            from sqlalchemy import text

            async with get_session_factory()() as session:
                await session.execute(
                    text(
                        "INSERT INTO llm_usage_log "
                        "(trace_id, service, feature, model, in_tokens, out_tokens, latency_ms) "
                        "VALUES (:trace_id, :service, :feature, :model, :in_tokens, :out_tokens, :latency_ms)"
                    ),
                    row,
                )
                await session.commit()
        except Exception:  # noqa: BLE001 — 记账失败绝不影响主流程
            pass

    @staticmethod
    def _parse(content: str, offset: int, batch_size: int) -> tuple[dict[int, bool], dict[int, str]]:
        """从 LLM 输出中解析判定结果.

        支持：纯 JSON 数组 / JSON 对象列表 / 混在 think 标签与文本中的 JSON 对象。
        缺失编号 → 不进入 verdicts（调用方按宁缺毋滥处理）。
        """
        verdicts: dict[int, bool] = {}
        reasons: dict[int, str] = {}

        def try_record(obj: Any) -> None:
            if not isinstance(obj, dict):
                return
            idx = obj.get("index")
            if idx is None:
                # 无 index 的单个对象（单条判定场景）
                idx = offset
            try:
                idx = int(idx)
            except (TypeError, ValueError):
                return
            if "relevant" not in obj:
                return
            verdicts[idx] = bool(obj["relevant"])
            if obj.get("reason"):
                reasons[idx] = str(obj["reason"])[:200]

        text = content.strip()
        # ① 整体 JSON（数组或对象）
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                for obj in parsed:
                    try_record(obj)
                return verdicts, reasons
            if isinstance(parsed, dict):
                try_record(parsed)
                return verdicts, reasons
        except json.JSONDecodeError:
            pass

        # ② 提取散落 JSON 对象（兼容 think 标签包裹）
        for m in re.finditer(r"\{[^{}]*\"index\"[^{}]*\}", text):
            try:
                try_record(json.loads(m.group(0)))
            except json.JSONDecodeError:
                continue

        # ③ 兜底：index/relevant 键值对（容错格式错乱）
        if not verdicts:
            for m in re.finditer(r"\"?index\"?\s*[:：]\s*(\d+)[,，]?\s*\"?relevant\"?\s*[:：]\s*(true|false)", text):
                verdicts[int(m.group(1))] = m.group(2) == "true"
        return verdicts, reasons
