"""question 服务包：题目领域（DESIGN v2 §11）."""

from .answer_judge import Judgment, judge_objective, judge_subjective
from .attempt_service import AttemptService, QuestionNotActiveError
from .models import (
    CognitiveLevel,
    EvidenceRef,
    KnowledgePointRef,
    OptionItem,
    QuestionCreate,
    QuestionType,
    QuestionUpdate,
    SourceType,
    Status,
)
from .question_selector import QuestionSelector
from .question_service import (
    DuplicateQuestionError,
    QuestionNotFoundError,
    QuestionService,
    row_to_record,
)
from .revalidation import REVALIDATION_KEY, RevalidationService
from .validators import (
    COGNITIVE_LEVELS,
    QUESTION_TYPES,
    SOURCE_TYPES,
    STATUSES,
    ValidationError,
    validate_question,
)

__all__ = [
    "QuestionService",
    "QuestionCreate",
    "QuestionUpdate",
    "QuestionNotFoundError",
    "DuplicateQuestionError",
    "ValidationError",
    "row_to_record",
    "validate_question",
    "OptionItem",
    "KnowledgePointRef",
    "EvidenceRef",
    "QuestionType",
    "Status",
    "SourceType",
    "CognitiveLevel",
    "QUESTION_TYPES",
    "STATUSES",
    "SOURCE_TYPES",
    "COGNITIVE_LEVELS",
    "QuestionSelector",
    "AttemptService",
    "QuestionNotActiveError",
    "Judgment",
    "judge_objective",
    "judge_subjective",
    "RevalidationService",
    "REVALIDATION_KEY",
]
