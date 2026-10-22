from abc import ABC, abstractmethod

from app.domain.models import WorkflowState
from app.llm import LLMClient


class BaseAgent(ABC):
    agent_id: str
    name: str

    def __init__(self, llm: LLMClient):
        self.llm = llm

    @abstractmethod
    async def process(self, state: WorkflowState) -> None:
        raise NotImplementedError
