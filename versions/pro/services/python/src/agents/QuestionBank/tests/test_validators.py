"""防线 1 Schema 校验 + 防线 4 精确去重 单元测试（纯函数，无 DB）."""
import pytest

from questionbank.services.question import ValidationError, validate_question
from questionbank.services.question.duplicate_detector import content_hash


def _validate(**kwargs):
    return validate_question(
        question_type=kwargs.get("question_type", "single_choice"),
        difficulty=kwargs.get("difficulty", 3),
        cognitive_level=kwargs.get("cognitive_level", "remember"),
        stem=kwargs.get("stem", "题干"),
        options=kwargs.get("options", [{"key": "A", "text": "a"}, {"key": "B", "text": "b"}]),
        reference_answer=kwargs.get("reference_answer", "A"),
    )


class TestQuestionTypeAndDifficulty:
    def test_invalid_type(self):
        with pytest.raises(ValidationError):
            _validate(question_type="essay")

    def test_difficulty_out_of_range(self):
        with pytest.raises(ValidationError):
            _validate(difficulty=0)
        with pytest.raises(ValidationError):
            _validate(difficulty=6)

    def test_difficulty_boundaries_ok(self):
        assert _validate(difficulty=1)[1] == 1
        assert _validate(difficulty=5)[1] == 5

    def test_blank_stem(self):
        with pytest.raises(ValidationError):
            _validate(stem="   ")

    def test_invalid_cognitive_level(self):
        with pytest.raises(ValidationError):
            _validate(cognitive_level="magic")


class TestSingleChoice:
    def test_requires_at_least_two_options(self):
        with pytest.raises(ValidationError):
            _validate(options=[{"key": "A", "text": "a"}])

    def test_answer_must_be_in_options(self):
        with pytest.raises(ValidationError):
            _validate(reference_answer="Z")

    def test_answer_key_case_normalized(self):
        _, _, _, opts, answer = _validate(reference_answer="b")
        assert answer == "B"
        assert opts[1]["key"] == "B"

    def test_duplicate_option_keys(self):
        with pytest.raises(ValidationError):
            _validate(
                options=[
                    {"key": "A", "text": "a"},
                    {"key": "a", "text": "b"},
                ]
            )


class TestMultipleChoice:
    def test_requires_at_least_two_answers(self):
        with pytest.raises(ValidationError):
            _validate(question_type="multiple_choice", reference_answer=["A"])

    def test_answers_deduped_and_in_options(self):
        _, _, _, _, answer = _validate(
            question_type="multiple_choice",
            reference_answer=["A", "a", "B"],
        )
        assert answer == ["A", "B"]

    def test_answer_not_in_options(self):
        with pytest.raises(ValidationError):
            _validate(question_type="multiple_choice", reference_answer=["A", "Z"])


class TestTrueFalse:
    def test_boolean_answer_ok(self):
        _, _, _, _, answer = _validate(question_type="true_false", options=None, reference_answer=True)
        assert answer is True

    def test_int_answer_normalized(self):
        _, _, _, _, answer = _validate(question_type="true_false", options=None, reference_answer=0)
        assert answer is False

    def test_string_answer_normalized(self):
        _, _, _, _, answer = _validate(question_type="true_false", options=None, reference_answer="false")
        assert answer is False

    def test_invalid_answer(self):
        with pytest.raises(ValidationError):
            _validate(question_type="true_false", options=None, reference_answer="maybe")


class TestShortAnswer:
    def test_non_empty_text_required(self):
        with pytest.raises(ValidationError):
            _validate(question_type="short_answer", options=None, reference_answer="   ")

    def test_text_ok(self):
        _, _, _, _, answer = _validate(question_type="short_answer", options=None, reference_answer="要点一；要点二")
        assert "要点" in answer


class TestContentHash:
    def test_stable_for_same_content(self):
        a = content_hash(question_type="single_choice", stem="题", options=[{"key": "A", "text": "x"}], reference_answer="A")
        b = content_hash(question_type="single_choice", stem="题", options=[{"key": "A", "text": "x"}], reference_answer="A")
        assert a == b == content_hash(
            question_type="single_choice", stem=" 题 ", options=[{"key": "A", "text": "x"}], reference_answer="a"
        )

    def test_changes_with_content(self):
        a = content_hash(question_type="single_choice", stem="题1", options=None, reference_answer="A")
        b = content_hash(question_type="single_choice", stem="题2", options=None, reference_answer="A")
        assert a != b

    def test_multiple_choice_order_insensitive(self):
        a = content_hash(question_type="multiple_choice", stem="题", options=None, reference_answer=["A", "B"])
        b = content_hash(question_type="multiple_choice", stem="题", options=None, reference_answer=["B", "A"])
        assert a == b

    def test_option_order_sensitive(self):
        opts = [{"key": "A", "text": "x"}, {"key": "B", "text": "y"}]
        a = content_hash(question_type="single_choice", stem="题", options=opts, reference_answer="A")
        b = content_hash(question_type="single_choice", stem="题", options=list(reversed(opts)), reference_answer="A")
        assert a != b

    def test_sha256_format(self):
        digest = content_hash(question_type="true_false", stem="题", options=None, reference_answer=True)
        assert len(digest) == 64
        assert all(c in "0123456789abcdef" for c in digest)


class TestTrueFalseExtended:
    """判断题答案容错：LLM 常见变体（T/F/对/错/√/×）归一化."""

    @pytest.mark.parametrize("raw", ["true", "T", "t", "对", "正确", "是", "√", "yes", "1"])
    def test_true_variants(self, raw):
        _, _, _, _, answer = _validate(question_type="true_false", options=None, reference_answer=raw)
        assert answer is True

    @pytest.mark.parametrize("raw", ["false", "F", "错", "错误", "否", "×", "no", "0"])
    def test_false_variants(self, raw):
        _, _, _, _, answer = _validate(question_type="true_false", options=None, reference_answer=raw)
        assert answer is False
