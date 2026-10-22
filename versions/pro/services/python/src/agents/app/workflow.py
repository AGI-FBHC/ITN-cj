from collections.abc import AsyncIterator
import logging

from app.agents.pipeline import build_agents
from app.domain.models import AgentEvent, RunStatus, WorkflowState
from app.llm import LLMClient
from app.storage.run_repository import AgentRunRepository


logger = logging.getLogger(__name__)


class AgentWorkflow:
    def __init__(self, llm: LLMClient, repository: AgentRunRepository):
        self.agents = build_agents(llm)
        self.repository = repository

    async def stream(self, state: WorkflowState) -> AsyncIterator[AgentEvent]:
        state.status = RunStatus.RUNNING
        self.repository.create(state)
        sequence = 0
        start = AgentEvent(type="run_started", run_id=state.run_id, sequence=sequence,
                           data={"learningGoalId": str(state.learning_goal_id)})
        self.repository.save_event(start)
        yield start
        for agent in self.agents:
            sequence += 1
            thinking = AgentEvent(type="agent_started", run_id=state.run_id, sequence=sequence,
                                  agent=agent.agent_id, data={"name": agent.name})
            self.repository.save_event(thinking)
            yield thinking
            try:
                await agent.process(state)
                state.executed_agents.append(agent.agent_id)
                sequence += 1
                completed = AgentEvent(type="agent_completed", run_id=state.run_id, sequence=sequence,
                                       agent=agent.agent_id, data={"name": agent.name})
                self.repository.save_event(completed)
                yield completed
            except Exception as exc:
                logger.exception("Agent %s failed for run %s", agent.agent_id, state.run_id)
                state.errors.append({"agent": agent.agent_id, "code": "AGENT_EXECUTION_FAILED"})
                state.status = RunStatus.FAILED
                sequence += 1
                failed = AgentEvent(type="run_failed", run_id=state.run_id, sequence=sequence,
                                    agent=agent.agent_id, data={"code": "AGENT_EXECUTION_FAILED"})
                self.repository.save_event(failed)
                yield failed
                self.repository.finish(state)
                return
        state.status = RunStatus.COMPLETED
        sequence += 1
        done = AgentEvent(type="run_completed", run_id=state.run_id, sequence=sequence,
                          data={"result": state.final_content, "riskAssessment": state.risk_assessment})
        self.repository.save_event(done)
        self.repository.finish(state)
        yield done

    async def run(self, state: WorkflowState) -> WorkflowState:
        async for _ in self.stream(state):
            pass
        return state
