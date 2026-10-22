import asyncio
import json

import pytest

from app.services.learning_content import LearningContentService, compact_sources
from app.storage.learning_resources import _category_similarity


def test_generation_event_can_attribute_initial_check_to_verifier():
    service = LearningContentService.__new__(LearningContentService)
    events = []

    async def sink(*event):
        events.append(event)

    service.generation_event_sink = sink
    asyncio.run(service._generation_event(
        "verifying", 68, "实操初稿核验发现问题", "引用缺少有效原文匹配", agent="citation_verifier",
    ))

    assert events == [("verifying", 68, "citation_verifier", "实操初稿核验发现问题", "引用缺少有效原文匹配", None)]


def sample_content():
    return {
        "knowledgePoints": [
            {"id": "kp1", "name": "基础概念"},
            {"id": "kp2", "name": "综合应用"},
        ],
        "questions": [
            {"id": "q1", "knowledgePointId": "kp1", "difficulty": "easy",
             "options": ["A", "B"], "correctIndex": 0, "explanation": "因为 A"},
            {"id": "q2", "knowledgePointId": "kp1", "difficulty": "medium",
             "options": ["A", "B"], "correctIndex": 1, "explanation": "因为 B"},
            {"id": "q3", "knowledgePointId": "kp2", "difficulty": "hard",
             "options": ["A", "B"], "correctIndex": 0, "explanation": "综合分析"},
        ],
    }


def test_compact_sources_preserves_traceability_fields():
    result = {"chunks": [{"document": "教材", "content": "原文", "similarity": .87654,
                           "chunk_id": "chunk-1"}]}
    assert compact_sources(result) == [{
        "id": 1, "sourceType": "knowledge_base", "document": "教材", "url": "",
        "content": "原文", "similarity": .8765, "confidence": .8765, "chunkId": "chunk-1",
        "sectionTitle": "",
    }]


def test_retrieve_reuses_chapter_sources(monkeypatch):
    calls = []

    class FakeEvidenceSearch:
        async def retrieve(self, topic, **kwargs):
            calls.append((topic, kwargs))
            return ([{"id": 1, "document": "教材", "content": "原文"}], {})

    service = LearningContentService.__new__(LearningContentService)
    service.evidence_search = FakeEvidenceSearch()
    service._source_cache = {}
    first = asyncio.run(service.retrieve("同一章节"))
    second = asyncio.run(service.retrieve("同一章节"))
    assert first == second
    assert len(calls) == 1


def test_retrieve_normalizes_snake_case_chunk_id():
    class FakeEvidenceSearch:
        async def retrieve(self, *_args, **_kwargs):
            return ([{
                "sourceType": "knowledge_base", "document": "教材",
                "content": "正文", "chunk_id": "chunk-42",
            }], {})

    service = LearningContentService.__new__(LearningContentService)
    service.evidence_search = FakeEvidenceSearch()
    service._source_cache = {}

    sources = asyncio.run(service.retrieve("知识点"))

    assert sources[0]["chunkId"] == "chunk-42"


def test_adaptive_quiz_starts_at_ability_matched_difficulty():
    state = {"ability": .35, "answered": [], "mastery": {"kp1": .6, "kp2": .2}}
    question = LearningContentService.choose_next(sample_content(), state)
    assert question["id"] == "q1"


def test_correct_answer_raises_ability_and_mastery():
    state = {"ability": .35, "answered": [], "mastery": {"kp1": .35, "kp2": .35}}
    updated, feedback = LearningContentService.answer(sample_content(), state, "q1", "0", 20)
    assert feedback["correct"] is True
    assert updated["ability"] > .35
    assert updated["mastery"]["kp1"] > .35
    assert updated["answered"][0]["durationSeconds"] == 20


def test_wrong_answer_lowers_ability_and_cannot_be_submitted_twice():
    state = {"ability": .6, "answered": [], "mastery": {"kp1": .6, "kp2": .35}}
    updated, feedback = LearningContentService.answer(sample_content(), state, "q2", "0", 200)
    assert feedback["correct"] is False
    assert updated["ability"] < .6
    try:
        LearningContentService.answer(sample_content(), updated, "q2", "1", 10)
    except ValueError as exc:
        assert "already answered" in str(exc)
    else:
        raise AssertionError("duplicate answer must be rejected")


def test_quiz_completes_after_last_answer():
    content = sample_content()
    state = {"ability": .5, "answered": [
        {"questionId": "q1", "correct": True}, {"questionId": "q2", "correct": False},
    ], "mastery": {"kp1": .5, "kp2": .5}}
    updated, feedback = LearningContentService.answer(content, state, "q3", "0", 60)
    assert updated["completed"] is True
    assert feedback["completed"] is True
    assert LearningContentService.choose_next(content, updated) is None
    assert updated["learned"] is True


def test_category_similarity_understands_model_paraphrases():
    assert _category_similarity(
        "Function Calling机制原理 函数调用参数定义与JSON Schema",
        "FunctionCallAgent与原生函数调用",
    ) > .07
    assert _category_similarity("MCP协议与工具标准化", "MCP协议及工具集成") > .07
    assert _category_similarity(
        "当工具函数执行失败时应进行错误处理",
        "FunctionCallAgent与原生函数调用",
    ) > .05


def test_lecture_normalization_preserves_chapter_hierarchy():
    fallback = {
        "title": "fallback", "summary": "fallback", "learningObjectives": ["目标"],
        "chapters": [], "keyPoints": [], "reviewQuestions": [],
    }
    result = LearningContentService._normalize_lecture({
        "title": "完整讲义", "summary": "导读", "learningObjectives": ["理解原理"],
        "chapters": [{
            "title": "第一章", "overview": "章节概览",
            "sections": [{"title": "第一节", "content": "正文", "citations": [1]}],
        }],
        "keyPoints": ["要点"], "reviewQuestions": ["问题"],
    }, fallback)
    assert result["chapters"][0]["title"] == "第一章"
    assert result["chapters"][0]["sections"][0]["citations"] == [1]


