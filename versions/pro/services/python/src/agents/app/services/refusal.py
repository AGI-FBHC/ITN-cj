"""Refusal detection shared between chat streaming paths.

Some LLM safety systems (notably MiMo's high-reasoning mode) embed
their refusal text inside the reasoning stream instead of returning a
clean refusal API. We surface those as a typed stream event so the
UI can fold the long refusal into a single banner instead of pasting
500+ tokens of internal monologue for the user to scroll through.
"""
from __future__ import annotations

from typing import Optional

# Ordered from strongest signal to weakest so the first hit wins.
# Add new entries at the top; lower entries are fallback when the
# upstream uses looser phrasing we have not whitelisted yet.
_REFUSAL_PATTERNS: tuple[str, ...] = (
    # English: explicit safety API phrases
    "considered high risk",
    "was rejected",
    "rejected as",
    "as an ai language model",
    "as an ai assistant",
    "high risk request",
    "content policy",
    "safety reasons",
    "i cannot answer",
    "i'm not able to",
    "i am not able to",
    "i cannot provide",
    "i'm unable to",
    "i am unable to",
    # Chinese: MiMo / domestic policy phrasings
    "请求被拒绝",
    "被判定为高风险",
    "作为 ai 我不能",
    "作为 ai 我无法",
    "抱歉，我无法",
    "抱歉我无法",
    "我无法回答",
    "不在我可回答范围",
    "无法回答这个问题",
    "敏感内容",
    "无法完成",
    "请换个话题",
)

# Model is "blocked" only when content is essentially empty AND a
# signal appears in either reasoning or the short content trail.
# A long factual answer containing the word "rejected" must not be
# misclassified (e.g. a customer support reply quoting a rejection
# from a backend service).
_MAX_BLANK_CONTENT = 80


def detect_refusal(
    reasoning_text: str,
    content_text: str = "",
    *,
    max_blank_content: int = _MAX_BLANK_CONTENT,
) -> Optional[dict]:
    """Return a refusal descriptor if the current stream looks refused.

    Detection rules:
    - the user-visible content is empty or shorter than max_blank_content
    - any of the refusal patterns appear (case insensitive) in the
      reasoning, the content, or both combined
    - returns a dict {signal, excerpt, content_length, reasoning_length}
      that the chat router can persist alongside the partial reply
    """
    trimmed_content = (content_text or "").strip()
    if len(trimmed_content) > max_blank_content:
        return None
    haystack = f"{reasoning_text or ''}\n{content_text or ''}".lower()
    for pattern in _REFUSAL_PATTERNS:
        if pattern.lower() in haystack:
            return {
                "signal": pattern,
                "content_length": len(trimmed_content),
                "reasoning_length": len(reasoning_text or ""),
            }
    return None


def refusal_banner_message(reasoning_excerpt: str) -> str:
    """Stable Chinese-language banner the UI renders in place of the
    internal monologue. Keep it short and actionable."""
    return (
        "该问题被模型判定为高风险，无法给出完整回答。"
        "可能是触发了内容安全策略（涉及地理、时政、敏感关键词等）。"
        "如需继续，请调整提问方式、补充上下文，或联系管理员检查模型策略配置。\n\n"
        f"[内部决策摘要] {reasoning_excerpt[:240].strip()}"
    )
