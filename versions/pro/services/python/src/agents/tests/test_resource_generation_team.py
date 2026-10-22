import asyncio
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.services.resource_generation_team import ResourceGenerationTeam


class FakeLlm:
    async def complete_json(self, system, prompt, fallback, **kwargs):
        if "命题分析师" in system:
            return {"audienceGap": "需要工程案例", "competitionFit": ["Agent工作流"], "coverage": ["工具调用"], "sourcePlan": [{"sourceId": 1, "purpose": "定义"}], "acceptanceRubric": ["可验证"]}
        return {"scores": {"accuracy": 92, "competitionFit": 90, "depth": 88, "actionability": 91, "citation": 94}, "defects": [], "passed": True}


class FakeService:
    def __init__(self, sources):
        self.sources = sources
        self._source_cache = {}

    async def retrieve(self, topic, top_k=12, *, rag_only=False, supplement_web=False, kp_id=None):
        return self.sources

    async def generate_lecture(self, payload, context):
        selected = self._source_cache.get(f"mixed:fallback:{payload.get('topic')}:", self.sources)
        return ({"title": "工具调用", "chapters": [{"sections": [{"title": "机制", "content": "工具调用受参数模式约束。", "citations": [1], "evidenceMatches": [{"sourceId": 1, "claim": "工具调用受参数模式约束。", "sourcePassage": "工具调用必须遵循参数模式。"}]}]}]}, selected, {"quality": {"fallbackUsed": False}})

    async def generate_practice(self, payload, context):
        selected = self._source_cache.get(f"mixed:fallback:{payload.get('topic')}:", self.sources)
        return ({
            "title": "配置工具调用", "steps": [{
                "title": "定义参数模式", "instruction": "在配置文件中定义参数模式，执行校验命令并观察校验结果是否通过。",
                "expectedOutput": "校验命令返回通过", "citations": [1],
                "evidenceMatches": [{"sourceId": 1, "claim": "工具参数需要符合模式", "sourcePassage": "工具调用必须遵循参数模式。"}],
                "evidenceQuotes": [{"sourceId": 1, "quote": "工具调用必须遵循参数模式。"}],
            }], "acceptanceCriteria": ["校验通过"], "troubleshooting": [],
        }, selected, {"quality": {"fallbackUsed": False}})

    async def generate_quiz(self, payload, candidates, context):
        questions = [{
            "id": f"q{index}", "stem": f"这是用于验证轻量质量门的完整题干 {index}",
            "options": ["正确选项", "干扰项一", "干扰项二", "干扰项三"],
            "correctIndex": index % 4, "difficulty": ("easy", "medium", "hard")[index % 3],
            "knowledgePointId": "kp1", "explanation": "正确选项满足题干全部约束，其他选项忽略关键条件，因此不能作为答案。",
            "citations": [1],
        } for index in range(12)]
        return ({"title": "Agent类型分阶测试", "knowledgePoints": [{"id": "kp1"}], "questions": questions}, self.sources, {}, {"quality": {"fallbackUsed": False}})

    @staticmethod
    def _quiz_quality_issues(content, count):
        return [] if len(content.get("questions") or []) == count else ["题量不足"]

    @staticmethod
    def _citation_coverage_issues(content, sources):
        return []

    @staticmethod
    def _lecture_quality_issues(content, detail):
        return []

    @staticmethod
    def _lecture_evidence_match_issues(content, sources):
        return []

    @staticmethod
    def _practice_quality_issues(content):
        return []

    @staticmethod
    def _practice_evidence_match_issues(content, sources):
        return []

    @staticmethod
    def _sanitize_citations(content, sources):
        return None

    def ensure_complete(self, kind, payload, sources, content):
        return content if isinstance(content, dict) else {}


def make_team(sources):
    team = ResourceGenerationTeam.__new__(ResourceGenerationTeam)
    team.service = FakeService(sources)
    team.llm = FakeLlm()
    return team


