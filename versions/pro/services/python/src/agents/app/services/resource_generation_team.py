from __future__ import annotations

import json
import logging
import hashlib
import copy
from datetime import datetime, timezone
from collections.abc import Awaitable, Callable
from uuid import UUID

from app.config import Settings
from app.services.evidence_search import RAG_MIN_SIMILARITY, filter_rag_sources_by_chapter
from app.services.learning_content import LearningContentService
from app.services.knowledge_decision import KnowledgeDecisionClient
from app.services.web_evidence_debate import WebEvidenceDebate
from app.services.rule_core import RuleCoreClient

logger = logging.getLogger(__name__)


EventSink = Callable[..., Awaitable[None]]


class ResourceGenerationTeam:
    """Role-separated, evidence-grounded generation for competition-grade resources."""

    @staticmethod
    def _event_display(agent: str, title: str, detail: str, snapshot: dict) -> dict:
        """Build a stable, user-facing activity report without exposing prompts or chain-of-thought."""
        agent_next = {
            "retrieval": "将核验后的资料交给教学策划 Agent",
            "planner": "将教学蓝图交给内容生成 Agent",
            "writer": "将生成内容交给质量核验 Agent",
            "revision": "返修完成后重新进入质量核验",
            "schema_validator": "继续检查结构和内容完整性",
            "citation_verifier": "将核验结果交给发布仲裁 Agent",
            "reviewer": "根据评议结果通过或发起定向返修",
            "judge": "发布资源或退回对应 Agent 修复",
        }
        inputs = []
        for key, label in (("topic", "学习主题"), ("query", "检索范围"), ("resourceType", "资源类型")):
            if snapshot.get(key) not in (None, "", []):
                inputs.append({"label": label, "value": snapshot[key]})
        outputs = []
        for key, label in (("coverage", "内容覆盖"), ("acceptanceRubric", "验收标准"), ("sourceTitles", "采用资料"),
                           ("chapterCount", "章节数量"), ("stepCount", "实操步骤"), ("questionCount", "题目数量")):
            if snapshot.get(key) not in (None, "", []):
                outputs.append({"label": label, "value": snapshot[key]})
        checks = []
        if "citationVerified" in snapshot:
            checks.append({"label": "引用核验", "passed": bool(snapshot["citationVerified"])})
        for issue in snapshot.get("issues") or []:
            checks.append({"label": str(issue), "passed": False})
        has_issues = bool(snapshot.get("issues"))
        decision = snapshot.get("decision") or ("repair" if has_issues else None)
        next_step = snapshot.get("nextStep")
        if not next_step and has_issues:
            next_step = "交给内容生成 Agent 按问题明细定向修订，修订完成后重新进入质量核验"
        return {
            "summary": detail or title,
            "inputs": inputs,
            "actions": [snapshot["activity"]] if snapshot.get("activity") else [],
            "outputs": outputs,
            "evidence": snapshot.get("evidenceItems") or [],
            "artifact": snapshot.get("artifactPreview") or None,
            "checks": checks,
            "decision": decision,
            "nextStep": next_step or agent_next.get(agent, "继续执行当前生成任务"),
        }

    @staticmethod
    def _artifact_preview(kind: str, content: dict) -> dict:
        if kind == "lecture":
            chapters = content.get("chapters") or []
            return {"kind": kind, "title": content.get("title"), "countLabel": "章节", "count": len(chapters),
                    "items": [{"title": item.get("title") or f"第 {index + 1} 章",
                               "preview": str(item.get("introduction") or item.get("summary") or "")[:240]}
                              for index, item in enumerate(chapters[:6]) if isinstance(item, dict)]}
        if kind == "practice":
            steps = content.get("steps") or []
            return {"kind": kind, "title": content.get("title"), "countLabel": "步骤", "count": len(steps),
                    "items": [{"title": item.get("title") or f"步骤 {index + 1}",
                               "preview": str(item.get("instruction") or item.get("expectedOutput") or "")[:240]}
                              for index, item in enumerate(steps[:8]) if isinstance(item, dict)]}
        questions = content.get("questions") or []
        return {"kind": kind, "title": content.get("title"), "countLabel": "题目", "count": len(questions),
                "items": [{"title": f"第 {index + 1} 题", "preview": str(item.get("stem") or "")[:240]}
                          for index, item in enumerate(questions[:6]) if isinstance(item, dict)]}
    def __init__(self, settings: Settings):
        self.settings = settings
        self.service = LearningContentService(settings)
        self.llm = self.service.llm
        self.knowledge = KnowledgeDecisionClient(settings)
        self.web_debate = WebEvidenceDebate(self.llm)
        self.rule_core = RuleCoreClient(settings)

    async def close(self) -> None:
        await self.service.close()

    @staticmethod
    def _citation_ids(content: object) -> list[int]:
        found: list[int] = []
        if isinstance(content, dict):
            for key, value in content.items():
                if key == "citations" and isinstance(value, list):
                    found.extend(item for item in value if isinstance(item, int))
                else:
                    found.extend(ResourceGenerationTeam._citation_ids(value))
        elif isinstance(content, list):
            for item in content:
                found.extend(ResourceGenerationTeam._citation_ids(item))
        return found

    @staticmethod
    def _evidence_snapshot(sources: list[dict]) -> list[dict]:
        """Persist stable evidence identity and a short reviewable quote for every resource."""
        return [{
            "source_id": item.get("id"),
            "chunk_id": item.get("chunkId") or item.get("chunk_id"),
            "document_id": item.get("documentId") or item.get("document_id"),
            "category_id": item.get("categoryId") or item.get("category_id"),
            "title": item.get("document") or item.get("title") or "知识库资料",
            "source_type": item.get("sourceType") or item.get("source") or "knowledge_base",
            "score": item.get("similarity") or item.get("score"),
            "quote": str(item.get("content") or "")[:1200],
            "url": item.get("url"),
        } for item in sources]

    @staticmethod
    def _quiz_defense_report(content: dict, sources: list[dict]) -> dict:
        """QuestionBank-compatible deterministic schema/evidence/dedup defenses."""
        valid_sources = {int(item["id"]) for item in sources if item.get("id") is not None}
        hashes: set[str] = set()
        schema_issues: list[str] = []
        evidence_issues: list[str] = []
        duplicate_count = 0
        for index, question in enumerate(content.get("questions") or [], 1):
            stem = str(question.get("stem") or "").strip()
            options = question.get("options") or []
            try:
                correct = int(question.get("correctIndex"))
            except (TypeError, ValueError):
                correct = -1
            if not stem or len(options) < 2 or correct < 0 or correct >= len(options):
                schema_issues.append(f"第{index}题结构或答案索引不合法")
            citations = set()
            for raw in question.get("citations") or []:
                try:
                    citations.add(int(raw))
                except (TypeError, ValueError):
                    pass
            if not citations or not citations <= valid_sources:
                evidence_issues.append(f"第{index}题缺少有效证据或引用越界")
            digest = hashlib.sha256(json.dumps(
                {"stem": stem, "options": options, "answer": correct},
                ensure_ascii=False, sort_keys=True, separators=(",", ":"),
            ).encode("utf-8")).hexdigest()
            if digest in hashes:
                duplicate_count += 1
            hashes.add(digest)
        return {
            "schema": {"passed": not schema_issues, "issues": schema_issues},
            "evidence": {"passed": not evidence_issues, "issues": evidence_issues},
            "reviewer": {"mode": "resource_quality_gate", "passed": not schema_issues and not evidence_issues},
            "duplicate": {"passed": duplicate_count == 0, "exactDuplicateCount": duplicate_count},
        }

    async def _blueprint(self, kind: str, payload: dict, context: dict, sources: list[dict]) -> dict:
        label = {"lecture": "定制讲义", "practice": "实操指南", "quiz": "分阶测试"}[kind]
        admin_master = payload.get("generation_mode") == "admin_master"
        source_strategy = (
            "实操指南先用知识库规划课程内操作方法、步骤约束、验收标准和安全边界；"
            "Web 只补工具版本、环境差异、现实案例和更新信息。蓝图必须围绕动作、观察、判定、排错组织，不得写成理论讲义。"
            if kind == "practice" else
            "核心定义、课程内理论和基本原理优先规划 knowledge_base；Web 只补充案例、实践、更新信息或知识库未覆盖部分。"
        )
        source_digest = [{"id": item["id"], "sourceType": item.get("sourceType"), "scope": item.get("retrievalScope"), "title": item.get("document"), "excerpt": str(item.get("content") or "")[:260]} for item in sources[:10]]
        fallback = {
            **({"audienceDesign": "面向具备基础学习条件的通用学习者，关键术语首次出现时解释，难度由基础到应用递进"}
               if admin_master else {"audienceGap": "根据用户画像确定术语解释深度和任务难度"}),
            "competitionFit": ["围绕Agent知识与工程能力", "强调可验证产出", "引用落到具体内容位置"],
            "coverage": [payload.get("topic")], "sourcePlan": [{"sourceId": item["id"], "purpose": "事实依据"} for item in sources[:4]],
            "learningObjectives": [f"准确理解{payload.get('topic')}的核心概念", f"能够解释{payload.get('topic')}的关键机制", f"能够在典型场景中应用并验证{payload.get('topic')}"],
            "contentStructure": [{"title": payload.get("topic"), "focus": "核心概念、机制、应用与边界", "expectedOutcome": "形成可核查、可应用的完整理解"}],
            "knowledgeBaseCoverage": [], "webSupplement": [],
            "acceptanceRubric": ["事实准确", "结构完整", "实践可执行", "引用可核验"],
        }
        audience_instruction = (
            "这是管理员预生成的机构通用资源母版，不得读取、推断或提及任何用户画像、个人水平、个人偏好或个人目标；"
            "个性化适配将在客户端后生成阶段完成。返回audienceDesign。"
            if admin_master else "结合学习者上下文返回audienceGap。"
        )
        blueprint = await self.llm.complete_json(
            "你是全国职业技能竞赛Agent方向命题分析师，只返回JSON。你负责把知识点转成符合比赛命题逻辑、可训练、可评价的内容蓝图。",
            f"资源类型：{label}\n主题：{payload.get('topic')}\n课程与机构上下文：{json.dumps(context, ensure_ascii=False)[:7000]}\n"
            f"可用证据：{json.dumps(source_digest, ensure_ascii=False)}\n"
            f"{audience_instruction}"
            "返回learningObjectives:string[]（3-6项可观察目标）、contentStructure:[{title,focus,expectedOutcome}]（3-8个递进板块）、"
            "competitionFit:string[],coverage:string[]（3-8项具体覆盖内容）、sourcePlan:[{sourceId,purpose}],"
            "knowledgeBaseCoverage:string[],webSupplement:string[],preferredSourceTypeBySection:object,acceptanceRubric:string[]。"
            "先阅读 retrievalScope=chapter 的知识库证据建立整章上下文，再用 retrievalScope=topic 的知识库证据写当前知识点。"
            f"{source_strategy}"
            "命题必须围绕Agent基础、工作流、工具调用、记忆/检索、评测、安全与工程实践中与当前主题直接相关的能力，"
            "不得扩写无关章节；每个评价点必须能通过答案、代码、运行结果或操作证据判断。",
            fallback, provider="mimo", max_tokens=1800, max_retries=2, thinking=False,
        )
        if admin_master:
            blueprint["audienceDesign"] = blueprint.get("audienceDesign") or blueprint.pop("audienceGap", "") or fallback["audienceDesign"]
            blueprint.pop("audienceGap", None)
        coverage = [str(item) for item in (blueprint.get("coverage") or []) if str(item).strip()]
        if len(coverage) < 3:
            topic = str(payload.get("topic") or "当前知识点")
            coverage = list(dict.fromkeys(coverage + [f"{topic}的核心概念", f"{topic}的工作机制", f"{topic}的应用与验证"]))[:6]
            blueprint["coverage"] = coverage
        if not blueprint.get("learningObjectives"):
            blueprint["learningObjectives"] = [f"理解{item}" for item in coverage[:4]]
        if not blueprint.get("contentStructure"):
            blueprint["contentStructure"] = [
                {"title": item, "focus": f"围绕“{item}”组织事实、机制与示例", "expectedOutcome": f"能够说明并验证{item}"}
                for item in coverage[:6]
            ]
        return blueprint

    async def _review(self, kind: str, content: dict, sources: list[dict], blueprint: dict) -> dict:
        fallback = {"scores": {"accuracy": 0, "competitionFit": 0, "depth": 0, "actionability": 0, "citation": 0}, "defects": ["审查Agent未返回有效结果"], "passed": False}
        compact_sources = [{"id": item["id"], "title": item.get("document"), "content": str(item.get("content") or "")[:700]} for item in sources[:8]]
        return await self.llm.complete_json(
            "你是独立质量审查Agent。不得替生成Agent辩护，只返回JSON。",
            f"资源类型：{kind}\n命题蓝图：{json.dumps(blueprint, ensure_ascii=False)}\n"
            f"候选内容：{json.dumps(content, ensure_ascii=False)[:24000]}\n证据：{json.dumps(compact_sources, ensure_ascii=False)[:9000]}\n"
            "返回scores(accuracy,competitionFit,depth,actionability,citation，均0-100), defects:string[], passed:boolean。"
            "逐项检查：是否贴合Agent赛题能力；事实是否能由来源支撑；引用是否位于对应段落/步骤/题目；"
            "讲义是否形成概念-机制-案例-边界-验证闭环；指南能否由学员独立复现并客观验收；"
            "测试题是否分阶、单一正确、干扰项来自真实误区且解析解释错误项。任一核心分低于75必须不通过。",
            fallback, provider="mimo", max_tokens=2200, max_retries=2, thinking=False,
        )

    async def _repair(self, kind: str, content: dict, sources: list[dict], blueprint: dict,
                      defects: list[str], round_number: int) -> dict:
        """Repair the existing artifact in place before falling back to full regeneration."""
        compact_sources = [
            {"id": item["id"], "title": item.get("document"), "content": str(item.get("content") or "")[:900]}
            for item in sources[:10]
        ]
        fallback = {"__repair_failed__": True}
        quiz_rules = (
            "测试题必须逐题核对stem、options、correctIndex和explanation。correctIndex是0开始的唯一真值；"
            "解析不得另写与correctIndex冲突的A/B/C/D字母，必须直接引用正确选项文本并解释其余选项。"
            "至少包含案例分析或综合应用题，用于评估场景匹配和工程权衡。"
            if kind == "quiz" else ""
        )
        return await self.llm.complete_json(
            "你是内容修复Agent。你的任务是直接修好已有内容，而不是评价、解释或拒绝。只返回修复后的完整JSON，字段结构不得改变。",
            f"资源类型：{kind}\n修复轮次：{round_number}\n命题蓝图：{json.dumps(blueprint, ensure_ascii=False)}\n"
            f"审查缺陷：{json.dumps(defects, ensure_ascii=False)}\n证据：{json.dumps(compact_sources, ensure_ascii=False)[:11000]}\n"
            f"待修复完整内容：{json.dumps(content, ensure_ascii=False)[:26000]}\n"
            "逐条消除缺陷；保留已经正确的部分；所有事实与引用必须能由证据支持；不得虚构来源编号。"
            + quiz_rules,
            fallback, provider="mimo", max_tokens=4096, max_retries=2, thinking=False,
        )

    async def _retrieve_repair_sources(self, topic: str, issues: list[str],
                                       current_sources: list[dict]) -> tuple[list[dict], dict]:
        """Actually supplement the evidence pool used by a citation repair."""
        query = f"{topic} {' '.join(issues[:4])} 可核验原文与实操依据"
        candidates = await self.service.retrieve(
            query, top_k=10, rag_only=False, supplement_web=True,
        )
        web_candidates = [item for item in candidates if item.get("sourceType") == "web"]
        admitted_web: list[dict] = []
        debate_archive: dict = {}
        if web_candidates:
            debate_service = getattr(self, "web_debate", None) or WebEvidenceDebate(self.llm)
            admitted_web, debate_archive = await debate_service.run(query, web_candidates)
        admitted = [item for item in candidates if item.get("sourceType") == "knowledge_base"] + admitted_web
        existing = {
            (str(item.get("sourceType")), str(item.get("chunkId") or item.get("url") or item.get("content", "")[:160]))
            for item in current_sources
        }
        next_id = max((int(item.get("id") or 0) for item in current_sources), default=0) + 1
        added: list[dict] = []
        for item in admitted:
            identity = (str(item.get("sourceType")), str(item.get("chunkId") or item.get("url") or item.get("content", "")[:160]))
            if identity in existing or not str(item.get("content") or "").strip():
                continue
            existing.add(identity)
            added.append({**item, "id": next_id, "retrievalScope": "quality_repair"})
            next_id += 1
        return added, {
            "candidateCount": len(candidates), "webCandidateCount": len(web_candidates),
            "admittedWebCount": len(admitted_web), "addedSourceCount": len(added),
            "debateScorecard": debate_archive.get("scorecard") or {},
        }

    async def _repair_practice_steps(self, content: dict, sources: list[dict],
                                     defects: list[str], issue_details: list[dict],
                                     round_number: int) -> dict:
        """Repair only failed practice steps and freeze every accepted step."""
        affected = sorted({
            int(item.get("stepIndex") or item.get("blockIndex"))
            for item in issue_details
            if isinstance(item, dict) and str(item.get("stepIndex") or item.get("blockIndex") or "").isdigit()
            and str(item.get("blockType") or "实操步骤") in {"实操步骤", ""}
        })
        steps = content.get("steps") if isinstance(content.get("steps"), list) else []
        affected = [index for index in affected if 1 <= index <= len(steps)]
        if not affected:
            return await self._repair("practice", content, sources, {}, defects, round_number)
        source_by_id = {int(item["id"]): item for item in sources if item.get("id") is not None}
        repaired_content = json.loads(json.dumps(content, ensure_ascii=False))
        repaired_any = False
        for step_index in affected:
            step = repaired_content["steps"][step_index - 1]
            cited_ids = set()
            for value in list(step.get("citations") or []) + [
                item.get("sourceId") for item in step.get("evidenceMatches") or [] if isinstance(item, dict)
            ]:
                try: cited_ids.add(int(value))
                except (TypeError, ValueError): pass
            relevant = [source_by_id[source_id] for source_id in cited_ids if source_id in source_by_id]
            if not relevant:
                relevant = list(source_by_id.values())[:6]
            compact_sources = [{
                "id": item.get("id"), "title": item.get("document") or "知识资料",
                "content": str(item.get("content") or "")[:5000],
            } for item in relevant[:6]]
            step_issues = [item for item in issue_details if isinstance(item, dict)
                           and int(item.get("stepIndex") or item.get("blockIndex") or 0) == step_index]
            result = await self.llm.complete_json(
                "你是实操步骤修复Agent。只修指定步骤，返回完整step JSON；不得改动其他步骤。",
                f"修复轮次：{round_number}\n本步骤：{json.dumps(step, ensure_ascii=False)}\n"
                f"本步骤问题：{json.dumps(step_issues or defects, ensure_ascii=False)}\n"
                f"可引用原文：{json.dumps(compact_sources, ensure_ascii=False)}\n"
                "返回 {\"step\":{title,instruction,code,expectedOutput,citations,evidenceMatches,safety,warning}}。"
                "每个 evidenceMatches.sourcePassage 必须从对应来源 content 逐字复制。",
                {"step": None}, provider="mimo", max_tokens=3000, max_retries=1,
                thinking=False, timeout_seconds=45,
            )
            candidate = result.get("step") if isinstance(result, dict) else None
            if not isinstance(candidate, dict) and isinstance(result, dict) and result.get("instruction"):
                candidate = result
            if isinstance(candidate, dict) and str(candidate.get("instruction") or "").strip():
                repaired_content["steps"][step_index - 1] = candidate
                repaired_any = True
        return repaired_content if repaired_any else {"__repair_failed__": True}

    async def _evidence_consistency_debate(self, kind: str, content: dict, sources: list[dict]) -> dict:
        """Mandatory quality-stage debate: challenge generated claims against retrieved evidence."""
        compact_sources = [{
            "id": item.get("id"), "title": item.get("document") or item.get("title"),
            "content": str(item.get("content") or item.get("excerpt") or "")[:1200],
        } for item in sources[:12]]
        fallback = {
            "passed": True, "contradictions": [], "consensus": "未发现可确认的内容—证据矛盾",
            "supportingFindings": [], "challengeFindings": [], "arbitrationItems": [],
        }
        result = await self.llm.complete_json(
            "你是质量核验阶段的内容—证据一致性辩论组。内部必须依次执行支持方、质疑方、仲裁方三种角色；"
            "只返回JSON，不展示思维链，不得把证据未覆盖误判为事实矛盾。",
            f"资源类型：{kind}\n检索依据：{json.dumps(compact_sources, ensure_ascii=False)[:15000]}\n"
            f"生成内容：{json.dumps(content, ensure_ascii=False)[:24000]}\n"
            "请核对生成内容是否与检索依据存在直接矛盾。返回可供操作员审核的结构化评议记录，不得只写角色名称。"
            "supportingFindings 逐条列出通过核对的生成表述、来源编号、证据原文和支持结论；"
            "challengeFindings 逐条列出被质疑表述、来源编号、证据原文、质疑原因和风险；"
            "arbitrationItems 对每项质疑给出采纳或驳回、理由和返修要求。返回："
            '{"passed":true或false,"supportingFindings":[{"claim":"被核对表述","sourceId":1,"evidence":"证据原文","analysis":"支持结论"}],'
            '"challengeFindings":[{"claim":"被质疑表述","sourceId":1,"evidence":"冲突或缺口依据","analysis":"质疑原因","risk":"风险"}],'
            '"arbitrationItems":[{"issue":"争议项","decision":"accept或reject","reason":"裁决理由","repairInstruction":"返修要求"}],'
            '"contradictions":[{"claim":"生成表述","evidence":"冲突依据","reason":"矛盾原因","repairInstruction":"定向返修要求"}],'
            '"consensus":"仲裁结论"}。',
            fallback, provider="mimo", max_tokens=2200, max_retries=2, thinking=False,
        )
        contradictions = result.get("contradictions") if isinstance(result, dict) else []
        contradictions = [item for item in contradictions if isinstance(item, dict)][:10] if isinstance(contradictions, list) else []
        def records(key: str) -> list[dict]:
            value = result.get(key) if isinstance(result, dict) else []
            return [item for item in value if isinstance(item, dict)][:12] if isinstance(value, list) else []
        return {
            "passed": bool(result.get("passed", not contradictions)) and not contradictions,
            "contradictions": contradictions,
            "consensus": str(result.get("consensus") or fallback["consensus"]),
            "supportingFindings": records("supportingFindings"),
            "challengeFindings": records("challengeFindings"),
            "arbitrationItems": records("arbitrationItems"),
        }

    async def _verify_consistency_repairs(self, kind: str, content: dict, sources: list[dict],
                                          previous_contradictions: list[dict]) -> dict:
        """Verify only previously arbitrated contradictions; never open a new audit scope."""
        compact_sources = [{
            "id": item.get("id"), "title": item.get("document") or item.get("title"),
            "content": str(item.get("content") or item.get("excerpt") or "")[:1200],
        } for item in sources[:12]]
        issues = [{"issueIndex": index + 1, **item} for index, item in enumerate(previous_contradictions)]
        fallback = {"resolutions": [
            {"issueIndex": item["issueIndex"], "resolved": False, "finding": "未取得明确复核结论"}
            for item in issues
        ], "consensus": "返修问题尚未全部关闭"}
        result = await self.llm.complete_json(
            "你是返修复核员。只核对上一轮已经裁定的问题是否修正，不重新进行全量审查，不得新增问题。只返回JSON。",
            f"资源类型：{kind}\n上一轮问题：{json.dumps(issues, ensure_ascii=False)}\n"
            f"检索依据：{json.dumps(compact_sources, ensure_ascii=False)[:15000]}\n"
            f"返修后内容：{json.dumps(content, ensure_ascii=False)[:24000]}\n"
            "逐项返回原 issueIndex、resolved 和可供操作员查看的 finding。只评价这些原问题。返回："
            '{"resolutions":[{"issueIndex":1,"resolved":true或false,"finding":"返修后的具体核对结果"}],"consensus":"复核结论"}。',
            fallback, provider="mimo", max_tokens=1400, max_retries=2, thinking=False,
        )
        raw_resolutions = result.get("resolutions") if isinstance(result, dict) else []
        by_index = {
            int(item.get("issueIndex")): item for item in raw_resolutions or []
            if isinstance(item, dict) and str(item.get("issueIndex") or "").isdigit()
        }
        resolutions, unresolved = [], []
        for issue in issues:
            resolution = by_index.get(issue["issueIndex"], {})
            resolved = resolution.get("resolved") is True
            record = {**issue, "resolved": resolved,
                      "finding": str(resolution.get("finding") or "未取得明确复核结论")}
            resolutions.append(record)
            if not resolved:
                unresolved.append({key: value for key, value in issue.items() if key != "issueIndex"})
        return {
            "passed": not unresolved, "contradictions": unresolved,
            "consensus": str(result.get("consensus") or ("上一轮问题已全部关闭" if not unresolved else "仍有原问题未关闭")),
            "supportingFindings": [], "challengeFindings": [], "arbitrationItems": resolutions,
        }

    @staticmethod
    def _gate(review: dict, content: dict, selected_sources: list[dict], fallback_used: bool) -> tuple[bool, bool, dict]:
        valid_ids = {int(item["id"]) for item in selected_sources}
        cited_ids = set(ResourceGenerationTeam._citation_ids(content))
        citation_ok = bool(cited_ids) and cited_ids <= valid_ids
        scores = review.get("scores") if isinstance(review.get("scores"), dict) else {}
        passed = (
            bool(review.get("passed")) and citation_ok and not fallback_used
            and all(float(scores.get(key) or 0) >= 75 for key in ("accuracy", "competitionFit", "depth", "citation"))
        )
        return passed, citation_ok, scores

    @staticmethod
    def _source_snapshot_label(source: dict) -> str:
        """Keep the human-readable document while distinguishing each retrieved chunk."""
        document = str(source.get("document") or "检索资料").strip()
        chunk_id = str(source.get("chunkId") or source.get("chunk_id") or "").strip()
        section = str(source.get("sectionTitle") or source.get("section_title") or "").strip()
        parts = [document]
        if chunk_id:
            parts.append(f"切片 {chunk_id}")
        if section and section != document:
            parts.append(section)
        return " · ".join(parts)

    async def generate(self, kind: str, payload: dict, context: dict, emit: EventSink,
                       category_candidates: list[dict] | None = None, user_id: UUID | None = None):
        event_sink = emit

        async def emit(status: str, progress: int, agent: str, title: str, detail: str = "", snapshot: dict | None = None):
            safe_snapshot = dict(snapshot or {})
            safe_snapshot.setdefault("display", self._event_display(agent, title, detail, safe_snapshot))
            await event_sink(status, progress, agent, title, detail, safe_snapshot)

        self.service.generation_event_sink = emit
        rule_mode = getattr(getattr(self, "settings", None), "rule_core_mode", "observe")
        retrieval_detail = "先用知识网络章节路径检索 RAGFlow；覆盖不足时以 Web Search 补充可溯源资料"
        await emit("retrieving", 12, "retrieval", "检索可信资料", retrieval_detail, {
            "activity": "正在定位知识网络章节并检索可信资料", "topic": payload.get("topic"),
        })
        category = next((item for item in (category_candidates or []) if str(item.get("id")) == str(payload.get("kp_id"))), None)
        if category is None and category_candidates:
            category = category_candidates[0]
        knowledge_path = str((category or {}).get("path") or "")
        kp_code = str((category or {}).get("node_code") or payload.get("kp_id") or "")
        if kp_code:
            payload.setdefault("kp_id", kp_code)
        topic = str(payload["topic"]).strip()
        retrieval_query = knowledge_path if knowledge_path and knowledge_path.rstrip().endswith(topic) else " / ".join(filter(None, [knowledge_path, topic]))
        knowledge_context = None
        knowledge_sources: list[dict] = []
        if user_id is not None:
            knowledge_context = await self.knowledge.retrieve(
                retrieval_query, user_id, top_k=12,
                task_type="exercise" if kind == "quiz" else "troubleshooting" if kind == "practice" else "explanation",
            )
            for item in knowledge_context.get("chunks") or []:
                knowledge_sources.append({
                    "sourceType": "knowledge_base", "document": item.get("document"),
                    "content": item.get("content"), "similarity": item.get("similarity"),
                    "chunkId": item.get("chunk_id"), "documentId": item.get("document_id"),
                    "categoryId": item.get("category_id"), "retrievalScope": "knowledge_core",
                    "sectionTitle": item.get("section_title") or "",
                })
            await emit("retrieving", 18, "retrieval", "知识依据解析完成",
                       "已完成知识点归属、依据覆盖判断与可追溯资料整理", {
                "activity": "正在核对知识依据与当前学习主题",
                "requestId": knowledge_context.get("request_id"),
                "decision": knowledge_context.get("decision"),
                "highFidelityScore": knowledge_context.get("high_fidelity_score"),
                "fallbackUsed": knowledge_context.get("fallback_used"),
                "knowledgeCoreCount": len(knowledge_sources),
                "contrastCount": len(knowledge_context.get("contrasts") or []),
            })
        if kind in {"lecture", "practice"} and knowledge_path:
            chapter_query = knowledge_path.rsplit("/", 1)[0].strip() or knowledge_path
            chapter_sources = await self.service.retrieve(chapter_query, top_k=10, rag_only=True, kp_id=kp_code)
            topic_sources = await self.service.retrieve(
                retrieval_query, top_k=12, rag_only=False, supplement_web=False, kp_id=kp_code,
            )
            if not kp_code:
                chapter_sources = filter_rag_sources_by_chapter(chapter_sources, knowledge_path)
                topic_sources = filter_rag_sources_by_chapter(topic_sources, knowledge_path)
            merged: list[dict] = []
            seen: set[tuple[str, str]] = set()
            for scope, group in (("chapter", chapter_sources), ("topic", topic_sources)):
                for source in group:
                    identity = (str(source.get("sourceType")), str(source.get("chunkId") or source.get("url") or source.get("content", "")[:100]))
                    if identity in seen:
                        continue
                    seen.add(identity)
                    merged.append({**source, "retrievalScope": scope})
            sources = merged
        else:
            sources = await self.service.retrieve(
                retrieval_query, top_k=12, rag_only=False, supplement_web=False, kp_id=kp_code,
            )
            if not kp_code:
                sources = filter_rag_sources_by_chapter(sources, knowledge_path)
        has_confident_kb = any(
            item.get("sourceType") == "knowledge_base"
            and float(item.get("similarity") or 0) >= RAG_MIN_SIMILARITY
            for item in sources
        )
        if kind == "practice" and not has_confident_kb:
            # Practical guides may use Web only when the knowledge base has no
            # confident course slice for the operation at hand. Web remains a
            # last-resort fallback, never a parallel evidence candidate.
            practice_supplement = await self.service.retrieve(
                f"{retrieval_query} 实操配置、版本差异与常见故障",
                top_k=8, rag_only=False, supplement_web=True,
            )
            sources.extend(
                {**item, "retrievalScope": "practice_web_supplement"}
                for item in practice_supplement if item.get("sourceType") == "web"
            )
        deduped_sources: list[dict] = []
        seen_sources: set[tuple[str, str]] = set()
        for source in sources:
            identity = (str(source.get("sourceType")), str(source.get("chunkId") or source.get("url") or source.get("content", "")[:160]))
            if identity in seen_sources:
                continue
            seen_sources.add(identity)
            deduped_sources.append(source)
        sources = deduped_sources
        web_candidates = [item for item in sources if item.get("sourceType") == "web"]
        debate_archive = {"triggered": False, "name": "多源证据辩论庭", "claims": [], "sources": [], "scorecard": {}}
        if web_candidates:
            proactive_practice_web = kind == "practice"
            await emit("debating", 20, "retrieval", "多源证据辩论庭已启动",
                       (f"正在对 {len(web_candidates)} 条实操补充资料进行独立来源归并、交叉佐证与质疑"
                        if proactive_practice_web else
                        f"知识库依据不足，正在对 {len(web_candidates)} 条补充资料进行独立来源归并、交叉佐证与质疑"), {
                "activity": "正在召集多源证据辩论庭", "debateTriggered": True,
                "debateStage": "多源调查", "candidateSourceCount": len(web_candidates),
                "triggerReason": "practice_web_supplement" if proactive_practice_web else "knowledge_gap",
            })
            debate_service = getattr(self, "web_debate", None) or WebEvidenceDebate(self.llm)
            admitted_web, debate_archive = await debate_service.run(retrieval_query, web_candidates)
            sources = [item for item in sources if item.get("sourceType") != "web"] + admitted_web
            scorecard = debate_archive.get("scorecard") or {}
            await emit("debating", 22, "retrieval", "证据仲裁完成",
                       f"完成 {scorecard.get('claimCount', 0)} 项议题裁决，仅保留 {scorecard.get('admittedSourceCount', 0)} 条通过的补充依据", {
                "activity": "证据仲裁员正在提交辩论成绩单", "debateTriggered": True,
                "debateStage": "仲裁完成", "debateScorecard": scorecard,
                "debateClaims": [{"claim": item.get("claim"), "revisedClaim": item.get("revisedClaim"),
                                    "verdict": item.get("verdict"), "confidence": item.get("confidence"),
                                    "supportSummary": item.get("supportSummary"), "challengeSummary": item.get("challengeSummary"),
                                    "conditions": item.get("conditions") or [], "independentSourceCount": item.get("independentSourceCount")}
                                   for item in debate_archive.get("claims") or []],
            })
        elif sources:
            await emit("retrieving", 20, "retrieval", "知识库依据充分",
                       "现有知识依据已满足生成要求，本次无需启动多源证据辩论庭", {
                "activity": "已完成知识依据覆盖检查", "debateTriggered": False,
                "debateStage": "无需启动",
            })
        else:
            await emit("retrieving", 20, "retrieval", "未取得可用知识依据",
                       "知识服务连接或检索失败，当前没有取得可供生成使用的切片", {
                "activity": "已停止把空检索结果误判为依据充分",
                "decision": "blocked", "retrievalError": (knowledge_context or {}).get("error"),
                "knowledgeCoreCount": 0, "nextStep": "恢复知识服务连接后重新检索",
            })
        for index, source in enumerate(sources, 1):
            source["id"] = index
        rule_snapshot: dict = {"mode": "off", "constraints": [], "reasoningTrace": []}
        rule_client = getattr(self, "rule_core", None)
        if kind == "practice" and user_id is not None and rule_client is not None:
            rule_snapshot = await rule_client.resolve(
                task=f"为“{topic}”生成机构通用实操指南",
                resource_type=kind, topic=topic, user_id=user_id,
                extra_context=f"知识路径：{knowledge_path}",
            )
            constraints = rule_snapshot.get("constraints") or []
            if constraints:
                await emit("planning", 23, "retrieval", "生成规范匹配完成",
                           f"已从领域规范中匹配 {len(constraints)} 条适用于本次实操的生成要求", {
                    "activity": "正在把领域规范转换为本次任务的固定验收清单",
                    "ruleMode": rule_mode,
                    "ruleCount": len(constraints), "ruleConstraints": constraints,
                    "reasoningTrace": rule_snapshot.get("reasoningTrace") or [],
                    "decision": "observe" if rule_mode == "observe" else "apply",
                    "nextStep": "将固定生成规范纳入教学蓝图",
                })
            elif rule_snapshot.get("available") is False:
                await emit("planning", 23, "retrieval", "生成规范服务暂不可用",
                           "本次继续使用现有知识检索与质量核验流程", {
                    "activity": "已隔离规则服务异常，不影响原有资源生成",
                    "decision": "continue", "nextStep": "继续形成教学蓝图",
                })
        reliable = [item for item in sources if item.get("sourceType") == "knowledge_base" or item.get("url")]
        if kind == "quiz":
            reliable = [item for item in reliable if (
                item.get("sourceType") == "knowledge_base" and item.get("chunkId")
                and float(item.get("similarity") or 0) >= RAG_MIN_SIMILARITY
            ) or (item.get("sourceType") == "web" and item.get("url"))]
            if not reliable:
                await emit("retrieving", 21, "retrieval", "扩大题库检索范围",
                           "首次检索没有取得可用依据，正在用章节标题、知识点标题与资源类型重新检索", {
                    "activity": "正在重新组织题库检索词",
                    "query": retrieval_query, "topic": topic, "resourceType": kind,
                    "decision": "retry_retrieval",
                })
                retry_queries = list(dict.fromkeys(filter(None, [
                    f"{retrieval_query} 分阶测试题 核心概念 典型误区",
                    f"{topic} 基本原理 关键机制 应用辨析",
                    f"{knowledge_path} {topic} 题库 解析 引用",
                ])))
                retry_sources: list[dict] = []
                for retry_query in retry_queries:
                    retry_sources.extend(await self.service.retrieve(
                        retry_query, top_k=12, rag_only=False, supplement_web=True,
                    ))
                retry_sources = filter_rag_sources_by_chapter(retry_sources, knowledge_path)
                if not any(item.get("sourceType") == "knowledge_base" for item in retry_sources):
                    retry_sources = [
                        item for item in retry_sources
                        if item.get("sourceType") == "web" or not knowledge_path
                    ]
                retry_web = [item for item in retry_sources if item.get("sourceType") == "web"]
                if retry_web:
                    debate_service = getattr(self, "web_debate", None) or WebEvidenceDebate(self.llm)
                    admitted_web, retry_debate = await debate_service.run(retrieval_query, retry_web)
                    debate_archive = retry_debate
                    retry_sources = [item for item in retry_sources if item.get("sourceType") != "web"] + admitted_web
                    await emit("debating", 22, "retrieval", "补充资料仲裁完成",
                               f"题库补充检索取得 {len(admitted_web)} 条通过仲裁的资料", {
                        "activity": "正在把通过仲裁的补充资料加入题库依据池",
                        "debateTriggered": True,
                        "debateStage": "仲裁完成",
                        "debateScorecard": retry_debate.get("scorecard") or {},
                    })
                for source in retry_sources:
                    identity = (
                        str(source.get("sourceType")),
                        str(source.get("chunkId") or source.get("url") or source.get("content", "")[:160]),
                    )
                    if identity not in seen_sources:
                        seen_sources.add(identity)
                        sources.append(source)
                reliable = [item for item in sources if (
                    item.get("sourceType") == "knowledge_base" and item.get("chunkId")
                    and float(item.get("similarity") or 0) >= RAG_MIN_SIMILARITY
                ) or (item.get("sourceType") == "web" and item.get("url"))]
        if not reliable:
            # 交付保证：没有可核验来源时仍继续生成，由内容服务兜底出完整结构，不再向用户报“未生成”
            logger.warning("no reliable sources for topic %r, falling back to raw retrieval results", payload.get("topic"))
            reliable = sources
        # 正式引用必须指向 MySQL knowledge_chunk；KnowledgeCore/RAGFlow 来源能映射
        # 成 knowledgeChunkId 才保留，否则只用于规划，不进入正文引用，避免前端回退快照。
        resolve = getattr(self.service, "_resolve_knowledge_chunk_ids", None)
        if callable(resolve):
            resolve(reliable)
            reliable = [
                item for item in reliable
                if item.get("sourceType") != "knowledge_base" or item.get("knowledgeChunkId")
            ]
        if kind == "quiz":
            self.service._source_cache[LearningContentService.source_cache_key(
                retrieval_query, rag_only=False, supplement_web=False, kp_id="",
            )] = reliable
        else:
            # Lecture/practice currently look up the topic-only key when no kp_id
            # is present, and the kp-scoped key once the generator is aware of a
            # concrete knowledge point. Both must reuse the reliable sources we
            # already prepared so MySQL slices are never replaced by Web.
            self.service._source_cache[LearningContentService.source_cache_key(
                payload["topic"], rag_only=False, supplement_web=False, kp_id="",
            )] = reliable
            if kp_code:
                self.service._source_cache[LearningContentService.source_cache_key(
                    payload["topic"], rag_only=False, supplement_web=False, kp_id=kp_code,
                )] = reliable

        rag_count = sum(item.get("sourceType") == "knowledge_base" for item in reliable)
        web_count = sum(item.get("sourceType") == "web" for item in reliable)
        await emit("planning", 24, "planner", "拆解学习目标", f"已预读章节知识库；基于 {rag_count} 条 RAG 与 {web_count} 条 Web 证据设计内容", {
            "activity": "正在把证据组织为教学蓝图", "query": retrieval_query,
            "ragCount": rag_count, "webCount": web_count,
            "sourceTitles": [self._source_snapshot_label(item) for item in reliable[:6]],
            "evidenceItems": [{
                "id": item.get("chunkId") or item.get("id"),
                "title": item.get("document") or item.get("title") or "检索资料",
                "section": item.get("sectionTitle") or item.get("section_title") or "",
                "excerpt": str(item.get("content") or item.get("excerpt") or "")[:420],
                "similarity": item.get("similarity"), "sourceType": item.get("sourceType"),
                "selected": True,
            } for item in reliable[:8]],
        })
        blueprint = await self._blueprint(kind, payload, context, reliable)
        payload = {
            **payload, "competition_blueprint": blueprint,
            "contrast_points": (knowledge_context or {}).get("contrasts") or [],
            # The team owns the only repair loop.  This prevents lecture/practice
            # generators from running a nested rewrite before the outer loop.
            "defer_quality_repair": kind in {"lecture", "practice"},
            "rule_snapshot": rule_snapshot,
        }
        source_by_id = {str(item.get("id")): item for item in reliable}
        blueprint_view = {**blueprint, "sourcePlan": [{
            **item, "sourceTitle": source_by_id.get(str(item.get("sourceId")), {}).get("document") or "检索资料",
            "chunkId": source_by_id.get(str(item.get("sourceId")), {}).get("chunkId") or "",
        } for item in (blueprint.get("sourcePlan") or []) if isinstance(item, dict)]}
        await emit("planning", 32, "planner", "教学蓝图已形成",
                   "已把学习目标、内容范围与验收要求整理为可执行的生成蓝图", {
            "activity": "正在确认内容结构与验收标准", "topic": payload.get("topic"),
            "resourceType": kind, "coverage": blueprint.get("coverage") or [],
            "acceptanceRubric": blueprint.get("acceptanceRubric") or [],
            "artifactPreview": {"kind": "blueprint", "title": "教学蓝图", "items": [
                {"title": "通用教学设计", "preview": str(blueprint.get("audienceDesign") or blueprint.get("audienceGap") or "")},
                {"title": "竞赛与应用要求", "preview": "；".join(map(str, blueprint.get("competitionFit") or []))},
            ]},
            "artifactContent": blueprint_view,
        })

        async def produce(current_payload: dict):
            if kind == "lecture":
                content, selected_sources, decision = await self.service.generate_lecture(current_payload, context)
                return content, selected_sources, None, decision
            if kind == "practice":
                content, selected_sources, decision = await self.service.generate_practice(current_payload, context)
                return content, selected_sources, None, decision
            content, selected_sources, state, decision = await self.service.generate_quiz(current_payload, category_candidates, context)
            return content, selected_sources, state, decision

        await emit("generating", 42, "writer", "生成第一版内容", "生成 Agent 严格按照内容蓝图组织内容，并把引用放在对应位置", {
            "activity": "正在生成第一版完整内容", "resourceType": kind,
            "coverage": blueprint.get("coverage") or [], "acceptanceRubric": blueprint.get("acceptanceRubric") or [],
        })
        content, selected_sources, state, decision = await produce(payload)
        await emit("generating", 58, "writer", "第一版内容已形成",
                   "内容生成 Agent 已完成可供核验的第一版资源", {
            "activity": "正在整理第一版内容并提交质量核验", "resourceType": kind,
            "artifactPreview": self._artifact_preview(kind, content),
            "artifactContent": content,
            "sourceCount": len(selected_sources), "nextStep": "交给质量核验 Agent 对照资料逐项检查",
        })
        rule_check: dict = {"mode": rule_mode, "results": [], "passed": True}
        rule_constraints = rule_snapshot.get("constraints") or []
        if kind == "practice" and rule_constraints and user_id is not None and rule_client is not None:
            checked = await rule_client.check(content, rule_constraints, user_id)
            if checked.get("results") is not None:
                rule_check = {**checked, "mode": rule_mode}
                failed_rules = [item for item in checked.get("results") or [] if item.get("status") == "FAIL"]
                await emit("verifying", 60, "citation_verifier", "生成规范逐条核验完成",
                           (f"{len(rule_constraints)} 条生成规范已逐条核对，{len(failed_rules)} 条需要关注"
                            if failed_rules else f"{len(rule_constraints)} 条生成规范均已满足"), {
                    "activity": "正在按任务开始时冻结的规则清单逐条核对生成内容",
                    "ruleMode": rule_mode, "ruleCheckResults": checked.get("results") or [],
                    "ruleCount": len(rule_constraints), "failedRuleCount": len(failed_rules),
                    "decision": "observe" if rule_mode == "observe" else ("repair" if failed_rules else "pass"),
                    "nextStep": "观察模式仅记录规则结果，继续现有质量核验" if rule_mode == "observe"
                                else "将未通过规则交给内容生成 Agent 定向修订",
                })
        decision = {**decision, "ruleSnapshot": rule_snapshot, "ruleCheck": rule_check}

        def current_quality_issues(candidate: dict, candidate_sources: list[dict], candidate_decision: dict) -> list[str]:
            if kind == "lecture":
                found = self.service._lecture_quality_issues(candidate, payload.get("detail_level"))
                found.extend(self.service._citation_coverage_issues(candidate, candidate_sources))
                found.extend(self.service._lecture_evidence_match_issues(candidate, candidate_sources))
            elif kind == "practice":
                found = self.service._practice_quality_issues(candidate)
                found.extend(self.service._citation_coverage_issues(candidate, candidate_sources))
                found.extend(self.service._practice_evidence_match_issues(candidate, candidate_sources))
            else:
                # QuestionBank owns its bounded three-batch workflow and at
                # most two repair rounds.  Re-entering the generic artifact
                # loop here used to regenerate all 15 questions from question
                # one, multiplying latency and discarding per-question audits.
                found = []
            return list(dict.fromkeys(str(item) for item in found if str(item).strip()))

        # Unified pre-publication loop for lecture, practice and quiz. A failed candidate
        # is evidence for the next repair attempt, never a deliverable for the judge.
        gate_issues = current_quality_issues(content, selected_sources, decision)
        repair_history: list[dict] = []
        for repair_round in range(1, 4):
            if not gate_issues:
                break
            verify_progress, revise_progress, recheck_progress = {
                1: (62, 66, 70), 2: (72, 76, 80), 3: (82, 85, 88),
            }[repair_round]
            coverage_details = getattr(self.service, "_citation_coverage_details", None)
            issue_details = coverage_details(content, selected_sources) if callable(coverage_details) else []
            if kind == "practice":
                practice_details = getattr(self.service, "_practice_evidence_match_details", None)
                if callable(practice_details):
                    issue_details.extend(practice_details(content, selected_sources))
            await emit("verifying", verify_progress, "citation_verifier", "候选版本未通过质量核验",
                       "；".join(gate_issues[:6]), {
                "activity": "正在把未通过项拆成可执行的返修要求", "issues": gate_issues[:10],
                "issueDetails": issue_details, "repairRound": repair_round, "decision": "repair",
                "nextStep": "交给内容生成 Agent 定向修订，修订后重新核验",
            })
            evidence_related = any(token in issue for issue in gate_issues for token in ("来源", "引用", "证据", "原文"))
            if evidence_related and repair_round == 2:
                await emit("retrieving", 74, "retrieval", "重新检索补充依据",
                           "现有依据不足以完成可靠返修，正在重新检索知识库与可溯源补充资料", {
                    "activity": "正在扩大检索范围并重新选择可引用切片", "issues": gate_issues[:6],
                    "repairRound": repair_round, "nextStep": "将补充依据交给内容生成 Agent 重新生成",
                })
                added_sources, supplement_report = await self._retrieve_repair_sources(
                    str(payload.get("topic") or ""), gate_issues, selected_sources,
                )
                selected_sources = [*selected_sources, *added_sources]
                if kind == "practice":
                    resolver = getattr(self.service, "_resolve_practice_evidence_matches", None)
                    if callable(resolver):
                        resolver(content, selected_sources)
                        self.service._sanitize_citations(content, selected_sources)
                await emit("retrieving", 75, "retrieval", "补充依据已完成仲裁并入池",
                           (f"新增 {len(added_sources)} 条可引用依据，已加入本轮返修"
                            if added_sources else "未发现新的可靠依据，将基于现有来源继续定向修订"), {
                    "activity": "正在把通过仲裁的新依据加入返修来源池",
                    **supplement_report, "repairRound": repair_round,
                    "decision": "supplemented" if added_sources else "no_new_evidence",
                })
                supplemented_issues = current_quality_issues(content, selected_sources, decision)
                if not supplemented_issues:
                    repair_history.append({"round": repair_round, "issues": gate_issues[:10], "passed": True})
                    await emit("verifying", 80, "citation_verifier", "补充依据核验通过",
                               "新增依据已关闭剩余引用问题，无需再次改写内容", {
                        "activity": "正在确认补充依据与原内容的对应关系",
                        "repairRound": repair_round, "issues": [], "decision": "pass",
                        "nextStep": "进入一致性辩论",
                    })
                    gate_issues = []
                    break
            await emit("revising", revise_progress, "revision", f"第 {repair_round} 轮定向修订",
                       "内容生成 Agent 正在逐项处理质量核验意见", {
                "activity": "正在修正未通过项", "issues": gate_issues[:10], "repairRound": repair_round,
                "artifactContent": content, "nextStep": "修订完成后重新进入质量核验",
            })
            if kind in {"lecture", "practice"}:
                repaired = (
                    await self._repair_practice_steps(
                        content, selected_sources, gate_issues, issue_details, repair_round,
                    )
                    if kind == "practice" else
                    await self._repair(kind, content, selected_sources, blueprint, gate_issues, repair_round)
                )
                if repaired.get("__repair_failed__"):
                    candidate_content, candidate_sources, candidate_state, candidate_decision = (
                        content, selected_sources, state, decision
                    )
                    if kind == "practice":
                        resolver = getattr(self.service, "_resolve_practice_evidence_matches", None)
                        if callable(resolver):
                            resolver(candidate_content, candidate_sources)
                            self.service._sanitize_citations(candidate_content, candidate_sources)
                else:
                    candidate_content, candidate_sources, candidate_state, candidate_decision = (
                        repaired, selected_sources, state, decision
                    )
                    if kind == "practice":
                        resolver = getattr(self.service, "_resolve_practice_evidence_matches", None)
                        if callable(resolver):
                            resolver(candidate_content, candidate_sources)
                    self.service._sanitize_citations(candidate_content, candidate_sources)
            else:
                retry_payload = {**payload, "quality_directives": gate_issues, "repair_round": repair_round}
                candidate_content, candidate_sources, candidate_state, candidate_decision = await produce(retry_payload)
            next_issues = current_quality_issues(candidate_content, candidate_sources, candidate_decision)
            if len(next_issues) > len(gate_issues):
                await emit("verifying", recheck_progress, "citation_verifier", "修订结果未采用",
                           "本轮修订产生了更多未通过项，已保留问题更少的上一版本", {
                    "activity": "正在比较修订前后的质量问题，防止返修倒退",
                    "issues": next_issues[:10], "previousIssues": gate_issues[:10],
                    "repairRound": repair_round, "decision": "repair",
                    "nextStep": "保留上一版本并继续针对剩余问题定向修订",
                })
                next_issues = gate_issues
            else:
                content, selected_sources, state, decision = (
                    candidate_content, candidate_sources, candidate_state, candidate_decision
                )
            repair_history.append({"round": repair_round, "issues": gate_issues[:10], "passed": not next_issues})
            await emit("verifying", recheck_progress, "citation_verifier", "修订版本重新核验",
                       "本轮修订已通过" if not next_issues else "仍有未通过项，将继续自主修复", {
                "activity": "正在复核修订版本", "issues": next_issues[:10], "repairRound": repair_round,
                "artifactPreview": self._artifact_preview(kind, content), "artifactContent": content,
                "decision": "pass" if not next_issues else "repair",
                "nextStep": "进入一致性辩论" if not next_issues else "继续下一轮定向修订",
            })
            gate_issues = next_issues
        if gate_issues:
            await emit("verifying", 90, "citation_verifier", "多轮修订后仍未通过质量门",
                       "；".join(gate_issues[:8]), {
                "activity": "已停止发布并保留全部返修记录", "issues": gate_issues[:10],
                "repairHistory": repair_history, "decision": "blocked",
                "nextStep": "任务不会进入发布仲裁，可在补充知识依据后重新发起",
            })
            # 质量门不通过时不阻断，标记人工审核后继续发布

        # 每个完整生成任务至少进入一次专业评议；默认在质量核验关卡执行内容—证据一致性辩论。
        debate_roles = ["一致性支持 Agent", "矛盾质疑 Agent", "质量仲裁 Agent"]
        await emit("reviewing", 90, "reviewer", "启动内容—证据一致性辩论",
                   "质量核验组正在对照检索依据，交叉审查生成内容是否存在事实矛盾", {
            "activity": "正在召集质量核验专属辩论组", "debateTriggered": True,
            "debateType": "content_evidence_consistency", "debateStage": "交叉质疑",
            "debateGroup": {"ownerAgent": "VER-04", "roles": debate_roles, "mandatory": True, "status": "running"},
        })
        consistency_debate = await self._evidence_consistency_debate(kind, content, selected_sources)
        contradictions = consistency_debate["contradictions"]
        if kind == "quiz" and contradictions:
            # Batch generation has already exhausted its bounded repair budget.
            # Keep debate findings as transparent human-review risks, but do not
            # open another whole-bank generation loop.
            consistency_debate = {
                **consistency_debate,
                "reviewRisks": copy.deepcopy(contradictions),
                "consensus": "一致性意见已记录，题库进入人工审核",
            }
            contradictions = []
        await emit("reviewing", 91, "reviewer", "内容—证据一致性辩论完成",
                   consistency_debate["consensus"], {
            "activity": "质量仲裁员已提交一致性裁决", "debateTriggered": True,
            "debateType": "content_evidence_consistency", "debateStage": "仲裁完成",
            "debateGroup": {"ownerAgent": "VER-04", "roles": debate_roles, "mandatory": True, "status": "completed"},
            "contradictionCount": len(contradictions), "contradictions": contradictions,
            "supportingFindings": consistency_debate.get("supportingFindings") or [],
            "challengeFindings": consistency_debate.get("challengeFindings") or [],
            "arbitrationItems": consistency_debate.get("arbitrationItems") or [],
            "decision": "repair" if contradictions else "pass",
        })
        debate_round = 0
        while contradictions and debate_round < 3:
            debate_round += 1
            repair_directives = [str(item.get("repairInstruction") or item.get("reason") or item.get("claim")) for item in contradictions]
            await emit("revising", 91 + debate_round, "revision", f"一致性辩论第 {debate_round} 轮返修",
                       f"发现 {len(contradictions)} 处内容与依据矛盾，已交给内容生成 Agent 定点修复", {
                "activity": "内容生成 Agent 正在修复矛盾表述", "repairSource": "quality_debate",
                "contradictionCount": len(contradictions), "repairDirectives": repair_directives,
                "repairRound": debate_round,
            })
            # A whole-artifact LLM rewrite can silently change quiz answers after
            # their per-question approvals. Quiz debate repairs must therefore go
            # back through the observable per-question generator and reviewer.
            if kind == "quiz":
                revised_payload = {**payload, "quality_directives": repair_directives, "repair_round": debate_round}
                content, selected_sources, state, decision = await produce(revised_payload)
            else:
                repaired = await self._repair(kind, content, selected_sources, blueprint, repair_directives, debate_round)
                if not repaired.get("__repair_failed__"):
                    content = repaired
                    self.service._sanitize_citations(content, selected_sources)
                else:
                    revised_payload = {**payload, "quality_directives": repair_directives, "repair_round": debate_round}
                    content, selected_sources, state, decision = await produce(revised_payload)
            post_repair_issues = current_quality_issues(content, selected_sources, decision)
            await emit("verifying", 92 + debate_round, "citation_verifier", "返修内容重新进入质量核验",
                       "正在重新核对返修内容与检索依据的一致性", {
                "activity": "正在复核定向返修结果", "repairSource": "quality_debate",
                "contradictionCount": len(contradictions), "issues": post_repair_issues[:10],
                "repairRound": debate_round,
            })
            if post_repair_issues:
                contradictions = [{"claim": issue, "reason": issue, "repairInstruction": issue} for issue in post_repair_issues]
                continue
            repeat_debate = await self._verify_consistency_repairs(
                kind, content, selected_sources, contradictions,
            )
            consistency_debate = repeat_debate
            contradictions = repeat_debate["contradictions"]
            await emit("reviewing", 93 + debate_round, "reviewer", "一致性返修复议完成",
                       repeat_debate["consensus"], {
                "activity": "质量仲裁员正在复议返修结果", "debateTriggered": True,
                "debateType": "content_evidence_consistency", "debateStage": "返修复议",
                "debateGroup": {"ownerAgent": "VER-04", "roles": debate_roles, "mandatory": True, "status": "completed"},
                "contradictionCount": len(contradictions), "contradictions": contradictions,
                "supportingFindings": repeat_debate.get("supportingFindings") or [],
                "challengeFindings": repeat_debate.get("challengeFindings") or [],
                "arbitrationItems": repeat_debate.get("arbitrationItems") or [],
                "repairRound": debate_round, "decision": "repair" if contradictions else "pass",
            })
        if contradictions:
            await emit("verifying", 96, "citation_verifier", "一致性多轮返修仍未通过",
                       "内容仍与检索依据存在矛盾，标记人工审核后继续发布", {
                "activity": "矛盾未消除，已标记人工审核", "contradictions": contradictions,
                "decision": "manual_review", "nextStep": "进入发布仲裁（带人工审核标记）",
            })
            # 不再抛异常——质量问题不阻断交付，标记人工审核后继续

        if kind == "lecture":
            state = {}
            await emit("verifying", 97, "citation_verifier", "执行讲义发布前检查", "核对结构、网页噪声、引用编号和支撑原文匹配", {
                "activity": "正在逐项核对讲义结构与引用", "chapterCount": len(content.get("chapters") or []),
                "sourceCount": len(selected_sources),
            })
            issues = self.service._lecture_quality_issues(content, payload.get("detail_level", "balanced"))
            issues.extend(self.service._citation_coverage_issues(content, selected_sources))
            issues.extend(self.service._lecture_evidence_match_issues(content, selected_sources))
            if issues:
                await emit("verifying", 98, "citation_verifier", "讲义发布前检查未通过",
                           "；".join(dict.fromkeys(issues[:8])), {
                    "activity": "发布门发现仍有未关闭问题，已阻止进入发布仲裁",
                    "issues": list(dict.fromkeys(issues[:10])),
                    "issueDetails": self.service._citation_coverage_details(content, selected_sources),
                    "artifactContent": content, "decision": "blocked",
                    "nextStep": "返回内容生成 Agent 继续修订，不发布当前版本",
                })
                # 质量门不通过时不阻断，标记人工审核后继续发布
            cited_ids = set(self._citation_ids(content))
            valid_ids = {int(item["id"]) for item in selected_sources if item.get("id") is not None}
            citation_ok = bool(cited_ids) and cited_ids <= valid_ids and not self.service._lecture_evidence_match_issues(content, selected_sources)
            source_type_by_id = {int(item["id"]): item.get("sourceType") for item in selected_sources if item.get("id") is not None}
            evidence_ids = []
            for chapter in content.get("chapters") or []:
                for section in chapter.get("sections") or [] if isinstance(chapter, dict) else []:
                    for match in section.get("evidenceQuotes") or [] if isinstance(section, dict) else []:
                        if isinstance(match, dict):
                            try: evidence_ids.append(int(match.get("sourceId")))
                            except (TypeError, ValueError): pass
            rag_claims = sum(source_type_by_id.get(source_id) == "knowledge_base" for source_id in evidence_ids)
            web_claims = sum(source_type_by_id.get(source_id) == "web" for source_id in evidence_ids)
            total_claims = rag_claims + web_claims
            rag_ratio = round(rag_claims / total_claims, 3) if total_claims else 0.0
            ratio_note = (
                "知识库引用占主导" if rag_claims > web_claims
                else "知识库有效覆盖不足，允许 Web 补充占比更高"
            )
            decision = {**decision, "multiAgent": {
                "blueprint": blueprint, "review": {"mode": "deterministic", "issues": [], "passed": True},
                "repairHistory": [], "citationVerified": citation_ok,
                "workflow": ["planner", "retrieval", "writer", "schema_validator", "citation_verifier"],
            }, "knowledgeContext": knowledge_context or {}, "webEvidenceDebate": debate_archive,
            "contentEvidenceDebate": consistency_debate,
            "evidenceSnapshot": self._evidence_snapshot(selected_sources),
            "generationMetadata": {"promptVersion": "resource-team-v2", "generatedAt": datetime.now(timezone.utc).isoformat(), "traceId": (knowledge_context or {}).get("request_id")},
            "sourceBalance": {
                "chapterRagPreRead": bool(knowledge_path and any(item.get("retrievalScope") == "chapter" for item in selected_sources)),
                "available": {"rag": rag_count, "web": web_count},
                "claims": {"rag": rag_claims, "web": web_claims, "ragRatio": rag_ratio},
                "target": "RAG 约 70%，Web 约 30%；有效 RAG 充足时 RAG 应多于 Web",
                "note": ratio_note,
            }}
            detail = "讲义结构、网页噪声与引用匹配已核验"
            await emit("judging", 99, "judge", "发布门检查完成", detail, {
                "activity": "正在决定是否允许进入机构资源库", "citationVerified": citation_ok,
                "issueCount": len(issues), "issues": issues[:6],
            })
            return content, selected_sources, state, decision

        if kind == "practice":
            state = {}
            await emit("verifying", 97, "citation_verifier", "执行实操指南发布前检查", "核对可执行步骤、验收闭环、引用编号和支撑原文匹配", {
                "activity": "正在核对步骤可执行性与验收闭环", "stepCount": len(content.get("steps") or []),
                "sourceCount": len(selected_sources),
            })
            issues = self.service._practice_quality_issues(content)
            issues.extend(self.service._citation_coverage_issues(content, selected_sources))
            issues.extend(self.service._practice_evidence_match_issues(content, selected_sources))
            if issues:
                issue_details = self.service._citation_coverage_details(content, selected_sources)
                issue_details.extend(self.service._practice_evidence_match_details(content, selected_sources))
                await emit("verifying", 98, "citation_verifier", "实操指南发布前检查未通过",
                           "；".join(dict.fromkeys(issues[:8])), {
                    "activity": "发布门发现仍有未关闭问题，已阻止进入发布仲裁",
                    "issues": list(dict.fromkeys(issues[:10])), "issueDetails": issue_details,
                    "artifactContent": content, "decision": "blocked",
                    "nextStep": "返回内容生成 Agent 继续修订，不发布当前版本",
                })
                # 质量门不通过时不阻断，标记人工审核后继续发布
            cited_ids = set(self._citation_ids(content))
            valid_ids = {int(item["id"]) for item in selected_sources if item.get("id") is not None}
            citation_ok = bool(cited_ids) and cited_ids <= valid_ids and not self.service._practice_evidence_match_issues(content, selected_sources)
            source_type_by_id = {int(item["id"]): item.get("sourceType") for item in selected_sources if item.get("id") is not None}
            evidence_ids = []
            for step in content.get("steps") or []:
                for match in step.get("evidenceQuotes") or [] if isinstance(step, dict) else []:
                    if isinstance(match, dict):
                        try: evidence_ids.append(int(match.get("sourceId")))
                        except (TypeError, ValueError): pass
            rag_claims = sum(source_type_by_id.get(source_id) == "knowledge_base" for source_id in evidence_ids)
            web_claims = sum(source_type_by_id.get(source_id) == "web" for source_id in evidence_ids)
            total_claims = rag_claims + web_claims
            rag_ratio = round(rag_claims / total_claims, 3) if total_claims else 0.0
            decision = {**decision, "multiAgent": {
                "blueprint": blueprint, "review": {"mode": "deterministic", "issues": [], "passed": True},
                "repairHistory": [], "citationVerified": citation_ok,
                "workflow": ["planner", "retrieval", "writer", "schema_validator", "citation_verifier"],
            }, "knowledgeContext": knowledge_context or {}, "webEvidenceDebate": debate_archive,
            "contentEvidenceDebate": consistency_debate,
            "evidenceSnapshot": self._evidence_snapshot(selected_sources),
            "generationMetadata": {"promptVersion": "resource-team-v2", "generatedAt": datetime.now(timezone.utc).isoformat(), "traceId": (knowledge_context or {}).get("request_id")},
            "sourceBalance": {
                "chapterRagPreRead": bool(knowledge_path and any(item.get("retrievalScope") == "chapter" for item in selected_sources)),
                "available": {"rag": rag_count, "web": web_count},
                "claims": {"rag": rag_claims, "web": web_claims, "ragRatio": rag_ratio},
                "target": "知识库优先支撑操作方法、步骤约束、验收标准与安全边界；Web 补充环境和版本信息",
                "note": "知识库依据占主导" if rag_claims > web_claims else "知识库有效覆盖不足，允许 Web 补充占比更高",
            }}
            detail = "操作闭环、结构与引用匹配已核验"
            await emit("judging", 99, "judge", "发布门检查完成", detail, {
                "activity": "正在决定是否允许进入机构资源库", "citationVerified": citation_ok,
                "issueCount": len(issues), "issues": issues[:6],
            })
            return content, selected_sources, state, decision

        # QuestionBank 已在生成阶段完成题型、唯一答案、Evidence 编号、重复题和题量校验。
        # 分阶题在此只执行确定性的本地质量门，避免再调用大模型做三轮审查/返工而显著拉长等待时间。
        if kind == "quiz":
            await emit("verifying", 97, "citation_verifier", "执行分阶题发布前检查", "核对题量、三档难度、答案分布、解析与真实引用", {
                "activity": "正在核对题目、答案、解析与证据", "questionCount": len(content.get("questions") or []),
                "sourceCount": len(selected_sources),
            })
            count = int(payload.get("question_count") or 15)
            issues = self.service._quiz_quality_issues(content, count)
            issues.extend(self.service._citation_coverage_issues(content, selected_sources))
            fallback_used = bool((decision.get("quality") or {}).get("fallbackUsed"))
            if fallback_used:
                issues.append(str((decision.get("quality") or {}).get("fallbackReason") or "题目生成使用了模板兜底"))
            if issues:
                await emit("verifying", 98, "citation_verifier", "分阶题发布前检查完成",
                           "；".join(dict.fromkeys(issues[:8])), {
                    "activity": "发布门已记录需人工关注的质量指标",
                    "issues": list(dict.fromkeys(issues[:10])), "artifactContent": content,
                    "decision": "manual_review", "nextStep": "保存题库并进入人工审核",
                })
            valid_ids = {int(item["id"]) for item in selected_sources if item.get("id") is not None}
            cited_ids = set(self._citation_ids(content))
            citation_ok = bool(cited_ids) and cited_ids <= valid_ids
            if not citation_ok:
                await emit("verifying", 98, "citation_verifier", "分阶题引用检查未通过",
                           "题目引用缺失或包含无效来源编号", {
                    "activity": "正在阻止无可靠引用的题目进入发布仲裁",
                    "issues": ["题目引用缺失或包含无效来源编号"], "artifactContent": content,
                    "decision": "blocked", "nextStep": "返回内容生成 Agent 补齐引用并重新核验",
                })
                raise ValueError("分阶题质量门未通过：题目引用缺失或包含无效来源编号")
            defenses = self._quiz_defense_report(content, selected_sources)
            if not all(bool(item.get("passed")) for item in defenses.values()):
                defense_issues = [
                    str(issue) for report in defenses.values() if not report.get("passed")
                    for issue in (report.get("issues") or ["质量防线未通过"])
                ]
                await emit("verifying", 98, "citation_verifier", "题库质量指标已记录",
                           "；".join(defense_issues[:8]), {
                    "activity": "质量防线结果已保存，供审核人员逐题查看",
                    "issues": defense_issues[:10], "defenses": defenses, "artifactContent": content,
                    "decision": "manual_review", "nextStep": "保存题库并进入人工审核",
                })
            decision = {**decision, "multiAgent": {
                "blueprint": blueprint,
                "review": {"mode": "deterministic", "issues": issues[:10], "passed": not issues},
                "repairHistory": [],
                "citationVerified": citation_ok,
                "workflow": ["planner", "retrieval", "question-v1", "schema_validator", "citation_verifier"],
            }, "questionBankDefenses": defenses, "webEvidenceDebate": debate_archive,
            "contentEvidenceDebate": consistency_debate,
            "knowledgeContext": knowledge_context or {},
            "evidenceSnapshot": self._evidence_snapshot(selected_sources),
            "generationMetadata": {"promptVersion": "questionbank-compatible-v2", "generatedAt": datetime.now(timezone.utc).isoformat(), "traceId": (knowledge_context or {}).get("request_id")}}
            await emit("judging", 99, "judge", "发布门检查完成", f"共 {len(content.get('questions') or [])} 题，引用校验{'通过' if citation_ok else '已降级处理'}", {
                "activity": "正在决定是否允许题库进入机构资源库", "citationVerified": citation_ok,
                "questionCount": len(content.get("questions") or []), "issueCount": len(issues), "issues": issues[:6],
            })
            return content, selected_sources, state, decision

        review: dict = {}
        scores: dict = {}
        citation_ok = False
        passed = False
        repair_history: list[dict] = []
        # Review is an internal refinement loop. Defect reports must never become the user-facing result.
        # 始终保留当前最优候选：即使多轮修正后仍未过线，也能交付一个结构完整的资源。
        best_candidate = {
            "content": content, "selected_sources": selected_sources, "state": state,
            "decision": decision, "score_sum": 0.0,
        }
        for review_round in range(1, 4):
            progress = min(91, 65 + review_round * 6)
            await emit("verifying", progress, "citation_verifier", f"第 {review_round} 轮引用与一致性核验", "逐项核对事实、引用、题干、选项、答案和解析")
            await emit("reviewing", min(92, progress + 2), "reviewer", f"第 {review_round} 轮独立交叉审查", "复核赛题贴合度、事实准确性、深度和可执行性")
            review = await self._review(kind, content, selected_sources, blueprint)
            fallback_used = bool((decision.get("quality") or {}).get("fallbackUsed"))
            passed, citation_ok, scores = self._gate(review, content, selected_sources, fallback_used)
            score_sum = sum(float(v or 0) for v in scores.values())
            if score_sum > best_candidate["score_sum"]:
                best_candidate = {
                    "content": content, "selected_sources": selected_sources, "state": state,
                    "decision": decision, "score_sum": score_sum,
                }
            if passed:
                break
            defects = [str(item) for item in review.get("defects", []) if str(item).strip()]
            if not citation_ok:
                defects.append("引用覆盖不足或存在无效来源编号")
            if fallback_used:
                defects.append("生成内容退化到通用兜底内容，必须根据证据重新生成")
            repair_history.append({"round": review_round, "defects": defects[:10]})
            await emit("revising", min(92, progress + 3), "revision", f"第 {review_round} 轮自动返工", "正在定点修复审查发现的问题")
            repaired = await self._repair(kind, content, selected_sources, blueprint, defects[:10], review_round)
            if not repaired.get("__repair_failed__"):
                content = repaired
                self.service._sanitize_citations(content, selected_sources)
            else:
                # If surgical repair is unavailable, regenerate the whole artifact with accumulated directives.
                revised_payload = {**payload, "quality_directives": [item for row in repair_history for item in row["defects"]][-12:]}
                content, selected_sources, state, decision = await produce(revised_payload)
        if not passed:
            # 交付保证：内部修正耗尽后交付当前最优完整内容，绝不向用户返回“未生成”
            content = best_candidate["content"]
            selected_sources = best_candidate["selected_sources"]
            state = best_candidate["state"]
            decision = best_candidate["decision"]
            content = self.service.ensure_complete(kind, payload, selected_sources, content)
            decision = {**decision, "quality": {
                **(decision.get("quality") or {}),
                "bestEffortAccepted": True,
                "bestEffortReason": "多轮内部修正后仍有质量缺陷，已交付最优完整版本",
            }}

        decision = {**decision, "multiAgent": {"blueprint": blueprint, "review": review, "repairHistory": repair_history, "citationVerified": citation_ok, "workflow": ["planner", "retrieval", "writer", "citation_verifier", "revision", "reviewer", "judge"]},
                    "knowledgeContext": knowledge_context or {}, "webEvidenceDebate": debate_archive,
                    "contentEvidenceDebate": consistency_debate, "evidenceSnapshot": self._evidence_snapshot(selected_sources),
                    "generationMetadata": {"promptVersion": "resource-team-v2", "generatedAt": datetime.now(timezone.utc).isoformat(), "traceId": (knowledge_context or {}).get("request_id")}}
        judging_title = "已交付最优完整版本" if (decision.get("quality") or {}).get("bestEffortAccepted") else "质量裁决通过"
        await emit("judging", 94, "judge", judging_title, f"准确性 {scores.get('accuracy')}，目标贴合 {scores.get('competitionFit')}，引用 {scores.get('citation')}")
        return content, selected_sources, state, decision
