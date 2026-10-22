import asyncio

from app.services.course_outline_planner import CourseOutlinePlanner
from app.tools.base import tool_registry


class FakeTool:
    def __init__(self, tool_id, result):
        self.id = tool_id
        self.available = True
        self.result = result
        self.calls = []

    async def execute(self, params):
        self.calls.append(params)
        return self.result


class FakeLlm:
    def __init__(self, plan):
        self.plan = plan
        self.prompt = ""
        self.kwargs = {}

    async def complete_json(self, **kwargs):
        self.kwargs = kwargs
        self.prompt = kwargs["prompt"]
        return self.plan


def test_course_planner_uses_rag_and_web_and_keeps_sections(monkeypatch):
    rag = FakeTool("rag_search", {"success": True, "chunks": [{"document": "教材", "content": "先学感知，再学规划", "similarity": .8}]})
    web = FakeTool("web_search", {"success": True, "results": [{"title": "官方指南", "url": "https://example.test", "content": "工具调用与评测"}]})
    original_get = tool_registry.get
    monkeypatch.setattr(tool_registry, "get", lambda name: {"rag_search": rag, "web_search": web}.get(name) or original_get(name))
    chapters = [{"title": f"章节{i}", "summary": f"摘要{i}", "objectives": ["理解", "应用"], "sections": [{"title": f"{i}.1 概念", "summary": "定义", "keyTopics": ["概念"]}, {"title": f"{i}.2 原理", "summary": "机制", "keyTopics": ["原理"]}, {"title": f"{i}.3 实践", "summary": "案例", "keyTopics": ["实践"]}]} for i in range(1, 5)]
    llm = FakeLlm({"title": "智能体课程", "description": "系统学习", "chapters": chapters})
    plan, evidence, tools = asyncio.run(CourseOutlinePlanner(llm).plan({"goal": {"title": "智能体"}}, 4, "systematic", "包含代码"))
    assert tools == ["rag_search", "web_search"]
    assert len(evidence) == 2
    assert len(plan["chapters"]) == 4
    assert all(len(chapter["sections"]) == 3 for chapter in plan["chapters"])
    assert "RAG与网页检索证据" in llm.prompt
    assert llm.kwargs["thinking"] is False
    assert llm.kwargs["max_tokens"] == 3000
    assert rag.calls[0]["top_k"] == 8
    assert web.calls[0]["limit"] == 8


def test_course_planner_repairs_missing_and_duplicate_structure():
    fallback = CourseOutlinePlanner._fallback({"goal": {"title": "数据结构"}}, 4)
    plan = CourseOutlinePlanner._normalize({"title": "课程", "chapters": [{"title": "线性表", "sections": []}, {"title": "线性表", "sections": []}]}, fallback, 4)
    assert len(plan["chapters"]) == 4
    assert len({chapter["title"] for chapter in plan["chapters"]}) == 4
    assert all(3 <= len(chapter["sections"]) <= 6 for chapter in plan["chapters"])


def test_course_planner_times_out_to_valid_outline(monkeypatch):
    class SlowLlm:
        async def complete_json(self, **_kwargs):
            await asyncio.sleep(.1)

    monkeypatch.setattr(CourseOutlinePlanner, "PLANNING_TIMEOUT_SECONDS", .01)
    monkeypatch.setattr(CourseOutlinePlanner, "_retrieve", lambda self, query: asyncio.sleep(0, result=([], [])))
    plan, _, _ = asyncio.run(CourseOutlinePlanner(SlowLlm()).plan({"goal": {"title": "智能体"}}, 6, "systematic", ""))
    assert len(plan["chapters"]) == 6
    assert all(len(chapter["sections"]) == 3 for chapter in plan["chapters"])
def test_clean_title_strips_numbering_prefixes():
    from app.services.course_outline_planner import clean_title
    assert clean_title("第六章：多智能体协作与框架开发实践") == "多智能体协作与框架开发实践"
    assert clean_title("第8章 复盘与综合评测") == "复盘与综合评测"
    assert clean_title("第 十二 讲 - ReAct循环") == "ReAct循环"
    assert clean_title("Chapter 3: Memory") == "Memory"
    assert clean_title("ReAct循环机制") == "ReAct循环机制"
    assert clean_title("") == ""
    assert clean_title(None) == ""


def test_normalize_cleans_model_numbered_titles():
    fallback = CourseOutlinePlanner._fallback({"goal": {"title": "智能体"}}, 2)
    plan = CourseOutlinePlanner._normalize(
        {"title": "课程", "chapters": [
            {"title": "第一章：基础概念", "summary": "s",
             "sections": [{"title": "1.1 概念", "summary": "a", "keyTopics": ["概念"]},
                          {"title": "第2节 原理", "summary": "b", "keyTopics": ["原理"]},
                          {"title": "实践", "summary": "c", "keyTopics": ["实践"]}]},
        ]},
        fallback, 2,
    )
    assert plan["chapters"][0]["title"] == "基础概念"
    section_titles = [section["title"] for section in plan["chapters"][0]["sections"]]
    assert "原理" in section_titles


def test_fallback_uses_concrete_summaries():
    fallback = CourseOutlinePlanner._fallback({"goal": {"title": "智能体"}}, 8)
    assert fallback["title"] == "智能体课程"
    summaries = [chapter["summary"] for chapter in fallback["chapters"]]
    assert not any("建立第" in summary and "阶段的系统能力" in summary for summary in summaries)
    assert all(summary for summary in summaries)
def test_fallback_shortens_long_goal_titles():
    fallback = CourseOutlinePlanner._fallback({"goal": {"title": "大模型智能体工程：从原理到独立项目开发"}}, 4)
    assert fallback["title"] == "大模型智能体工程"
    assert "：从原理" not in fallback["chapters"][0]["summary"]
    assert all("从原理到独立项目开发" not in chapter["summary"] for chapter in fallback["chapters"])
def _three_section_chapter(title):
    return {"title": title, "summary": "s", "sections": [
        {"title": f"{title}a", "summary": "s", "keyTopics": ["a"]},
        {"title": f"{title}b", "summary": "s", "keyTopics": ["b"]},
        {"title": f"{title}c", "summary": "s", "keyTopics": ["c"]},
    ]}


def test_normalize_respects_chapter_range():
    fallback = CourseOutlinePlanner._fallback({"goal": {"title": "智能体"}}, 6)
    plan = CourseOutlinePlanner._normalize(
        {"title": "课程", "chapters": [_three_section_chapter(f"章{i}") for i in range(1, 10)]},
        fallback, 6, (5, 8),
    )
    assert len(plan["chapters"]) == 8


def test_normalize_pads_to_range_minimum():
    fallback = CourseOutlinePlanner._fallback({"goal": {"title": "智能体"}}, 6)
    plan = CourseOutlinePlanner._normalize(
        {"title": "课程", "chapters": [_three_section_chapter("唯一章")]},
        fallback, 6, (5, 8),
    )
    assert len(plan["chapters"]) == 5


def test_plan_prompt_uses_chapter_range(monkeypatch):
    monkeypatch.setattr(CourseOutlinePlanner, "_retrieve", lambda self, query: asyncio.sleep(0, result=([], [])))
    llm = FakeLlm({"title": "课程", "chapters": []})
    asyncio.run(CourseOutlinePlanner(llm).plan({"goal": {"title": "智能体"}}, 6, "systematic", "", (5, 8)))
    assert "5-8" in llm.prompt
    assert "必须生成" not in llm.prompt
