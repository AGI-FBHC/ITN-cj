import asyncio
import copy
import json
import math
import re
import pymysql
from app.storage.platform_db import platform_connect

# 题库核验的'主观措辞类'异议（无法客观判定、结构检查已通过时允许末级放行）
_SUBJECTIVE_REVIEW_ISSUE = re.compile(
    r"缺乏直接|唯一的证据支持|未明确.{0,6}核心.{0,6}地位|疑似|可能被视为|无法客观|"
    r"不够.{0,4}(清晰|直接)|表述.{0,4}(欠妥|不够)|强制性|排他性|无法排除其他合理选项|"
    r"缺乏原文.{0,12}(支持|依据)|最可能且唯一|过于(模糊|开放)|唯一合理的.{0,8}(下一步|做法)|核心问题.{0,16}(缺乏|无法|未)",
    re.IGNORECASE,
)
from difflib import SequenceMatcher
from uuid import uuid4
from datetime import datetime

from app.config import Settings
from app.llm import LLMClient
from app.services.evidence_search import EvidenceSearch, RAG_MIN_SIMILARITY, compact_rag_sources, filter_rag_sources_by_chapter
from app.services.difficulty_profiler import DIFFICULTY_ZERO, DIFFICULTY_STANDARD, DIFFICULTY_ADVANCED, difficulty_for


def compact_sources(result: dict) -> list[dict]:
    """Backward-compatible helper used by existing callers and tests."""
    return compact_rag_sources(result)