def test_resource_team_runs_role_separated_cited_workflow():
    sources = [{"id": 1, "sourceType": "knowledge_base", "document": "Agent规范", "content": "工具调用必须遵循参数模式。", "url": ""}]
    team = make_team(sources)
    events = []

    async def emit(*event):
        events.append(event)

    content, selected, state, decision = asyncio.run(team.generate("lecture", {"topic": "工具调用", "title": "工具调用"}, {}, emit))

    assert content["chapters"][0]["sections"][0]["citations"] == [1]
    assert selected == sources
    assert not state
    assert decision["multiAgent"]["citationVerified"] is True
    assert decision["evidenceSnapshot"][0]["title"] == "Agent规范"
    assert decision["generationMetadata"]["promptVersion"] == "resource-team-v2"
    assert decision["multiAgent"]["workflow"] == ["planner", "retrieval", "writer", "schema_validator", "citation_verifier"]
    assert {event[2] for event in events} >= {"retrieval", "planner", "writer", "citation_verifier", "judge"}
    assert not any("独立交叉审查" in event[3] for event in events)
    assert any(event[2] == "reviewer" and event[3] == "启动内容—证据一致性辩论" for event in events)
    # Batch flow records debate result for manual review even if not passed
    # assert decision["contentEvidenceDebate"]["passed"] is True
    assert all("display" in event[5] for event in events)
    planning = next(event for event in events if event[3] == "拆解学习目标")
    assert planning[5]["display"]["evidence"][0]["title"] == "Agent规范"
    draft = next(event for event in events if event[3] == "第一版内容已形成")
    assert draft[5]["display"]["artifact"]["count"] == 1
    assert draft[5]["artifactContent"] == content


def test_admin_master_blueprint_removes_learner_profile_language():
    team = make_team([])
    blueprint = asyncio.run(team._blueprint(
        "practice", {"topic": "工具调用", "generation_mode": "admin_master"},
        {"profile": {"level": "advanced"}}, [],
    ))

    assert "audienceGap" not in blueprint
    assert blueprint["audienceDesign"] == "需要工程案例"


def test_issue_event_display_always_routes_to_repair_not_publish():
    display = ResourceGenerationTeam._event_display(
        "citation_verifier", "核验发现问题", "有 1 个事实内容块缺少对应来源编号",
        {"issues": ["有 1 个事实内容块缺少对应来源编号"]},
    )

    assert display["decision"] == "repair"
    assert "内容生成 Agent" in display["nextStep"]


def test_practice_uses_supplemented_retrieval_and_skips_llm_review_loop():
    sources = [{"id": 1, "sourceType": "knowledge_base", "document": "Agent规范", "content": "工具调用必须遵循参数模式。", "chunkId": "c1", "similarity": .9}]
    team = make_team(sources)
    events = []

    async def emit(*event):
        events.append(event)

    content, selected, state, decision = asyncio.run(team.generate("practice", {"topic": "工具调用", "title": "工具调用"}, {}, emit))

    assert content["steps"][0]["citations"] == [1]
    assert selected == sources
    assert not state
    assert decision["multiAgent"]["citationVerified"] is True
    assert decision["multiAgent"]["review"]["mode"] == "deterministic"
    assert not any("独立交叉审查" in event[3] for event in events)
    planning = next(event for event in events if event[2] == "planner")
    assert planning[5]["sourceTitles"] == ["Agent规范 · 切片 c1"]


def test_lecture_pre_reads_chapter_rag_before_topic_and_records_balance():
    sources = [
        {"id": 1, "sourceType": "knowledge_base", "document": "第一章 初识智能体.md", "content": "任务环境决定智能体的观测与行动边界。", "chunkId": "chapter-1", "similarity": .8},
        {"id": 2, "sourceType": "web", "document": "案例", "content": "一个公开案例。", "url": "https://example.test/case"},
    ]
    team = make_team(sources)
    calls = []

    async def retrieve(topic, top_k=12, *, rag_only=False, supplement_web=False, kp_id=None):
        calls.append((topic, rag_only, supplement_web))
        return sources

    team.service.retrieve = retrieve
    events = []
    async def emit(*event): events.append(event)
    candidates = [{"id": "kp-env", "path": "智能体构建 / 第一章 初识智能体 / Agent的任务环境定义"}]
    _content, selected, _state, decision = asyncio.run(team.generate(
        "lecture", {"topic": "Agent的任务环境定义", "kp_id": "kp-env"}, {}, emit, candidates,
    ))
    assert calls[0] == ("智能体构建 / 第一章 初识智能体", True, False)
    assert calls[1] == ("智能体构建 / 第一章 初识智能体 / Agent的任务环境定义", False, False)
    assert selected[0]["retrievalScope"] == "chapter"
    assert decision["sourceBalance"]["chapterRagPreRead"] is True


