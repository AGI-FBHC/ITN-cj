import json
import asyncio
from uuid import uuid4

import pytest

from app.services.customize_service import CustomizeService
import app.services.customize_service as customize_module


class _TaskStore:
    def __init__(self):
        self.calls = []
        self.slide_history = []

    def update(self, *args, **kwargs):
        self.calls.append((args, kwargs))

    def save_slides(self, *_args):
        self.slides = _args[-1]
        self.slide_history.append(json.loads(json.dumps(self.slides, ensure_ascii=False)))


class _ContentService:
    async def close(self):
        return None


class _StreamingLLM:
    def __init__(self, chunks):
        self.chunks = chunks
        self.calls = []

    async def stream_chat(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        for chunk in self.chunks:
            yield {"type": "content", "text": chunk}


class _StreamingContentService(_ContentService):
    def __init__(self, chunks):
        self.llm = _StreamingLLM(chunks)


class _JsonLLM:
    def __init__(self, result):
        self.result = result
        self.calls = []

    async def complete_json(self, system, prompt, fallback, **kwargs):
        self.calls.append((system, prompt, fallback, kwargs))
        return self.result


class _JsonContentService(_ContentService):
    def __init__(self, result):
        self.llm = _JsonLLM(result)


def _lecture_template():
    return {
        "id": uuid4().bytes,
        "content_json": json.dumps({
            "title": "母版",
            "summary": "原摘要",
            "learningObjectives": ["原目标"],
            "chapters": [{
                "title": "第一章",
                "sections": [{"title": "第一节", "content": "原正文", "citations": [1]}],
            }],
        }, ensure_ascii=False),
    }


def test_llm_failure_never_delivers_template_copy(monkeypatch):
    service = CustomizeService.__new__(CustomizeService)
    service.tasks = _TaskStore()
    service.content_service = _ContentService()
    template = _lecture_template()
    captured = {}

    monkeypatch.setattr(service, "_load_template", lambda *_args: template)
    monkeypatch.setattr(service, "_load_user_context", lambda *_args: service._empty_user_context())

    async def fail_generation(*_args):
        raise TimeoutError("model timeout")

    monkeypatch.setattr(service, "_customize_content", fail_generation)

    def save(*args):
        captured["content"] = args[5]
        return uuid4()

    monkeypatch.setattr(service, "_create_user_copy", save)
    asyncio.run(service.run(uuid4(), uuid4(), uuid4(), "kp-1-1", "lecture", "个人讲义"))

    assert "content" not in captured
    assert service.tasks.calls[-1][0][2] == "failed"


def test_lecture_merge_preserves_structure_and_citations():
    template = json.loads(_lecture_template()["content_json"])
    candidate = {
        "summary": "个性化摘要",
        "learningObjectives": ["个性化目标"],
        "chapters": [{
            "title": "被模型改名",
            "sections": [{"title": "被模型改名", "content": "增补后的正文", "citations": [99]}],
        }],
    }

    merged = CustomizeService._merge_with_template("lecture", template, candidate)

    assert merged["summary"] == "个性化摘要"
    assert merged["chapters"][0]["title"] == "第一章"
    assert merged["chapters"][0]["sections"][0]["content"] == "增补后的正文"
    assert merged["chapters"][0]["sections"][0]["citations"] == [1]
    assert CustomizeService._quality_check("lecture", template, merged)


def test_quiz_merge_keeps_all_template_questions_and_audit_fields():
    template = {
        "questions": [
            {"id": "q1", "stem": "题1", "reviewMetrics": {"overall": 92}},
            {"id": "q2", "stem": "题2", "reviewMetrics": {"overall": 88}},
        ]
    }
    candidate = {
        "questions": [{"id": "q2"}],
        "personalization": {"focus": "先巩固薄弱概念"},
    }

    merged = CustomizeService._merge_with_template("quiz", template, candidate)

    assert [item["id"] for item in merged["questions"]] == ["q2", "q1"]
    assert merged["questions"][0]["reviewMetrics"]["overall"] == 88
    assert merged["personalization"]["focus"] == "先巩固薄弱概念"
    assert CustomizeService._quality_check("quiz", template, merged)


def test_presentation_regeneration_overwrites_existing_copy(monkeypatch):
    existing_id = uuid4()
    template_id = uuid4()
    statements = []

    class Cursor:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, sql, args):
            statements.append((sql, args))

        def fetchone(self):
            return {"id": existing_id.bytes}

    class Connection:
        def __init__(self):
            self.commits = 0

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def cursor(self):
            return Cursor()

        def commit(self):
            self.commits += 1

    connection = Connection()
    monkeypatch.setattr(customize_module, "platform_connect", lambda _settings: connection)
    service = CustomizeService.__new__(CustomizeService)
    service.settings = object()
    template = {
        "id": template_id.bytes,
        "request_json": "{}",
        "outline_json": "{}",
        "events_json": "[]",
        "output_path": "/tmp/template.pptx",
    }

    result = service._copy_presentation(uuid4(), template, "kp-1-1", "重新生成课件")

    assert result == existing_id
    assert any("UPDATE presentation_tasks" in sql for sql, _args in statements)
    assert not any("INSERT INTO presentation_tasks" in sql for sql, _args in statements)
    assert connection.commits == 1


