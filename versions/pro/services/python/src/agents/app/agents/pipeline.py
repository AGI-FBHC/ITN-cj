import json

from app.agents.base import BaseAgent
from app.domain.models import WorkflowState


class DiagnosisAgent(BaseAgent):
    agent_id, name = "diagnosis", "学情诊断"

    async def process(self, state: WorkflowState) -> None:
        fallback = {
            "summary": "根据用户画像和当前目标生成初始诊断",
            "strengths": state.profile.get("strengths", []),
            "weaknesses": state.profile.get("weaknesses", []),
            "suggestedDifficulty": state.profile.get("initialLevel", "ELEMENTARY"),
            "learningPreference": state.profile.get("learningPreference"),
        }
        result = await self.llm.complete_json(
            "你是学情诊断专家，只返回 JSON。",
            f"学习目标：{state.content}\n用户画像：{json.dumps(state.profile, ensure_ascii=False)}",
            fallback,
        )
        state.diagnosis = {**fallback, **result}


class TaskAgent(BaseAgent):
    agent_id, name = "task", "任务拆解"

    async def process(self, state: WorkflowState) -> None:
        fallback = {
            "skills": [
                {"order": 1, "name": "基础概念", "difficulty": "ELEMENTARY"},
                {"order": 2, "name": "核心实践", "difficulty": "PROFICIENT"},
                {"order": 3, "name": "综合评估", "difficulty": "PROFICIENT"},
            ]
        }
        result = await self.llm.complete_json(
            "你是学习任务规划专家，只返回 JSON。",
            f"目标：{state.content}\n诊断：{json.dumps(state.diagnosis, ensure_ascii=False)}",
            fallback,
        )
        skills = result.get("skills")
        state.skill_sequence = (skills if isinstance(skills, list) and skills else fallback["skills"])[:20]


class RetrievalAgent(BaseAgent):
    agent_id, name = "retrieval", "知识检索"

    async def process(self, state: WorkflowState) -> None:
        supplied = state.input.get("evidence", [])
        state.evidence = [item for item in supplied if isinstance(item, dict)][:20]


class GenerationAgent(BaseAgent):
    agent_id, name = "generation", "内容生成"

    async def process(self, state: WorkflowState) -> None:
        fallback = {
            "lecture": {"title": state.content, "sections": [
                {"heading": skill.get("name", "学习内容"), "body": "围绕该知识点完成概念理解与示例练习。"}
                for skill in state.skill_sequence
            ]},
            "practice": {"title": "实操训练", "steps": [
                {"step": index + 1, "instruction": f"完成 {skill.get('name', '知识点')} 实践"}
                for index, skill in enumerate(state.skill_sequence)
            ]},
            "quiz": [{"question": "请总结本次学习的核心内容", "type": "OPEN_ENDED"}],
            "citations": state.evidence,
        }
        result = await self.llm.complete_json(
            "你是教学内容生成专家，只返回 JSON，引用必须来自提供的证据。",
            json.dumps({"goal": state.content, "diagnosis": state.diagnosis,
                        "skills": state.skill_sequence, "evidence": state.evidence}, ensure_ascii=False),
            fallback,
        )
        normalized = {
            key: result.get(key, default) if isinstance(result, dict) else default
            for key, default in fallback.items()
        }
        state.candidates = [normalized]


class ReviewAgent(BaseAgent):
    agent_id, name = "review", "质量审核"

    async def process(self, state: WorkflowState) -> None:
        candidate = state.candidates[0] if state.candidates else {}
        defects = []
        if not candidate.get("lecture"):
            defects.append({"severity": "CRITICAL", "message": "缺少讲义"})
        if not candidate.get("practice"):
            defects.append({"severity": "MAJOR", "message": "缺少实操内容"})
        if state.evidence and not candidate.get("citations"):
            defects.append({"severity": "MAJOR", "message": "缺少知识溯源"})
        state.defects = defects


class JudgeAgent(BaseAgent):
    agent_id, name = "judge", "最终裁决"

    async def process(self, state: WorkflowState) -> None:
        critical = any(item.get("severity") == "CRITICAL" for item in state.defects)
        state.risk_assessment = {
            "level": "HIGH" if critical else ("MEDIUM" if state.defects else "LOW"),
            "defects": state.defects,
        }
        state.final_content = None if critical else (state.candidates[0] if state.candidates else None)


def build_agents(llm):
    return [DiagnosisAgent(llm), TaskAgent(llm), RetrievalAgent(llm),
            GenerationAgent(llm), ReviewAgent(llm), JudgeAgent(llm)]