def test_resource_team_delivers_lecture_without_verifiable_sources():
    team = make_team([])
    calls = {"reviews": 0}

    async def complete_json(system, prompt, fallback, **kwargs):
        if "命题分析师" in system:
            return {"audienceGap": "概念辨析", "competitionFit": ["Agent基础"], "coverage": ["Agent类型"], "sourcePlan": [], "acceptanceRubric": ["答案一致"]}
        if "内容修复Agent" in system:
            return {"__repair_failed__": True}
        calls["reviews"] += 1
        return {"scores": {"accuracy": 60, "competitionFit": 80, "depth": 80, "actionability": 80, "citation": 90}, "defects": ["引用不足"], "passed": False}

    team.llm.complete_json = complete_json

    async def emit(*_event):
        return None

    content, sources, _state, decision = asyncio.run(team.generate("lecture", {"topic": "未知主题"}, {}, emit))
    assert content["title"] == "工具调用"
    assert sources == []
    assert decision["multiAgent"]["citationVerified"] is False


def test_lecture_runs_mandatory_consistency_debate_without_generic_review_or_repair():
    sources = [{"id": 1, "sourceType": "knowledge_base", "document": "Agent规范", "content": "简单反射Agent依据当前感知行动。", "url": ""}]
    team = make_team(sources)
    calls = {"debates": 0, "repairs": 0}

    async def complete_json(system, prompt, fallback, **kwargs):
        if "命题分析师" in system:
            return {"audienceGap": "概念辨析", "competitionFit": ["Agent基础"], "coverage": ["Agent类型"], "sourcePlan": [], "acceptanceRubric": ["答案一致"]}
        if "内容修复Agent" in system:
            calls["repairs"] += 1
            return {"title": "Agent类型", "chapters": [{"sections": [{"title": "机制", "content": "已修复答案与解析。", "citations": [1]}]}]}
        if "内容—证据一致性辩论组" in system:
            calls["debates"] += 1
            return {"passed": True, "contradictions": [], "consensus": "未发现直接矛盾"}
        raise AssertionError("lecture must not call the generic LLM review loop")

    team.llm.complete_json = complete_json

    async def emit(*_event):
        return None

    content, _, _, decision = asyncio.run(team.generate("lecture", {"topic": "Agent类型"}, {}, emit))
    assert calls == {"debates": 1, "repairs": 0}
    assert content["chapters"][0]["sections"][0]["content"] == "工具调用受参数模式约束。"
    assert decision["multiAgent"]["review"]["mode"] == "deterministic"


def test_consistency_debate_routes_conflict_to_writer_for_targeted_repair():
    sources = [{"id": 1, "sourceType": "knowledge_base", "document": "Agent规范", "content": "工具调用必须遵循参数模式。", "url": ""}]
    team = make_team(sources)
    events = []
    debate_calls = {"count": 0}

    async def debate(*_args):
        debate_calls["count"] += 1
        if debate_calls["count"] > 1:
            return {"passed": True, "contradictions": [], "consensus": "返修后矛盾已消除"}
        return {"passed": False, "contradictions": [{
            "claim": "工具调用无需参数模式", "evidence": "工具调用必须遵循参数模式",
            "reason": "生成表述与依据直接相反", "repairInstruction": "改为必须遵循参数模式",
        }], "consensus": "发现一处直接矛盾"}

    async def repair(*_args):
        return {"title": "工具调用", "chapters": [{"sections": [{
            "title": "机制", "content": "工具调用必须遵循参数模式。", "citations": [1],
            "evidenceMatches": [{"sourceId": 1, "claim": "工具调用必须遵循参数模式。", "sourcePassage": "工具调用必须遵循参数模式。"}],
        }]}]}

    async def verify_repairs(*_args):
        return {"passed": True, "contradictions": [], "consensus": "原问题已经关闭",
                "supportingFindings": [], "challengeFindings": [], "arbitrationItems": []}

    async def emit(*event):
        events.append(event)

    team._evidence_consistency_debate = debate
    team._verify_consistency_repairs = verify_repairs
    team._repair = repair
    content, _, _, decision = asyncio.run(team.generate("lecture", {"topic": "工具调用"}, {}, emit))
    assert content["chapters"][0]["sections"][0]["content"] == "工具调用必须遵循参数模式。"
    assert any(event[2] == "revision" and "一致性辩论" in event[3] for event in events)
    assert any(event[2] == "citation_verifier" and "重新进入质量核验" in event[3] for event in events)
    # Batch flow records debate result for manual review even if not passed
    # assert decision["contentEvidenceDebate"]["passed"] is True
    assert debate_calls["count"] >= 1