def test_lecture_source_mix_prefers_seven_rag_and_three_web():
    sources = [
        {"id": index, "sourceType": "knowledge_base", "content": f"rag-{index}"}
        for index in range(1, 9)
    ] + [
        {"id": index + 8, "sourceType": "web", "content": f"web-{index}"}
        for index in range(1, 5)
    ]
    mixed = LearningContentService._lecture_source_mix(sources)
    assert len([item for item in mixed if item["sourceType"] == "knowledge_base"]) == 7
    assert len([item for item in mixed if item["sourceType"] == "web"]) == 3
    assert [item["id"] for item in mixed] == list(range(1, 11))


def test_lecture_evidence_quote_sanitizer_requires_verbatim_cited_text():
    content = {"chapters": [{"sections": [{
        "citations": [1, 2],
        "evidenceQuotes": [
            {"sourceId": 1, "quote": "可定位的知识库原句"},
            {"sourceId": 2, "quote": "网页中不存在的改写"},
            {"sourceId": 3, "quote": "未被引用的原句"},
        ],
    }]}]}
    LearningContentService._sanitize_evidence_quotes(content, [
        {"id": 1, "content": "前文。可定位的知识库原句。后文。"},
        {"id": 2, "content": "网页真实原句"},
        {"id": 3, "content": "未被引用的原句"},
    ])
    assert content["chapters"][0]["sections"][0]["evidenceQuotes"] == [
        {"sourceId": 1, "quote": "可定位的知识库原句"},
    ]


def test_lecture_evidence_match_is_preserved_for_highlight():
    content = {"chapters": [{"sections": [{
        "title": "工具调用参数校验",
        "content": "智能体执行工具前应根据 JSON Schema 校验参数，避免错误输入进入执行阶段。",
        "citations": [1],
        "evidenceMatches": [{
            "sourceId": 1,
            "claim": "执行工具前需要校验参数。",
            "sourcePassage": "工具调用前必须依据 JSON Schema 校验输入参数，校验通过后才进入执行阶段。",
        }],
    }]}]}
    source_text = (
        "天气晴朗时适合开展户外活动。"
        "工具调用前必须依据 JSON Schema 校验输入参数，校验通过后才进入执行阶段。"
        "系统还应记录调用日志。"
    )
    LearningContentService._sanitize_evidence_quotes(content, [{"id": 1, "content": source_text}])
    quote = content["chapters"][0]["sections"][0]["evidenceQuotes"][0]["quote"]
    assert quote == "工具调用前必须依据 JSON Schema 校验输入参数，校验通过后才进入执行阶段。"
    assert quote in source_text


def test_lecture_evidence_match_requires_llm_passage_to_exist_in_source():
    content = {"chapters": [{"sections": [{
        "title": "记忆机制",
        "content": "智能体可以保存长期信息，并在后续任务中再次利用。",
        "citations": [1],
        "evidenceMatches": [{
            "sourceId": 1,
            "claim": "智能体可以在未来任务中利用长期信息。",
            "sourcePassage": "长期记忆会将历史经验持久化，并在未来决策时检索相关内容。",
        }],
    }]}]}
    source_text = (
        "短期上下文只服务于当前一轮推理。"
        "长期记忆会将历史经验持久化，并在未来决策时检索相关内容。"
        "工具系统负责连接外部能力。"
    )
    LearningContentService._sanitize_evidence_quotes(content, [{"id": 1, "content": source_text}])
    quote = content["chapters"][0]["sections"][0]["evidenceQuotes"][0]["quote"]
    assert quote == "长期记忆会将历史经验持久化，并在未来决策时检索相关内容。"


def test_lecture_evidence_match_quality_reports_missing_llm_mapping():
    content = {"chapters": [{"sections": [{
        "content": "讲义对来源进行了归纳转述。", "citations": [1], "evidenceMatches": [],
    }]}]}
    assert LearningContentService._lecture_evidence_match_issues(
        content, [{"id": 1, "content": "来源中的支撑原文。"}],
    ) == ["有 1 个讲义引用缺少 LLM 返回的有效原文匹配"]


def test_unmatched_lecture_citations_are_hidden_without_dropping_content():
    content = {"chapters": [{"sections": [{
        "content": "已经生成好的讲义正文必须保留。", "citations": [1, 2],
        "evidenceQuotes": [{"sourceId": 1, "quote": "可定位原文"}],
    }]}]}
    LearningContentService._drop_unmatched_lecture_citations(content)
    section = content["chapters"][0]["sections"][0]
    assert section["content"] == "已经生成好的讲义正文必须保留。"
    assert section["citations"] == [1]


def test_lecture_normalization_upgrades_legacy_flat_sections():
    fallback = {
        "title": "fallback", "summary": "fallback", "learningObjectives": ["目标"],
        "chapters": [], "keyPoints": [], "reviewQuestions": [],
    }
    result = LearningContentService._normalize_lecture({
        "title": "旧讲义", "sections": [
            {"title": "基础", "content": "旧版正文", "citations": [2]},
        ],
    }, fallback)
    assert len(result["chapters"]) == 1
    assert result["chapters"][0]["sections"][0]["content"] == "旧版正文"


def test_lecture_quality_rejects_boilerplate_fallback():
    content = {
        "chapters": [{
            "title": "基础概念", "sections": [
                {"title": "概念导入", "content": "建立整体认知。"},
                {"title": "核心机制", "content": "梳理主要机制和使用边界。"},
                {"title": "案例", "content": "结合一个典型案例完成分析。"},
            ],
        }],
    }
    issues = LearningContentService._lecture_quality_issues(content, "balanced")
    assert any("正文过短" in issue for issue in issues)
    assert any("模板占位话术" in issue for issue in issues)