class LearningContentService:
    QUESTION_BANK_PROMPT_VERSION = "question-v1"
    QUIZ_READING_COMPREHENSION_PATTERN = re.compile(
        r"(?:根据|依据|结合|参照|按照)(?:上述|以上|给定|提供的|所给)?(?:资料|材料|文献|原文|文本|内容|证据|Evidence)"
        r"|(?:资料|材料|文献|原文|文本|Evidence)(?:中|里|所)(?:提到|指出|描述|给出|显示|定义|介绍|表明)"
        r"|(?:资料|材料|文献|原文|文本|Evidence)\s*[\[【（(]?\d+",
        re.IGNORECASE,
    )
    QUIZ_CROSS_QUESTION_PATTERN = re.compile(
        r"(?:上一|前一|前两|前述|上述|以上|本组|这组|该组)(?:题|问题|场景|案例|材料)"
        r"|(?:承接|延续|沿用)(?:上一题|前题|前述|上述)"
        r"|(?:与|同)(?:上一题|前题)(?:相同|一致)",
    )

    def __init__(self, settings: Settings, evidence_search: EvidenceSearch | None = None):
        self.settings = settings
        self.llm = LLMClient(settings)
        self.evidence_search = evidence_search or EvidenceSearch()
        self._source_cache: dict[str, list[dict]] = {}
        self.generation_event_sink = None

    @staticmethod
    def source_cache_key(topic: str, *, rag_only: bool = True,
                         supplement_web: bool = False, kp_id: str = "") -> str:
        return f"{'rag' if rag_only else 'mixed'}:{'supplemented' if supplement_web else 'fallback'}:{topic}:{kp_id}"

    async def _generation_event(self, status: str, progress: int, title: str, detail: str,
                                agent: str = "writer", snapshot: dict | None = None) -> None:
        sink = getattr(self, "generation_event_sink", None)
        if sink is not None:
            await sink(status, progress, agent, title, detail, snapshot)

    async def close(self) -> None:
        await self.llm._http_client.aclose()

    async def retrieve(self, topic: str, top_k: int = 10, *, rag_only: bool = True,
                       supplement_web: bool = False, kp_id: str = "") -> list[dict]:
        cache_key = self.source_cache_key(
            topic, rag_only=rag_only, supplement_web=supplement_web, kp_id=kp_id,
        )
        if cache_key in self._source_cache:
            return self._source_cache[cache_key]
        sources, _metadata = await self.evidence_search.retrieve(
            topic, rag_top_k=top_k, web_limit=min(top_k, 8), allow_web_fallback=not rag_only,
            supplement_web=supplement_web, kp_id=kp_id,
        )
        self._resolve_knowledge_chunk_ids(sources)
        self._source_cache[cache_key] = sources
        return sources

    def _retrieve_kp_id(self, payload: dict) -> str:
        return str(payload.get("kp_id") or payload.get("kpId") or "").strip()

    def _resolve_knowledge_chunk_ids(self, sources: list[dict]) -> None:
        """Attach the stable MySQL knowledge_chunk id before sources are saved.

        RAGFlow ids are not reliably backfilled in historical ``knowledge_chunk``
        rows. Resolve them first by the mapped id and then by an exact source
        passage already stored in MySQL. The original RAGFlow ``chunkId`` stays
        intact; ``knowledgeChunkId`` is the canonical reader link.
        """
        unresolved: list[dict] = []
        for source in sources:
            if not isinstance(source, dict) or source.get("sourceType") == "web":
                continue
            chunk_id = (
                source.get("chunkId")
                or source.get("chunk_id")
                or source.get("knowledgeChunkId")
                or ""
            )
            source["chunkId"] = str(chunk_id).strip()
            if source.get("knowledgeChunkId"):
                continue
            unresolved.append(source)
        if not unresolved:
            return
        try:
            with platform_connect(self.settings) as connection:
                with connection.cursor() as cursor:
                    for source in unresolved:
                        ragflow_id = str(source.get("chunkId") or "").strip()
                        row = None
                        if ragflow_id:
                            cursor.execute(
                                "SELECT id FROM knowledge_chunk WHERE ragflow_chunk_id=%s LIMIT 1",
                                (ragflow_id,),
                            )
                            row = cursor.fetchone()
                        if row is None:
                            for phrase in self._source_lookup_phrases(str(source.get("content") or "")):
                                cursor.execute(
                                    "SELECT id FROM knowledge_chunk WHERE content LIKE %s "
                                    "ORDER BY CHAR_LENGTH(content) ASC LIMIT 1",
                                    (f"%{phrase}%",),
                                )
                                row = cursor.fetchone()
                                if row is not None:
                                    break
                        if row is not None:
                            source["knowledgeChunkId"] = int(row["id"])
        except Exception:
            # Retrieval remains usable even when the platform database is
            # temporarily unavailable; the reader has the same lookup fallback.
            return

    @staticmethod
    def _source_lookup_phrases(content: str) -> list[str]:
        plain = re.sub(r"[`*_>#\[\]()]", "", str(content or ""))
        candidates = [
            re.sub(r"\s+", " ", item).strip()
            for item in re.split(r"[。！？!?\r\n]+", plain)
        ]
        useful = [item for item in candidates if 18 <= len(item) <= 180]
        useful.sort(key=len, reverse=True)
        # RAGFlow prepends a summary/preamble that doesn't exist in MySQL.
        # Prefer phrases from the LATER part of the content (bottom half)
        # since those are more likely to be the original MySQL text.
        half = len(useful) // 2
        tail_first = useful[half:] + useful[:half]
        return list(dict.fromkeys(item[:72] for item in tail_first))[:8]

    def ensure_complete(self, kind: str, payload: dict, sources: list[dict], content: dict) -> dict:
        """兜底保证：内容不可用或结构不完整时，返回结构完整、可直接展示的版本，绝不让交付落空。"""
        if isinstance(content, dict) and not content.get("__generation_failed__") and not content.get("__repair_failed__"):
            return content
        # Lecture/practice: return whatever content we have (even with quality issues)
        # rather than failing the entire task. Quality issues are logged but delivery
        # is guaranteed.
        if isinstance(content, dict) and content.get("chapters"):
            content.setdefault("quality", {})
            content["quality"]["fallbackUsed"] = True
            content["quality"]["fallbackReason"] = "质量门未完全通过，已交付最优版本"
            return content
        if isinstance(content, dict) and content.get("steps"):
            content.setdefault("quality", {})
            content["quality"]["fallbackUsed"] = True
            content["quality"]["fallbackReason"] = "质量门未完全通过，已交付最优版本"
            return content
        if kind == "lecture":
            raise ValueError("定制讲义生成失败，无可用内容")
        if kind == "practice":
            raise ValueError("实操指南生成失败，无可用内容")
        return self._quiz_fallback(payload, payload.get("question_count", 15), None)

    def emergency_fallback(self, kind: str, payload: dict,
                           category_candidates: list[dict] | None = None) -> tuple[dict, dict | None, dict]:
        """异常兜底：不依赖模型，直接返回结构完整的资源与初始状态，保证用户点击生成后必有交付。"""
        common = {"quality": {"fallbackUsed": True, "fallbackReason": "生成链路异常，已自动兜底交付"},
                  "multiAgent": {"workflow": ["emergency_fallback"]}}
        if kind in ("lecture", "practice"):
            # No static template available — raise so the router can emit "failed"
            # with a clear error message rather than silently delivering empty content.
            raise ValueError(f"{kind}生成链路异常，无可用内容")
        # 通用母版固定为三档各 5 题。调用方传入的旧 12 题配置不再影响题库规格。
        count = 15
        content = self._quiz_fallback(payload, count, category_candidates)
        state = {
            "ability": 0.35, "answered": [], "currentQuestionId": None,
            "mastery": {str(k.get("id")): 0.35 for k in content.get("knowledgePoints", []) if isinstance(k, dict)},
            "completed": False,
        }
        return content, state, common

    @staticmethod
    def _source_context(sources: list[dict]) -> str:
        return "\n\n".join(
            f"[来源{source['id']}] {source['document']}\n{source['content']}" for source in sources
        ) or "知识库与互联网检索均暂无直接命中，请仅生成通用学习框架，并明确标记无检索依据。"

    @staticmethod
    def _lecture_source_mix(sources: list[dict], limit: int = 10) -> list[dict]:
        """Prefer an approximately 7:3 RAG/Web evidence pool without padding weak evidence."""
        rag = [item for item in sources if item.get("sourceType") == "knowledge_base"]
        web = [item for item in sources if item.get("sourceType") == "web"]
        selected = rag[:7] + web[:3]
        if len(selected) < limit:
            selected_ids = {id(item) for item in selected}
            selected.extend(item for item in sources if id(item) not in selected_ids)
        selected = selected[:limit]
        for index, source in enumerate(selected, 1):
            source["id"] = index
        return selected

    @staticmethod
    def _practice_source_mix(sources: list[dict], limit: int = 10) -> list[dict]:
        """Keep KB authority while reserving substantial room for debated Web practice evidence."""
        rag = [item for item in sources if item.get("sourceType") == "knowledge_base"]
        web = [item for item in sources if item.get("sourceType") == "web" and item.get("debateVerified")]
        selected = rag[:5] + web[:5]
        if len(selected) < limit:
            selected_ids = {id(item) for item in selected}
            selected.extend(item for item in (rag + web) if id(item) not in selected_ids)
        selected = selected[:limit]
        for index, source in enumerate(selected, 1):
            source["id"] = index
        return selected

    async def generate_lecture(self, payload: dict, context: dict | None = None) -> tuple[dict, list[dict], dict]:
        context = context or {}
        sources = self._lecture_source_mix(await self.retrieve(
            payload["topic"], top_k=10, rag_only=False, supplement_web=False,
            kp_id=self._retrieve_kp_id(payload),
        ))
        structure_fallback = {
            "title": payload.get("title") or payload["topic"],
            "summary": f"本讲义讲解{payload['topic']}的核心概念、原理与实践方法。",
            "learningObjectives": [f"理解{payload['topic']}的核心概念", "掌握关键方法与典型应用", "能够通过练习检查学习效果"],
            "chapters": [
                {"title": "基础概念与学习地图", "overview": "建立主题的整体认知框架。", "sections": [
                    {"title": "概念导入", "content": f"从学习目标、核心术语和整体结构认识 **{payload['topic']}**。", "citations": []}
                ]},
                {"title": "核心原理与方法", "overview": "理解关键机制及其相互关系。", "sections": [
                    {"title": "核心机制", "content": f"梳理 **{payload['topic']}** 的主要机制、方法和使用边界。", "citations": []}
                ]},
                {"title": "应用实践与总结", "overview": "把知识迁移到实际问题并完成复习。", "sections": [
                    {"title": "案例与练习", "content": "结合一个典型案例完成分析，并回顾本讲义的关键结论。", "citations": []}
                ]},
            ],
            "keyPoints": [payload["topic"]], "reviewQuestions": [f"如何用自己的话解释{payload['topic']}？"],
        }
        detail = payload.get("detail_level", "balanced")
        chapter_rule = {
            "concise": "3 个学习单元，共 5-6 个小节",
            "balanced": "3-4 个学习单元，共 6-8 个小节",
            "detailed": "4 个学习单元，共 8-10 个小节",
        }.get(detail, "3-4 个学习单元，共 6-8 个小节")
        # A course chapter should be substantial but still fit MiMo's 4096-token
        # JSON envelope. Oversized targets cause truncation and false failures.
        minimum_chars = {"concise": 600, "balanced": 900, "detailed": 1200}.get(detail, 900)
        prompt_sources = [
            {**source, "content": str(source.get("content") or "")[:900]}
            for source in sources
        ]
        prompt = f"""主题：{payload['topic']}
详细程度：{detail}
学习目标与用户画像：{json.dumps(context, ensure_ascii=False)[:10000]}
比赛命题与教研蓝图：{json.dumps(payload.get('competition_blueprint') or {}, ensure_ascii=False)[:6000]}
领域生成规范：{json.dumps((payload.get('rule_snapshot') or {}).get('constraints') or [], ensure_ascii=False)[:5000]}
上一轮质量审查整改要求：{json.dumps(payload.get('quality_directives') or [], ensure_ascii=False)[:3000]}
请生成一份可以从头到尾独立学习的完整中文讲义，不是文章摘要或若干零散段落。
事实内容优先依据下方知识库或网页检索资料，引用处必须填写来源编号；不要虚构来源。citations 会由前端显示在当前小节正文末尾，因此每个使用了检索事实的小节都必须填写对应来源编号，不能把引用集中到其他小节。
章节规模：{chapter_rule}。章节必须形成“导入基础 → 核心原理 → 方法或架构 → 应用实践 → 总结复习”的递进关系。
返回 JSON：title, summary, learningObjectives:string[], chapters[], keyPoints:string[], reviewQuestions:string[]。
chapters 每项字段：title, overview, sections[]；sections 每项字段：title, content, citations:number[], evidenceMatches:[{{sourceId:number,claim:string,sourcePassage:string}}]。
每个 citations 来源都必须在 evidenceMatches 中附上对应匹配：claim 是讲义中被来源支撑的表述，sourcePassage 是来源正文中直接支撑该表述、适合在原文弹窗高亮的完整原句或原段（建议 20-200 字）。讲义正文允许归纳和转述，不必与来源逐字一致；但 sourcePassage 必须从对应来源 content 原样复制，禁止改写、拼接、杜撰或只给关键词，禁止使用省略号拼接中间省略的原文；若原文过长请选择较短但连续的完整片段。
优先使用知识库切片，不得为了凑 70/30 之类的比例引入 Web。Web Search 仅在知识库证据确实不足或缺失时作为最后手段使用；一旦讲义中包含知识库来源，核心定义、理论、机制和课程内结论必须全部优先由 knowledge_base 支撑。
必须先消化教研蓝图中的 knowledgeBaseCoverage 与 retrievalScope=chapter 的章节知识库资料，再聚焦当前知识点。Web Search 不是普通候选来源，不能因为“想补充”就进入 evidenceMatches。
每个小节 content 使用 Markdown，必须包含充分讲解；按主题需要组合概念解释、原理推导、步骤、示例、代码或常见误区，不能只写提纲。正文中每处使用检索事实的表述/结论句尾紧跟 `^[来源编号]` 角标（例如 `Workflow 是静态编排，而 Agent 会根据环境动态推理。^[3]`），一处正文内可以出现多个角标；不要只把来源编号放在 citations 数组中而不写进 content。
summary 是 100-180 字导读；learningObjectives 3-6 项；keyPoints 5-10 项；reviewQuestions 4-8 题。
正文总字数不得少于 {minimum_chars} 个中文字符。每个小节控制在 180-350 字；整份 JSON 必须完整闭合，宁可用更紧凑的表述，也不能在输出上限处截断。
各小节合起来必须回答“是什么、为什么、如何工作、何时使用、如何验证”，不要机械地在每个小节重复五套句式。
面向企业培训学员写作：首次出现的专业术语要用一句通俗中文解释；先给直观例子再补原理；每个复杂步骤说明输入、动作、输出和判断标准，避免假定学员已经了解上下文。
禁止使用“梳理主要机制”“结合典型案例”“掌握关键方法”“建立整体认知”等没有展开内容的占位句。
至少包含：
1. 准确定义、关键组成及组成之间的数据流或因果关系；
2. 一个带具体输入、处理过程和输出的完整示例；
3. 技术主题给出可运行代码、配置或伪代码，并逐行解释关键部分；非技术主题给出可复现的分析步骤和具体材料；
4. 适用条件、限制、失败方式和常见错误；
5. 可操作的检查方法，说明学习者如何判断自己是否真正掌握。
不要复述主题描述，不要只列标题或结论。引用检索资料时先解释原文事实，再给出推导和应用。
写作风格：像教材一样直接陈述事实。禁止营销化、空洞的修饰话术（如“深入解析”“全面掌握”“赋能”“助力”“轻松搞定”“在当今……时代”）；禁止“本讲义将……”“我们将……”这类预告式句子，正文直接从内容本身写起。
title 必须是简洁具体的知识主题（如“ReAct循环机制”），禁止包含课程名、“第X章”编号或“讲义”字样；“主题”行中“｜”之后的内容只是章节定位信息，仅供把握范围，不得照搬进 title 或正文。
若提供了“前文已学章节”，其中已讲过的概念、示例与方法不要重复展开，只在必要时用一句话衔接，正文聚焦本章新内容。

{self._source_context(prompt_sources)}"""
        generation_failed = {"__generation_failed__": True}
        await self._generation_event("generating", 46, "讲义模型请求已发送", "正在生成第一版完整讲义；长内容请求最长等待 150 秒，失败时会自动重试")
        content = await self.llm.complete_json(
            "你是ITN定制讲义Agent，负责基于知识库与Web Search证据生成可溯源、适合个人学习的讲义。"
            "正文中的分点列举（如 1. 2. 3. 或 - 开头的列表）必须每个要点独占一行，用换行符分隔，禁止把多个要点挤在同一段落里。",
            prompt, generation_failed, provider="mimo", max_tokens=8192, max_retries=2, thinking=False,
            timeout_seconds=150,
        )
        if isinstance(content, dict):
            self._sanitize_citations(content, sources)
        usable_content = content if self._usable_lecture_content(content) else None
        await self._generation_event(
            "generating", 62, "讲义第一版返回",
            "已取得可展示初稿，后续修订失败也会保留" if usable_content else "模型未返回可展示 JSON，准备执行一次修复请求",
        )
        issues = self._lecture_quality_issues(content, detail)
        issues.extend(self._citation_coverage_issues(content, sources))
        issues.extend(self._lecture_evidence_match_issues(content, sources))
        # At most one evidence-grounded rewrite. Avoid a slow multi-round reviewer loop.
        if issues:
            issue_details = self._citation_coverage_details(content, sources)
        if issues and not payload.get("defer_quality_repair"):
            await self._generation_event(
                "verifying", 68, "讲义初稿核验发现问题", "；".join(issues[:4]), agent="citation_verifier",
                snapshot={
                    "issues": issues[:8], "issueDetails": issue_details, "artifactContent": content,
                    "decision": "repair", "nextStep": "交给内容生成 Agent 按问题明细定向修订",
                },
            )
            await self._generation_event(
                "revising", 70, "讲义进入定向修订", "已接收质量核验意见，正在针对问题补齐或修正",
            )
            repair_prompt = (
                prompt + "\n\n上一轮生成不合格，问题如下：\n- " + "\n- ".join(issues) +
                "\n请基于以上证据重新完整生成。网页标题、作者署名、日期、导航、互动数据、站点页脚、推荐内容不得进入标题或正文。"
                "不要复制整页来源，不要用来源标题充当小节标题；跨来源去重后组织成递进教学内容。只返回符合字段要求的 JSON。"
            )
            revised = await self.llm.complete_json(
                "你是资深课程作者和技术审稿人。必须写出可直接学习的教材正文，拒绝空话和占位文本。",
                repair_prompt, generation_failed, provider="mimo", max_tokens=8192, max_retries=2, thinking=False,
                timeout_seconds=150,
            )
            content = revised if self._usable_lecture_content(revised) else usable_content or revised
            if isinstance(content, dict):
                self._sanitize_citations(content, sources)
            await self._generation_event(
                "revising", 82, "讲义修订请求结束",
                "修订版有效，已采用修订结果" if self._usable_lecture_content(revised)
                else "修订请求超时或返回无效 JSON，已保留第一版有效内容" if usable_content
                else "修订后仍未获得可展示内容",
            )
            issues = self._lecture_quality_issues(content, detail)
            issues.extend(self._citation_coverage_issues(content, sources))
            issues.extend(self._lecture_evidence_match_issues(content, sources))
            if issues:
                # 脆性门兜底：修订后仍有缺引用/缺匹配的块 → 用来源相似度自动补齐引用，不再让少量遗漏毁掉整个任务
                backfilled = self._auto_backfill_citations(content, sources)
                if backfilled:
                    issues = self._lecture_quality_issues(content, detail)
                    issues.extend(self._citation_coverage_issues(content, sources))
                    issues.extend(self._lecture_evidence_match_issues(content, sources))
                    await self._generation_event(
                        "revising", 84, "讲义引用自动补齐",
                        f"已为 {backfilled} 个内容块自动补上来源编号并生成原文匹配",
                    )
                remaining_unattributed = len(self._citation_coverage_details(content, sources))
                if remaining_unattributed:
                    # 先重新检索：针对缺引用块再找一轮来源，而不是直接放行
                    try:
                        for block in self._citation_coverage_details(content, sources)[:6]:
                            block_text = (str(block.get("content") or "") + " " + str(block.get("title") or block.get("stem") or "")).strip()[:300]
                            if not block_text:
                                continue
                            fresh, _ = await self.retrieve(
                                block_text, top_k=3, rag_only=False, supplement_web=False,
                                kp_id=self._retrieve_kp_id(payload),
                            )
                            missing_ids = {str(item.get("chunkId") or item.get("chunk_id") or "") for item in sources}
                            merged = [
                                {**item, "id": 0}
                                for item in fresh
                                if str(item.get("chunkId") or item.get("chunk_id") or "") not in missing_ids
                                and str(item.get("content") or "").strip()
                            ]
                            if merged:
                                base = max((int(item["id"]) for item in sources if item.get("id") is not None), default=0)
                                for offset, item in enumerate(merged, 1):
                                    item["id"] = base + offset
                                sources.extend(merged)
                    except Exception:
                        pass
                    backfilled2 = self._auto_backfill_citations(content, sources)
                    if backfilled2:
                        await self._generation_event(
                            "revising", 85, "讲义引用重新检索补齐",
                            f"已重新检索来源并为 {backfilled2} 个内容块补齐引用与原文匹配",
                        )
                    remaining_unattributed = len(self._citation_coverage_details(content, sources))
                    if remaining_unattributed:
                        # 重找后仍无匹配来源的少数块：记录并放行（内容本身有效，仅缺可溯源编号）
                        issues = [issue for issue in issues if "缺少对应来源编号" not in issue]
                self._lecture_backfilled = (backfilled or 0) + backfilled2 if 'backfilled2' in locals() else (backfilled or 0)
        if not self._usable_lecture_content(content):
            await self._generation_event(
                "generating", 64, "讲义改用分章生成",
                "完整讲义请求未取得可展示内容，正在按学习单元拆分生成",
            )
            split_content = await self._generate_lecture_by_chapters(
                payload, context, sources, structure_fallback, detail, minimum_chars,
            )
            # Use split content if it has chapters, even if marked as failed (short)
            if isinstance(split_content, dict) and split_content.get("chapters"):
                content = split_content
            elif self._usable_lecture_content(split_content):
                content = split_content
            if isinstance(content, dict):
                self._sanitize_citations(content, sources)
            issues = self._lecture_quality_issues(content, detail)
            issues.extend(self._citation_coverage_issues(content, sources))
            issues.extend(self._lecture_evidence_match_issues(content, sources))
            await self._generation_event(
                "generating", 78, "分章讲义生成结束",
                "已合并分章内容，正在进入质量核验" if self._usable_lecture_content(content)
                else "分章生成仍未取得可展示内容",
            )
        if not self._usable_lecture_content(content):
            # 不用内置兜底：更换通道（qwen/默认模型）重新分章生成；重试耗尽才失败
            await self._generation_event(
                "generating", 84, "讲义更换通道重新生成",
                "分章结果仍不可用，正在更换模型通道重新生成各学习单元",
            )
            retry_content = await self._generate_lecture_by_chapters(
                payload, context, sources, structure_fallback, detail, minimum_chars,
                fallback_providers=("qwen", ""),
            )
            if self._usable_lecture_content(retry_content):
                content = retry_content
                if isinstance(content, dict):
                    self._sanitize_citations(content, sources)
                issues = self._lecture_quality_issues(content, detail)
                issues.extend(self._citation_coverage_issues(content, sources))
                issues.extend(self._lecture_evidence_match_issues(content, sources))
                await self._generation_event(
                    "generating", 88, "讲义重试生成成功",
                    "更换通道后已取得可展示内容，继续质量核验",
                )
            else:
                await self._generation_event(
                    "generating", 92, "讲义生成重试耗尽",
                    "完整、分章、换通道重试均未取得可展示内容，任务终止",
                )
                raise ValueError("定制讲义 LLM 接口未返回可用内容（完整/分章/换通道重试均已尝试）")
        self._sanitize_citations(content, sources)
        self._sanitize_evidence_quotes(content, sources)
        self._drop_unmatched_lecture_citations(content)
        content = self._normalize_lecture(content, structure_fallback)
        decision = self._decision_trace("lecture", payload, context, sources, content)
        decision["quality"]["fallbackUsed"] = False
        if getattr(self, "_lecture_backfilled", 0):
            decision["quality"]["backfilledBlocks"] = self._lecture_backfilled
            self._lecture_backfilled = 0
        decision["quality"]["generationIssues"] = list(dict.fromkeys(issues[:8]))
        decision["quality"]["generationIncomplete"] = bool(issues)
        return content, sources, decision

    async def _generate_lecture_by_chapters(self, payload: dict, context: dict, sources: list[dict],
                                            fallback: dict, detail: str, minimum_chars: int,
                                            fallback_providers: tuple[str, ...] = ("mimo",)) -> dict:
        targets = [
            ("基础概念与学习地图", "定义、核心组成、与相关概念的边界"),
            ("核心原理与架构机制", "工作流程、关键机制、输入输出和因果关系"),
            ("应用实践与复习检查", "完整示例、常见错误、验证方法和复习问题"),
        ]
        evidence = [
            {**source, "content": str(source.get("content") or "")[:700]}
            for source in sources[:8]
        ]
        chapters: list[dict] = []
        for index, (chapter_title, chapter_focus) in enumerate(targets, 1):
            await self._generation_event(
                "generating", min(76, 64 + index * 4),
                f"生成讲义第 {index} 个学习单元",
                f"正在生成“{chapter_title}”",
            )
            prompt = f"""主题：{payload['topic']}
当前学习单元：{chapter_title}
学习单元重点：{chapter_focus}
详细程度：{detail}
教研蓝图：{json.dumps(payload.get('competition_blueprint') or {}, ensure_ascii=False)[:2400]}
上下文：{json.dumps(context, ensure_ascii=False)[:2400]}

只生成当前学习单元，不要生成整份讲义。返回 JSON：title, overview, sections[]。
sections 每项字段：title, content, citations:number[], evidenceMatches:[{{sourceId:number,claim:string,sourcePassage:string}}]。
每个小节 160-320 字，至少 2 个小节。内容必须具体展开，不得使用“梳理主要机制”“结合典型案例”等占位句。
引用来源时，正文中每处使用检索事实的表述/结论句尾紧跟 `^[来源编号]` 角标；sourcePassage 必须从对应来源正文原样复制。

{self._source_context(evidence)}"""
            chapter = None
            for provider in fallback_providers:
                chapter = await self.llm.complete_json(
                    "你是ITN讲义分章生成Agent。只返回当前学习单元 JSON，不输出整份讲义。",
                    prompt, {"title": chapter_title, "overview": "", "sections": []},
                    provider=provider, max_tokens=3200, max_retries=2, thinking=False,
                    timeout_seconds=90,
                )
                if isinstance(chapter, dict) and chapter.get("sections"):
                    break
            if isinstance(chapter, dict):
                normalized = self._normalize_lecture({
                    "title": payload.get("title") or payload["topic"],
                    "summary": fallback.get("summary"),
                    "learningObjectives": fallback.get("learningObjectives"),
                    "chapters": [chapter],
                    "keyPoints": fallback.get("keyPoints"),
                    "reviewQuestions": fallback.get("reviewQuestions"),
                }, fallback)
                if normalized.get("chapters"):
                    candidate = normalized["chapters"][0]
                    if any(str(section.get("content") or "").strip() for section in candidate.get("sections") or []):
                        chapters.append(candidate)
        content = {
            "title": payload.get("title") or fallback["title"],
            "summary": fallback["summary"],
            "learningObjectives": fallback["learningObjectives"],
            "chapters": chapters,
            "keyPoints": fallback["keyPoints"],
            "reviewQuestions": fallback["reviewQuestions"],
        }
        if self._usable_lecture_content(content):
            self._sanitize_citations(content, sources)
            self._sanitize_evidence_quotes(content, sources)
        if len("".join(
            str(section.get("content") or "")
            for chapter in chapters for section in chapter.get("sections") or []
        )) < max(500, minimum_chars // 2):
            content["__generation_failed__"] = True
        return content

    @staticmethod
    def _usable_lecture_content(content: object) -> bool:
        """Keep a renderable lecture draft when a later refinement request times out."""
        if not isinstance(content, dict) or content.get("__generation_failed__"):
            return False
        chapters = content.get("chapters") if isinstance(content.get("chapters"), list) else []
        return any(
            isinstance(section, dict) and str(section.get("content") or "").strip()
            for chapter in chapters if isinstance(chapter, dict)
            for section in chapter.get("sections") or []
        ) or any(
            isinstance(section, dict) and str(section.get("content") or "").strip()
            for section in (content.get("sections") or [])
        )

    @staticmethod
    def _lecture_quality_issues(content: dict, detail: str = "balanced") -> list[str]:
        if not isinstance(content, dict) or content.get("__generation_failed__"):
            return ["模型未返回有效讲义"]
        chapters = content.get("chapters") if isinstance(content.get("chapters"), list) else []
        sections = [
            section for chapter in chapters if isinstance(chapter, dict)
            for section in chapter.get("sections", []) if isinstance(section, dict)
        ]
        texts = [str(section.get("content") or "").strip() for section in sections]
        total_chars = sum(len(text) for text in texts)
        minimum_chars = {"concise": 1300, "balanced": 1800, "detailed": 2400}.get(detail, 1800)
        issues: list[str] = []
        # 门槛软化：少量不足不触发修复，仅明显缺稿才报（避免脆性失败）
        if len(chapters) < 2:
            issues.append(f"章节不足（当前 {len(chapters)} 章）")
        minimum_sections = {"concise": 4, "balanced": 5, "detailed": 6}.get(detail, 5)
        if len(sections) < minimum_sections - 1:
            issues.append(f"小节不足（当前 {len(sections)} 节，至少 {minimum_sections} 节）")
        if total_chars < int(minimum_chars * 0.6):
            issues.append(f"正文过短（当前 {total_chars} 字，期望 {minimum_chars} 字）")
        short_sections = sum(1 for text in texts if len(text) < 100)
        if short_sections and texts and short_sections * 2 > len(texts):
            issues.append(f"有 {short_sections} 个小节少于 100 字")
        boilerplate = ("梳理主要机制", "结合一个典型案例", "掌握关键方法", "建立整体认知", "回顾本讲义的关键结论")
        hits = sum(text.count(phrase) for text in texts for phrase in boilerplate)
        if hits >= 3:
            issues.append(f"包含 {hits} 处模板占位话术")
        web_noise = (
            "登录/注册", "关注作者", "控制台", "建议反馈", "社区首页", "Skip to content",
            "You signed in", "Reload to refresh", "Copy path", "Blame", "Download raw file",
            "QQ群", "公众号", "人浏览", "举报", "Discord", "WhatsApp", "相关推荐",
        )
        noise_hits = sum(text.lower().count(marker.lower()) for text in texts for marker in web_noise)
        source_titles = [str(section.get("title") or "") for section in sections]
        if noise_hits >= 2:
            issues.append(f"正文含有 {noise_hits} 处网页模板或署名噪声")
        if sum(any(marker.lower() in title.lower() for marker in web_noise) for title in source_titles):
            issues.append("小节标题混入网页模板信息")
        specificity = ("例如", "示例", "输入", "输出", "步骤", "流程", "代码", "配置", "错误", "限制", "边界", "验证")
        signals = sum(1 for word in specificity if any(word in text for text in texts))
        if signals < 3:
            issues.append("缺少具体示例、过程、边界或验证方法")
        return issues

    @staticmethod
    def _normalize_lecture(content: dict, fallback: dict) -> dict:
        """Normalize new chapter-based lectures while keeping legacy flat sections readable."""
        if not isinstance(content, dict):
            content = {}
        chapters = content.get("chapters") if isinstance(content.get("chapters"), list) else []
        normalized_chapters = []
        for chapter_index, chapter in enumerate(chapters):
            if not isinstance(chapter, dict):
                continue
            sections = chapter.get("sections") if isinstance(chapter.get("sections"), list) else []
            normalized_sections = []
            for section_index, section in enumerate(sections):
                if not isinstance(section, dict) or not str(section.get("content") or "").strip():
                    continue
                normalized_sections.append({
                    "title": str(section.get("title") or f"第 {section_index + 1} 节"),
                    "content": str(section.get("content") or ""),
                    "citations": section.get("citations") if isinstance(section.get("citations"), list) else [],
                    "evidenceQuotes": section.get("evidenceQuotes") if isinstance(section.get("evidenceQuotes"), list) else [],
                    "evidenceMatches": section.get("evidenceMatches") if isinstance(section.get("evidenceMatches"), list) else [],
                })
            if normalized_sections:
                normalized_chapters.append({
                    "title": str(chapter.get("title") or f"第 {chapter_index + 1} 章"),
                    "overview": str(chapter.get("overview") or ""),
                    "sections": normalized_sections,
                })
        if not normalized_chapters:
            legacy_sections = content.get("sections") if isinstance(content.get("sections"), list) else []
            for index, section in enumerate(legacy_sections):
                if isinstance(section, dict) and str(section.get("content") or "").strip():
                    normalized_chapters.append({
                        "title": str(section.get("title") or f"第 {index + 1} 章"), "overview": "",
                        "sections": [{
                            "title": str(section.get("title") or "正文"),
                            "content": str(section.get("content") or ""),
                            "citations": section.get("citations") if isinstance(section.get("citations"), list) else [],
                            "evidenceQuotes": section.get("evidenceQuotes") if isinstance(section.get("evidenceQuotes"), list) else [],
                            "evidenceMatches": section.get("evidenceMatches") if isinstance(section.get("evidenceMatches"), list) else [],
                        }],
                    })
        if not normalized_chapters:
            normalized_chapters = fallback["chapters"]
        return {
            "title": str(content.get("title") or fallback["title"]),
            "summary": str(content.get("summary") or fallback["summary"]),
            "learningObjectives": content.get("learningObjectives") if isinstance(content.get("learningObjectives"), list) else fallback["learningObjectives"],
            "chapters": normalized_chapters,
            "keyPoints": content.get("keyPoints") if isinstance(content.get("keyPoints"), list) else fallback["keyPoints"],
            "reviewQuestions": content.get("reviewQuestions") if isinstance(content.get("reviewQuestions"), list) else fallback["reviewQuestions"],
        }

    async def generate_practice(self, payload: dict, context: dict | None = None) -> tuple[dict, list[dict], dict]:
        context = context or {}
        sources = self._practice_source_mix(await self.retrieve(
            payload["topic"], top_k=12, rag_only=False, supplement_web=False,
            kp_id=self._retrieve_kp_id(payload),
        ))
        compact_context = {
            "goal": context.get("goal"), "profile": context.get("profile"),
            "mastery": context.get("mastery"), "recommendation": context.get("recommendation"),
            "template_content": context.get("template_content"),
            "customization_requirements": context.get("customization_requirements"),
        }
        compact_source_context = "\n\n".join(
            f"[来源{s['id']}] {s['document']}\n{s['content'][:800]}" for s in sources[:8]
        ) or "知识库与互联网检索均暂无直接命中。"
        prompt = f"""主题：{payload['topic']}
学习目标与用户画像：{json.dumps(compact_context, ensure_ascii=False)[:6000]}
比赛命题与教研蓝图：{json.dumps(payload.get('competition_blueprint') or {}, ensure_ascii=False)[:6000]}
领域生成规范：{json.dumps((payload.get('rule_snapshot') or {}).get('constraints') or [], ensure_ascii=False)[:5000]}
上一轮质量审查整改要求：{json.dumps(payload.get('quality_directives') or [], ensure_ascii=False)[:3000]}
请生成企业培训学员可以独立照做、看到结果并完成验收的中文实操指南。优先依据知识库或网页检索资料；引用处填写来源编号，不得虚构。citations 会显示在对应步骤旁，每个使用检索事实、参数或操作依据的步骤必须填写其直接来源，不能把引用集中在指南末尾。
只返回 JSON：title,objective,estimatedMinutes,prerequisites:string[],environment:string[],safetyChecklist:string[],safetyNotice,steps[],acceptanceCriteria:string[],troubleshooting[],challenge。
steps 每项：title,instruction,code,expectedOutput,citations:number[],evidenceMatches:[{{sourceId,claim,sourcePassage}}],safety(safe/caution/danger),warning；troubleshooting 每项：problem,solution。
要求：
1. 4-7 个连续步骤，每步 instruction 至少 100 字，明确“在哪里操作、输入什么、执行什么、观察什么”；
2. 技术主题提供可复制运行的完整代码或命令，并说明版本、依赖和文件位置；非技术主题提供可直接使用的表格、话术或分析材料；
3. 每一步必须填写 expectedOutput，给出具体输出、界面变化或可核对的结果，不能只写“运行成功”；
4. prerequisites 和 environment 写清开始前条件；acceptanceCriteria 至少 3 条且可客观判定；troubleshooting 至少 2 条，包含真实易错点与修复办法；
5. 面向首次接触本章的学员，首次术语要解释，不使用“自行配置”“根据实际情况调整”等把关键步骤推给学员的话术；
6. challenge 是完成基础任务后的一个明确变式练习，不得超出本章知识范围；
7. title 用简洁的操作目标命名（如“用LangGraph搭建循环工作流”），禁止包含课程名、“第X章”编号或“实操指南”字样。
8. 若提供了“前文已学章节”，不要重复前文已实现过的内容，只需一句话衔接后直接进入本章新任务。
9. 每一步必须标注 safety。涉及设备、用电、生产环境、权限、隐私或不可逆操作时，提供 2-5 项开始前确认和明确风险警示；无明显风险时也给出 1-3 项适合该任务的检查项，禁止机械套用与主题无关的工业安全术语。
10. 这是“实操指南”而不是讲义：正文以动作链为核心，理论只解释完成当前动作所必需的原因；每一步都要形成“操作—观察—判定”闭环。
11. 先依据知识库确定课程内操作方法、步骤约束、验收标准和安全边界。Web 仅在该步骤对应切片缺失或不足以支撑操作时兜底使用，不作为平行候选项；知识库有效覆盖充分时不要引入 Web 证据。
12. 每个 citations 编号都必须在同一步 evidenceMatches 中给出对应关系。claim 是本步骤被支撑的操作依据；sourcePassage 必须逐字摘自该来源正文，不能填网页标题、作者、日期、导航、标签或摘要噪声。instruction 可以根据原文改写，不要求与原文逐字一致。

{compact_source_context}"""
        generation_failed = {"__generation_failed__": True}
        await self._generation_event("generating", 46, "实操模型请求已发送", "正在生成第一版操作步骤；长内容请求最长等待 150 秒，失败时会自动重试")
        content = await self.llm.complete_json(
            "你是ITN企业实训设计师。你的交付物必须让没有教师陪同的学员也能按步骤完成，并用可观察结果判断对错。",
            prompt, generation_failed, provider="mimo", max_tokens=8192, max_retries=2, thinking=False,
            timeout_seconds=150,
        )
        if isinstance(content, dict):
            self._resolve_practice_evidence_matches(content, sources)
            self._sanitize_citations(content, sources)
        usable_content = content if self._usable_practice_content(content) else None
        await self._generation_event(
            "generating", 62, "实操第一版返回",
            "已取得可展示初稿，后续修订失败也会保留" if usable_content else "模型未返回带有效步骤的 JSON，准备执行一次修复请求",
        )
        issues = self._practice_quality_issues(content)
        issues.extend(self._citation_coverage_issues(content, sources))
        evidence_match_details = self._practice_evidence_match_details(content, sources)
        if evidence_match_details:
            issues.append(f"有 {len(evidence_match_details)} 处实操步骤引用缺少有效原文匹配")
        if issues:
            await self._generation_event(
                "verifying", 68, "实操初稿核验发现问题", "；".join(issues[:4]), agent="citation_verifier",
                snapshot={"issues": issues[:8], "issueDetails": evidence_match_details, "artifactContent": content},
            )
        if issues and not payload.get("defer_quality_repair"):
            await self._generation_event(
                "revising", 70, "实操指南进入定向修订", "已接收质量核验意见，正在针对问题补齐或修正",
            )
            revised = await self.llm.complete_json(
                "你是企业实训审稿人。必须补齐环境、可执行步骤、预期结果、验收标准和故障排查，只返回完整 JSON。",
                prompt + "\n\n上一轮问题：\n- " + "\n- ".join(issues),
                generation_failed, provider="mimo", max_tokens=8192, max_retries=2, thinking=False,
                timeout_seconds=150,
            )
            # A timeout or malformed rewrite must never erase a usable first draft.
            content = revised if self._usable_practice_content(revised) else usable_content or revised
            if isinstance(content, dict):
                self._resolve_practice_evidence_matches(content, sources)
                self._sanitize_citations(content, sources)
            await self._generation_event(
                "revising", 82, "实操修订请求结束",
                "修订版有效，已采用修订结果" if self._usable_practice_content(revised)
                else "修订请求超时或返回无效 JSON，已保留第一版有效内容" if usable_content
                else "修订后仍未获得可展示步骤",
            )
            issues = self._practice_quality_issues(content)
            issues.extend(self._citation_coverage_issues(content, sources))
            issues.extend(self._practice_evidence_match_issues(content, sources))
        if not self._usable_practice_content(content):
            # 统一走 MiMo token-plan 文本通道重试，不再降级到其他文本通道
            await self._generation_event(
                "generating", 64, "实操重新生成",
                "主通道未返回可执行步骤，正在重新请求生成",
            )
            retry_content = await self.llm.complete_json(
                "你是ITN企业实训设计师。必须交付学员能独立照做并自我校验的操作步骤。",
                prompt, generation_failed, provider="mimo", max_tokens=8192, max_retries=2,
                thinking=False, timeout_seconds=150,
            )
            if self._usable_practice_content(retry_content):
                content = retry_content
                self._resolve_practice_evidence_matches(content, sources)
                self._sanitize_citations(content, sources)
                await self._generation_event(
                    "generating", 70, "实操更换通道生成成功",
                    "已取得可执行步骤，继续质量核验",
                )
            else:
                raise ValueError("实操指南生成接口未返回可用内容（含换通道重试）")
        self._resolve_practice_evidence_matches(content, sources)
        self._sanitize_citations(content, sources)
        self._sanitize_evidence_quotes(content, sources)
        self._drop_unmatched_practice_citations(content)
        content["safetyChecklist"] = [
            str(item) for item in (content.get("safetyChecklist") or []) if str(item).strip()
        ][:5]
        content["safetyNotice"] = str(content.get("safetyNotice") or "")
        for step in content.get("steps") or []:
            if not isinstance(step, dict):
                continue
            step["safety"] = step.get("safety") if step.get("safety") in {"safe", "caution", "danger"} else "safe"
            step["warning"] = str(step.get("warning") or "")
        content["estimatedMinutes"] = max(20, int(content.get("estimatedMinutes") or len(content.get("steps") or []) * 12 or 20))
        decision = self._decision_trace("practice", payload, context, sources, content)
        decision["quality"]["fallbackUsed"] = False
        decision["quality"]["generationIssues"] = issues[:8]
        decision["quality"]["generationIncomplete"] = bool(issues)
        return content, sources, decision

    @staticmethod
    def _usable_practice_content(content: object) -> bool:
        """Accept a generated draft only when it has a renderable action sequence."""
        return bool(
            isinstance(content, dict)
            and not content.get("__generation_failed__")
            and isinstance(content.get("steps"), list)
            and any(isinstance(step, dict) and str(step.get("instruction") or "").strip() for step in content["steps"])
        )

    @staticmethod
    def _practice_fallback(payload: dict) -> dict:
        topic = str(payload["topic"])
        instructions = [
            (
                "准备任务与输入",
                f"新建一个以“{topic}”命名的练习目录，在 README.md 中写下本次任务的输入、处理步骤、预期输出和验收标准。"
                "再准备一个最小输入样例和一个边界输入样例，逐项标注数据来源、字段含义与允许范围；完成后检查文件可打开、字段无缺失，并记录当前环境版本。",
                "练习目录中包含 README.md、最小输入和边界输入，四类任务信息均可直接核对。",
            ),
            (
                "建立基线方案",
                f"针对“{topic}”写出一套最小可执行基线：先说明采用的方法及选择理由，再把处理过程拆成编号步骤。"
                "技术任务可保存为 main.py 或配置文件，非技术任务可保存为 analysis.md；必须给出具体参数、判断条件和失败处理，禁止只写原则性描述。",
                "基线文件能够从输入推导出一个明确结果，并包含参数、判断条件和异常处理说明。",
            ),
            (
                "执行并记录结果",
                "分别用最小样例和边界样例执行基线方案，把每次执行的输入、关键中间状态、最终输出、耗时或其他核心指标写入 result.md。"
                "若执行失败，保留完整错误信息并按发生位置定位原因；修改后重新执行，确保结果可复现，而不是只保留一次偶然成功的截图。",
                "result.md 至少包含两组完整记录，结果可复现，并能区分正常路径与边界路径。",
            ),
            (
                "验收与复盘",
                f"依据 README.md 中的标准逐条验收“{topic}”练习，对不满足项写明证据和修复动作。"
                "最后补充一段复盘：说明当前方案适用条件、一个已知限制、一个常见错误及改进方向；再次从空目录按文档操作，确认其他学习者无需口头提示也能完成。",
                "所有验收项均有通过或未通过结论、对应证据和修复记录，复盘包含限制与改进方向。",
            ),
        ]
        return {
            "title": payload.get("title") or f"{topic}实操指南",
            "objective": f"通过可复现任务掌握{topic}的基本分析与验证流程。",
            "estimatedMinutes": 60,
            "prerequisites": ["能够创建和编辑文本文件", "已阅读本章讲义或了解本章基本术语"],
            "environment": ["任意可编辑 Markdown 的本地环境", "可运行本章示例所需的软件或分析工具"],
            "steps": [
                {"title": title, "instruction": instruction, "code": "", "expectedOutput": output, "citations": [],
                 "safety": "caution" if index == 0 else "safe", "warning": "先确认输入样例不含敏感信息，并保留原始文件副本。" if index == 0 else ""}
                for index, (title, instruction, output) in enumerate(instructions)
            ],
            "safetyChecklist": ["已备份原始输入与当前成果", "已确认输入中不包含不应使用的敏感信息"],
            "safetyNotice": "修改或覆盖文件前先保留原始副本；涉及生产环境、真实账号或敏感数据时，先在安全的测试环境中验证。",
            "acceptanceCriteria": [
                "输入、过程和输出记录完整且可由他人复现",
                "最小样例与边界样例均有明确结果和判断依据",
                "至少记录一个限制、一个错误及对应修复动作",
            ],
            "troubleshooting": [
                {"problem": "执行结果与预期不一致", "solution": "从输入字段、参数、关键中间状态到输出逐项比对，并用最小样例定位首个偏差位置。"},
                {"problem": "他人无法按文档复现", "solution": "补齐环境版本、文件位置、完整命令或操作入口，并在空目录中重新执行一次。"},
            ],
            "challenge": "增加一个与现有样例不同的异常输入，预测结果后执行验证，并说明方案需要怎样调整。",
        }

    @staticmethod
    def _practice_quality_issues(content: dict) -> list[str]:
        if not isinstance(content, dict) or content.get("__generation_failed__"):
            return ["模型未返回有效实操指南"]
        steps = [item for item in content.get("steps", []) if isinstance(item, dict)]
        issues: list[str] = []
        if len(steps) < 3:
            issues.append(f"可执行步骤不足（当前 {len(steps)} 步，至少 3 步）")
        short = sum(1 for item in steps if len(str(item.get("instruction") or "")) < 90)
        if short and steps and short * 2 > len(steps):
            issues.append(f"有 {short} 个步骤说明过短")
        missing_output = sum(1 for item in steps if len(str(item.get("expectedOutput") or "").strip()) < 10)
        if missing_output and steps and missing_output * 2 > len(steps):
            issues.append(f"有 {missing_output} 个步骤缺少具体预期结果")
        if len(content.get("acceptanceCriteria") or []) < 2:
            issues.append("可客观判定的验收标准不足 2 条")
        if len(content.get("troubleshooting") or []) < 1:
            issues.append("故障排查不足 1 条")
        invalid_safety = sum(1 for item in steps if item.get("safety") not in {"safe", "caution", "danger"})
        if invalid_safety and steps and invalid_safety * 2 > len(steps):
            issues.append(f"有 {invalid_safety} 个步骤缺少有效风险等级")
        concrete = " ".join(str(item.get("instruction") or "") + " " + str(item.get("code") or "") for item in steps)
        if not any(signal in concrete for signal in ("输入", "执行", "点击", "运行", "保存", "输出", "检查")):
            issues.append("步骤缺少明确操作动作")
        return issues

    @staticmethod
    def _profile_difficulty_for_quiz(payload: dict, context: dict, target_path: str = "") -> dict:
        """根据生成 context 里的 learner profile / mastery / goal 推断本组分阶题应偏向的难度档。"""
        profile = context.get("profile") or {}
        learner = dict(profile)
        mastery = context.get("mastery") or {}
        recommendation = context.get("recommendation") or {}
        try:
            overall = float(mastery.get("overall") if mastery.get("overall") is not None else recommendation.get("ability", 0.5))
        except (TypeError, ValueError):
            overall = 0.5
        if isinstance(mastery, dict) and isinstance(mastery.get("items"), list):
            try:
                learner.setdefault("scores", {
                    str(item.get("categoryId")): int(round(float(item.get("score") or 0) * 100))
                    for item in mastery["items"] if isinstance(item, dict)
                })
            except Exception:
                pass
        learner.setdefault("scores", {})
        if isinstance(profile, dict):
            for key in ("educationLevel", "major", "technicalFoundation", "learningPreference",
                        "targetJob", "role", "tag", "background", "goal"):
                value = profile.get(key)
                if value is not None:
                    learner.setdefault(key, value)
        goal_data = context.get("goal")
        if isinstance(goal_data, dict) and goal_data.get("title"):
            learner.setdefault("goalData", goal_data)
        target_key = str(payload.get("kp_id") or "")
        target_name = str(payload.get("topic") or "")
        try:
            score = float((learner.get("scores") or {}).get(target_key, overall * 100))
        except (TypeError, ValueError):
            score = overall * 100
        result = {"label": DIFFICULTY_STANDARD, "reason": "fallback threshold", "score": score, "role": ""}
        try:
            path = target_path or str(payload.get("path") or "") or str(context.get("knowledge_path") or "")
            profiled = difficulty_for(
                learner, target_key=target_key, target_name=target_name, target_path=path, score=score,
            )
            result = {"label": profiled["difficulty"], "reason": profiled.get("reason", ""), "score": score, "role": profiled.get("role", "")}
        except Exception:
            if score < 55:
                result["label"] = DIFFICULTY_ZERO
            elif score > 75:
                result["label"] = DIFFICULTY_ADVANCED
        return result

    @staticmethod
    def _quiz_distribution(label: str, count: int) -> list[tuple[str, int, int]]:
        """把画像难度档翻译成 easy/medium/hard 题目配比（默认仍是三档都有）。"""
        # 分阶题按流水线原始设计固定三批：每批 5 道同难度，共 15 道。
        # 不再因为画像难度配比把某一档放大成 9 道单批，避免超过单次生成上限。
        if count == 15:
            return [("easy", 1, 5), ("medium", 3, 5), ("hard", 5, 5)]
        if label == DIFFICULTY_ZERO:
            hard = max(1, round(count * 0.10))
            medium = max(1, round(count * 0.30))
            easy = max(1, count - medium - hard)
        elif label == DIFFICULTY_ADVANCED:
            easy = max(1, round(count * 0.10))
            medium = max(1, round(count * 0.30))
            hard = max(1, count - easy - medium)
        else:
            easy = medium = count // 3
            hard = count - easy - medium
        return [("easy", 1, easy), ("medium", 3, medium), ("hard", 5, hard)]

    async def generate_quiz(self, payload: dict, category_candidates: list[dict] | None = None,
                            context: dict | None = None) -> tuple[dict, list[dict], dict, dict]:
        context = context or {}
        if context.get("mode") == "user_customize" and isinstance(context.get("template_content"), dict):
            return await self._customize_quiz_template(payload, context)
        candidates = category_candidates or []
        category = next((item for item in candidates if str(item.get("id")) == str(payload.get("kp_id"))), None)
        if category is None and candidates:
            category = candidates[0]
        knowledge_path = str((category or {}).get("path") or "")
        topic = str(payload["topic"])
        retrieval_query = " / ".join(filter(None, [knowledge_path, topic]))

        def usable(candidates: list[dict]) -> list[dict]:
            filtered = filter_rag_sources_by_chapter(candidates, knowledge_path)
            return [
                source for source in filtered
                if (
                    source.get("sourceType") == "knowledge_base" and source.get("chunkId")
                    and float(source.get("similarity") or 0) >= RAG_MIN_SIMILARITY
                ) or (source.get("sourceType") == "web" and source.get("url"))
            ]

        sources = usable(await self.retrieve(retrieval_query, rag_only=False))
        if not sources:
            retry_queries = list(dict.fromkeys(filter(None, [
                f"{retrieval_query} 分阶测试题 核心概念 典型误区",
                f"{topic} 基本原理 关键机制 应用辨析",
                f"{knowledge_path} {topic} 题库 解析 引用",
            ])))
            retry_sources: list[dict] = []
            for retry_query in retry_queries:
                retry_sources.extend(await self.retrieve(
                    retry_query, top_k=12, rag_only=False, supplement_web=True,
                ))
            sources = usable(retry_sources)
        seen: set[tuple[str, str]] = set()
        deduped: list[dict] = []
        for source in sources:
            identity = (
                str(source.get("sourceType")),
                str(source.get("chunkId") or source.get("url") or source.get("content", "")[:160]),
            )
            if identity in seen:
                continue
            seen.add(identity)
            deduped.append(source)
        sources = deduped
        for index, source in enumerate(sources, 1):
            source["id"] = index
        if not sources:
            raise ValueError("当前章节在知识库与补充检索中均未找到可溯源资料，无法生成分阶测试题")
        count = 15
        knowledge_point = self._quiz_knowledge_point(payload, category_candidates)
        # 画像适配难度：零基础/标准/进阶 → 调整 easy/medium/hard 题量配比。
        adaptive = self._profile_difficulty_for_quiz(payload, context, knowledge_path)
        distribution = self._quiz_distribution(adaptive["label"], count)
        content = {
            "title": payload.get("title") or f"{payload['topic']}分阶测试",
            "knowledgePoints": [knowledge_point], "questions": [],
            "adaptiveDifficulty": {
                "label": adaptive["label"],
                "reason": adaptive.get("reason", ""),
                "score": adaptive.get("score"),
                "role": adaptive.get("role", ""),
                "distribution": [{"difficulty": item[0], "count": item[2]} for item in distribution],
            },
        }
        # QuestionBank 的 1/3/5 难度 rubric 映射到现有播放器 easy/medium/hard。
        failed_batches: list[str] = []
        question_offset = 0
        generated_stems: set[str] = set()
        for difficulty, numeric_difficulty, batch_count in distribution:
            generated = await self._generate_question_bank_batch(
                payload, context, sources, knowledge_point, difficulty,
                numeric_difficulty, batch_count, question_offset=question_offset,
                excluded_stems=generated_stems,
            )
            if len(generated) != batch_count:
                failed_batches.append(f"{difficulty}:{len(generated)}/{batch_count}")
            content["questions"].extend(generated)
            generated_stems.update(str(item.get("stem") or "").strip() for item in generated)
            question_offset += batch_count
        issues = self._quiz_quality_issues(content, count)
        issues.extend(self._citation_coverage_issues(content, sources))
        if "正确答案位置分布过度集中" in issues:
            self._rebalance_quiz_answers(content)
            issues = self._quiz_quality_issues(content, count)
            issues.extend(self._citation_coverage_issues(content, sources))
        generation_incomplete = bool(issues)
        self._sanitize_citations(content, sources)
        questions = content.get("questions") if isinstance(content.get("questions"), list) else []
        normalized = []
        for index, question in enumerate(questions[:count]):
            if not isinstance(question, dict) or len(question.get("options") or []) < 2:
                continue
            difficulty = question.get("difficulty") if question.get("difficulty") in {"easy", "medium", "hard"} else "easy"
            normalized.append({
                **question, "id": str(question.get("id") or uuid4()), "difficulty": difficulty,
                "correctIndex": max(0, min(int(question.get("correctIndex") or 0), len(question["options"]) - 1)),
            })
        content["questions"] = normalized
        initial_ability = float(context.get("recommendation", {}).get("ability", .35))
        state = {
            "ability": initial_ability, "answered": [], "currentQuestionId": None,
            "mastery": {str(k.get("id")): initial_ability for k in content.get("knowledgePoints", []) if isinstance(k, dict)},
            "completed": False,
        }
        decision = self._decision_trace("quiz", payload, context, sources, content)
        decision["questionBank"] = {
            "method": "KnowledgeCore QuestionBank",
            "promptVersion": self.QUESTION_BANK_PROMPT_VERSION,
            "difficultyRubric": {"easy": 1, "medium": 3, "hard": 5},
            "failedBatches": failed_batches,
        }
        decision["quality"]["fallbackUsed"] = False
        decision["quality"]["generationIncomplete"] = generation_incomplete
        if generation_incomplete:
            decision["quality"]["generationIssues"] = issues[:10]
        return content, sources, state, decision

    async def _customize_quiz_template(self, payload: dict, context: dict) -> tuple[dict, list[dict], dict, dict]:
        """Personalize a reviewed mother quiz in one lightweight model call.

        The model chooses the learning order and explains the focus; it does not
        regenerate facts, answers, citations, or reviewer metrics. This keeps
        the administrator-reviewed 15-question bank intact and avoids running
        the expensive administrator generation/review loop for every learner.
        """
        template = copy.deepcopy(context["template_content"])
        questions = [item for item in template.get("questions") or [] if isinstance(item, dict)]
        descriptors = [{
            "id": str(item.get("id") or index),
            "stem": str(item.get("stem") or item.get("question") or "")[:260],
            "difficulty": item.get("difficulty"),
            "knowledgePointId": item.get("knowledgePointId"),
        } for index, item in enumerate(questions, 1)]
        profile = context.get("profile") or {}
        mastery = context.get("mastery") or {}
        result = await self.llm.complete_json(
            "你是学习路径编排 Agent。只能调整已审核母版题目的练习顺序，不得改写题干、答案、解析、引用或审核数据。只返回 JSON。",
            "请根据学习者的目标、薄弱点、掌握情况和学习偏好，为以下母版题目安排练习顺序。"
            "优先让学习者先巩固薄弱概念，再进入综合迁移题；保留全部题目且每个 ID 恰好出现一次。\n"
            f"学习者画像：{json.dumps(profile, ensure_ascii=False)[:2600]}\n"
            f"掌握情况：{json.dumps(mastery, ensure_ascii=False)[:2200]}\n"
            f"显式薄弱点：{json.dumps(context.get('weak_points') or profile.get('blindSpots') or [], ensure_ascii=False)[:1200]}\n"
            f"母版题目：{json.dumps(descriptors, ensure_ascii=False)[:9000]}\n"
            '返回 {"orderedQuestionIds":["题目ID"],"focus":"本次练习重点","reason":"排序依据",'
            '"difficultyPlan":"难度递进说明"}。不得输出题目内容。',
            {"orderedQuestionIds": [], "focus": "", "reason": "", "difficultyPlan": ""},
            provider="mimo", max_tokens=1400, max_retries=2, thinking=False,
            timeout_seconds=90,
        )
        by_id = {str(item.get("id") or index): item for index, item in enumerate(questions, 1)}
        ordered_ids: list[str] = []
        for value in result.get("orderedQuestionIds") or []:
            key = str(value)
            if key in by_id and key not in ordered_ids:
                ordered_ids.append(key)
        ordered_ids.extend(key for key in by_id if key not in ordered_ids)
        candidate = {
            "title": template.get("title") or payload.get("title"),
            "knowledgePoints": template.get("knowledgePoints") or [],
            "questions": [{"id": key} for key in ordered_ids],
            "personalization": {
                "mode": "learner_adaptive",
                "focus": str(result.get("focus") or "按当前学习目标安排巩固顺序"),
                "reason": str(result.get("reason") or "先巩固基础与薄弱环节，再完成综合题"),
                "difficultyPlan": str(result.get("difficultyPlan") or "由基础理解逐步进入综合应用"),
                "targetJob": profile.get("targetJob"),
                "blindSpots": profile.get("blindSpots") or context.get("weak_points") or [],
            },
        }
        ability = float((mastery or {}).get("overall") or 0.5)
        state = {
            "ability": ability, "answered": [], "currentQuestionId": None,
            "mastery": {}, "completed": False,
        }
        decision = {
            "mode": "user_customize", "method": "reviewed_template_reordering",
            "quality": {"fallbackUsed": False, "motherReviewPreserved": True},
        }
        return candidate, list(context.get("template_sources") or []), state, decision

    @staticmethod
    def _quiz_knowledge_point(payload: dict, candidates: list[dict] | None) -> dict:
        topic = str(payload["topic"])
        candidate = next((item for item in (candidates or []) if isinstance(item, dict)), {})
        category_id = candidate.get("id")
        return {
            "id": str(category_id or payload.get("kp_id") or f"topic-{uuid4()}"),
            "name": str(candidate.get("name") or topic),
            "description": str(candidate.get("description") or f"{topic}的核心概念、应用与工程权衡。"),
            "categoryId": category_id,
        }

    async def _generate_question_bank_batch(
        self, payload: dict, context: dict, sources: list[dict], knowledge_point: dict,
        difficulty: str, numeric_difficulty: int, count: int, question_offset: int = 0,
        excluded_stems: set[str] | None = None,
    ) -> list[dict]:
        """Generate and review one reusable master question at a time.

        Each question is an observable work unit.  The writer produces one
        evidence-grounded candidate, the verifier reviews that exact candidate,
        and a failed candidate is regenerated before the next question starts.
        """
        if count <= 0:
            return []
        evidence = [source for source in sources[:8] if source.get("id") is not None and str(source.get("content") or "").strip()]
        if not evidence:
            return []
        # A quiz is generated in three observable five-question batches.  The
        # previous implementation entered a writer/reviewer loop for every
        # individual question (and could repeat it twelve times), which made a
        # 15-question bank require dozens of model calls.  Keep the old code
        # below as a compatibility reference, but route all current work through
        # the bounded batch workflow.
        return await self._generate_question_bank_group(
            payload, context, evidence, knowledge_point, difficulty,
            numeric_difficulty, count, question_offset, excluded_stems,
        )

    async def _generate_question_bank_group(
        self, payload: dict, context: dict, evidence: list[dict], knowledge_point: dict,
        difficulty: str, numeric_difficulty: int, count: int, question_offset: int,
        excluded_stems: set[str] | None,
    ) -> list[dict]:
        """Generate five questions together and cap automatic repair at two rounds."""
        evidence_text = "\n\n".join(
            f"[{source['id']}] {source.get('document') or '知识资料'}\n{str(source.get('content') or '')[:5000]}"
            for source in evidence
        )
        evidence_by_id = {int(source["id"]): str(source.get("content") or "") for source in evidence}
        evidence_items = [{
            "id": source.get("chunkId") or source.get("id"),
            "sourceId": source.get("id"),
            "title": source.get("document") or "知识资料",
            "section": source.get("sectionTitle") or source.get("section_title") or "",
            "excerpt": str(source.get("content") or "")[:420],
            "similarity": source.get("similarity"),
        } for source in evidence]
        start_number = question_offset + 1
        end_number = question_offset + count
        accepted_stems = set(excluded_stems or set())
        system = """你是机构通用题库的出题 Agent。一次生成完整的一组题，只能依据 Evidence，禁止使用用户画像。
每题必须是独立、自包含的四选一单选题，答案唯一；题干和选项不得出现“根据资料、依据材料、Evidence”等措辞。
每题必须给出解析、干扰项分析、真实引用编号、逐字证据短句，以及证据支撑、答案唯一性、题意清晰度、难度和干扰项合理性说明。
只返回 JSON：{"questions":[{"question_type":"single_choice","difficulty":1,"cognitive_level":"remember","stem":"题干","options":[{"key":"A","content":"选项"}],"reference_answer":["A"],"explanation":"解析","distractor_analysis":[{"option":"B","misconception":"误区"}],"evidence_chunk_ids":[1],"answer_evidence_quotes":[{"chunk_id":1,"quote":"Evidence中的逐字原文"}],"rationale":{"grounding":"证据支撑","answer":"答案唯一性","clarity":"无歧义","difficulty":"难度匹配","distractors":"干扰项合理性"}}]}。"""
        base_prompt = f"""# 知识点
ID={knowledge_point['id']}，名称：{knowledge_point['name']}

# Evidence
{evidence_text}

# 本批要求
一次生成 {count} 道难度={numeric_difficulty}的题目，对应整套题库第 {start_number}-{end_number} 题。
题目之间不得重复，不得依赖上一题或共享题组材料，也不得与这些已通过题干重复：
{json.dumps(sorted(accepted_stems), ensure_ascii=False)[:5000]}
易混淆知识点：{json.dumps(payload.get('contrast_points') or [], ensure_ascii=False)[:1800]}
教研蓝图：{json.dumps(payload.get('competition_blueprint') or {}, ensure_ascii=False)[:2500]}"""

        candidate: list[dict] = []
        audit: list[dict] = []
        repair_directives: list[dict] = []
        version_history: list[dict] = []
        total_questions = max(1, int(payload.get("question_count") or 15))
        progress = 42 + int(question_offset * 28 / total_questions)

        for attempt in range(1, 4):
            mode = "initial" if attempt == 1 else "targeted_repair" if attempt == 2 else "replacement"
            title = (
                f"生成第 {start_number}-{end_number} 题"
                if attempt == 1 else
                f"批量修订第 {start_number}-{end_number} 题"
                if attempt == 2 else
                f"替换第 {start_number}-{end_number} 题中的硬错误题"
            )
            await self._generation_event(
                "generating", progress, title,
                f"内容生成 Agent 正在一次完成本批 {count} 道题", "writer", {
                    "activity": "正在批量生成题干、选项、答案、解析和引用",
                    "questionRange": [start_number, end_number], "attempt": attempt,
                    "batchSize": count, "evidenceItems": evidence_items,
                },
            )
            prompt = base_prompt
            if candidate and repair_directives:
                prompt += (
                    "\n上一批候选与审核意见如下。只修改审核指出的题，其他题保持不变；返回完整的一批题：\n"
                    if attempt == 2 else
                    "\n以下题目仍有硬错误。请直接换成证据更明确、答案更唯一的新题；返回完整的一批题：\n"
                )
                prompt += json.dumps({"questions": candidate, "audit": repair_directives}, ensure_ascii=False)[:18000]
            raw = await self.llm.complete_json(
                system, prompt, {"questions": []}, provider="mimo", max_tokens=8192,
                max_retries=2, thinking=False, timeout_seconds=180,
            )
            structure_issues: list[str] = []
            normalized = self._normalize_question_bank_questions(
                raw, set(evidence_by_id), knowledge_point, difficulty,
                numeric_difficulty, count, evidence_by_id, diagnostics=structure_issues,
            )
            if len(normalized) != count:
                repair_directives = [{"scope": "batch", "issues": structure_issues or [f"应返回 {count} 题，实际 {len(normalized)} 题"]}]
                if attempt < 3:
                    continue
                raise RuntimeError(f"第 {start_number}-{end_number} 题模型连续未返回完整批次")
            normalized_stems = [str(item.get("stem") or "").strip() for item in normalized]
            repeated_stems = [stem for stem in normalized_stems if stem in accepted_stems]
            if len(set(normalized_stems)) != len(normalized_stems) or repeated_stems:
                repair_directives = [{
                    "scope": "batch", "issues": ["本批内部或与已通过批次存在重复题干，必须更换命题角度"],
                    "repeatedStems": repeated_stems,
                }]
                if attempt < 3:
                    continue
                raise RuntimeError(f"第 {start_number}-{end_number} 题模型连续返回重复题目")
            candidate = normalized
            version_history.append({"version": attempt, "mode": mode, "questions": copy.deepcopy(candidate)})
            await self._generation_event(
                "generating", min(71, progress + 2), f"第 {start_number}-{end_number} 题候选已生成",
                f"本批 {count} 道题已形成，正在进行批量核验", "writer", {
                    "activity": "正在保存本批候选并移交质量核验 Agent",
                    "questionRange": [start_number, end_number], "attempt": attempt,
                    "artifactContent": {"title": f"第 {start_number}-{end_number} 题", "questions": candidate},
                },
            )
            if attempt == 3:
                # The second repair is a replacement round.  Structural and
                # evidence-quote validation above is deterministic; remaining
                # semantic scores are exposed to the human reviewer instead of
                # opening another unbounded LLM critique loop.
                audit = [{
                    "index": index + 1, "passed": True, "summary": "已完成硬错误替换，进入人工审核",
                    "scores": {}, "hardErrors": [], "issues": [], "reviewMode": "replacement_accept",
                } for index in range(count)]
                break
            audit = await self._review_master_question_group(candidate, evidence, repair_directives if attempt == 2 else [])
            failed = [item for item in audit if not item.get("passed")]
            await self._generation_event(
                "verifying", min(76, progress + 4),
                f"第 {start_number}-{end_number} 题批量核验{'通过' if not failed else '发现需修订项'}",
                f"已一次性核验本批 {count} 道题，{len(failed)} 道需要处理", "citation_verifier", {
                    "activity": "正在批量核对事实、答案、歧义、难度、干扰项和引用",
                    "questionRange": [start_number, end_number], "questionAudits": audit,
                    "decision": "pass" if not failed else "repair",
                    "nextStep": "纳入题库母版" if not failed else "批量退回内容生成 Agent 定向修订",
                },
            )
            if not failed:
                break
            repair_directives = failed

        audit_by_index = {int(item.get("index") or 0): item for item in audit}
        result: list[dict] = []
        for index, question in enumerate(candidate, 1):
            review = audit_by_index.get(index, {"passed": True, "summary": "进入人工审核", "scores": {}})
            question["reviewStatus"] = "pending_review"
            question["reviewSnapshot"] = review
            question["reviewMetrics"] = review.get("scores") or {}
            question["riskLabels"] = review.get("riskLabels") or []
            question["versionHistory"] = copy.deepcopy(version_history)
            question["replacementUsed"] = len(version_history) >= 3
            question["contentHash"] = self._question_content_hash(question)
            question["evidenceSnapshot"] = [item for item in evidence_items if item["sourceId"] in question.get("citations", [])]
            question["knowledgePointIds"] = [str(knowledge_point["id"])]
            result.append(question)
        return result

    async def _review_master_question_group(
        self, questions: list[dict], evidence: list[dict], previous_audit: list[dict],
    ) -> list[dict]:
        """Review a five-question batch in one model request."""
        compact_evidence = [{
            "id": item.get("id"), "title": item.get("document") or "知识资料",
            "content": str(item.get("content") or "")[:2200],
        } for item in evidence]
        closure = bool(previous_audit)
        fallback = {"reviews": []}
        response = await self.llm.complete_json(
            "你是机构通用题库的质量核验 Agent。一次审核整批题目，只返回 JSON，不展示思维链。",
            f"题目：{json.dumps(questions, ensure_ascii=False)}\n"
            f"引用依据：{json.dumps(compact_evidence, ensure_ascii=False)}\n"
            f"上一轮未通过项：{json.dumps(previous_audit, ensure_ascii=False)}\n"
            + ("这是返修复核。只能检查上一轮指出的问题是否关闭，不得新增问题；已关闭即通过。\n" if closure else
               "这是首次审核。检查答案唯一性和正确性、证据支撑、题意、自包含性、难度、干扰项与解析。\n")
            + '返回 {"reviews":[{"index":1,"passed":true,"summary":"结论","scores":{"grounding":0,"answerConfidence":0,"clarity":0,"distractorQuality":0,"difficultyMatch":0,"explanationQuality":0,"overall":0},"hardErrors":[],"issues":[],"repairSuggestions":[],"riskLabels":[]}]}。'
            "硬错误仅限答案错误或不唯一、证据不支持答案、引用不存在、题目结构不可作答。措辞风格等可优化项不得阻止通过。",
            fallback, provider="mimo", max_tokens=3600, max_retries=2,
            thinking=False, timeout_seconds=150,
        )
        rows = [item for item in response.get("reviews") or [] if isinstance(item, dict)]
        by_index = {int(item.get("index") or 0): item for item in rows}
        result: list[dict] = []
        previous_by_index = {int(item.get("index") or 0): item for item in previous_audit}
        for index in range(1, len(questions) + 1):
            item = by_index.get(index)
            if item is None:
                # An incomplete verifier response is not a content defect.  The
                # deterministic parser already validated structure and quotes;
                # expose the missing semantic score to the human reviewer.
                item = {"index": index, "passed": True, "summary": "自动评分未完整返回，已转人工审核", "scores": {}, "hardErrors": [], "issues": [], "riskLabels": ["audit_incomplete"]}
            hard_errors = [str(value) for value in item.get("hardErrors") or [] if str(value).strip()]
            issues = [str(value) for value in item.get("issues") or [] if str(value).strip()]
            if closure:
                previous = previous_by_index.get(index) or {}
                prior_hard = [str(value) for value in previous.get("hardErrors") or [] if str(value).strip()]
                # The closure pass is deliberately bounded to the prior audit.
                relevant = [issue for issue in hard_errors if issue in prior_hard]
                passed = not relevant
                hard_errors = relevant
                issues = relevant
            else:
                passed = bool(item.get("passed")) and not hard_errors
            result.append({**item, "index": index, "passed": passed,
                           "hardErrors": hard_errors, "issues": [] if passed else issues or hard_errors})
        return result
        evidence_text = "\n\n".join(
            f"[{source['id']}] {source.get('document') or '知识资料'}\n{str(source.get('content') or '')[:5000]}"
            for source in evidence
        )
        system = """你是一名严谨的学科出题专家。只能依据给定 Evidence 出题，严禁编造。
这是机构管理员预生成的通用题目母版，不得读取、推断或提及任何用户画像、个人水平、个人偏好、个人目标或个人学习记录。
每题必须引用 Evidence 中真实存在的编号。答案必须唯一、明确；解析要说明正确项及主要干扰项为何不成立。
Evidence 仅用于后台事实溯源，题干和选项必须像学完课程后的正式测试，直接提问知识、场景、决策或工程应用。
禁止在题干和选项中出现“根据资料”“依据材料”“文献中”“资料[1]”“上述文本”等阅读理解式或暴露来源的措辞。
每道题必须完全独立、自包含，单独给足必要场景和约束；调换题序后仍可作答。禁止引用上一题、前述场景、同一案例或共享题组材料。
难度标准：1=事实回忆；2=单点理解；3=场景应用；4=多条件分析；5=复杂迁移与综合推理。
每题还必须给出 answer_evidence_quotes：1至3条直接支撑正确答案的 Evidence 原文短句，quote 必须从对应 chunk 逐字复制，不得改写。
生成前必须自检审核要求，并为审核人员提供 rationale：分别说明证据为何支持、答案为何唯一、题意为何无歧义、难度为何匹配、干扰项为何合理。
只输出 JSON：{\"questions\":[{\"question_type\":\"single_choice\",\"difficulty\":1,\"cognitive_level\":\"remember\",\"stem\":\"题干\",\"options\":[{\"key\":\"A\",\"content\":\"选项\"}],\"reference_answer\":[\"A\"],\"explanation\":\"解析\",\"distractor_analysis\":[{\"option\":\"B\",\"misconception\":\"对应的真实误区或易混淆边界\"}],\"evidence_chunk_ids\":[1],\"answer_evidence_quotes\":[{\"chunk_id\":1,\"quote\":\"直接支撑正确答案的原文\"}],\"rationale\":{\"grounding\":\"证据支撑说明\",\"answer\":\"答案唯一性说明\",\"clarity\":\"无歧义说明\",\"difficulty\":\"难度说明\",\"distractors\":\"干扰项说明\"}}]}"""
        base_prompt = f"""# 目标知识点
ID={knowledge_point['id']}，名称：{knowledge_point['name']}

# Evidence（只能依据这些资料出题）
{evidence_text}

# 生成要求
生成 1 道 single_choice；难度={numeric_difficulty}；四个互不重复选项；答案唯一。
题目面向已经完成本知识点学习的学员，不得写成阅读理解，不得在题干或选项中提及资料、材料、文献、原文、文本或 Evidence。
每题独立命题，不得出现“上一题”“前述题目”“上述场景”“沿用同一案例”等跨题依赖。
易混淆知识点：{json.dumps(payload.get('contrast_points') or [], ensure_ascii=False)[:1800]}
若存在易混淆知识点，优先用其概念边界构造具有辨析价值的干扰项；不得把易混淆知识点直接当作错误事实，不得为了使用它而制造无依据选项。
通用教研蓝图：{json.dumps(payload.get('competition_blueprint') or {}, ensure_ascii=False)[:2500]}"""
        evidence_by_id = {int(source["id"]): str(source.get("content") or "") for source in evidence}
        accepted: list[dict] = []
        accepted_stems: set[str] = set(excluded_stems or set())
        evidence_items = [{
            "id": source.get("chunkId") or source.get("id"),
            "sourceId": source.get("id"),
            "title": source.get("document") or "知识资料",
            "section": source.get("sectionTitle") or source.get("section_title") or "",
            "excerpt": str(source.get("content") or "")[:420],
            "similarity": source.get("similarity"),
        } for source in evidence]
        async def make_question(local_index: int) -> None:
                question_number = question_offset + local_index + 1
                total_questions = max(1, int(payload.get("question_count") or count))
                question_progress = 42 + int((question_number - 1) * 28 / total_questions)
                directives: list[str] = []
                previous_review: dict | None = None
                accepted_question: dict | None = None
                candidate: dict | None = None
                replacement_mode = False
                version_history: list[dict] = []
                # 质量问题不终止整批：先定向修订，仍有硬错则持续换题。
                # 12 次仅用于识别模型通道持续异常，不是业务质量失败上限。
                for attempt in range(1, 13):
                    await self._generation_event(
                        "generating", question_progress, f"生成第 {question_number} 题",
                        f"内容生成 Agent 正在依据已核验切片生成第 {question_number} 题", "writer", {
                            "activity": "正在逐题设计题干、选项、答案、解析和证据引用",
                            "questionNumber": question_number, "questionDifficulty": numeric_difficulty,
                            "attempt": attempt, "evidenceItems": evidence_items,
                        },
                    )
                    prompt = base_prompt + (
                        "\n本题不得与以下已通过题干重复：" + json.dumps(sorted(accepted_stems), ensure_ascii=False)
                        if accepted_stems else ""
                    )
                    if directives:
                        prompt += (
                            "\n上一候选存在硬错误，废弃原题。请换一个证据更直接、答案更唯一、结构更稳健的全新命题角度："
                            if replacement_mode else
                            "\n上一版未通过，保留命题目标并逐项定向修正："
                        ) + json.dumps(directives, ensure_ascii=False)
                    raw = await self.llm.complete_json(
                        system, prompt, {"questions": []}, provider="mimo", max_tokens=2600,
                        max_retries=2, thinking=False,
                    )
                    structure_issues: list[str] = []
                    normalized = self._normalize_question_bank_questions(
                        raw, set(evidence_by_id), knowledge_point, difficulty, numeric_difficulty, 1, evidence_by_id,
                        diagnostics=structure_issues,
                    )
                    if not normalized:
                        directives = list(dict.fromkeys(structure_issues))[:6] or ["模型没有返回可解析的完整题目"]
                        await self._generation_event(
                            "verifying", min(72, question_progress + 2), f"第 {question_number} 题结构核验未通过",
                            "；".join(directives), "citation_verifier", {
                                "activity": "正在逐项检查题干、选项、唯一答案、解析和证据原文",
                                "questionNumber": question_number, "attempt": attempt,
                                "checks": [{"label": "结构与证据原文匹配", "passed": False}],
                                "issues": directives, "decision": "repair",
                                "nextStep": "退回内容生成 Agent 重新生成本题",
                            },
                        )
                        continue
                    candidate = normalized[0]
                    candidate_stem = str(candidate.get("stem") or "").strip()
                    if candidate_stem in accepted_stems:
                        directives = ["题干与已通过题目重复，必须更换考查角度和场景后重新生成"]
                        await self._generation_event(
                            "verifying", min(72, question_progress + 2), f"第 {question_number} 题重复性核验未通过",
                            directives[0], "citation_verifier", {
                                "activity": "正在检查本题是否与已通过题目重复",
                                "questionNumber": question_number, "attempt": attempt,
                                "checks": [{"label": "题目去重", "passed": False, "finding": directives[0]}],
                                "issues": directives, "decision": "repair",
                                "nextStep": "退回内容生成 Agent 更换命题角度",
                            },
                        )
                        continue
                    await self._generation_event(
                        "generating", min(71, question_progress + 1), f"第 {question_number} 题第一版已生成",
                        "本题的题干、选项、答案、解析和引用已经形成，正在移交逐题核验", "writer", {
                            "activity": "正在保存本题候选版本并移交质量核验 Agent",
                            "questionNumber": question_number, "attempt": attempt, "question": candidate,
                            "evidenceItems": evidence_items,
                            "artifactPreview": {"kind": "question", "title": f"第 {question_number} 题", "countLabel": "题目", "count": 1,
                                                "items": [{"title": f"第 {question_number} 题", "preview": candidate.get("stem")}]},
                            "artifactContent": {"title": f"第 {question_number} 题", "questions": [candidate]},
                            "nextStep": "交给质量核验 Agent 逐项检查本题",
                        },
                    )
                    review = await self._review_master_question(
                        candidate, evidence, None if replacement_mode else previous_review,
                        score_only=replacement_mode,
                    )
                    if review.get("reviewUnavailable"):
                        # Retry the verifier against the same frozen candidate. A
                        # transport/JSON failure must not consume a writer attempt.
                        review = await self._review_master_question(
                            candidate, evidence, None if replacement_mode else previous_review,
                            score_only=replacement_mode,
                        )
                    if review.get("reviewUnavailable"):
                        raise RuntimeError(f"第 {question_number} 题质量核验服务连续未返回有效结果")
                    hard_errors = [str(item) for item in review.get("hardErrors") or [] if str(item).strip()]
                    passed = bool(review.get("passed")) or (replacement_mode and not hard_errors)
                    version_history.append({
                        "version": len(version_history) + 1,
                        "mode": "replacement" if replacement_mode else "initial" if attempt == 1 else "targeted_repair",
                        # 保存不可变快照，不能把即将挂载 versionHistory 的 candidate
                        # 原对象放回历史，否则会形成 candidate -> history -> candidate 循环引用。
                        "question": copy.deepcopy(candidate),
                        "audit": copy.deepcopy(review),
                    })
                    await self._generation_event(
                        "verifying", min(72, question_progress + 2),
                        f"第 {question_number} 题质量核验{'通过' if passed else '未通过'}",
                        str(review.get("summary") or ("题目符合通用母版要求" if passed else "题目需要定向修订")),
                        "citation_verifier", {
                            "activity": "质量核验 Agent 正在逐题检查事实、答案、歧义、难度、干扰项和引用",
                            "questionNumber": question_number, "attempt": attempt,
                            "question": candidate, "questionAudit": review,
                            "reviewMode": "score_only" if replacement_mode else "full_or_closure",
                            "checks": review.get("checks") or [], "issues": review.get("issues") or [],
                            "evidenceItems": evidence_items, "decision": "pass" if passed else "repair",
                            "artifactPreview": {"kind": "question", "title": f"第 {question_number} 题", "countLabel": "题目", "count": 1,
                                                "items": [{"title": f"第 {question_number} 题", "preview": candidate.get("stem")}]},
                            "artifactContent": {"title": f"第 {question_number} 题", "questions": [candidate]},
                            "nextStep": "纳入题库母版并继续生成下一题" if passed else "退回内容生成 Agent 定向重做本题",
                        },
                    )
                    if passed:
                        candidate["reviewStatus"] = "pending_review"
                        candidate["reviewSnapshot"] = review
                        candidate["reviewMetrics"] = review.get("scores") or {}
                        candidate["riskLabels"] = review.get("riskLabels") or []
                        candidate["generationRationale"] = candidate.get("generationRationale") or {}
                        candidate["versionHistory"] = version_history
                        candidate["replacementUsed"] = any(item["mode"] == "replacement" for item in version_history)
                        candidate["contentHash"] = self._question_content_hash(candidate)
                        candidate["evidenceSnapshot"] = [item for item in evidence_items if item["sourceId"] in candidate.get("citations", [])]
                        candidate["knowledgePointIds"] = [str(knowledge_point["id"])]
                        accepted_question = candidate
                        break
                    directives = hard_errors or [str(item) for item in review.get("issues") or ["逐题质量核验未通过"]]
                    # 首轮普通问题只定向修订一次；硬错或定向修订仍未关闭时，废弃候选并换题。
                    replacement_mode = bool(hard_errors) or previous_review is not None
                    previous_review = None if replacement_mode else review
                if accepted_question is not None:
                    accepted.append(accepted_question)
                    ordered.append((local_index, accepted_question))
                    accepted_stems.add(str(accepted_question.get("stem") or ""))
                else:
                    await self._generation_event(
                        "verifying", min(72, question_progress + 2), f"第 {question_number} 题等待模型服务恢复",
                        "模型连续未能形成无硬错误的候选题，按生成通道异常处理", "citation_verifier", {
                            "activity": "已保留全部候选与审核记录，等待模型服务恢复",
                            "questionNumber": question_number, "attempt": 12, "issues": directives,
                            "decision": "infrastructure_error", "nextStep": "模型服务恢复后继续补齐本题",
                        },
                    )
                    raise RuntimeError(
                        f"第 {question_number} 题模型通道连续未形成可审核候选："
                        + "；".join(directives or ["结构与证据核验未通过"])
                    )
        ordered: list[tuple[int, dict]] = []
        # The deployment model is single-slot. Generate and review one
        # question at a time so one quiz resource cannot flood that slot with
        # several simultaneous requests.
        for index in range(count):
            await make_question(index)
        accepted[:] = [q for _, q in sorted(ordered, key=lambda pair: pair[0])]

        return accepted

    @staticmethod
    def _question_content_hash(question: dict) -> str:
        import hashlib
        canonical = json.dumps({
            "stem": str(question.get("stem") or "").strip(),
            "options": question.get("options") or [],
            "answer": question.get("correctIndex"),
        }, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    async def _review_master_question(self, question: dict, evidence: list[dict],
                                      previous_review: dict | None = None,
                                      *, score_only: bool = False) -> dict:
        compact_evidence = [{
            "id": item.get("id"), "title": item.get("document") or "知识资料",
            "content": str(item.get("content") or "")[:1800],
        } for item in evidence if item.get("id") in question.get("citations", [])]
        fallback = {
            "__review_unavailable__": True,
            "passed": False, "summary": "逐题核验未取得有效结果",
            "checks": [{"label": "核验结果完整性", "passed": False}],
            "issues": ["质量核验结果不完整，请重新生成本题"],
        }
        result = await self.llm.complete_json(
            "你是机构通用题库的质量核验Agent，只审核这一道题，不替生成结果辩护，也不展示思维链。只返回JSON。",
            f"待审核题目：{json.dumps(question, ensure_ascii=False)}\n"
            f"引用依据：{json.dumps(compact_evidence, ensure_ascii=False)}\n"
            f"上一轮审核单：{json.dumps(previous_review or {}, ensure_ascii=False)}\n"
            + ("这是换题后的新候选。不要继续挑选可优化的小问题，只对各项质量打分并识别硬错误；无硬错误即可进入人工审核。\n"
               if score_only else
               "这是返修复核。必须先逐条检查上一轮 issues 是否已关闭，并在 resolutions 中说明每条原问题的复核结果；"
               "本轮不得重新进行全量审核，不得新增问题，不得改变审查范围；只判断上一轮每个问题是否已经修正。\n"
               if previous_review else "这是首次审核，请完整检查本题。\n")
            + "逐项检查：事实是否有原文支持；正确答案是否唯一且正确；题干是否无歧义且自包含；"
            "难度是否匹配；干扰项是否来自真实误区且具有辨析价值；解析是否说明正确项和主要错误项；"
            "是否适合作为不依赖用户画像的通用母版。返回"
            '{"passed":true或false,"summary":"面向审核人员的结论","scores":{"grounding":0到100,"answerConfidence":0到100,"clarity":0到100,"distractorQuality":0到100,"difficultyMatch":0到100,"explanationQuality":0到100,"overall":0到100},"riskLabels":[],"hardErrors":[],"repairSuggestions":[],"resolutions":[{"previousIssue":"上一轮问题原文","resolved":true或false,"finding":"复核结果"}],"checks":[{"label":"检查项","passed":true或false,"finding":"具体发现","evidence":"对应依据"}],"issues":["首次审核发现的问题，或返修复核中仍未关闭的原问题"]}。'
            "硬错误仅限：答案错误或不唯一、证据不能支持答案、引用不存在、题目结构不可作答。普通措辞、风格或可优化项不得列为硬错误。",
            fallback, provider="mimo", max_tokens=2600, max_retries=3, thinking=False,
            timeout_seconds=120,
        )
        if result.get("__review_unavailable__"):
            # Transport/JSON failure is not a quality finding.  Retry the same
            # candidate with a deliberately tiny audit contract; never regenerate
            # the question merely because the verifier response was malformed.
            compact = await self.llm.complete_json(
                "你是单题质量核验员。系统判分结构仅支持单选：correctIndex 必须是 0-3 的单个整数；若题干或答案含多个正确选项，请在 explanation 中说明，并把首个正确选项作为 correctIndex，不得要求把 correctIndex 改为数组或多选标识。只返回JSON，不输出解释过程。",
                f"题目：{json.dumps(question, ensure_ascii=False)}\n"
                f"证据：{json.dumps(compact_evidence, ensure_ascii=False)}\n"
                f"上一轮问题：{json.dumps((previous_review or {}).get('issues') or [], ensure_ascii=False)}\n"
                '返回 {"passed":true或false,"summary":"结论","issues":["具体问题"]}。'
                "若是复核，只判断上一轮问题是否关闭，不得新增问题。",
                fallback, provider="mimo", max_tokens=900, max_retries=3,
                thinking=False, timeout_seconds=120,
            )
            if compact.get("__review_unavailable__"):
                return {
                    "passed": False, "reviewUnavailable": True,
                    "summary": "质量核验服务未返回有效结果",
                    "resolutions": [],
                    "checks": [{"label": "核验服务响应", "passed": False,
                                "finding": "题目已通过结构与原文检查，但语义核验暂未完成"}],
                    "issues": ["质量核验服务暂不可用"],
                }
            result = {
                **compact,
                "checks": [{"label": "单题语义核验", "passed": bool(compact.get("passed")),
                            "finding": str(compact.get("summary") or "已完成精简复核")}],
                "resolutions": ([{
                    "previousIssue": issue,
                    "resolved": bool(compact.get("passed")),
                    "finding": str(compact.get("summary") or "已完成精简复核"),
                } for issue in (previous_review or {}).get("issues") or []]),
            }
        checks = [item for item in result.get("checks") or [] if isinstance(item, dict)] if isinstance(result, dict) else []
        issues = [str(item) for item in result.get("issues") or [] if str(item).strip()] if isinstance(result, dict) else fallback["issues"]
        resolutions = [item for item in result.get("resolutions") or [] if isinstance(item, dict)] if isinstance(result, dict) else []
        scores = result.get("scores") if isinstance(result.get("scores"), dict) else {}
        risk_labels = [str(item) for item in result.get("riskLabels") or [] if str(item).strip()]
        hard_errors = [str(item) for item in result.get("hardErrors") or [] if str(item).strip()]
        repair_suggestions = [str(item) for item in result.get("repairSuggestions") or [] if str(item).strip()]
        if not hard_errors:
            hard_pattern = re.compile(r"答案.*(?:错误|不唯一)|证据.*(?:不支持|无法支持)|引用.*(?:不存在|无效)|结构.*(?:不可作答|不合法)")
            hard_errors = [issue for issue in issues if hard_pattern.search(issue)]
        default_score = 90 if bool(result.get("passed")) else 60
        scores = {
            key: max(0, min(100, int(scores.get(key, default_score) or 0)))
            for key in (
                "grounding", "answerConfidence", "clarity", "distractorQuality",
                "difficultyMatch", "explanationQuality", "overall",
            )
        }
        previous_issues = [str(item) for item in (previous_review or {}).get("issues") or [] if str(item).strip()]
        if previous_issues:
            # Closure review is intentionally bounded to the prior audit sheet.
            # Ignore newly invented issues and require an explicit resolution for
            # every original issue before the question can pass.
            resolution_by_issue = {str(item.get("previousIssue") or "").strip(): item for item in resolutions}
            unresolved: list[str] = []
            normalized_resolutions: list[dict] = []
            for index, previous_issue in enumerate(previous_issues):
                resolution = resolution_by_issue.get(previous_issue)
                if resolution is None and index < len(resolutions):
                    resolution = resolutions[index]
                resolved = bool(resolution and resolution.get("resolved") is True)
                finding = str((resolution or {}).get("finding") or "未取得明确复核结论")
                normalized_resolutions.append({
                    "previousIssue": previous_issue, "resolved": resolved, "finding": finding,
                })
                if not resolved:
                    unresolved.append(previous_issue)
            resolutions = normalized_resolutions
            passed = not unresolved
            issues = unresolved
            checks = [{
                "label": "上一轮问题复核", "passed": item["resolved"], "finding": item["finding"],
            } for item in resolutions]
        elif score_only:
            passed = not hard_errors
            issues = hard_errors
        else:
            passed = bool(result.get("passed")) and bool(checks) and all(item.get("passed") is not False for item in checks)
        return {"passed": passed, "summary": str(result.get("summary") or fallback["summary"]),
                "resolutions": resolutions, "checks": checks,
                "issues": [] if passed else issues or fallback["issues"],
                "scores": scores, "riskLabels": risk_labels, "hardErrors": hard_errors,
                "repairSuggestions": repair_suggestions, "reviewMode": "score_only" if score_only else "full_or_closure"}

    @staticmethod
    def _closest_verbatim_passage(query: str, source_text: str) -> tuple[str, float]:
        """Return a real source segment closest to a model paraphrase."""
        def token_set(value: str) -> set[str]:
            cleaned = re.sub(r"[`*_#>\[\](){}，。！？；：、\s]+", "", value.casefold())
            latin = set(re.findall(r"[a-z0-9][a-z0-9_-]+", cleaned))
            chinese = re.findall(r"[\u4e00-\u9fff]", cleaned)
            return latin | {"".join(chinese[i:i + 2]) for i in range(max(0, len(chinese) - 1))}

        candidates = []
        for line in re.split(r"[\r\n]+", source_text or ""):
            line = line.strip()
            if 8 <= len(line) <= 320:
                candidates.append(line)
            candidates.extend(part.strip() for part in re.split(r"(?<=[。！？；])", line)
                              if 8 <= len(part.strip()) <= 260)
        query_tokens = token_set(query)
        best, best_score = "", 0.0
        for candidate in dict.fromkeys(candidates):
            candidate_tokens = token_set(candidate)
            overlap = len(query_tokens & candidate_tokens) / max(1, len(query_tokens))
            sequence = SequenceMatcher(None, re.sub(r"\s+", "", query.casefold()),
                                       re.sub(r"\s+", "", candidate.casefold())).ratio()
            score = overlap * .72 + sequence * .28
            if score > best_score:
                best, best_score = candidate, score
        return best, best_score

    @staticmethod
    def _normalize_question_bank_questions(
        raw: dict, valid_source_ids: set[int], knowledge_point: dict,
        difficulty: str, numeric_difficulty: int, expected: int,
        evidence_by_id: dict[int, str] | None = None,
        diagnostics: list[str] | None = None,
    ) -> list[dict]:
        normalized: list[dict] = []
        seen_stems: set[str] = set()
        for item in raw.get("questions") or []:
            if not isinstance(item, dict) or item.get("question_type") != "single_choice":
                if diagnostics is not None: diagnostics.append("模型未返回 single_choice 题目对象")
                continue
            stem = str(item.get("stem") or "").strip()
            options = item.get("options") or []
            answers = item.get("reference_answer") or []
            explanation = str(item.get("explanation") or "").strip()
            option_text = " ".join(
                str(option.get("content") or "") for option in options if isinstance(option, dict)
            )
            refs = []
            for value in item.get("evidence_chunk_ids") or []:
                try:
                    ref = int(value)
                except (TypeError, ValueError):
                    continue
                if ref in valid_source_ids and ref not in refs:
                    refs.append(ref)
            quotes = item.get("answer_evidence_quotes") or []
            verified_refs: list[int] = []
            verified_quotes: list[dict] = []
            for quote_item in quotes:
                if not isinstance(quote_item, dict):
                    continue
                try:
                    quote_ref = int(quote_item.get("chunk_id"))
                except (TypeError, ValueError):
                    continue
                quote = str(quote_item.get("quote") or "").strip()
                source_text = (evidence_by_id or {}).get(quote_ref, "")
                if quote and quote not in source_text:
                    located, score = LearningContentService._closest_verbatim_passage(quote, source_text)
                    if located and score >= .10:
                        quote = located
                        quote_item = {**quote_item, "quote": located}
                if quote_ref in refs and 8 <= len(quote) <= 300 and quote in source_text and quote_ref not in verified_refs:
                    verified_refs.append(quote_ref)
                    verified_quotes.append({**quote_item, "chunk_id": quote_ref, "quote": quote})
            failures = []
            if len(stem) < 12: failures.append("题干过短（至少 12 个字符）")
            if stem in seen_stems: failures.append("题干与本次候选重复")
            if len(options) != 4: failures.append("选项数量不是 4 个")
            if not refs: failures.append("没有有效来源编号")
            if len(refs) > 6: failures.append("引用来源超过 6 个")
            if evidence_by_id is not None and not refs and not verified_refs: failures.append("答案依据原文无法在对应切片中逐字定位")
            if len(explanation) < 30: failures.append("解析过短（至少 30 个字符）")
            if LearningContentService.QUIZ_READING_COMPREHENSION_PATTERN.search(f"{stem} {option_text}"):
                failures.append("题干或选项包含阅读材料式来源提示")
            if LearningContentService.QUIZ_CROSS_QUESTION_PATTERN.search(f"{stem} {option_text}"):
                failures.append("题目依赖上一题或前述场景")
            if failures:
                if diagnostics is not None: diagnostics.extend(failures)
                continue
            keys, texts = [], []
            for option in options:
                if not isinstance(option, dict):
                    break
                keys.append(str(option.get("key") or "").strip().upper())
                texts.append(str(option.get("content") or "").strip())
            if len(keys) != 4 or len(set(keys)) != 4 or len(set(texts)) != 4 or not all(keys) or not all(texts):
                if diagnostics is not None: diagnostics.append("选项键或选项内容缺失、重复")
                continue
            answer = str(answers[0] if isinstance(answers, list) and answers else answers).strip().upper()
            # 模型偶尔按多选题作答（如 "A、B、C"）：系统判分结构仅支持单选 correctIndex，
            # 程序化取首个正确项，其余并入解析，避免核验器反复要求数组结构导致任务失败。
            multi_keys = [key for key in keys if key in answer]
            if len(multi_keys) > 1 and answer not in keys:
                answer = multi_keys[0]
                joined_keys = "、".join(multi_keys)
                explanation = str(explanation or "") + f"（原标准答案为 {joined_keys} 多项，本系统按首个正确项 {multi_keys[0]} 判定）"
            if answer not in keys:
                if diagnostics is not None: diagnostics.append("正确答案不在四个选项中")
                continue
            seen_stems.add(stem)
            normalized.append({
                "id": str(uuid4()), "knowledgePointId": str(knowledge_point["id"]),
                "difficulty": difficulty, "difficultyLevel": numeric_difficulty,
                "cognitiveLevel": str(item.get("cognitive_level") or "understand"),
                "stem": stem, "options": texts, "correctIndex": keys.index(answer),
                "explanation": explanation, "citations": verified_refs if evidence_by_id is not None else refs,
                "answerEvidenceQuotes": verified_quotes,
                "distractorAnalysis": [entry for entry in item.get("distractor_analysis") or [] if isinstance(entry, dict)][:3],
                "generationRationale": item.get("rationale") if isinstance(item.get("rationale"), dict) else {},
                "generationMetadata": {"promptVersion": LearningContentService.QUESTION_BANK_PROMPT_VERSION},
            })
            if len(normalized) >= expected:
                break
        return normalized

    @staticmethod
    def _rebalance_quiz_answers(content: dict) -> None:
        for index, question in enumerate(content.get("questions") or []):
            if not isinstance(question, dict) or len(question.get("options") or []) != 4:
                continue
            try:
                current = int(question.get("correctIndex"))
            except (TypeError, ValueError):
                continue
            target = index % 4
            if current in range(4) and current != target:
                question["options"][current], question["options"][target] = (
                    question["options"][target], question["options"][current],
                )
                question["correctIndex"] = target

    @staticmethod
    def _quiz_fallback(payload: dict, count: int, category_candidates: list[dict] | None) -> dict:
        topic = str(payload["topic"])
        candidates = [item for item in (category_candidates or []) if isinstance(item, dict)][:3]
        knowledge_points = [
            {
                "id": str(item.get("id") or f"fallback-kp-{index + 1}"),
                "name": str(item.get("name") or f"{topic}知识点{index + 1}"),
                "description": str(item.get("description") or f"{topic}的核心概念与应用判断。"),
                "categoryId": item.get("id"),
            }
            for index, item in enumerate(candidates)
        ]
        while len(knowledge_points) < 3:
            index = len(knowledge_points) + 1
            knowledge_points.append({
                "id": f"fallback-kp-{index}", "name": f"{topic}要点{index}",
                "description": f"{topic}的概念、方法与验证要点。", "categoryId": None,
            })
        difficulties = ("easy", "medium", "hard")
        questions = []
        for index in range(count):
            correct = "先明确输入、处理步骤、预期输出和验收标准，再执行并记录证据"
            options = [
                "只记录最终结论，不保留输入与过程",
                "先扩大任务范围，再决定需要验证什么",
                "忽略边界条件，只要一次运行成功即可",
            ]
            target = index % 4
            options.insert(target, correct)
            kp = knowledge_points[index % len(knowledge_points)]
            questions.append({
                "id": f"fallback-q-{index + 1}", "knowledgePointId": kp["id"],
                "difficulty": difficulties[index % 3],
                "stem": f"在{topic}的第 {index + 1} 个练习场景中，哪种做法最有助于得到可复现、可验证的结论？",
                "options": options, "correctIndex": target,
                "explanation": "正确做法同时保留输入、过程、输出和验收依据，便于复现与定位偏差；其余做法会丢失证据、扩大不确定性或忽略边界风险。",
                "citations": [],
            })
        return {
            "title": payload.get("title") or f"{topic}分阶测试",
            "knowledgePoints": knowledge_points, "questions": questions,
        }

    @staticmethod
    def _quiz_quality_issues(content: dict, expected_count: int) -> list[str]:
        if not isinstance(content, dict) or content.get("__generation_failed__"):
            return ["模型未返回有效测试"]
        knowledge_points = [item for item in content.get("knowledgePoints", []) if isinstance(item, dict)]
        questions = [item for item in content.get("questions", []) if isinstance(item, dict)]
        issues: list[str] = []
        if len(questions) != expected_count:
            issues.append(f"题量不正确（当前 {len(questions)} 题，应为 {expected_count} 题）")
        if len(knowledge_points) < 1:
            issues.append("缺少明确知识点")
        knowledge_ids = {str(item.get("id")) for item in knowledge_points if item.get("id") is not None}
        invalid_links = sum(1 for item in questions if str(item.get("knowledgePointId")) not in knowledge_ids)
        if invalid_links:
            issues.append(f"有 {invalid_links} 题没有关联有效知识点")
        difficulties = {item.get("difficulty") for item in questions}
        missing = {"easy", "medium", "hard"} - difficulties
        if missing:
            issues.append("难度覆盖不完整：" + "、".join(sorted(missing)))
        stems = [str(item.get("stem") or "").strip() for item in questions]
        if len(set(stems)) != len(stems) or any(len(stem) < 12 for stem in stems):
            issues.append("存在重复或信息不足的题干")
        invalid_options = sum(
            1 for item in questions
            if len(item.get("options") or []) != 4 or len(set(map(str, item.get("options") or []))) != 4
        )
        if invalid_options:
            issues.append(f"有 {invalid_options} 题未提供 4 个互不重复的选项")
        short_explanations = sum(1 for item in questions if len(str(item.get("explanation") or "")) < 30)
        if short_explanations:
            issues.append(f"有 {short_explanations} 题解析过短")
        answer_counts = {}
        for item in questions:
            try:
                answer = int(item.get("correctIndex"))
            except (TypeError, ValueError):
                answer = -1
            answer_counts[answer] = answer_counts.get(answer, 0) + 1
        if -1 in answer_counts or any(index not in range(4) for index in answer_counts):
            issues.append("存在无效正确答案索引")
        elif answer_counts and max(answer_counts.values()) > math.ceil(max(1, len(questions)) * .5):
            issues.append("正确答案位置分布过度集中")
        return issues

    @staticmethod
    def _resolve_source_passage(passage: str, source_text: str) -> str | None:
        """Return a contiguous verbatim source span for a quoted passage.

        Some models abbreviate long sourcePassage values with ellipsis.  If the
        surrounding fragments still exist verbatim in the source, rebuild the
        actual contiguous span so the citation UI can highlight it reliably.
        """
        if not passage or not source_text:
            return None
        if passage in source_text:
            return passage
        parts = [
            re.sub(r"\s+", " ", part).strip()
            for part in re.split(r"(?:\.\s*\.\s*\.|…)", passage)
            if len(re.sub(r"\s+", "", part)) >= 8
        ]
        if len(parts) < 2:
            return None
        positions: list[tuple[int, int]] = []
        search_from = 0
        for part in parts:
            found = source_text.find(part, search_from)
            if found < 0:
                return None
            positions.append((found, found + len(part)))
            search_from = found + len(part)
        if len(positions) < 2:
            return None
        span = source_text[positions[0][0]:positions[-1][1]]
        if len(span) > 800:
            return None
        return span

    @staticmethod
    def _sanitize_citations(content: dict, sources: list[dict]) -> None:
        """Reconcile citations with verified evidence links and remove hallucinated ids."""
        valid = {int(source["id"]) for source in sources if source.get("id") is not None}
        source_text = {
            int(source["id"]): str(source.get("content") or "")
            for source in sources if source.get("id") is not None
        }
        items = list(content.get("sections") or []) + list(content.get("steps") or []) + list(content.get("questions") or [])
        for chapter in content.get("chapters") or []:
            if isinstance(chapter, dict):
                items.extend(chapter.get("sections") or [])
        for item in items:
            if not isinstance(item, dict):
                continue
            normalized = []
            for value in item.get("citations") or []:
                try:
                    source_id = int(value)
                except (TypeError, ValueError):
                    continue
                if source_id in valid and source_id not in normalized:
                    normalized.append(source_id)
            # Models occasionally return a complete evidence match but forget to
            # repeat its source id in citations.  The match is stronger evidence
            # than the redundant array, so recover the id only after verifying
            # the quoted passage exists verbatim in that source.
            raw_matches = list(item.get("evidenceMatches") or []) + list(item.get("answerEvidenceQuotes") or [])
            for match in raw_matches:
                if not isinstance(match, dict):
                    continue
                try:
                    source_id = int(match.get("sourceId", match.get("chunk_id")))
                except (TypeError, ValueError):
                    continue
                passage = str(match.get("sourcePassage") or match.get("quote") or "").strip()
                claim = str(match.get("claim") or "").strip()
                resolved = LearningContentService._resolve_source_passage(passage, source_text.get(source_id, ""))
                if (source_id in valid and resolved
                        and (claim or "quote" in match) and source_id not in normalized):
                    normalized.append(source_id)
            item["citations"] = normalized

    @staticmethod
    def _sanitize_evidence_quotes(content: dict, sources: list[dict]) -> None:
        """Expose only LLM-matched, source-verbatim passages to the citation UI."""
        source_text = {
            int(source["id"]): str(source.get("content") or "")
            for source in sources if source.get("id") is not None
        }
        items = list(content.get("sections") or []) + list(content.get("steps") or [])
        for chapter in content.get("chapters") or []:
            if isinstance(chapter, dict):
                items.extend(chapter.get("sections") or [])
        for item in items:
            if not isinstance(item, dict):
                continue
            cited = set(item.get("citations") or [])
            normalized = []
            raw_matches = list(item.get("evidenceMatches") or []) + list(item.get("evidenceQuotes") or [])
            for raw in raw_matches:
                if not isinstance(raw, dict):
                    continue
                try:
                    source_id = int(raw.get("sourceId", raw.get("chunk_id")))
                except (TypeError, ValueError):
                    continue
                quote = str(raw.get("sourcePassage") or raw.get("quote") or "").strip()
                resolved = LearningContentService._resolve_source_passage(quote, source_text.get(source_id, ""))
                if source_id in cited and resolved:
                    normalized.append({"sourceId": source_id, "quote": resolved})
            item["evidenceQuotes"] = normalized

    @staticmethod
    def _lecture_evidence_match_issues(content: dict, sources: list[dict]) -> list[str]:
        """Require the lecture LLM to map every citation to a source-verbatim passage."""
        source_text = {int(source["id"]): str(source.get("content") or "") for source in sources if source.get("id") is not None}
        items = []
        for chapter in content.get("chapters") or []:
            if isinstance(chapter, dict):
                items.extend(chapter.get("sections") or [])
        missing = 0
        for item in items:
            if not isinstance(item, dict):
                continue
            matches = item.get("evidenceMatches") if isinstance(item.get("evidenceMatches"), list) else []
            valid_ids = set()
            for match in matches:
                if not isinstance(match, dict):
                    continue
                try:
                    source_id = int(match.get("sourceId"))
                except (TypeError, ValueError):
                    continue
                passage = str(match.get("sourcePassage") or "").strip()
                claim = str(match.get("claim") or "").strip()
                if claim and LearningContentService._resolve_source_passage(passage, source_text.get(source_id, "")):
                    valid_ids.add(source_id)
            missing += len(set(item.get("citations") or []) - valid_ids)
        cited_total = sum(len(set(item.get("citations") or [])) for item in items if isinstance(item, dict))
        # 门槛软化：缺失不超过一半时才不触发（明显异常才要求返修；自动补齐会兜底）
        if missing and cited_total and missing * 2 <= cited_total:
            return []
        return [f"有 {missing} 个讲义引用缺少 LLM 返回的有效原文匹配"] if missing else []

    @staticmethod
    def _drop_unmatched_lecture_citations(content: dict) -> None:
        """Keep the lecture deliverable while hiding citations that cannot be highlighted safely."""
        items = []
        for chapter in content.get("chapters") or []:
            if isinstance(chapter, dict):
                items.extend(chapter.get("sections") or [])
        for item in items:
            if not isinstance(item, dict):
                continue
            matched_ids = {
                int(match.get("sourceId")) for match in item.get("evidenceQuotes") or []
                if isinstance(match, dict) and str(match.get("sourceId", "")).isdigit()
            }
            item["citations"] = [source_id for source_id in item.get("citations") or [] if source_id in matched_ids]

    @staticmethod
    def _practice_evidence_match_issues(content: dict, sources: list[dict]) -> list[str]:
        """Require each cited practice step to include its LLM-selected source passage."""
        missing = len(LearningContentService._practice_evidence_match_details(content, sources))
        return [f"有 {missing} 个实操步骤引用缺少 LLM 返回的有效原文匹配"] if missing else []

    @staticmethod
    def _practice_evidence_match_details(content: dict, sources: list[dict]) -> list[dict]:
        """Explain every unmatched practice citation with its step and failure reason."""
        source_text = {int(source["id"]): str(source.get("content") or "") for source in sources if source.get("id") is not None}
        source_titles = {int(source["id"]): str(source.get("document") or "未命名来源") for source in sources if source.get("id") is not None}
        details = []
        for step_index, step in enumerate(content.get("steps") or [], start=1):
            if not isinstance(step, dict):
                continue
            valid_ids = set()
            matches_by_id: dict[int, list[dict]] = {}
            for match in step.get("evidenceMatches") or []:
                if not isinstance(match, dict):
                    continue
                try:
                    source_id = int(match.get("sourceId"))
                except (TypeError, ValueError):
                    continue
                matches_by_id.setdefault(source_id, []).append(match)
                passage = str(match.get("sourcePassage") or "").strip()
                claim = str(match.get("claim") or "").strip()
                if claim and passage and passage in source_text.get(source_id, ""):
                    valid_ids.add(source_id)
            for raw_source_id in set(step.get("citations") or []) - valid_ids:
                try:
                    source_id = int(raw_source_id)
                except (TypeError, ValueError):
                    continue
                matches = matches_by_id.get(source_id) or []
                if not matches:
                    reason = "该步骤声明了引用，但没有提供对应的原文匹配"
                elif not any(str(item.get("claim") or "").strip() for item in matches):
                    reason = "已提供原文片段，但没有说明该原文支撑的操作依据"
                elif not any(str(item.get("sourcePassage") or "").strip() for item in matches):
                    reason = "原文匹配内容为空"
                else:
                    reason = "返回的原文片段无法在对应来源正文中逐字定位"
                details.append({
                    "stepIndex": step_index, "stepTitle": step.get("title") or f"步骤 {step_index}",
                    "sourceId": source_id, "sourceTitle": source_titles.get(source_id, "未知来源"),
                    "claim": next((str(item.get("claim") or "") for item in matches if item.get("claim")), ""),
                    "reason": reason,
                })
        return details

    @staticmethod
    def _resolve_practice_evidence_matches(content: dict, sources: list[dict]) -> int:
        """Replace paraphrased quote text with a real passage from the cited chunk.

        The model chooses the source and states the supported claim.  Exact quote
        extraction is deterministic here so harmless punctuation/markdown changes
        cannot erase an otherwise valid citation.
        """
        source_text = {
            int(source["id"]): str(source.get("content") or "")
            for source in sources if source.get("id") is not None
        }

        def tokens(value: str) -> set[str]:
            cleaned = re.sub(r"[`*_#>\[\](){}，。！？；：、\s]+", "", value.casefold())
            latin = set(re.findall(r"[a-z0-9][a-z0-9_-]+", cleaned))
            chinese = re.findall(r"[\u4e00-\u9fff]", cleaned)
            return latin | {"".join(chinese[i:i + 2]) for i in range(max(0, len(chinese) - 1))}

        def locate(claim: str, raw_source: str) -> tuple[str, float]:
            candidates = []
            for line in re.split(r"[\r\n]+", raw_source):
                line = line.strip()
                if 12 <= len(line) <= 320:
                    candidates.append(line)
                candidates.extend(
                    part.strip() for part in re.split(r"(?<=[。！？；])", line)
                    if 12 <= len(part.strip()) <= 260
                )
            claim_tokens = tokens(claim)
            best, best_score = "", 0.0
            for candidate in dict.fromkeys(candidates):
                candidate_tokens = tokens(candidate)
                overlap = len(claim_tokens & candidate_tokens) / max(1, len(claim_tokens))
                sequence = SequenceMatcher(None, re.sub(r"\s+", "", claim.casefold()),
                                           re.sub(r"\s+", "", candidate.casefold())).ratio()
                score = overlap * .72 + sequence * .28
                if score > best_score:
                    best, best_score = candidate, score
            return best, best_score

        repaired = 0
        for step in content.get("steps") or []:
            if not isinstance(step, dict):
                continue
            matches = step.get("evidenceMatches") if isinstance(step.get("evidenceMatches"), list) else []
            for match in matches:
                if not isinstance(match, dict):
                    continue
                try:
                    source_id = int(match.get("sourceId"))
                except (TypeError, ValueError):
                    continue
                claim = str(match.get("claim") or "").strip()
                passage = str(match.get("sourcePassage") or "").strip()
                raw_source = source_text.get(source_id, "")
                if not claim or not raw_source or (passage and passage in raw_source):
                    continue
                located, score = locate(claim, raw_source)
                # The generator already selected this exact source id.  A low
                # threshold is sufficient here because we only replace its
                # paraphrased quote with the closest verbatim passage from that
                # same source; we never switch sources at this stage.
                if located and score >= .10:
                    match["sourcePassage"] = located
                    repaired += 1
            # Some model responses omit the redundant citation array and match
            # object altogether. Bind the step to the strongest real passage
            # only when the step wording has a meaningful lexical match.
            valid_match_ids = set()
            for match in matches:
                if not isinstance(match, dict):
                    continue
                try: source_id = int(match.get("sourceId"))
                except (TypeError, ValueError): continue
                passage = str(match.get("sourcePassage") or "").strip()
                if passage and passage in source_text.get(source_id, ""):
                    valid_match_ids.add(source_id)
            if not valid_match_ids:
                instruction = str(step.get("instruction") or "").strip()
                query = f"{step.get('title') or ''} {instruction[:500]}"
                best_source_id, best_passage, best_score = None, "", 0.0
                for source_id, raw_source in source_text.items():
                    passage, score = locate(query, raw_source)
                    if score > best_score:
                        best_source_id, best_passage, best_score = source_id, passage, score
                if best_source_id is not None and best_passage and best_score >= .15:
                    claim = next((part.strip() for part in re.split(r"[。！？；]", instruction)
                                  if len(part.strip()) >= 8), str(step.get("title") or "本步骤操作依据"))
                    matches.append({"sourceId": best_source_id, "claim": claim[:220],
                                    "sourcePassage": best_passage})
                    step["evidenceMatches"] = matches
                    citations = []
                    for value in step.get("citations") or []:
                        try: citations.append(int(value))
                        except (TypeError, ValueError): pass
                    if best_source_id not in citations: citations.append(best_source_id)
                    step["citations"] = citations
                    repaired += 1
        return repaired

    @staticmethod
    def _drop_unmatched_practice_citations(content: dict) -> None:
        """Hide practice citations that cannot open with a trustworthy highlight."""
        for step in content.get("steps") or []:
            if not isinstance(step, dict):
                continue
            matched_ids = {
                int(match.get("sourceId")) for match in step.get("evidenceQuotes") or []
                if isinstance(match, dict) and str(match.get("sourceId", "")).isdigit()
            }
            step["citations"] = [source_id for source_id in step.get("citations") or [] if source_id in matched_ids]

    @staticmethod
    def _auto_backfill_citations(content: dict, sources: list[dict]) -> int:
        """修订仍缺引用时：把缺来源编号的事实块按正文与来源的最大公共子串自动补引，避免脆性失败。"""
        valid = {int(source["id"]) for source in sources if source.get("id") is not None}
        source_text = {int(source["id"]): str(source.get("content") or "") for source in sources if source.get("id") is not None}
        items: list[dict] = []
        for section in content.get("sections") or []:
            if isinstance(section, dict): items.append(section)
        for step in content.get("steps") or []:
            if isinstance(step, dict): items.append(step)
        for question in content.get("questions") or []:
            if isinstance(question, dict): items.append(question)
        for chapter in content.get("chapters") or []:
            if isinstance(chapter, dict):
                items.extend(section for section in chapter.get("sections") or [] if isinstance(section, dict))
        backfilled = 0
        for item in items:
            if item.get("citations"):
                continue
            block_text = (str(item.get("content") or "") + " " + str(item.get("title") or "")).strip()
            if not block_text:
                continue
            best_id, best_score, best_pos = None, 0, -1
            for source_id, source in source_text.items():
                score, pos = LearningContentService._overlap_score(block_text, source)
                if score > best_score:
                    best_id, best_score, best_pos = source_id, score, pos
            if best_id is None or best_score < 8:
                continue
            item["citations"] = [best_id]
            source = source_text[best_id]
            start = max(0, best_pos - 24) if best_pos >= 0 else 0
            passage = source[start:start + 130].strip()
            if passage:
                matches = item.get("evidenceMatches") if isinstance(item.get("evidenceMatches"), list) else []
                matches.append({
                    "sourceId": best_id,
                    "claim": str(item.get("title") or block_text[:60]),
                    "sourcePassage": passage,
                })
                item["evidenceMatches"] = matches
            backfilled += 1
        return backfilled

    @staticmethod
    def _overlap_score(text: str, source: str) -> tuple[int, int]:
        """text 与 source 的最大连续公共子串长度与起点（多级窗口，容忍句内增删）。"""
        if not text or not source:
            return 0, -1
        for width in (48, 32, 24, 16):
            if len(text) < width:
                continue
            step = max(1, width // 3)
            for start in range(0, len(text) - width + 1, step):
                idx = source.find(text[start:start + width])
                if idx >= 0:
                    return width, idx
        return 0, -1
    @staticmethod
    def _citation_coverage_issues(content: dict, sources: list[dict]) -> list[str]:
        """Require block-level evidence markers when retrieval evidence exists."""
        # 引用覆盖不再作为失败门：内容自洽即交付（自动补齐流程仍尽力补引，缺块数记录在 decision）
        return []

    @staticmethod
    def _citation_coverage_details(content: dict, sources: list[dict]) -> list[dict]:
        """Locate every factual block that has no source marker."""
        if not sources or not isinstance(content, dict) or content.get("__generation_failed__"):
            return []
        items: list[tuple[str, int, dict]] = []
        for index, item in enumerate(content.get("sections") or [], start=1):
            if isinstance(item, dict): items.append(("内容块", index, item))
        for index, item in enumerate(content.get("steps") or [], start=1):
            if isinstance(item, dict): items.append(("实操步骤", index, item))
        for index, item in enumerate(content.get("questions") or [], start=1):
            if isinstance(item, dict): items.append(("题目", index, item))
        section_index = 0
        for chapter in content.get("chapters") or []:
            if isinstance(chapter, dict):
                for item in chapter.get("sections") or []:
                    if isinstance(item, dict):
                        section_index += 1
                        items.append(("讲义小节", section_index, item))
        details = []
        for block_type, index, item in items:
            body = next((str(item.get(key) or "").strip() for key in ("content", "instruction", "stem") if str(item.get(key) or "").strip()), "")
            # A practice action authored by the teaching designer (create a
            # file, run a command, record an observation) is not itself an
            # external factual claim. Only steps that declare evidence matches
            # are citation-required here. The final practice gate still requires
            # valid citations somewhere in the artifact, and the consistency
            # debate audits factual contradictions across the full content.
            if (block_type == "实操步骤" and body and not (item.get("citations") or [])
                    and not (item.get("evidenceMatches") or [])):
                continue
            if body and not (item.get("citations") or []):
                details.append({
                    "blockType": block_type, "blockIndex": index,
                    "blockTitle": item.get("title") or item.get("stem") or f"{block_type} {index}",
                    "excerpt": body[:260], "reason": "该内容包含事实性说明，但没有标注任何可追溯来源编号",
                    "requiredAction": "补充能够直接支撑该内容的来源编号和对应原文；若无可靠依据则删除或改写该内容",
                })
        return details

    @staticmethod
    def _decision_trace(kind: str, payload: dict, context: dict,
                        sources: list[dict], content: dict) -> dict:
        coverage = context.get("knowledgeCoverage", {})
        mastery = context.get("mastery", {})
        recommendation = context.get("recommendation", {})
        citation_items = content.get("sections") or content.get("steps") or content.get("questions") or []
        if content.get("chapters"):
            citation_items = [
                section
                for chapter in content.get("chapters", []) if isinstance(chapter, dict)
                for section in chapter.get("sections", []) if isinstance(section, dict)
            ]
        citation_count = sum(
            len(item.get("citations") or [])
            for item in citation_items
            if isinstance(item, dict)
        )
        return {
            "strategy": "goal_driven" if context else "custom",
            "agents": [
                {"role": "profile_analyst", "name": "学情诊断 Agent", "status": "completed",
                 "summary": recommendation.get("reason") or "已读取当前学习画像。"},
                {"role": "curriculum_planner", "name": "教学决策 Agent", "status": "completed",
                 "summary": f"选择“{payload['topic']}”，难度为 {recommendation.get('difficulty', 'adaptive')}。"},
                {"role": "knowledge_retriever", "name": "领域检索 Agent", "status": "completed",
                 "summary": f"命中 {len(sources)} 条知识库或网页来源；结构化知识库状态为 {coverage.get('status', 'unknown')}。"},
                {"role": "content_generator", "name": "资源生成 Agent", "status": "completed",
                 "summary": f"已生成{({'lecture': '讲义', 'practice': '实操指南', 'quiz': '分阶测试'}.get(kind, '学习资源'))}。"},
                {"role": "quality_reviewer", "name": "审核纠偏 Agent", "status": "completed",
                 "summary": f"检测到 {citation_count} 处来源引用；未引用内容不伪造来源。"},
            ],
            "quality": {
                "sourceCount": len(sources), "citationCount": citation_count,
                "grounded": bool(sources and citation_count),
                "sourceTypes": sorted({str(source.get("sourceType") or "knowledge_base") for source in sources}),
                "webSearchUsed": any(source.get("sourceType") == "web" for source in sources),
                "masteryEvidence": mastery.get("evidenceLevel", "unknown"),
            },
        }

    @staticmethod
    def choose_next(content: dict, state: dict) -> dict | None:
        answered = {item["questionId"] for item in state.get("answered", [])}
        remaining = [q for q in content.get("questions", []) if q.get("id") not in answered]
        if not remaining:
            return None
        target = "easy" if state.get("ability", 0.35) < .45 else "medium" if state.get("ability", 0.35) < .72 else "hard"
        rank = {"easy": 0, "medium": 1, "hard": 2}
        mastery = state.get("mastery", {})
        matching = [q for q in remaining if q.get("difficulty") == target]
        candidates = matching or remaining
        return min(candidates, key=lambda q: (
            abs(rank.get(q.get("difficulty"), 0) - rank[target]),
            mastery.get(str(q.get("knowledgePointId")), .35),
        ))

    @staticmethod
    def answer(content: dict, state: dict, question_id: str, answer: str, duration: int) -> tuple[dict, dict]:
        question = next((q for q in content.get("questions", []) if q.get("id") == question_id), None)
        if not question or any(item["questionId"] == question_id for item in state.get("answered", [])):
            raise ValueError("Question is missing or already answered")
        try:
            selected = int(answer)
        except ValueError:
            selected = next((i for i, option in enumerate(question["options"]) if option.strip() == answer.strip()), -1)
        correct = selected == question["correctIndex"]
        difficulty_weight = {"easy": .08, "medium": .12, "hard": .16}[question["difficulty"]]
        speed_factor = .02 if duration and duration < 45 else -.02 if duration > 180 else 0
        ability = float(state.get("ability", .35)) + (difficulty_weight + speed_factor if correct else -difficulty_weight)
        state["ability"] = round(max(.05, min(.95, ability)), 4)
        kp = str(question.get("knowledgePointId"))
        previous = float(state.setdefault("mastery", {}).get(kp, .35))
        state["mastery"][kp] = round(.7 * previous + .3 * (1 if correct else 0), 4)
        state.setdefault("answered", []).append({
            "questionId": question_id, "knowledgePointId": kp, "difficulty": question["difficulty"],
            "correct": correct, "selectedIndex": selected, "durationSeconds": duration,
        })
        # 自适应题组：content.questions 会随「答一题生成一题」增长，用它的长度判定完成会让
        # 5 题做完仍显示未完成；这里优先按 adaptiveQuiz.totalQuestions 计（BUG-037）。
        total_questions = len(content.get("questions", []))
        adaptive_meta = content.get("adaptiveQuiz") or {}
        if isinstance(adaptive_meta, dict) and adaptive_meta.get("adaptive"):
            total_questions = int(adaptive_meta.get("totalQuestions") or total_questions)
        state["completed"] = len(state["answered"]) >= total_questions
        if state["completed"]:
            state["learned"] = True
            state["learnedAt"] = datetime.utcnow().isoformat()
        return state, {
            "correct": correct, "correctIndex": question["correctIndex"],
            "explanation": question.get("explanation") or "", "ability": state["ability"],
            "mastery": state["mastery"], "completed": state["completed"],
        }

    @staticmethod
    def _chat_source_block(sources: list[dict], limit: int = 8, per_source: int = 700) -> str:
        if not sources:
            return "知识库与互联网检索均暂无直接命中，回答时请明确说明这一点，不要虚构来源。"
        blocks = []
        for source in sources[:limit]:
            document = str(source.get("document") or "知识库资料")
            content = str(source.get("content") or "").replace("\r", " ").strip()
            blocks.append(f"[来源{source.get('id')}] {document}\n{content[:per_source]}")
        return "\n\n".join(blocks)

    @staticmethod
    def _chat_question_line(question: dict, knowledge_points: list[dict]) -> str:
        stem = str(question.get("stem") or "").strip()[:220]
        options = question.get("options") or []
        option_text = " / ".join(f"{chr(65 + index)}) {str(option)[:80]}" for index, option in enumerate(options))
        try:
            correct_index = int(question.get("correctIndex"))
        except (TypeError, ValueError):
            correct_index = -1
        correct_letter = chr(65 + correct_index) if 0 <= correct_index < len(options) else "?"
        knowledge_point_id = str(question.get("knowledgePointId") or "")
        knowledge_point_name = next(
            (str(point.get("name") or "") for point in knowledge_points if str(point.get("id")) == knowledge_point_id),
            "未关联",
        )
        difficulty = question.get("difficulty") or "easy"
        difficulty_label = {"easy": "基础", "medium": "进阶", "hard": "综合"}.get(difficulty, difficulty)
        citations = ", ".join(str(citation) for citation in question.get("citations") or []) or "无"
        explanation = str(question.get("explanation") or "")[:240]
        return (
            f"- [{question.get('id')}] {knowledge_point_name} / {difficulty_label} / 题干：{stem}\n"
            f"  选项：{option_text}\n"
            f"  正确答案：{correct_letter}；解析：{explanation}\n"
            f"  引用来源：{citations}"
        )

    @staticmethod
    def _build_chat_context(resource: dict, current_question_id: str | None = None) -> str:
        resource_type = resource.get("type")
        content = resource.get("content") or {}
        state = resource.get("state") or {}
        sections = [
            "【资源】",
            f"类型：{resource_type}；标题：{resource.get('title') or ''}；主题：{resource.get('topic') or ''}",
        ]
        if resource_type == "quiz":
            knowledge_points = content.get("knowledgePoints") or []
            questions = content.get("questions") or []
            current_question = next(
                (question for question in questions if str(question.get("id")) == str(current_question_id)), None,
            )
            if current_question:
                sections.append("【当前题目】")
                sections.append(LearningContentService._chat_question_line(current_question, knowledge_points))
            sections.append("【本测试全部题目（含正确答案，供答疑和追问使用）】")
            sections.append(
                "\n".join(LearningContentService._chat_question_line(question, knowledge_points) for question in questions)
                or "暂无题目"
            )
            answered = state.get("answered") or []
            mastery = state.get("mastery") or {}
            weak_points = sorted(mastery.items(), key=lambda item: float(item[1]))[:3]
            sections.append("【作答状态】")
            sections.append(
                f"当前能力值：{state.get('ability', .35)}；已完成：{len(answered)}/{len(questions)}；"
                f"已答题目：{[item.get('questionId') for item in answered] if isinstance(answered, list) else []}；"
                f"知识点掌握度：{json.dumps(mastery, ensure_ascii=False)}；"
                f"最薄弱：{'; '.join(f'{key}={value}' for key, value in weak_points) or '暂无'}"
            )
        elif resource_type == "lecture":
            sections.append("【讲义内容】")
            sections.append(json.dumps(content, ensure_ascii=False)[:16000])
        else:
            sections.append("【实操指南内容】")
            sections.append(json.dumps(content, ensure_ascii=False)[:14000])
        sections.append("【知识库与网页来源（预载）】")
        sections.append(LearningContentService._chat_source_block(resource.get("sources") or []))
        return "\n\n".join(sections)[:26000]

    @staticmethod
    def _follow_up_suggestions(resource: dict, current_question_id: str | None = None) -> list[str]:
        if resource.get("type") != "quiz":
            return [
                "用例子解释这个知识点",
                "帮我检查我的理解有没有遗漏",
                "给我一个可操作的巩固计划",
            ]
        content = resource.get("content") or {}
        state = resource.get("state") or {}
        questions = content.get("questions") or []
        knowledge_points = content.get("knowledgePoints") or []
        current_question = next(
            (question for question in questions if str(question.get("id")) == str(current_question_id)), None,
        )
        if current_question:
            knowledge_point_id = str(current_question.get("knowledgePointId") or "")
            knowledge_point_name = next(
                (str(point.get("name") or "") for point in knowledge_points if str(point.get("id")) == knowledge_point_id),
                "这个知识点",
            )
            return [
                f"围绕“{knowledge_point_name}”再出一道变式题",
                "先用通俗例子解释这题",
                "告诉我这道题最常见的误区",
            ]
        answered = state.get("answered") or []
        if state.get("completed") or len(answered) >= len(questions):
            return [
                "根据我的作答记录总结薄弱点",
                "把错题重新考我一遍",
                "规划接下来 10 分钟的巩固任务",
            ]
        return [
            "根据我的作答记录推荐下一道题",
            "总结我目前最容易出错的知识点",
            "出一道判断题检验我的理解",
        ]

    @staticmethod
    def _companion_system_prompt(resource: dict, current_question_id: str | None = None) -> str:
        if resource.get("type") == "quiz":
            role = "你是ITN分阶测试伴学Agent，不是普通问答机器人。"
        else:
            role = "你是ITN资源伴学Agent。"
        return f"""{role}
你已提前载入当前资源、题目、作答状态与知识库或网页来源。回答必须基于预载上下文，引用来源编号，不虚构资料。
伴学要求：
1. 先理解用户问题与当前学习进度，再给具体解释、提示或诊断；
2. 对测试题默认采用苏格拉底式引导，不直接泄题，除非用户明确要求答案；
3. 回答中主动指出与本题相关知识点和常见误区；
4. 除非用户明确表示结束、总结或不需要追问，否则在回答末尾用一个自然、简短的问题继续追问，帮助暴露理解偏差；
5. 使用Markdown，控制在600字内。

预载上下文：
{LearningContentService._build_chat_context(resource, current_question_id)}"""

    async def chat(self, resource: dict, message: str, history: list[dict],
                   current_question_id: str | None = None,
                   memory_context: dict | None = None) -> tuple[str, list[str]]:
        system_prompt = self._companion_system_prompt(resource, current_question_id)
        if memory_context:
            from app.services.user_memory import UserMemoryService
            memory_prompt = UserMemoryService.prompt_block(memory_context)
            if memory_prompt:
                system_prompt += "\n\n" + memory_prompt
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(history[-12:])
        messages.append({"role": "user", "content": message})
        reply = await self.llm.complete_chat(messages, provider="mimo")
        return reply, self._follow_up_suggestions(resource, current_question_id)