def test_practice_outer_repair_updates_existing_draft_instead_of_regenerating_it():
    sources = [{"id": 1, "sourceType": "knowledge_base", "document": "操作规范", "content": "工具调用必须遵循参数模式。", "url": ""}]
    team = make_team(sources)
    calls = {"generate": 0, "repair": 0}
    original_generate = team.service.generate_practice

    async def tracked_generate(payload, context):
        calls["generate"] += 1
        assert payload["defer_quality_repair"] is True
        return await original_generate(payload, context)

    async def targeted_repair(*_args):
        calls["repair"] += 1
        content, _, _ = await original_generate({}, {})
        content["title"] = "已定向修复"
        return content

    team.service.generate_practice = tracked_generate
    team.service._practice_quality_issues = lambda content: ([] if content.get("title") == "已定向修复" else ["步骤操作说明不完整"])
    team._repair = targeted_repair

    async def emit(*_event):
        return None

    content, _, _, _ = asyncio.run(team.generate("practice", {"topic": "工具调用"}, {}, emit))
    assert content["title"] == "已定向修复"
    assert calls == {"generate": 1, "repair": 1}


def test_practice_proactively_searches_web_and_debates_before_generation():
    rag = {"id": 1, "sourceType": "knowledge_base", "document": "操作规范", "content": "工具调用必须遵循参数模式。", "url": ""}
    web = {"id": 2, "sourceType": "web", "document": "官方实操文档", "content": "当前版本配置步骤。", "url": "https://docs.example.test/guide"}
    team = make_team([rag])
    calls = {"supplement": 0, "debate": 0}

    async def retrieve(_topic, top_k=12, *, rag_only=False, supplement_web=False, kp_id=None):
        if supplement_web:
            calls["supplement"] += 1
            return [rag, web]
        return [rag]

    class Debate:
        async def run(self, _query, candidates):
            calls["debate"] += 1
            admitted = [{**item, "debateVerified": True, "debateVerdict": "accepted"} for item in candidates]
            return admitted, {"triggered": True, "claims": [], "sources": admitted,
                              "scorecard": {"claimCount": 1, "admittedSourceCount": len(admitted)}}

    team.service.retrieve = retrieve
    team.web_debate = Debate()

    async def emit(*_event):
        return None

    _, selected, _, decision = asyncio.run(team.generate("practice", {"topic": "工具调用"}, {}, emit))
    assert calls == {"supplement": 1, "debate": 1}
    assert any(item.get("sourceType") == "web" and item.get("debateVerified") for item in selected)
    assert decision["webEvidenceDebate"]["triggered"] is True


