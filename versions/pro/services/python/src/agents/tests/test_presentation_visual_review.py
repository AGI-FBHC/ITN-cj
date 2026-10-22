from app.config import get_settings
from app.presentations.visual_review import PresentationVisualReviewer


class NoopLlm:
    pass


def reviewer():
    settings = get_settings().model_copy(update={"presentation_visual_review_max_slides": 2})
    return PresentationVisualReviewer(NoopLlm(), settings)


def test_candidate_selection_ignores_simple_pages_and_limits_calls():
    outline = {"slides": [
        {"kind": "title", "points": ["封面"]},
        {"kind": "concept", "points": [{"heading": "定义", "detail": "简单文字"}]},
        {"kind": "table", "points": [{"detail": "很长" * 180}], "table": {
            "headers": ["A", "B", "C"], "rows": [["1", "2", "3"]] * 5,
        }},
        {"kind": "code", "points": [{"detail": "讲解" * 150}], "code": {
            "content": "\n".join(f"line {index}" for index in range(20)),
            "annotations": ["说明"] * 5,
        }},
        {"kind": "process", "process": [{"label": str(index)} for index in range(6)]},
    ]}
    assert reviewer().select_candidates(outline) == [3, 4]


def test_visual_issue_normalization_rejects_unknown_pages_and_actions():
    result = {"slides": [
        {"slide": 3, "severity": "high", "confidence": 0.92, "issues": ["overlap", "change_colors"]},
        {"slide": 9, "severity": "high", "confidence": 0.99, "issues": ["overflow"]},
        {"slide": 4, "severity": "medium", "confidence": 0.95, "issues": ["crowded"]},
    ]}
    assert PresentationVisualReviewer._normalize_issues(result, [2, 3]) == [
        {"slide": 3, "severity": "high", "confidence": 0.92, "issues": ["overlap"]},
    ]


def test_compact_outline_only_changes_flagged_slide():
    long_text = "详细讲解" * 100
    outline = {"slides": [
        {"kind": "concept", "points": [{"heading": "A", "detail": long_text}]},
        {"kind": "code", "takeaway": long_text, "points": [{"heading": "B", "detail": long_text}],
         "code": {"content": "\n".join(["line"] * 30), "annotations": ["说明" * 50] * 6}},
    ]}
    compacted = PresentationVisualReviewer.compact_outline(outline, [
        {"slide": 2, "severity": "high", "confidence": .95, "issues": ["overflow"]},
    ])
    assert compacted["slides"][0] == outline["slides"][0]
    assert len(compacted["slides"][1]["points"][0]["detail"]) <= 501
    assert len(compacted["slides"][1]["code"]["annotations"]) == 4
    assert len(compacted["slides"][1]["code"]["content"].splitlines()) <= 30


def test_cover_design_normalization_rejects_unsafe_values():
    assert PresentationVisualReviewer._normalize_cover_design({
        "placement": "left-middle",
        "titleColor": "#102030",
        "subtitleColor": "fefefe",
        "titleSize": 99,
    }) == {
        "placement": "left-middle",
        "titleColor": "102030",
        "subtitleColor": "FEFEFE",
        "titleSize": 48,
    }
    assert PresentationVisualReviewer._normalize_cover_design({"placement": "off-slide"}) == {}