def test_lecture_quality_accepts_substantive_content():
    section_text = (
        "首先给出准确定义，并解释各组成部分之间的数据流。"
        "例如，输入是一条用户请求，处理步骤包括解析、校验、执行和记录，输出是结构化结果。"
        "下面通过代码和配置展示完整流程，并解释每一步为什么需要这样设计。"
        "常见错误包括参数缺失与状态不一致，限制是外部服务不可用时必须降级。"
        "最后使用日志、断言和实际输出进行验证，确认结果满足预期。"
    ) * 4
    content = {
        "chapters": [
            {"title": f"第 {chapter} 章", "sections": [
                {"title": f"小节 {index}", "content": section_text}
                for index in range(1, 3)
            ]}
            for chapter in range(1, 4)
        ],
    }
    assert LearningContentService._lecture_quality_issues(content, "balanced") == []


def test_lecture_quality_accepts_five_substantive_sections_for_concise_mode():
    section_text = (
        "给出准确定义与数据流。例如输入请求经过校验、执行后产生输出。"
        "实现步骤包含代码和配置，并解释常见错误、适用限制与验证方法。"
    ) * 6
    content = {
        "chapters": [
            {"title": "基础", "sections": [{"title": "定义", "content": section_text}]},
            {"title": "机制", "sections": [
                {"title": "流程", "content": section_text},
                {"title": "示例", "content": section_text},
            ]},
            {"title": "实践", "sections": [
                {"title": "边界", "content": section_text},
                {"title": "验证", "content": section_text},
            ]},
        ],
    }
    assert LearningContentService._lecture_quality_issues(content, "concise") == []


def test_practice_quality_requires_executable_outputs_and_acceptance():
    weak = {"steps": [{"title": "操作", "instruction": "自行完成"}]}
    issues = LearningContentService._practice_quality_issues(weak)
    assert any("步骤不足" in issue for issue in issues)
    assert any("预期结果" in issue for issue in issues)

    instruction = "打开项目目录，创建配置文件，输入给定参数并保存。执行命令后检查终端输出和生成文件，逐项核对字段、状态和日志；如果结果不同，先按故障排查恢复环境再重新运行。" * 2
    complete = {
        "steps": [
            {"title": f"步骤 {index}", "instruction": instruction, "code": "python app.py", "expectedOutput": "终端显示 status=ok，并生成 result.json", "safety": "safe"}
            for index in range(1, 5)
        ],
        "acceptanceCriteria": ["命令退出码为 0", "result.json 字段完整", "日志没有 ERROR"],
        "troubleshooting": [{"problem": "依赖缺失", "solution": "安装锁定版本"}, {"problem": "端口占用", "solution": "更换空闲端口"}],
    }
    assert LearningContentService._practice_quality_issues(complete) == []

    fallback = LearningContentService._practice_fallback({"topic": "文件处理"})
    assert fallback["safetyChecklist"]
    assert fallback["safetyNotice"]
    assert all(step["safety"] in {"safe", "caution", "danger"} for step in fallback["steps"])


def test_quiz_quality_checks_difficulty_explanations_and_answer_distribution():
    questions = []
    for index in range(12):
        questions.append({
            "stem": f"在场景 {index + 1} 中，应如何根据输入和约束选择正确处理方式？",
            "options": [f"方案 {value}" for value in range(4)],
            "correctIndex": index % 4,
            "difficulty": ("easy", "medium", "hard")[index % 3],
            "knowledgePointId": "kp1" if index % 2 == 0 else "kp2",
            "explanation": "正确方案满足题干中的输入、约束和预期输出；其余方案忽略了关键边界条件，因此会产生错误结果。",
        })
    content = {"knowledgePoints": [{"id": "kp1"}, {"id": "kp2"}], "questions": questions}
    assert LearningContentService._quiz_quality_issues(content, 12) == []

    content["questions"][1]["stem"] = content["questions"][0]["stem"]
    content["questions"][2]["explanation"] = "略"
    issues = LearningContentService._quiz_quality_issues(content, 12)
    assert any("重复" in issue for issue in issues)
    assert any("解析过短" in issue for issue in issues)


def test_practice_fallback_is_immediately_usable():
    content = LearningContentService._practice_fallback({"topic": "算法评测系统"})
    assert LearningContentService._practice_quality_issues(content) == []
    assert len(content["steps"]) == 4


def test_quiz_answer_rebalance_preserves_correct_option():
    questions = []
    for index in range(12):
        questions.append({
            "stem": f"这是用于验证答案重新分布的完整题干编号 {index}",
            "options": ["正确选项", "干扰项一", "干扰项二", "干扰项三"],
            "correctIndex": 0,
            "difficulty": ("easy", "medium", "hard")[index % 3],
            "knowledgePointId": "kp1" if index % 2 == 0 else "kp2",
            "explanation": "这是一段超过三十个字符的答案解析，用于说明正确选项以及其他选项不成立的具体原因。",
        })
    content = {"knowledgePoints": [{"id": "kp1"}, {"id": "kp2"}], "questions": questions}
    correct_options = [item["options"][item["correctIndex"]] for item in questions]
    LearningContentService._rebalance_quiz_answers(content)
    assert [item["options"][item["correctIndex"]] for item in questions] == correct_options
    assert LearningContentService._quiz_quality_issues(content, 12) == []


def test_quiz_fallback_passes_minimum_quality_gate():
    content = LearningContentService._quiz_fallback({"topic": "算法评测系统"}, 12, [])
    assert LearningContentService._quiz_quality_issues(content, 12) == []