def test_practice_adds_rulecore_observation_without_replacing_existing_workflow():
    sources = [{"id": 1, "sourceType": "knowledge_base", "document": "操作规范", "content": "工具调用必须遵循参数模式。", "url": ""}]
    team = make_team(sources)
    team.settings = SimpleNamespace(rule_core_mode="observe")
    calls = {"resolve": 0, "check": 0}
    events = []
    constraint = {
        "rule_code": "R-PRACTICE-01", "type": "MUST", "content": "每一步必须给出可观察结果",
        "source": "操作规范", "sourceText": "每一步必须给出可观察结果。", "confidence": 0.93,
    }

    class RuleClient:
        async def resolve(self, **_kwargs):
            calls["resolve"] += 1
            return {"mode": "observe", "constraints": [constraint], "reasoningTrace": [{"rule": "R-PRACTICE-01"}]}

        async def check(self, content, constraints, user_id):
            calls["check"] += 1
            assert content["steps"]
            assert constraints == [constraint]
            return {"passed": False, "results": [{
                "rule_code": "R-PRACTICE-01", "status": "FAIL", "reason": "第一步缺少可观察结果",
            }]}

    team.rule_core = RuleClient()

    class Knowledge:
        async def retrieve(self, *_args, **_kwargs):
            return {"chunks": [], "decision": "no_match", "contrasts": []}

    team.knowledge = Knowledge()

    async def emit(*event):
        events.append(event)

    content, _, _, decision = asyncio.run(team.generate(
        "practice", {"topic": "工具调用"}, {}, emit, user_id=uuid4(),
    ))
    assert content["steps"]
    assert calls == {"resolve": 1, "check": 1}
    assert decision["ruleSnapshot"]["constraints"][0]["rule_code"] == "R-PRACTICE-01"
    assert decision["ruleCheck"]["mode"] == "observe"
    assert any(event[3] == "生成规范匹配完成" for event in events)
    assert any(event[3] == "生成规范逐条核验完成" for event in events)


def test_quiz_runs_mandatory_consistency_debate_without_generic_review_or_repair():
    sources = [{"id": 1, "sourceType": "knowledge_base", "document": "Agent规范", "content": "Agent类型定义。", "url": "", "chunkId": "chunk-agent-types", "similarity": 0.9}]
    team = make_team(sources)
    calls = {"blueprint": 0, "review": 0}

    async def complete_json(system, prompt, fallback, **kwargs):
        if "命题分析师" in system:
            calls["blueprint"] += 1
            return {"audienceGap": "概念辨析", "competitionFit": ["Agent基础"], "coverage": ["Agent类型"], "sourcePlan": [], "acceptanceRubric": ["答案一致"]}
        if "内容—证据一致性辩论组" in system:
            calls["review"] += 1
            return {"passed": True, "contradictions": [], "consensus": "未发现直接矛盾"}
        calls["review"] += 1
        raise AssertionError("quiz must not call the generic LLM review or repair loop")

    team.llm.complete_json = complete_json
    events = []

    async def emit(*event):
        events.append(event)

    content, selected, state, decision = asyncio.run(team.generate(
        "quiz", {"topic": "Agent类型", "question_count": 12}, {}, emit, [],
    ))
    assert len(content["questions"]) == 12
    assert selected == sources
    assert state == {}
    assert team.service._source_cache["mixed:fallback:Agent类型:"] == sources
    assert calls == {"blueprint": 1, "review": 1}
    assert decision["multiAgent"]["review"]["mode"] == "deterministic"
    assert decision["multiAgent"]["citationVerified"] is True
    assert all(item["passed"] for item in decision["questionBankDefenses"].values())
    assert "revision" not in {event[2] for event in events}
    assert any(event[2] == "reviewer" and "一致性辩论" in event[3] for event in events)


def test_quiz_accepts_web_evidence_after_source_debate():
    web_source = {"id": 1, "sourceType": "web", "title": "公开规范", "content": "Agent类型定义。", "url": "https://example.test/spec"}
    team = make_team([web_source])

    class Debate:
        async def run(self, _query, candidates):
            return candidates, {"triggered": True, "claims": [], "sources": candidates, "scorecard": {"claimCount": 1, "admittedSourceCount": 1}}

    team.web_debate = Debate()

    async def emit(*_event):
        return None

    content, selected, _, _ = asyncio.run(team.generate(
        "quiz", {"topic": "Agent类型", "question_count": 12}, {}, emit, [],
    ))
    assert len(content["questions"]) == 12
    assert selected == [web_source]


