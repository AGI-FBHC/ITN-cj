"""AI 教研组服务：面向当前学习者执行真实五 Agent 协同链路。

P0 只做 SSE 实时输出，不伪造前端响应。运行记录落库放到 P1。
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from uuid import UUID, uuid4

from app.config import Settings
from app.domain.models import TeachingGroupRunRequest
from app.knowledge_retriever import KnowledgeRetriever
from app.llm import LLMClient
from app.services.evidence_search import EvidenceSearch
from app.storage.platform_db import PlatformDirectory

logger = logging.getLogger(__name__)

TEACHING_AGENTS = [
    {
        "id": "DIA-01",
        "name": "学情诊断 Agent",
        "status": "idle",
        "duty": "当前最该先补哪个知识点",
    },
    {
        "id": "RET-02",
        "name": "知识检索 Agent",
        "status": "idle",
        "duty": "为结论找到真实知识库依据",
    },
    {
        "id": "GEN-03",
        "name": "内容生成 Agent",
        "status": "idle",
        "duty": "把证据组织成一份备课方案",
    },
    {
        "id": "VER-04",
        "name": "审核裁判 Agent",
        "status": "idle",
        "duty": "检查结论是否有出处、是否自相矛盾",
    },
    {
        "id": "ARB-05",
        "name": "决策仲裁 Agent",
        "status": "idle",
        "duty": "给学习者最终建议和学习闭环",
    },
]


class TeachingGroupError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass
class TeachingGroupState:
    run_id: UUID = field(default_factory=uuid4)
    user_id: UUID | None = None
    learner: dict = field(default_factory=dict)
    knowledge_points: list[dict] = field(default_factory=list)
    knowledge_point: dict = field(default_factory=dict)
    mode: str = "prepare_next"
    prompt: str = ""
    diagnosis: dict = field(default_factory=dict)
    evidence: list[dict] = field(default_factory=list)
    plan: dict = field(default_factory=dict)
    review: dict = field(default_factory=dict)
    decision: dict = field(default_factory=dict)


class TeachingGroupService:
    def __init__(
        self,
        settings: Settings,
        llm: LLMClient | None = None,
        directory: PlatformDirectory | None = None,
        retriever: KnowledgeRetriever | None = None,
        evidence_search: EvidenceSearch | None = None,
    ):
        self.settings = settings
        self.llm = llm or LLMClient(settings)
        self.directory = directory or PlatformDirectory(settings)
        self.retriever = retriever or KnowledgeRetriever(settings)
        self.evidence_search = evidence_search or EvidenceSearch()

    def agents(self) -> list[dict]:
        return TEACHING_AGENTS

    async def stream(
        self,
        user_id: UUID,
        request: TeachingGroupRunRequest,
    ) -> AsyncIterator[dict]:
        try:
            state = await self._build_state(user_id, request)
        except TeachingGroupError as exc:
            yield {"type": "run_failed", "data": {"code": exc.code}}
            return

        yield {
            "type": "run_started",
            "runId": str(state.run_id),
            "learnerId": str(request.learner_id),
        }

        steps = [
            ("DIA-01", self._diagnose, "diagnosis"),
            ("RET-02", self._retrieve, "evidence"),
            ("GEN-03", self._generate, "plan"),
            ("VER-04", self._review, "review"),
            ("ARB-05", self._arbitrate, "decision"),
        ]
        for agent_id, method, attr in steps:
            yield {"type": "agent_started", "agent": agent_id, "data": {}}
            try:
                output = await method(state)
                if attr == "evidence":
                    state.evidence = output.get("evidence") or []
                else:
                    setattr(state, attr, output)
                yield {"type": "agent_output", "agent": agent_id, "data": output}
                yield {
                    "type": "agent_completed",
                    "agent": agent_id,
                    "success": True,
                    "data": {"name": next((a["name"] for a in TEACHING_AGENTS if a["id"] == agent_id), agent_id)},
                }
            except Exception as exc:
                logger.exception("Teaching group agent %s failed", agent_id)
                yield {
                    "type": "agent_failed",
                    "agent": agent_id,
                    "data": {"code": "AGENT_EXECUTION_FAILED"},
                }
                yield {"type": "run_failed", "data": {"code": "AGENT_EXECUTION_FAILED"}}
                return

            if request.mode == "diagnose" and attr == "evidence":
                yield {
                    "type": "run_completed",
                    "data": {
                        "diagnosis": state.diagnosis,
                        "evidence": state.evidence,
                    },
                }
                return

        yield {
            "type": "run_completed",
            "data": {
                "decision": state.decision,
                "diagnosis": state.diagnosis,
                "evidence": state.evidence,
                "plan": state.plan,
                "review": state.review,
            },
        }

    async def _build_state(self, user_id: UUID, request: TeachingGroupRunRequest) -> TeachingGroupState:
        if not self.directory.available():
            raise TeachingGroupError("TEACHING_GROUP_UNAVAILABLE")
        learner = await asyncio.to_thread(self.directory.load_learner, request.learner_id, user_id)
        if learner is None:
            raise TeachingGroupError("LEARNER_NOT_FOUND")
        km = await asyncio.to_thread(self.directory.load_knowledge_map)
        points = km.get("chapters") or []
        if not points:
            raise TeachingGroupError("KNOWLEDGE_POINTS_UNAVAILABLE")
        if request.knowledge_point_id:
            point = next((item for item in points if item["code"] == request.knowledge_point_id), None)
            if point is None:
                raise TeachingGroupError("KNOWLEDGE_POINT_NOT_FOUND")
        else:
            point = self._weakest_point(learner, points)
        return TeachingGroupState(
            user_id=user_id,
            learner=learner,
            knowledge_points=points,
            knowledge_point=point,
            mode=request.mode,
            prompt=(request.prompt or "").strip(),
        )

    @staticmethod
    def _weakest_point(learner: dict, points: list[dict]) -> dict:
        scores = learner.get("scores") or {}
        return sorted(
            points,
            key=lambda kp: (
                -(int(kp["targetLevel"]) - int(scores.get(kp["code"], 50))),
                int(scores.get(kp["code"], 50)),
            ),
        )[0]

    async def _complete_json(self, system: str, prompt: str, fallback: dict) -> dict:
        result = await self.llm.complete_json(
            system,
            prompt,
            fallback,
            provider="mimo",
            thinking=False,
        )
        return result if isinstance(result, dict) else fallback

    async def _diagnose(self, state: TeachingGroupState) -> dict:
        kp = state.knowledge_point
        learner = state.learner
        scores = learner.get("scores") or {}
        fallback = {
            "summary": f"{learner.get('name') or '学习者'} 当前最弱的是「{kp['name']}」",
            "focus": kp["name"],
            "reason": f"该知识点得分 {scores.get(kp['code'], 50)}，距离目标 {kp['targetLevel']} 的缺口最大。",
            "priority": "high",
        }
        system = "你是学情诊断 Agent，只返回 JSON。"
        prompt = (
            f"学习者画像：{json.dumps(learner, ensure_ascii=False)}\n"
            f"候选知识点：{json.dumps(state.knowledge_points, ensure_ascii=False)}\n"
            f"请返回 {{summary, focus, reason, priority}}，focus 必须是候选知识点 code 对应的 name。"
        )
        return await self._complete_json(system, prompt, fallback)

    async def _retrieve(self, state: TeachingGroupState) -> dict:
        focus = str(state.diagnosis.get("focus") or state.knowledge_point["name"])
        target = str(state.learner.get("targetJob") or "")
        prompt = str(state.prompt or "")
        query = " ".join(part for part in (focus, target, prompt) if part).strip()
        if not query:
            query = focus

        sources, retrieval = await self.evidence_search.retrieve(
            query, rag_top_k=5, web_limit=5,
        )
        if sources:
            evidence = self._evidence_from_sources(sources)[:5]
            source_types = {item.get("sourceType") for item in sources}
            if source_types == {"web"}:
                source = "web_search"
            elif "web" in source_types:
                source = "ragflow+web_search"
            else:
                source = "ragflow"
        else:
            articles = await asyncio.to_thread(self.retriever.search, query, 3)
            evidence = self._evidence_from_articles(articles)
            source = "knowledge_articles"
        state.evidence = evidence
        return {"query": query, "source": source, "retrieval": retrieval, "evidence": evidence}

    @staticmethod
    def _evidence_from_sources(sources: list[dict]) -> list[dict]:
        items = []
        for index, item in enumerate(sources or []):
            source_type = str(item.get("sourceType") or "knowledge_base")
            items.append({
                "kbId": str(item.get("chunkId") or f"WEB-{index + 1:03d}"),
                "title": str(item.get("document") or "检索资料"),
                "source": "Web Search" if source_type == "web" else "RAGFlow",
                "sourceType": source_type,
                "url": str(item.get("url") or ""),
                "credibility": round(float(item.get("confidence") or item.get("similarity") or 0) * 100),
                "excerpt": str(item.get("content") or "")[:300],
                "positions": [],
            })
        return items

    @staticmethod
    def _evidence_from_rag(chunks: list[dict]) -> list[dict]:
        items = []
        for index, chunk in enumerate(chunks or []):
            items.append({
                "kbId": str(chunk.get("chunk_id") or f"RAG-{index + 1}"),
                "title": str(chunk.get("document") or "RAGFlow 知识库"),
                "source": "RAGFlow",
                "credibility": round(float(chunk.get("similarity") or 0) * 100),
                "excerpt": str(chunk.get("content") or "")[:300],
                "positions": [],
            })
        return items

    @staticmethod
    def _evidence_from_articles(articles: list[dict]) -> list[dict]:
        items = []
        for index, article in enumerate(articles or []):
            items.append({
                "kbId": str(article.get("id") or f"KB-{index + 1:03d}"),
                "title": str(article.get("title") or "平台知识文章"),
                "source": str(article.get("source") or "知识库"),
                "credibility": 90,
                "excerpt": str(article.get("excerpt") or "")[:300],
                "positions": [],
            })
        return items

    async def _generate(self, state: TeachingGroupState) -> dict:
        kp = state.knowledge_point
        evidence = state.evidence
        citations = [
            {"kbId": item["kbId"], "title": item["title"]}
            for item in evidence[:5]
        ]
        fallback = {
            "title": f"{kp['name']}学习方案",
            "summary": (
                f"先补「{kp['name']}」：以基础知识讲清概念，再用 1 道例题和 2 道分阶题验证理解。"
                if evidence
                else f"「{kp['name']}」暂未检索到足够知识库依据，建议先做诊断题并补充资料。"
            ),
            "sections": [
                {
                    "heading": "为什么先学",
                    "body": f"「{kp['name']}」当前缺口较大，按目标 {kp['targetLevel']} 分安排优先补强。",
                    "citations": [item["kbId"] for item in citations[:2]],
                },
                {
                    "heading": "建议动作",
                    "body": "先读 1 份基础讲义，再完成 2 道基础题；答错后回到证据片段重读。",
                    "citations": [item["kbId"] for item in citations[2:4]],
                },
            ],
            "practice": "完成 1 个与当前知识点直接相关的练习。",
            "quiz": "做 3 道题：1 道基础、1 道进阶、1 道挑战。",
            "citations": citations,
        }
        system = "你是教学内容生成 Agent，只返回 JSON，关键论断必须引用提供的证据。"
        prompt = (
            f"诊断：{json.dumps(state.diagnosis, ensure_ascii=False)}\n"
            f"证据：{json.dumps(evidence, ensure_ascii=False)}\n"
            f"返回 {{title, summary, sections: [{{heading, body, citations}}], practice, quiz, citations}}。"
        )
        result = await self._complete_json(system, prompt, fallback)
        return result if isinstance(result, dict) else fallback

    async def _review(self, state: TeachingGroupState) -> dict:
        plan = state.plan or {}
        evidence = state.evidence or []
        cited_ids = set()
        for section in plan.get("sections") or []:
            for item in section.get("citations") or []:
                if isinstance(item, dict):
                    citation_id = item.get("kbId") or item.get("id") or item.get("chunkId")
                else:
                    citation_id = item
                if citation_id:
                    cited_ids.add(str(citation_id))
        evidence_ids = {str(item.get("kbId")) for item in evidence}

        defects = []
        if not plan.get("sections"):
            defects.append({"severity": "CRITICAL", "message": "生成结果缺少讲义内容"})
        if evidence and not cited_ids:
            defects.append({"severity": "MAJOR", "message": "生成内容未挂接任何证据"})
        if not evidence and plan.get("summary"):
            defects.append({"severity": "MAJOR", "message": "没有检索到知识库证据，结论置信度不足"})
        if cited_ids and not cited_ids.intersection(evidence_ids):
            defects.append({"severity": "MAJOR", "message": "引用不在检索证据集中，存在幻觉风险"})

        critical = any(item.get("severity") == "CRITICAL" for item in defects)
        return {
            "passed": not critical,
            "confidence": 95 if evidence and cited_ids else (65 if evidence else 45),
            "defects": defects,
            "recommendation": "可以发布" if not critical else "需要退回补资料",
        }

    async def _arbitrate(self, state: TeachingGroupState) -> dict:
        plan = state.plan or {}
        review = state.review or {}
        kp = state.knowledge_point
        critical = any(
            item.get("severity") == "CRITICAL"
            for item in review.get("defects") or []
        )
        fallback = {
            "decision": "reject" if critical else "accept",
            "nextAction": (
                f"从「{kp['name']}」基础讲义开始，完成 1 课 + 2 道题"
                if not critical
                else "先补充知识库资料，再重新生成"
            ),
            "reason": (
                f"审核通过，优先补「{kp['name']}」。"
                if not critical
                else "审核发现关键缺陷，暂不下发学习任务。"
            ),
            "sources": state.evidence[:3],
        }
        system = "你是决策仲裁 Agent，只返回 JSON。"
        prompt = (
            f"诊断：{json.dumps(state.diagnosis, ensure_ascii=False)}\n"
            f"方案：{json.dumps(plan, ensure_ascii=False)}\n"
            f"审核：{json.dumps(review, ensure_ascii=False)}\n"
            f"返回 {{decision, nextAction, reason, sources}}。"
        )
        result = await self._complete_json(system, prompt, fallback)
        if isinstance(result, dict):
            decision = str(result.get("decision") or "").strip()
            normalized_decision = decision.lower().replace("_", " ").replace("-", " ")
            publish_actions = {
                "accept", "approve", "approved", "publish", "release", "pass",
                "通过", "接受", "通过审核", "同意", "发布", "准予发布",
            }
            reject_actions = {
                "reject", "rejected", "decline", "return", "revise",
                "拒绝", "退回", "驳回", "需要修订",
            }
            if normalized_decision in publish_actions:
                result["decision"] = "accept"
            elif normalized_decision in reject_actions:
                result["decision"] = "reject"
            else:
                # Unknown action labels must not invert the deterministic review verdict.
                result["decision"] = fallback["decision"]
            next_action = str(result.get("nextAction") or "").strip()
            if next_action.lower() in publish_actions | reject_actions:
                result["nextAction"] = fallback["nextAction"]
            sources = result.get("sources") or []
            if sources and isinstance(sources[0], str):
                result["sources"] = state.evidence[:3]
        return result if isinstance(result, dict) else fallback