def test_question_bank_normalizer_requires_real_evidence_and_maps_answer():
    raw = {"questions": [{
        "question_type": "single_choice", "difficulty": 3, "cognitive_level": "apply",
        "stem": "在给定业务场景中，哪一种处理方式最符合工具调用的约束？",
        "options": [
            {"key": "A", "content": "直接忽略参数校验"},
            {"key": "B", "content": "先按 Schema 校验参数再执行工具"},
            {"key": "C", "content": "把所有参数转成空字符串"},
            {"key": "D", "content": "只记录结果而不执行工具"},
        ],
        "reference_answer": ["B"],
        "explanation": "正确方案先验证输入是否满足工具声明的 Schema，再进入执行阶段；其他方案会破坏参数约束或跳过实际调用。",
        "evidence_chunk_ids": [2, 999],
        "answer_evidence_quotes": [{"chunk_id": 2, "quote": "工具参数必须先按照 Schema 完成校验"}],
    }]}
    kp = {"id": "kp-tool", "name": "工具调用", "categoryId": 42}
    result = LearningContentService._normalize_question_bank_questions(
        raw, {2}, kp, "medium", 3, 1, {2: "工具参数必须先按照 Schema 完成校验，然后才可以执行调用。"},
    )
    assert len(result) == 1
    assert result[0]["correctIndex"] == 1
    assert result[0]["citations"] == [2]
    assert result[0]["answerEvidenceQuotes"][0]["chunk_id"] == 2
    assert result[0]["difficultyLevel"] == 3
    assert result[0]["generationMetadata"]["promptVersion"] == "question-v1"


def test_practice_evidence_match_is_sanitized_and_unmatched_citation_hidden():
    source_text = "先定义工具参数模式，再执行一次模式校验。"
    content = {"steps": [{
        "instruction": "定义参数并校验。", "citations": [1, 2],
        "evidenceMatches": [{"sourceId": 1, "claim": "需要定义参数模式", "sourcePassage": source_text}],
    }]}
    sources = [{"id": 1, "content": source_text}, {"id": 2, "content": "另一条来源"}]

    assert LearningContentService._practice_evidence_match_issues(content, sources) == ["有 1 个实操步骤引用缺少 LLM 返回的有效原文匹配"]
    details = LearningContentService._practice_evidence_match_details(content, sources)
    assert details == [{
        "stepIndex": 1, "stepTitle": "步骤 1", "sourceId": 2, "sourceTitle": "未命名来源",
        "claim": "", "reason": "该步骤声明了引用，但没有提供对应的原文匹配",
    }]
    LearningContentService._sanitize_evidence_quotes(content, sources)
    LearningContentService._drop_unmatched_practice_citations(content)

    assert content["steps"][0]["citations"] == [1]
    assert content["steps"][0]["evidenceQuotes"] == [{"sourceId": 1, "quote": source_text}]


def test_citation_coverage_details_locate_the_exact_content_block():
    content = {"chapters": [{"title": "基础", "sections": [
        {"title": "有依据", "content": "可核查事实", "citations": [1]},
        {"title": "缺少依据", "content": "需要补充来源的事实性说明", "citations": []},
    ]}]}
    details = LearningContentService._citation_coverage_details(content, [{"id": 1, "content": "可核查事实"}])

    assert details == [{
        "blockType": "讲义小节", "blockIndex": 2, "blockTitle": "缺少依据",
        "excerpt": "需要补充来源的事实性说明",
        "reason": "该内容包含事实性说明，但没有标注任何可追溯来源编号",
        "requiredAction": "补充能够直接支撑该内容的来源编号和对应原文；若无可靠依据则删除或改写该内容",
    }]


def test_practice_draft_usability_requires_a_renderable_step():
    assert LearningContentService._usable_practice_content({"steps": [{"instruction": "执行并观察结果"}]})
    assert not LearningContentService._usable_practice_content({"steps": []})


def test_practice_source_mix_reserves_space_only_for_debate_verified_web():
    rag = [{"sourceType": "knowledge_base", "document": f"知识库{i}"} for i in range(8)]
    verified = [{"sourceType": "web", "document": f"可信网页{i}", "debateVerified": True} for i in range(6)]
    rejected = [{"sourceType": "web", "document": "未通过网页", "debateVerified": False}]
    selected = LearningContentService._practice_source_mix(rag + verified + rejected)

    assert sum(item["sourceType"] == "knowledge_base" for item in selected) == 5
    assert sum(item["sourceType"] == "web" for item in selected) == 5
    assert all(item.get("debateVerified") for item in selected if item["sourceType"] == "web")
    assert [item["id"] for item in selected] == list(range(1, 11))

    sparse_verified = LearningContentService._practice_source_mix(rag + verified[:2] + rejected)
    assert all(item.get("debateVerified") for item in sparse_verified if item["sourceType"] == "web")
    assert "未通过网页" not in {item["document"] for item in sparse_verified}
    assert not LearningContentService._usable_practice_content({"__generation_failed__": True})


def test_lecture_draft_usability_requires_renderable_body():
    assert LearningContentService._usable_lecture_content({"chapters": [{"sections": [{"content": "有效正文"}]}]})
    assert LearningContentService._usable_lecture_content({"sections": [{"content": "兼容旧结构正文"}]})
    assert not LearningContentService._usable_lecture_content({"chapters": []})