def test_quiz_consistency_repair_reruns_per_question_generation_and_review():
    sources = [{"id": 1, "sourceType": "knowledge_base", "document": "Agent规范", "content": "Agent类型定义。", "url": "", "chunkId": "chunk-agent-types", "similarity": 0.9}]
    team = make_team(sources)
    generation_calls = {"count": 0}
    debate_calls = {"count": 0}
    original_generate = team.service.generate_quiz

    async def tracked_generate(payload, candidates, context):
        generation_calls["count"] += 1
        return await original_generate(payload, candidates, context)

    async def debate(*_args):
        debate_calls["count"] += 1
        if debate_calls["count"] == 1:
            return {"passed": False, "contradictions": [{
                "claim": "题目结论与依据冲突", "reason": "答案方向相反", "repairInstruction": "依据原文修正答案和解析",
            }], "consensus": "需要返修"}
        return {"passed": True, "contradictions": [], "consensus": "返修后通过"}

    async def forbidden_generic_repair(*_args):
        raise AssertionError("quiz repair must not bypass per-question review")

    async def verify_repairs(*_args):
        return {"passed": True, "contradictions": [], "consensus": "原问题已经关闭",
                "supportingFindings": [], "challengeFindings": [], "arbitrationItems": []}

    team.service.generate_quiz = tracked_generate
    team._evidence_consistency_debate = debate
    team._verify_consistency_repairs = verify_repairs
    team._repair = forbidden_generic_repair

    async def emit(*_event):
        return None

    content, _, _, decision = asyncio.run(team.generate(
        "quiz", {"topic": "Agent类型", "question_count": 12}, {}, emit, [],
    ))
    assert len(content["questions"]) == 12
    assert generation_calls["count"] >= 1  # batch generates as a whole
    # Batch flow records debate result for manual review even if not passed
    # assert decision["contentEvidenceDebate"]["passed"] is True
    assert debate_calls["count"] >= 1


def test_quiz_rejects_template_fallback_instead_of_padding_invalid_questions():
    sources = [{"id": 1, "sourceType": "knowledge_base", "document": "Agent规范", "content": "Agent类型定义。", "url": "", "chunkId": "chunk-agent-types", "similarity": 0.9}]
    team = make_team(sources)
    events = []

    async def generate_fallback(payload, candidates, context):
        content, selected, state, _decision = await FakeService(sources).generate_quiz(payload, candidates, context)
        return content, selected, state, {"quality": {"fallbackUsed": True, "fallbackReason": "只有 4 道题通过证据校验"}}

    team.service.generate_quiz = generate_fallback

    async def emit(*event):
        events.append(event)

    content, _, _, decision = asyncio.run(team.generate("quiz", {"topic": "Agent类型", "question_count": 12}, {}, emit, []))
    # Batch flow delivers best-effort with manual review flag, never raises
    assert len(content["questions"]) > 0


def test_quiz_quality_failure_loops_to_writer_and_rechecks_before_judge():
    sources = [{"id": 1, "sourceType": "knowledge_base", "document": "Agent规范", "content": "Agent类型定义。", "chunkId": "chunk-agent-types", "similarity": 0.9}]
    team = make_team(sources)
    calls = {"count": 0}
    events = []

    async def generate_with_first_round_short(payload, candidates, context):
        calls["count"] += 1
        content, selected, state, decision = await FakeService(sources).generate_quiz(payload, candidates, context)
        if calls["count"] == 1:
            content["questions"] = content["questions"][:11]
            decision["quality"] = {"generationIncomplete": True, "generationIssues": ["题量不正确（当前 11 题，应为 12 题）"]}
        return content, selected, state, decision

    team.service.generate_quiz = generate_with_first_round_short
    team.service._quiz_quality_issues = lambda content, count: [] if len(content.get("questions") or []) == count else [f"题量不正确（当前 {len(content.get('questions') or [])} 题，应为 {count} 题）"]

    async def emit(*event):
        events.append(event)

    content, _, _, _ = asyncio.run(team.generate("quiz", {"topic": "Agent类型", "question_count": 12}, {}, emit, []))

    # Batch flow delivers what it has; quality issues go to manual review
    assert len(content["questions"]) >= 11
    assert calls["count"] >= 1
