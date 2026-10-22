"""Tests for the multi-agent cited response pipeline."""
import asyncio

from app.services.multi_agent_orchestrator import MultiAgentOrchestrator


class FakeLLM:
    """Deterministic mock of LLMClient for pipeline tests.

    关键点：模拟"原文片段提取器"输出带偏移量的 snippet，但 content 可以是错的
    （模拟 LLM 幻觉）。后端会按偏移量强制从原文切片，输出仍是 100% 原文。
    """

    def __init__(
        self,
        plan=None,
        snippets_by_outline=None,
        compose_text="",
    ):
        self.plan = plan if plan is not None else {
            "outline": [
                {"point": "核心定义", "source_ids": [1]},
                {"point": "关键数据", "source_ids": [2]},
            ]
        }
        # snippets_by_outline: {outline_index: [{source_id, start, end}]}
        self.snippets_by_outline = snippets_by_outline
        self.compose_text = compose_text
        self.plan_calls = 0
        self.extract_calls = 0

    async def complete_json(self, system, prompt, fallback, reasoning_effort=None,
                            provider="", max_retries=None, max_tokens=None):
        if "结构设计师" in system or "outline" in prompt:
            self.plan_calls += 1
            return self.plan
        if "片段提取器" in system or "snippets" in prompt or "原文" in prompt:
            self.extract_calls += 1
            # 根据当前调用次数返回对应 outline 的 snippets
            idx = self.extract_calls - 1
            if self.snippets_by_outline and idx in self.snippets_by_outline:
                return {"snippets": self.snippets_by_outline[idx]}
            # 默认：从每条来源切一段（offset 0~80）
            return {"snippets": [{"source_id": 1, "start": 0, "end": 80}]}
        return fallback

    async def stream_chat(self, messages, include_reasoning=False, provider="kimi",
                          max_tokens_override=None, thinking=None):
        return
        yield  # 永远不会执行（compositor 不再调 stream_chat）


def make_sources():
    return [
        {"id": 1, "type": "rag", "document": "docA",
         "content": "AgentScope 中的 Tool 组件封装了智能体与外部世界交互的能力，提供了工具箱与 MCP 客户端等多种形式。"},
        {"id": 2, "type": "rag", "document": "docB",
         "content": "测试覆盖率提升 40%，训练效率提升 3 倍，推理速度提升 2 倍。"},
    ]


async def collect(generator):
    events = []
    async for event in generator:
        events.append(event)
    return events


def test_generate_success_emits_agent_events_and_streaming_content():
    orch = MultiAgentOrchestrator(FakeLLM(), provider="mock")
    events = asyncio.run(collect(orch.generate("什么是 X？", make_sources())))

    types = [e["type"] for e in events]
    assert "agent_started" in types and "agent_completed" in types
    # 必须产出流式 content
    contents = [e["text"] for e in events if e["type"] == "content"]
    assert contents, "管线成功时应产出 content"
    # 流式：应当有多个 content chunk，而不是合成一个
    assert len(contents) >= 3, f"应当流式产出多块，实际 {len(contents)} 块"
    # 拼接后应包含原文片段（不能是 LLM 自由发挥）
    full = "".join(contents)
    assert "AgentScope" in full or "Tool 组件" in full, "应包含原文片段"
    # phase 顺序：plan → extract → compose
    phases = [e["phase"] for e in events if e["type"] == "phase"]
    assert phases == ["plan", "extract", "compose"]
    # planner 输出含要点
    planner_done = next(e for e in events if e["type"] == "agent_completed" and e["agent"] == "planner")
    assert planner_done["success"] is True
    assert "核心定义" in planner_done["output"]


def test_generate_empty_sources_returns_early():
    orch = MultiAgentOrchestrator(FakeLLM(), provider="mock")
    events = asyncio.run(collect(orch.generate("问题", [])))
    assert not [e for e in events if e["type"] == "content"]


def test_generate_falls_back_when_plan_empty():
    orch = MultiAgentOrchestrator(FakeLLM(plan={"outline": []}), provider="mock")
    events = asyncio.run(collect(orch.generate("问题", make_sources())))
    assert not [e for e in events if e["type"] == "content"]
    planner_done = next(e for e in events if e["type"] == "agent_completed" and e["agent"] == "planner")
    assert planner_done["success"] is False


def test_generate_falls_back_when_compose_empty():
    llm = FakeLLM()
    llm.snippets_by_outline = {0: [], 1: []}
    orch = MultiAgentOrchestrator(llm, provider="mock")
    events = asyncio.run(collect(orch.generate("问题", make_sources())))
    assert not [e for e in events if e["type"] == "content"]
    composer_done = next(e for e in events if e["type"] == "agent_completed" and e["agent"] == "composer")
    assert composer_done["success"] is False


def test_extract_uses_real_text_via_offset_not_llm_generation():
    """核心保证：LLM 幻觉 text 字段不影响输出，后端按偏移量切片原文。"""
    sources = [
        {"id": 1, "type": "rag", "document": "docA",
         "content": "ABCDEF" * 20},  # 120 字
    ]
    llm = FakeLLM()
    llm.snippets_by_outline = {0: [{"source_id": 1, "start": 10, "end": 70}]}
    orch = MultiAgentOrchestrator(llm, provider="mock")
    events = asyncio.run(collect(orch.generate("问题", sources)))
    full = "".join(e["text"] for e in events if e["type"] == "content")
    assert sources[0]["content"][10:70] in full


def test_extract_falls_back_when_no_relevant_sources():
    """某个要点绑定的 source_ids 在 sources 中找不到 → 该要点产出空（不卡住管线）。"""
    llm = FakeLLM()
    llm.plan = {"outline": [{"point": "无来源要点", "source_ids": [99]}]}
    orch = MultiAgentOrchestrator(llm, provider="mock")
    events = asyncio.run(collect(orch.generate("问题", make_sources())))
    assert not [e for e in events if e["type"] == "content"]


def test_extract_failure_reports_failed_but_compose_falls_back():
    class FailingExtractLLM(FakeLLM):
        async def complete_json(self, system, prompt, fallback, **kw):
            if "片段提取器" in system or "snippets" in prompt:
                raise RuntimeError("LLM 不可用")
            return self.plan

    orch = MultiAgentOrchestrator(FailingExtractLLM(), provider="mock")
    events = asyncio.run(collect(orch.generate("问题", make_sources())))
    # 全部失败 → 无 content → 调用方回退
    assert not [e for e in events if e["type"] == "content"]