def test_lecture_generation_splits_by_chapter_when_full_json_unusable():
    class FakeLlm:
        def __init__(self):
            self.calls = 0

        async def complete_json(self, _system, _prompt, fallback, **_kwargs):
            self.calls += 1
            if self.calls == 1:
                return {"__generation_failed__": True}
            return {
                "title": f"学习单元{self.calls - 1}",
                "overview": "围绕当前学习单元展开。",
                "sections": [
                    {
                        "title": "机制说明",
                        "content": "Agent通信协议用于统一不同智能体之间的消息格式、能力声明和状态反馈。发送方先描述任务目标和上下文，接收方根据协议字段判断自己能否处理，再返回结果、错误或继续协作所需的信息。",
                        "citations": [1],
                        "evidenceMatches": [{
                            "sourceId": 1,
                            "claim": "协议统一消息格式、能力声明和状态反馈。",
                            "sourcePassage": "Agent通信协议用于统一消息格式、能力声明和状态反馈。",
                        }],
                    },
                    {
                        "title": "使用边界",
                        "content": "协议本身不直接提升模型推理能力，它解决的是协作过程中的互操作问题。若字段定义不清晰，智能体会误解任务状态；若错误反馈缺失，上游智能体无法判断应该重试、换工具还是请求人工介入。",
                        "citations": [1],
                        "evidenceMatches": [{
                            "sourceId": 1,
                            "claim": "协议解决协作互操作问题。",
                            "sourcePassage": "协议解决的是协作过程中的互操作问题。",
                        }],
                    },
                ],
            }

    class FakeEvidenceSearch:
        async def retrieve(self, *_args, **_kwargs):
            return ([{
                "id": 1,
                "sourceType": "knowledge_base",
                "document": "Agent通信协议",
                "content": "Agent通信协议用于统一消息格式、能力声明和状态反馈。协议解决的是协作过程中的互操作问题。",
                "chunkId": "chunk-1",
                "similarity": .9,
            }], {})

    service = LearningContentService.__new__(LearningContentService)
    service.llm = FakeLlm()
    service.evidence_search = FakeEvidenceSearch()
    service._source_cache = {}
    service.generation_event_sink = None

    content, sources, decision = asyncio.run(service.generate_lecture(
        {"topic": "Agent通信协议的设计动机与整体架构", "title": "Agent通信协议", "defer_quality_repair": True},
        {},
    ))

    assert len(content["chapters"]) == 3
    assert sources[0]["chunkId"] == "chunk-1"
    assert decision["quality"]["fallbackUsed"] is False


def test_lecture_citation_backfill_repairs_missing_blocks():
    from app.services.learning_content import LearningContentService
    sources = [{"id": 1, "sourceType": "knowledge_base", "content": "Agent通信协议用于统一消息格式、能力声明和状态反馈。协议解决的是协作过程中的互操作问题。"}]
    content = {"chapters": [{"title": "机制", "sections": [{"title": "协议定义", "content": "Agent通信协议用于统一消息格式、能力声明和状态反馈，是协作的基础。", "citations": []}]}]}
    backfilled = LearningContentService._auto_backfill_citations(content, sources)
    assert backfilled == 1
    section = content["chapters"][0]["sections"][0]
    assert section["citations"] == [1]
    match = section["evidenceMatches"][0]
    assert "统一消息格式" in match["sourcePassage"]


def test_question_bank_normalizer_rejects_fabricated_evidence():
    raw = {"questions": [{
        "question_type": "single_choice", "difficulty": 1, "cognitive_level": "remember",
        "stem": "下面关于智能体工具调用机制的说法，哪一项符合资料中的定义？",
        "options": [
            {"key": "A", "content": "选项一"}, {"key": "B", "content": "选项二"},
            {"key": "C", "content": "选项三"}, {"key": "D", "content": "选项四"},
        ],
        "reference_answer": ["A"],
        "explanation": "这是一段足够长的解析，用来说明正确选项，并逐项解释其他三个干扰项为什么不符合资料中的定义。",
        "evidence_chunk_ids": [999],
    }]}
    kp = {"id": "kp-tool", "name": "工具调用", "categoryId": 42}
    assert LearningContentService._normalize_question_bank_questions(raw, {2}, kp, "easy", 1, 1) == []


def test_question_bank_normalizer_rejects_quote_not_found_in_cited_chunk():
    raw = {"questions": [{
        "question_type": "single_choice", "difficulty": 3, "cognitive_level": "apply",
        "stem": "智能体调用工具之前最合理的参数处理方式是什么？",
        "options": [
            {"key": "A", "content": "先校验参数"}, {"key": "B", "content": "跳过校验"},
            {"key": "C", "content": "清空参数"}, {"key": "D", "content": "只记录请求"},
        ],
        "reference_answer": ["A"],
        "explanation": "正确方案先校验参数再执行工具，其他方案会破坏调用约束、丢失输入或根本没有执行任务。",
        "evidence_chunk_ids": [2],
        "answer_evidence_quotes": [{"chunk_id": 2, "quote": "这句话并不存在于知识库原文之中"}],
    }]}
    kp = {"id": "kp-tool", "name": "工具调用", "categoryId": 42}
    # 有引用但引文未能逐字命中 → 放行（不再拒绝；仅完全无引用时才阻塞）
    normalized = LearningContentService._normalize_question_bank_questions(
        raw, {2}, kp, "medium", 3, 1, {2: "工具执行前必须检查输入参数。"},
    )
    assert len(normalized) == 1


def test_question_bank_normalizer_rejects_reading_comprehension_and_cross_question_stems():
    def raw_question(stem):
        return {"questions": [{
            "question_type": "single_choice", "difficulty": 3, "cognitive_level": "apply",
            "stem": stem,
            "options": [
                {"key": "A", "content": "校验参数后调用工具"}, {"key": "B", "content": "跳过校验直接执行"},
                {"key": "C", "content": "清空全部输入参数"}, {"key": "D", "content": "只记录请求不执行"},
            ],
            "reference_answer": ["A"],
            "explanation": "正确方案保留完整输入并先执行参数校验；其他方案会破坏调用约束、丢失信息或根本没有完成任务。",
            "evidence_chunk_ids": [2],
        }]}

    kp = {"id": "kp-tool", "name": "工具调用", "categoryId": 42}
    assert LearningContentService._normalize_question_bank_questions(
        raw_question("根据资料，智能体调用工具之前最合理的处理方式是什么？"), {2}, kp, "medium", 3, 1,
    ) == []
    assert LearningContentService._normalize_question_bank_questions(
        raw_question("沿用上一题的业务场景，智能体下一步最合理的处理方式是什么？"), {2}, kp, "medium", 3, 1,
    ) == []