def test_presentation_customization_changes_only_speaker_notes():
    outline = {
        "title": "管理员课件",
        "slides": [
            {"title": "概念", "kind": "content", "points": ["定义", "特征"],
             "speakerNotes": "原始讲解稿第一页。"},
            {"title": "案例", "kind": "case", "points": ["案例过程"],
             "speakerNotes": "原始讲解稿第二页。"},
        ],
    }
    service = CustomizeService.__new__(CustomizeService)
    service.content_service = _JsonContentService({
        "pages": [
            {"slideIndex": 0, "speakerNotes": "针对薄弱概念增加一句通俗解释。"},
            {"slideIndex": 1, "speakerNotes": "原始讲解稿第二页。"},
        ]
    })

    personalized = asyncio.run(service._customize_presentation_notes(
        {"outline_json": json.dumps(outline, ensure_ascii=False)},
        {"profile": {"education": "本科"}, "mastery": {"overall": 0.35},
         "weak_points": [{"knowledgePoint": "定义"}]},
    ))

    assert personalized is not None
    assert personalized["slides"][0]["speakerNotes"] == "针对薄弱概念增加一句通俗解释。"
    assert personalized["slides"][1]["speakerNotes"] == "原始讲解稿第二页。"
    for index, original in enumerate(outline["slides"]):
        before = {key: value for key, value in original.items() if key != "speakerNotes"}
        after = {key: value for key, value in personalized["slides"][index].items() if key != "speakerNotes"}
        assert after == before


def test_long_chapter_is_generated_once_without_splitting_code():
    code = "\n".join(f"print({index})" for index in range(160))
    unit = {
        "title": "完整章节",
        "sections": [
            {"title": "概念", "content": "甲" * 900},
            {"title": "示例代码", "content": f"```python\n{code}\n```"},
        ],
    }

    slides = CustomizeService._slides_for_unit("lecture", unit, [])

    assert len(slides) == 1
    assert slides[0]["title"] == "完整章节"
    assert "甲" * 900 in slides[0]["content"]
    assert f"```python\n{code}\n```" in slides[0]["content"]


def test_legacy_split_chapter_is_merged_when_read():
    slides = [
        {"index": 0, "unitIndex": 0, "partIndex": 0, "partCount": 2,
         "type": "chapter", "title": "完整章节（1/2）", "content": "上半部分"},
        {"index": 1, "unitIndex": 0, "partIndex": 1, "partCount": 2,
         "type": "chapter", "title": "完整章节（2/2）", "content": "下半部分"},
        {"index": 2, "unitIndex": 1, "partIndex": 0, "partCount": 1,
         "type": "chapter", "title": "下一章节", "content": "下一章正文"},
    ]

    merged = CustomizeService.coalesce_legacy_unit_slides(slides)

    assert len(merged) == 2
    assert merged[0]["title"] == "完整章节"
    assert merged[0]["content"] == "上半部分\n\n下半部分"
    assert merged[0]["partCount"] == 1
    assert [slide["index"] for slide in merged] == [0, 1]


def test_practice_card_does_not_expose_internal_safety_enum():
    slides = CustomizeService._slides_for_unit(
        "practice",
        {"title": "执行步骤", "instruction": "完成配置。", "safety": "safe"},
        [],
    )

    assert slides[0]["content"] == "完成配置。"


def test_legacy_practice_card_removes_internal_safety_notice():
    slides = [{
        "index": 0, "unitIndex": 0, "partCount": 1, "type": "step",
        "title": "执行步骤", "content": "完成配置。\n\n**注意事项**\n\nsafe",
    }]

    cleaned = CustomizeService.coalesce_legacy_unit_slides(slides)

    assert cleaned[0]["content"] == "完成配置。"


def test_legacy_slide_cleanup_preserves_structured_quiz_content():
    question = {
        "stem": "Agent 与固定工作流的核心差异是什么？",
        "options": ["动态决策", "固定顺序", "没有状态", "没有工具"],
        "correctIndex": 0,
    }
    slides = [{
        "index": 0, "unitIndex": 0, "totalUnits": 1,
        "type": "question", "title": "第 1 题", "content": question,
    }]

    cleaned = CustomizeService.coalesce_legacy_unit_slides(slides)

    assert cleaned[0]["content"] == question
    assert isinstance(cleaned[0]["content"], dict)


