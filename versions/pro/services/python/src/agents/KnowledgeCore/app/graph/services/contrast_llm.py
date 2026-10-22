"""LLM 易混淆概念判定器（T4.4：contrasts_with 边的把关层）.

对候选知识点对判断"是否容易被学习者混淆"，输出 yes/no + confidence + rationale。
设计与 `prerequisite_llm.PrerequisiteJudge` 一致（批处理 + 严格 JSON 输出 + 优雅降级），
仅提示词与判定字段（is_contrast 而非 is_prerequisite）不同。

设计约束（与 prerequisite_llm 一致）：
- 优雅降级：LLM 不可用/未配置/解析覆盖不足 → 返回 None，调用方跳过整批候选
  （宁缺毋滥，不臆断写边）。
- 只读：不写任何表。
"""

from __future__ import annotations

import json
import re
from typing import Any

import httpx

from app.core.config import get_settings

MIN_COVERAGE_RATIO = 0.5

JUDGE_SYSTEM = (
    "你是严谨的学科教学专家。任务是判断两个知识点是否容易被学习者混淆。\n"
    "对每一对知识点 (A, B) 输出 JSON 对象列表，格式：\n"
    '[{"pair": 序号, "is_contrast": true或false, "confidence": 0.0到1.0, "rationale": "一句话理由"}]。\n'
    "规则：\n"
    "- 两者概念相近、容易被张冠李戴、常见于对比辨析题 → true\n"
    "- 只是同章节泛泛相关、差异明显、不易混淆 → false\n"
    "- 不确定时 confidence 给低值（<0.5），is_contrast 一律 false\n"
    "只输出 JSON，不要输出其他内容。"
)


class ContrastJudgeError(Exception):
    """LLM 易混淆判定调用失败（调用方应跳过该批）."""


class ContrastJudge:
    """OpenAI 兼容协议的易混淆知识点判定器（MiMo）."""

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

    async def judge_pairs(self, pairs: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
        """判断一批候选对，返回每条追加判定结果的列表：

        - is_contrast: bool
        - confidence: float
        - rationale: str

        LLM 不可用/未配置/解析覆盖不足 → 返回 None（调用方整体跳过本批）。
        """
        if not pairs:
            return []
        if not self._api_url or not self._api_key:
            return None

        numbered = [f"[{i}] A({p['a_name']}) vs B({p['b_name']})" for i, p in enumerate(pairs)]
        prompt = (
            f"候选知识点对（共 {len(pairs)} 对）：\n\n"
            + "\n".join(numbered)
            + "\n\n请逐对判断是否容易混淆，输出 JSON 对象列表。"
        )

        try:
            content = await self._chat(JUDGE_SYSTEM, prompt)
        except ContrastJudgeError:
            return None

        verdicts = self._parse(content, len(pairs))
        if len(verdicts) < max(1, len(pairs) * MIN_COVERAGE_RATIO):
            return None  # 覆盖不足 → 整体跳过，避免臆断写边

        results: list[dict[str, Any]] = []
        for i, p in enumerate(pairs):
            v = verdicts.get(i, {})
            results.append(
                {
                    **p,
                    "is_contrast": bool(v.get("is_contrast", False)),
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
                    last_err = ContrastJudgeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
                    continue
                data = resp.json()
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                if not content:
                    last_err = ContrastJudgeError("LLM 返回空内容")
                    continue
                return content
            except ContrastJudgeError:
                raise
            except Exception as e:  # noqa: BLE001 — 网络/超时重试
                last_err = e
        raise ContrastJudgeError(f"重试 3 次仍失败: {last_err}")

    @staticmethod
    def _parse(content: str, batch_size: int) -> dict[int, dict[str, Any]]:
        """解析 LLM 输出：pair 序号 → {is_contrast, confidence, rationale}."""
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
            if 0 <= pair < batch_size and "is_contrast" in obj:
                verdicts[pair] = {
                    "is_contrast": bool(obj["is_contrast"]),
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
