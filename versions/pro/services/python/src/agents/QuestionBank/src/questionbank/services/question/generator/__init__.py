"""question.generator 包：AI 出题（DESIGN v2 §12 阶段 3）."""

from .generator import (
    INSUFFICIENT_EVIDENCE,
    GenerationRejected,
    QuestionGenerator,
)
from .prompts import DIFFICULTY_RUBRIC, SYSTEM_PROMPT
from .schemas import GeneratedQuestion, GeneratedQuestions

__all__ = [
    "QuestionGenerator",
    "GenerationRejected",
    "INSUFFICIENT_EVIDENCE",
    "GeneratedQuestion",
    "GeneratedQuestions",
    "SYSTEM_PROMPT",
    "DIFFICULTY_RUBRIC",
]
