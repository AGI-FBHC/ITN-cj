import asyncio
from uuid import uuid4

from app.config import get_settings
from app.domain.models import RunStatus, WorkflowState
from app.llm import LLMClient
from app.storage.run_repository import AgentRunRepository
from app.workflow import AgentWorkflow


def test_six_agents_execute_in_order(tmp_path):
    async def execute():
        state = WorkflowState(user_id=uuid4(), learning_goal_id=uuid4(), content="学习 Python")
        engine = AgentWorkflow(LLMClient(get_settings()), AgentRunRepository(get_settings()))
        events = [event async for event in engine.stream(state)]
        return state, events

    state, events = asyncio.run(execute())
    assert state.status == RunStatus.COMPLETED
    assert state.executed_agents == ["diagnosis", "task", "retrieval", "generation", "review", "judge"]
    assert events[0].type == "run_started"
    assert events[-1].type == "run_completed"
    assert state.final_content is not None
