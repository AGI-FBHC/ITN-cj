"""LLM 先修关系判定器（dag-design.md §8 管道③）.

对候选概念对判断"A 是否是 B 的先修"，输出 yes/no + confidence + rationale。
对齐业界做法（MDPI 2025 / Sabanci：LLM 逐对判断 + 理由输出）。

设计约束：
- 防线 0：输出只接受白名单方向（候选对生成时已保证方向，此处只判 yes/no）
- 批处理：一次调用判断多对（MAX_PAIRS_PER_CALL），章节上下文一起给
- 优雅降级：LLM 不可用/解析失败 → 返回 None，调用方跳过该对（下次 sync 重试），不中断
- 只读：不写任何表
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from app.core.config import get_settings

MAX_PAIRS_PER_CALL = 10
MAX_DESC_CHARS = 120
MIN_COVERAGE_RATIO = 0.5

JUDGE_SYSTEM = (
    "你是严谨的课程设计专家。任务是判断概念之间的先修关系。\n"
    "对每一对概念 (A, B) 输出 JSON 对象列表，格式：\n"
    '[{"pair": 序号, "is_prerequisite": true或false, "confidence": 0.0到1.0, "rationale": "一句话理由"}]。\n'
    "规则：\n"
    "- A 是 B 的先修 ⟺ 学 B 之前必须先掌握 A（直接依赖，不是泛泛的相关）\n"
    "- 只有直接先修关系才算 true；仅主题相关、可并行学习、背景铺垫 → false\n"
    "- 不确定时 confidence 给低值（<0.5），is_prerequisite 一律 false\n"
    "- confidence 表示你对「是」的判断把握，不是关系强度\n"
    "只输出 JSON，不要输出其他内容。"
)


class PrerequisiteJudgeError(Exception):
    """LLM 先修判定调用失败（调用方应跳过该批）."""


class PrerequisiteJudge:
    """OpenAI 兼容协议的先修关系判定器（MiMo）."""

    def __init__(
        self,
        api_url: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        timeout: float = 90.0,
        max_tokens: int = 4096,
    ):
        settings = get_settings()
        self._api_url = (api_url or settings.LLM_API_URL).rstrip("/")
        self._api_key = api_key or settings.LLM_API_KEY
        self._model = model or settings.LLM_MODEL
        self._timeout = timeout
        self._max_tokens = max_tokens

    async def judge_pairs(
        self, chapter_name: str, pairs: list[dict[str, Any]]
    ) -> list[dict[str, Any]] | None:
        """判断一批候选对，返回每条 pair 追加判定结果的列表：

        - is_prerequisite: bool
        - confidence: float
        - rationale: str

        LLM 不可用/未配置/解析覆盖不足 → 返回 None（调用方整体跳过本批）。
        """
        if not pairs:
            return []
        if not self._api_url or not self._api_key:
            return None

        numbered = [
            f"[{i}] A({p['prereq_name']}): {str(p.get('prereq_desc') or '')[:MAX_DESC_CHARS]}\n"
            f"    B({p['target_name']}): {str(p.get('target_desc') or '')[:MAX_DESC_CHARS]}"
            for i, p in enumerate(pairs)
        ]
        prompt = (
            f"章节：{chapter_name}\n\n"
            f"候选概念对（共 {len(pairs)} 对）：\n\n"
            + "\n\n".join(numbered)
            + "\n\n请逐对判断 A 是否是 B 的先修，输出 JSON 对象列表。"
        )

        try:
            content = await self._chat(JUDGE_SYSTEM, prompt)
        except PrerequisiteJudgeError:
            return None

        verdicts = self._parse(content, len(pairs))
        if len(verdicts) < max(1, len(pairs) * MIN_COVERAGE_RATIO):
            return None  # 覆盖不足 → 整体跳过，下次 sync 重试

        results: list[dict[str, Any]] = []
        for i, p in enumerate(pairs):
            v = verdicts.get(i, {})
            results.append(
                {
                    **p,
                    "is_prerequisite": bool(v.get("is_prerequisite", False)),
                    "confidence": float(v.get("confidence", 0.0)),
                    "rationale": str(v.get("rationale", "")),
                }
            )
        return results

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
            try:
                async with httpx.AsyncClient(timeout=self._timeout, trust_env=False) as client:
                    resp = await client.post(self._api_url, headers=headers, json=body)
                if resp.status_code >= 400:
                    last_err = PrerequisiteJudgeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
                    continue
                data = resp.json()
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                if not content:
                    last_err = PrerequisiteJudgeError("LLM 返回空内容")
                    continue
                return content
            except PrerequisiteJudgeError:
                raise
            except Exception as e:  # noqa: BLE001 — 网络/超时重试
                last_err = e
        raise PrerequisiteJudgeError(f"重试 3 次仍失败: {last_err}")

    @staticmethod
    def _parse(content: str, batch_size: int) -> dict[int, dict[str, Any]]:
        """解析 LLM 输出：pair 序号 → {is_prerequisite, confidence, rationale}.

        支持：整体 JSON 数组 / 散落 JSON 对象。缺失 → 不进入结果（宁缺毋滥）。
        """
        verdicts: dict[int, dict[str, Any]] = {}

        def try_record(obj: Any) -> None:
            if not isinstance(obj, dict):
                return
            pair = obj.get("pair")
            if pair is None:
                return
            try:
                pair = int(pair)
            except (TypeError, ValueError):
                return
            if 0 <= pair < batch_size and "is_prerequisite" in obj:
                verdicts[pair] = {
                    "is_prerequisite": bool(obj["is_prerequisite"]),
                    "confidence": float(obj.get("confidence", 0.0)),
                    "rationale": str(obj.get("rationale", ""))[:200],
                }

        text = content.strip()
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                for obj in parsed:
                    try_record(obj)
                return verdicts
        except json.JSONDecodeError:
            pass

        for m in re.finditer(r"\{[^{}]*\"pair\"[^{}]*\}", text):
            try:
                try_record(json.loads(m.group(0)))
            except json.JSONDecodeError:
                continue
        return verdicts