def test_quiz_customization_uses_mother_bank_and_saves_each_card():
    service = CustomizeService.__new__(CustomizeService)
    service.tasks = _TaskStore()
    service.content_service = _ContentService()
    service._template_content = lambda _template: {
        "questions": [
            {"id": "q1", "stem": "普通概念", "difficulty": "hard", "options": ["A", "B"], "answer": 0},
            {"id": "q2", "stem": "工具调用薄弱点", "difficulty": "easy", "options": ["A", "B"], "answer": 1},
        ]
    }
    task_id, user_id = uuid4(), uuid4()

    result = asyncio.run(service._customize_content(
        "quiz", {"topic": "Agent", "sources_json": "[]"},
        {"mastery": {"overall": 0.2}, "weak_points": [{"knowledgePoint": "工具调用"}]},
        "kp-1-1", "分阶测试题", task_id=task_id, user_id=user_id,
    ))

    assert [item["id"] for item in result["questions"]] == ["q2", "q1"]
    assert len(service.tasks.slides) == 2
    assert service.tasks.slides[0]["type"] == "question"
    assert service.tasks.slides[0]["content"]["id"] == "q2"
    assert [call[0][4] for call in service.tasks.calls] == [
        "第 1 题已生成", "第 1 题结构检查完成",
        "第 2 题已生成", "第 2 题结构检查完成",
    ]
    assert [call[1]["agent"] for call in service.tasks.calls] == [
        "writer", "reviewer", "writer", "reviewer",
    ]
    assert service.tasks.calls[-1][1]["snapshot"]["completedUnits"] == 2


def test_lecture_uses_one_stream_and_persists_each_completed_unit():
    service = CustomizeService.__new__(CustomizeService)
    service.tasks = _TaskStore()
    service.content_service = _StreamingContentService([
        '好的，我现在开始生成第一页。{"unitIndex":0,"sections":[{"sectionIndex":0,"content":"针对薄弱点补充的解释"}]}',
        '接下来是第二页：{"unitIndex":1,"sections":[{"sectionIndex":0,"content":"好的，我现在来生成下一页的内容。结合学习记忆的例子"}]}',
    ])
    service._template_content = lambda _template: {
        "title": "母版",
        "chapters": [
            {"title": "第一章", "sections": [{"title": "概念", "content": "原文一", "citations": [1]}]},
            {"title": "第二章", "sections": [{"title": "应用", "content": "原文二", "citations": [2]}]},
        ],
    }
    task_id, user_id = uuid4(), uuid4()

    result = asyncio.run(service._customize_content(
        "lecture", {"topic": "Agent", "sources_json": "[]"},
        {"mastery": {"overall": 0.4}, "weak_points": [{"knowledgePoint": "规划"}]},
        "kp-1-1", "个性讲义", task_id=task_id, user_id=user_id,
    ))

    assert len(service.content_service.llm.calls) == 1
    assert result["chapters"][0]["sections"][0]["content"] == "针对薄弱点补充的解释"
    assert result["chapters"][1]["sections"][0]["content"] == "结合学习记忆的例子"
    assert result["chapters"][0]["sections"][0]["citations"] == [1]
    assert [len(value) for value in service.tasks.slide_history] == [1, 2]
    assert "针对薄弱点补充的解释" in service.tasks.slides[0]["content"]
    assert "结合学习记忆的例子" in service.tasks.slides[1]["content"]
    agents = [call[1].get("agent") for call in service.tasks.calls]
    assert agents.count("writer") == 3  # first-token event + two ready-card events
    assert agents.count("reviewer") == 2


def test_stream_missing_unit_never_publishes_mother_content():
    service = CustomizeService.__new__(CustomizeService)
    service.tasks = _TaskStore()
    service.content_service = _StreamingContentService([
        '{"unitIndex":0,"instruction":"根据薄弱点调整后的步骤"}\n',
        'not-json\n',
    ])
    service._template_content = lambda _template: {
        "steps": [
            {"title": "步骤一", "instruction": "原步骤一", "code": "print(1)", "citations": [1]},
            {"title": "步骤二", "instruction": "原步骤二", "code": "print(2)", "citations": [2]},
        ]
    }

    with pytest.raises(ValueError, match="every content unit"):
        asyncio.run(service._customize_content(
            "practice", {"topic": "Agent", "sources_json": "[]"}, {},
            "kp-1-1", "个性实操", task_id=uuid4(), user_id=uuid4(),
        ))

    assert len(service.tasks.slides) == 1
    assert service.tasks.slides[0]["content"].startswith("根据薄弱点调整后的步骤")