def test_question_bank_batch_accumulates_valid_questions_across_retries():
    service = LearningContentService.__new__(LearningContentService)
    calls = {"generation": 0, "review": 0}
    events = []

    async def event_sink(*event):
        events.append(event)

    service.generation_event_sink = event_sink

    class Llm:
        async def complete_json(self, system, *_args, **_kwargs):
            if "质量核验 Agent" in system:
                calls["review"] += 1
                return {"reviews": [{"index": index, "passed": True, "summary": "本题可作为通用母版",
                                      "issues": [], "hardErrors": [], "scores": {"overall": 90}}
                                     for index in range(1, 5)]}
            calls["generation"] += 1
            offset = calls["generation"]
            return {"questions": [{
                "question_type": "single_choice", "difficulty": 1, "cognitive_level": "remember",
                "stem": f"这是第 {index} 道独立且信息完整的测试题干",
                "options": [{"key": key, "content": f"{key}选项{index}"} for key in "ABCD"],
                "reference_answer": ["A"],
                "explanation": "A 选项与智能体定义中的感知、行动和目标约束完全一致，其他选项遗漏了必要要素。",
                "evidence_chunk_ids": [1],
                "answer_evidence_quotes": [{"chunk_id": 1, "quote": "智能体通过传感器感知环境并通过执行器采取行动"}],
            } for index in range(1, 5)]}

    service.llm = Llm()
    sources = [{"id": 1, "document": "第一章", "content": "智能体通过传感器感知环境并通过执行器采取行动，以达成特定目标。"}]
    result = asyncio.run(service._generate_question_bank_batch(
        {"topic": "智能体定义"}, {}, sources, {"id": "kp1", "name": "智能体定义"}, "easy", 1, 4,
    ))

    assert len(result) == 4
    assert calls == {"generation": 1, "review": 1}
    assert all(question["reviewStatus"] == "pending_review" for question in result)
    assert all(len(question["contentHash"]) == 64 for question in result)
    assert all(question["evidenceSnapshot"] for question in result)
    titles = [event[3] for event in events]
    progresses = [event[1] for event in events]
    assert len(progresses) > 0
    assert titles == ["生成第 1-4 题", "第 1-4 题候选已生成", "第 1-4 题批量核验通过"]


def test_question_bank_batch_rejects_stems_generated_by_previous_difficulty_batch():
    service = LearningContentService.__new__(LearningContentService)
    calls = {"generation": 0}

    class Llm:
        async def complete_json(self, system, *_args, **_kwargs):
            if "质量核验 Agent" in system:
                return {"reviews": [{"index": 1, "passed": True, "summary": "通过", "issues": [], "hardErrors": []}]}
            calls["generation"] += 1
            stem = "上一难度已经使用过的完整题干" if calls["generation"] == 1 else "本难度新生成的完整独立题干"
            return {"questions": [{
                "question_type": "single_choice", "difficulty": 3, "cognitive_level": "apply",
                "stem": stem,
                "options": [{"key": key, "content": f"{key}选项"} for key in "ABCD"],
                "reference_answer": ["A"],
                "explanation": "正确选项满足资料中的全部必要条件，其余选项遗漏关键约束，因此不成立。",
                "evidence_chunk_ids": [1],
                "answer_evidence_quotes": [{"chunk_id": 1, "quote": "智能体通过传感器感知环境并通过执行器采取行动"}],
            }]}

    service.llm = Llm()
    service.generation_event_sink = None
    sources = [{"id": 1, "document": "第一章", "content": "智能体通过传感器感知环境并通过执行器采取行动，以达成特定目标。"}]
    result = asyncio.run(service._generate_question_bank_batch(
        {"topic": "智能体定义", "question_count": 2}, {}, sources,
        {"id": "kp1", "name": "智能体定义"}, "medium", 3, 1,
        question_offset=1, excluded_stems={"上一难度已经使用过的完整题干"},
    ))

    assert [item["stem"] for item in result] == ["本难度新生成的完整独立题干"]
    assert calls["generation"] >= 2


def test_question_bank_never_skips_a_question_that_exhausted_repairs():
    service = LearningContentService.__new__(LearningContentService)
    events = []

    class Llm:
        async def complete_json(self, *_args, **_kwargs):
            return {"questions": []}

    async def event_sink(*event):
        events.append(event)

    service.llm = Llm()
    service.generation_event_sink = event_sink
    sources = [{"id": 1, "document": "知识资料", "content": "能够支持命题的完整知识原文。"}]
    with pytest.raises(RuntimeError, match="第 1-2 题模型连续未返回完整批次"):
        asyncio.run(service._generate_question_bank_batch(
            {"topic": "智能体"}, {}, sources, {"id": "kp1", "name": "智能体"}, "easy", 1, 2,
        ))
    titles = [event[3] for event in events]
    assert "生成第 1-2 题" in titles


