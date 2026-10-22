"""Shared helpers for text that will be read aloud by TTS."""
from __future__ import annotations

import re


_LLM_SPREAD_RE = re.compile(r"(?<![A-Za-z])LLM(?![A-Za-z])")


def spread_llm_for_speech(text: str | None) -> str:
    """Spread LLM into letters so TTS engines do not pronounce it as a word."""
    return _LLM_SPREAD_RE.sub("L L M", text or "")