def test_slide_sources_include_inline_and_evidence_match_citations():
    sources = [
        {"id": 1, "chunkId": "chunk-1"},
        {"id": 2, "chunkId": "chunk-2"},
        {"id": 6, "chunkId": "chunk-6"},
    ]
    chapter = {
        "sections": [{
            "content": "智能体通过传感器感知环境 [2][6]。",
            "citations": [],
            "evidenceMatches": [{"sourceId": 2}],
        }],
    }

    matched = CustomizeService._sources_for_item(chapter, sources)

    assert [item["id"] for item in matched] == [2, 6]


def test_stream_patch_cannot_remove_mother_inline_citations():
    original = {
        "sections": [{
            "content": "母版事实 [2][citation:6][^8][KB-039]。",
            "citations": [2, 6, 8],
            "evidenceMatches": [{"sourceId": 2}],
        }],
    }
    patch = {
        "unitIndex": 0,
        "sections": [{"sectionIndex": 0, "content": "个性化解释只保留了 [2]。"}],
    }

    adapted = CustomizeService._apply_stream_patch("lecture", original, patch)

    content = adapted["sections"][0]["content"]
    assert all(mark in content for mark in ("[2]", "[citation:6]", "[^8]", "[KB-039]"))
    assert adapted["sections"][0]["citations"] == [2, 6, 8]
    assert adapted["sections"][0]["evidenceMatches"] == [{"sourceId": 2}]


def test_stream_parser_persists_complete_json_without_newline_and_ignores_chatter():
    first = '好的，我现在生成第一页。{"unitIndex":0,"instruction":"第一页正文"}'
    second = '接下来生成第二页：{"unitIndex":1,"instruction":"第二页'

    parsed, remainder = CustomizeService._extract_stream_patches(first + second, 2)

    assert parsed == [(0, {"unitIndex": 0, "instruction": "第一页正文"})]
    assert remainder == '{"unitIndex":1,"instruction":"第二页'


def test_stream_patch_removes_model_handoff_preamble_from_card_content():
    original = {"title": "步骤", "instruction": "母版步骤", "citations": [1]}
    patch = {
        "unitIndex": 0,
        "instruction": "好的，我现在来生成下一页的内容。直接承接的实操正文 [1]",
    }

    adapted = CustomizeService._apply_stream_patch("practice", original, patch)

    assert adapted["instruction"] == "直接承接的实操正文 [1]"


def test_lecture_framing_replaces_intro_and_final_review_without_changing_topology():
    content = {
        "summary": "旧导览",
        "learningObjectives": ["旧目标"],
        "chapters": [
            {"title": "原理", "sections": [{"title": "机制", "content": "正文", "citations": [1]}]},
            {"title": "复习", "sections": [{"title": "核心概念验证", "content": "旧检查", "citations": [2]}]},
        ],
    }
    framing = {
        "intro": {"title": "先看清 Agent 如何行动", "overview": "从循环与边界进入主题。", "objectives": ["解释循环", "比较边界", "诊断错误"]},
        "review": {
            "title": "用三个场景检验 Agent 判断",
            "introduction": "请结合正文完成以下检查。",
            "checks": [
                {"task": "解释循环", "criteria": "说清输入与输出"},
                {"task": "比较系统", "criteria": "指出决策差异"},
                {"task": "诊断错误", "criteria": "能定位约束缺失"},
            ],
        },
    }

    assert CustomizeService._apply_lecture_framing(content, framing) is True
    assert content["introTitle"] == "先看清 Agent 如何行动"
    assert content["learningObjectives"] == ["解释循环", "比较边界", "诊断错误"]
    assert content["chapters"][-1]["sections"][-1]["title"] == "用三个场景检验 Agent 判断"
    assert "检查标准：能定位约束缺失" in content["chapters"][-1]["sections"][-1]["content"]
    assert content["chapters"][-1]["sections"][-1]["citations"] == [2]
    assert len(content["chapters"]) == 2


def test_slide_sources_carry_normalized_fact_evidence_anchors():
    item = {
        "citations": [2],
        "evidenceMatches": [{
            "claim": "智能体能够自主行动",
            "sourceId": 2,
            "sourcePassage": "智能体通过执行器采取行动。",
        }],
    }
    sources = [{"id": 2, "knowledgeChunkId": 2067, "content": "智能体通过执行器采取行动。"}]

    matched = CustomizeService._sources_for_item(item, sources)

    assert matched[0]["evidenceAnchors"] == [{
        "sourceId": 2,
        "claim": "智能体能够自主行动",
        "quote": "智能体通过执行器采取行动。",
        "evidenceType": "direct",
        "evidenceStart": 0,
        "evidenceEnd": 13,
        "exactMatch": True,
        "snapshotText": "智能体通过执行器采取行动。",
    }]