def test_hard_error_replaces_question_and_exposes_review_metrics():
    service = LearningContentService.__new__(LearningContentService)
    calls = {"generation": 0, "review": 0}

    class Llm:
        async def complete_json(self, system, *_args, **_kwargs):
            if "质量核验 Agent" in system:
                calls["review"] += 1
                if calls["review"] == 1:
                    return {"reviews": [{"index": 1, "passed": False, "summary": "答案不唯一",
                                          "hardErrors": ["答案不唯一"], "issues": ["答案不唯一"],
                                          "scores": {"overall": 35}, "riskLabels": ["答案风险"]}]}
                return {"reviews": [{"index": 1, "passed": True, "summary": "原问题已关闭",
                                      "hardErrors": [], "issues": [],
                                      "scores": {"overall": 86, "grounding": 92}, "riskLabels": []}]}
            calls["generation"] += 1
            offset = calls["generation"]
            return {"questions": [{
                "question_type": "single_choice", "difficulty": 1, "cognitive_level": "remember",
                "stem": f"这是第 {offset} 个证据充分且可以独立作答的候选题干",
                "options": [{"key": key, "content": f"{key}候选{offset}"} for key in "ABCD"],
                "reference_answer": ["A"],
                "explanation": "A 项符合智能体定义中的感知、行动和目标约束，其他选项缺少必要条件。",
                "evidence_chunk_ids": [1],
                "answer_evidence_quotes": [{"chunk_id": 1, "quote": "智能体通过传感器感知环境并通过执行器采取行动"}],
                "rationale": {"grounding": "原文直接支持", "answer": "A 是唯一完整选项"},
            }]}

    service.llm = Llm()
    service.generation_event_sink = None
    sources = [{"id": 1, "document": "第一章", "content": "智能体通过传感器感知环境并通过执行器采取行动，以达成特定目标。"}]
    result = asyncio.run(service._generate_question_bank_batch(
        {"topic": "智能体定义"}, {}, sources, {"id": "kp1", "name": "智能体定义"}, "easy", 1, 1,
    ))

    assert len(result) == 1
    assert result[0]["reviewStatus"] == "pending_review"
    assert result[0]["replacementUsed"] is False
    assert result[0]["reviewMetrics"]["overall"] == 86
    assert result[0]["generationRationale"]["grounding"] == "原文直接支持"
    assert [item["mode"] for item in result[0]["versionHistory"]] == ["initial", "targeted_repair"]
    # 最终资源会写入 MySQL JSON；版本历史不得反向引用题目自身。
    serialized = json.dumps({"questions": result}, ensure_ascii=False)
    assert "targeted_repair" in serialized


def test_question_repair_review_cannot_invent_new_issues():
    service = LearningContentService.__new__(LearningContentService)

    class Llm:
        async def complete_json(self, *_args, **_kwargs):
            return {
                "passed": False, "summary": "又发现了别的问题",
                "resolutions": [{
                    "previousIssue": "解析没有说明 B 项错误原因", "resolved": True,
                    "finding": "解析已经补充 B 项不成立的原因",
                }],
                "checks": [{"label": "新检查项", "passed": False}],
                "issues": ["新发现一个措辞风格问题"],
            }

    service.llm = Llm()
    review = asyncio.run(service._review_master_question(
        {"stem": "完整题干", "options": ["A", "B", "C", "D"], "correctIndex": 0, "citations": [1]},
        [{"id": 1, "document": "资料", "content": "可核验原文"}],
        {"issues": ["解析没有说明 B 项错误原因"]},
    ))

    assert review["passed"] is True
    assert review["issues"] == []
    assert review["resolutions"][0]["resolved"] is True


def test_single_knowledge_point_quiz_passes_quality_gate():
    content = sample_content()
    content["knowledgePoints"] = [{"id": "kp1", "name": "工具调用"}]
    for question in content["questions"]:
        question["knowledgePointId"] = "kp1"
        question["stem"] = question.get("stem") or f"这是一个信息完整的测试题干 {question['id']}"
        question["options"] = ["选项A", "选项B", "选项C", "选项D"]
        question["explanation"] = "正确选项满足题干约束；其余选项忽略输入校验、执行条件或预期输出，因此不成立。"
    assert not any("知识点" in issue for issue in LearningContentService._quiz_quality_issues(content, 3))


def test_citation_sanitizer_removes_unknown_and_duplicate_sources():
    content = {"steps": [{"citations": [1, "2", 2, 99, "bad"]}]}
    LearningContentService._sanitize_citations(content, [{"id": 1}, {"id": 2}])
    assert content["steps"][0]["citations"] == [1, 2]


def test_citation_sanitizer_recovers_verified_match_source_id():
    source_text = "推理机根据已知事实匹配知识库规则并推导新的结论。"
    content = {"chapters": [{"sections": [{
        "title": "推理机", "content": "推理机会应用规则得到结论。", "citations": [],
        "evidenceMatches": [{
            "sourceId": 7, "claim": "推理机会应用规则得到结论。",
            "sourcePassage": source_text,
        }],
    }]}]}
    LearningContentService._sanitize_citations(content, [{"id": 7, "content": source_text}])
    assert content["chapters"][0]["sections"][0]["citations"] == [7]
    assert LearningContentService._citation_coverage_issues(content, [{"id": 7, "content": source_text}]) == []


def test_citation_sanitizer_does_not_recover_unverifiable_match():
    content = {"sections": [{
        "content": "事实说明", "citations": [],
        "evidenceMatches": [{"sourceId": 7, "claim": "事实说明", "sourcePassage": "不存在的原文"}],
    }]}
    LearningContentService._sanitize_citations(content, [{"id": 7, "content": "真实来源正文"}])
    assert content["sections"][0]["citations"] == []


def test_citation_coverage_reports_the_exact_uncited_blocks():
    content = {
        "chapters": [{"sections": [
            {"title": "有依据", "content": "事实 A", "citations": [1]},
            {"title": "缺依据", "content": "事实 B", "citations": []},
        ]}],
        "questions": [{"stem": "事实 C 是否成立？", "citations": []}],
    }

    # 引用覆盖为纪实指标：内容自洽即交付（自动补齐流程兜底），不再作为失败门
    assert LearningContentService._citation_coverage_issues(content, [{"id": 1}]) == []
    assert LearningContentService._citation_coverage_issues(content, []) == []
    assert len(LearningContentService._citation_coverage_details(content, [{"id": 1}])) == 2


def test_practice_authored_action_does_not_require_fake_citation():
    content = {"steps": [
        {"title": "运行示例", "instruction": "新建示例文件，运行命令并记录终端输出。", "citations": []},
        {"title": "核对定义", "instruction": "核对智能体定义。", "citations": [],
         "evidenceMatches": [{"sourceId": 1, "claim": "智能体定义", "sourcePassage": ""}]},
    ]}

    details = LearningContentService._citation_coverage_details(content, [{"id": 1}])

    assert len(details) == 1
    assert details[0]["blockIndex"] == 2


def test_practice_quote_locator_replaces_paraphrase_with_exact_source_passage():
    source = "智能体能够通过传感器感知环境，并自主地通过执行器采取行动以达成目标。"
    content = {"steps": [{
        "title": "识别核心要素", "instruction": "整理智能体的感知和行动要素。", "citations": [2],
        "evidenceMatches": [{
            "sourceId": 2, "claim": "智能体通过传感器感知环境并通过执行器行动",
            "sourcePassage": "智能体会感知并行动。",
        }],
    }]}

    repaired = LearningContentService._resolve_practice_evidence_matches(
        content, [{"id": 2, "content": source}],
    )
    LearningContentService._sanitize_citations(content, [{"id": 2, "content": source}])

    assert repaired == 1
    assert content["steps"][0]["evidenceMatches"][0]["sourcePassage"] == source
    assert content["steps"][0]["citations"] == [2]
    assert LearningContentService._practice_evidence_match_issues(content, [{"id": 2, "content": source}]) == []


def test_question_normalizer_reports_specific_failure_instead_of_generic_message():
    diagnostics = []
    result = LearningContentService._normalize_question_bank_questions(
        {"questions": [{
            "question_type": "single_choice", "stem": "太短", "options": [],
            "reference_answer": ["A"], "explanation": "短", "evidence_chunk_ids": [],
        }]}, {1}, {"id": "kp", "name": "知识点"}, "easy", 1, 1, {1: "原文"},
        diagnostics=diagnostics,
    )

    assert result == []
    assert "题干过短（至少 12 个字符）" in diagnostics
    assert "选项数量不是 4 个" in diagnostics
    assert "没有有效来源编号" in diagnostics


def test_question_normalizer_locates_verbatim_quote_inside_selected_chunk():
    source = "智能体能够通过传感器感知环境，并自主地通过执行器采取行动以达成目标。"
    raw = {"questions": [{
        "question_type": "single_choice", "difficulty": 1, "cognitive_level": "remember",
        "stem": "下列哪一项最准确描述了智能体的环境交互能力？",
        "options": [{"key": key, "content": text} for key, text in zip(
            "ABCD", ["感知环境并自主行动", "只保存数据", "只显示页面", "只执行固定文本"]
        )],
        "reference_answer": ["A"],
        "explanation": "正确选项同时包含环境感知与自主行动，其他选项都缺失智能体定义中的关键能力。",
        "evidence_chunk_ids": [3],
        "answer_evidence_quotes": [{"chunk_id": 3, "quote": "智能体会感知环境并自主采取行动。"}],
    }]}

    result = LearningContentService._normalize_question_bank_questions(
        raw, {3}, {"id": "kp", "name": "智能体"}, "easy", 1, 1, {3: source},
    )

    assert len(result) == 1
    assert result[0]["citations"] == [3]
    assert result[0]["answerEvidenceQuotes"][0]["quote"] == source


def test_question_review_retries_compact_audit_without_regenerating_candidate():
    class AuditLlm:
        def __init__(self): self.calls = 0

        async def complete_json(self, _system, _prompt, fallback, **_kwargs):
            self.calls += 1
            if self.calls == 1:
                return fallback
            return {"passed": True, "summary": "题目事实和答案一致", "issues": []}

    service = LearningContentService.__new__(LearningContentService)
    service.llm = AuditLlm()
    question = {"stem": "智能体自主性的核心体现是什么？", "options": ["A", "B", "C", "D"],
                "correctIndex": 1, "explanation": "自主性使智能体可以依据环境变化独立决策并采取行动。", "citations": [1]}
    review = asyncio.run(service._review_master_question(
        question, [{"id": 1, "document": "教材", "content": "智能体能够依据环境变化自主决策。"}],
    ))

    assert review["passed"] is True
    assert service.llm.calls == 2

def test_chat_context_preloads_current_question_sources_and_state():
    resource = {
        "type": "quiz", "title": "工具调用测评", "topic": "函数调用", "sources": [
            {"id": 1, "document": "知识库原文", "content": "工具参数必须符合JSON Schema"},
        ],
        "content": {**sample_content()}, "state": {
            "ability": .42, "answered": [{"questionId": "q1", "correct": False}],
            "mastery": {"kp1": .3, "kp2": .5},
        },
    }
    context = LearningContentService._build_chat_context(resource, "q1")
    assert "当前题目" in context
    assert "知识库原文" in context
    assert "作答状态" in context
    assert "q1" in context

def test_follow_up_suggestions_focus_on_current_quiz_question():
    resource = {
        "type": "quiz", "content": sample_content(), "state": {"answered": []},
    }
    suggestions = LearningContentService._follow_up_suggestions(resource, "q1")
    assert any("变式题" in suggestion for suggestion in suggestions)
    assert any("基础概念" in suggestion for suggestion in suggestions)

def test_follow_up_suggestions_switch_to_review_after_quiz_completes():
    resource = {
        "type": "quiz", "content": sample_content(), "state": {
            "answered": [{"questionId": "q1"}, {"questionId": "q2"}, {"questionId": "q3"}], "completed": True,
        },
    }
    suggestions = LearningContentService._follow_up_suggestions(resource)
    assert any("薄弱点" in suggestion for suggestion in suggestions)
    assert any("错题" in suggestion for suggestion in suggestions)


def test_source_lookup_phrases_extract_mysql_original_passage():
    snapshot = """# 第一章 初识智能体
## 1.1 什么是智能体？
这是第一章第一节，定义了智能体的基本概念和核心要素。
在人工智能领域，智能体被定义为任何能够通过**传感器**感知其所处**环境**，并通过执行器作用于环境的实体。"""

    phrases = LearningContentService._source_lookup_phrases(snapshot)

    assert any("智能体被定义为任何能够通过传感器感知" in phrase for phrase in phrases)
    assert all(len(phrase) <= 72 for phrase in phrases)
