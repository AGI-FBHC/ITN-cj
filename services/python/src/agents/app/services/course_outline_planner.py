from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone

import app.tools  # noqa: F401 - register planning tools
from app.tools.base import tool_registry


_NUMBERING_PREFIX = re.compile(
    r"^\s*(第\s*[0-9零一二三四五六七八九十百]+\s*[章讲节课部篇]|chapter\s*\d+|part\s*\d+)\s*[:：、.\-—)]*\s*",
    re.IGNORECASE,
)


def clean_title(value: str) -> str:
    # Strip duplicated chapter-numbering prefixes from a title.
    title = str(value or "").strip()
    previous = None
    while previous != title:
        previous = title
        title = _NUMBERING_PREFIX.sub("", title).strip()
    return title


class CourseOutlinePlanner:
    """Evidence-grounded course outline planning using the tutor tool stack."""

    RETRIEVAL_TIMEOUT_SECONDS = 15
    PLANNING_TIMEOUT_SECONDS = 40

    def __init__(self, llm):
        self.llm = llm

    async def _retrieve(self, query: str) -> tuple[list[dict], list[str]]:
        calls, names = [], []
        rag, web = tool_registry.get("rag_search"), tool_registry.get("web_search")
        if rag and rag.available:
            calls.append(asyncio.wait_for(rag.execute({"query": query, "top_k": 8}), self.RETRIEVAL_TIMEOUT_SECONDS)); names.append("rag_search")
        if web and web.available:
            year = datetime.now(timezone.utc).year
            calls.append(asyncio.wait_for(web.execute({"query": f"{query} {year} 权威 教程 课程体系", "limit": 8}), self.RETRIEVAL_TIMEOUT_SECONDS)); names.append("web_search")
        results = await asyncio.gather(*calls, return_exceptions=True)
        evidence, used = [], []
        for name, result in zip(names, results):
            if isinstance(result, Exception) or not isinstance(result, dict) or not result.get("success"):
                continue
            used.append(name)
            if name == "rag_search":
                evidence.extend({"sourceType": "knowledge_base", "title": item.get("document") or "知识库资料", "content": item.get("content") or "", "similarity": item.get("similarity")} for item in (result.get("chunks") or [])[:8])
            else:
                evidence.extend({"sourceType": "web", "title": item.get("title") or "网页资料", "url": item.get("url") or "", "content": item.get("content") or ""} for item in (result.get("results") or [])[:8])
        return evidence, used

    @staticmethod
    def _fallback(context: dict, chapter_count: int) -> dict:
        goal = context.get("goal") or {}
        topic = str(goal.get("title") or goal.get("knowledgeDomainName") or "当前学习领域")
        short_topic = (re.split(r"[：:：]", topic, maxsplit=1)[0] or topic).strip()
        course_title = short_topic if any(word in short_topic for word in ("课程", "教程", "工程", "实战", "训练营", "入门", "软考", "考研")) else f"{short_topic}课程"
        text = f"{topic} {goal.get('description') or ''}"
        points = context.get("knowledgePoints") or []
        phases = []
        if "软考-软件设计师" in text or "软件设计师" in text:
            phases = [
                ("软件设计师考试认知与备考地图", "明确考试范围、题型、分值分布和备考节奏。"),
                ("计算机组成与体系结构", "掌握计算机硬件组成、指令系统与存储层次。"),
                ("操作系统与进程管理", "掌握进程、线程、内存、文件与设备管理。"),
                ("数据结构与算法", "掌握线性表、树、图、排序、查找与复杂度分析。"),
                ("计算机网络基础", "掌握网络分层、TCP/IP、HTTP 与网络安全。"),
                ("数据库系统与应用", "掌握关系模型、SQL、索引、事务与并发控制。"),
                ("软件工程与系统设计", "掌握需求、设计、测试、维护与项目管理。"),
                ("综合模拟与查漏补缺", "通过真题模拟定位薄弱章节并完成补强。"),
            ]
        elif "考研" in text or "408" in text:
            phases = [
                ("数据结构与算法", "掌握线性结构、树、图、排序、查找和算法分析。"),
                ("计算机组成原理", "掌握冯诺依曼、CPU、存储、指令与 I/O。"),
                ("操作系统", "掌握进程、内存、文件、设备和并发。"),
                ("计算机网络", "掌握分层模型、TCP/IP、HTTP 和安全。"),
                ("408 真题拆解", "按科目拆解历年真题并建立解题模板。"),
                ("综合模拟与薄弱点复盘", "模拟考试并针对错题完成知识补强。"),
            ]
        elif any(token in text for token in ("智能体", "Agent", "大模型", "AI")):
            phases = [
                ("智能体与大模型基础", "理解大模型能力边界、智能体范式与运行原理。"),
                ("提示词与上下文工程", "掌握提示设计、上下文管理与模型约束。"),
                ("RAG 与记忆机制", "掌握检索增强、向量库、记忆与知识注入。"),
                ("工具调用与 Function Calling", "掌握工具定义、调用循环与错误恢复。"),
                ("多智能体协作", "理解多智能体编排、通信、分工与仲裁。"),
                ("评测与工程落地", "掌握效果评测、可观测性与生产部署。"),
            ]
        elif points:
            phases = [
                (str(point.get("name") or f"专题 {index + 1}"), f"掌握{point.get('name')}的核心概念、方法与应用。")
                for index, point in enumerate(points[:chapter_count])
            ]
        if not phases:
            phases = [
                ("领域认知与目标拆解", f"理解{short_topic}的整体目标和关键能力。"),
                ("核心概念与关键机制", f"掌握{short_topic}的核心概念和运行机制。"),
                ("典型方法与工具", f"掌握{short_topic}的常用方法和工具链。"),
                ("实践案例与操作流程", f"完成{short_topic}的典型实践案例。"),
                ("问题诊断与优化", f"解决{short_topic}应用中的常见问题并优化结果。"),
                ("综合应用与复盘", f"综合运用{short_topic}知识并完成复盘。"),
            ]
        chapters = []
        for index in range(chapter_count):
            if index < len(phases):
                title, summary = phases[index]
            else:
                title, summary = f"专题 {index + 1}", f"学习{short_topic}的专题内容：{index + 1}。"
            chapters.append({"title": title, "summary": summary, "objectives": [f"理解{title}涉及的核心知识", f"能够运用{title}解决典型问题"], "sections": [{"title": f"{title}：核心概念", "summary": "本章涉及的核心概念及其相互关系", "keyTopics": [topic]}, {"title": f"{title}：方法与流程", "summary": "本章使用的方法、步骤与判断依据", "keyTopics": ["方法", "原理"]}, {"title": f"{title}：动手实践", "summary": "通过具体案例完成本章知识的应用", "keyTopics": ["案例", "实践"]}]})
        return {"title": course_title, "description": f"围绕{short_topic}的目标动态组织课程章节，不再使用固定六知识点模板。", "chapters": chapters}

    @staticmethod
    def _normalize(plan: dict, fallback: dict, chapter_count: int,
                   chapter_range: tuple[int, int] | None = None) -> dict:
        minimum, maximum = chapter_range if chapter_range else (chapter_count, chapter_count)
        minimum = max(1, minimum)
        maximum = max(minimum, maximum)
        chapters, seen = [], set()
        for index, item in enumerate(plan.get("chapters") or []):
            if not isinstance(item, dict): continue
            title = clean_title(item.get("title"))
            if not title or title in seen: continue
            seen.add(title); sections, section_seen = [], set()
            for section in item.get("sections") or []:
                if not isinstance(section, dict): continue
                section_title = clean_title(section.get("title"))
                if not section_title or section_title in section_seen: continue
                section_seen.add(section_title)
                sections.append({"title": section_title, "summary": str(section.get("summary") or "").strip(), "keyTopics": [str(value).strip() for value in (section.get("keyTopics") or []) if str(value).strip()][:6]})
            if len(sections) < 3: sections = fallback["chapters"][min(index, len(fallback["chapters"]) - 1)]["sections"]
            chapters.append({"title": title, "summary": str(item.get("summary") or "").strip(), "objectives": [str(value).strip() for value in (item.get("objectives") or []) if str(value).strip()][:5], "sections": sections[:6]})
            if len(chapters) == maximum: break
        for item in fallback["chapters"]:
            if len(chapters) >= minimum: break
            if item["title"] not in seen: chapters.append(item)
        return {"title": str(plan.get("title") or fallback["title"]), "description": str(plan.get("description") or fallback["description"]), "chapters": chapters[:maximum]}

    async def plan(self, context: dict, chapter_count: int, depth: str, extra_requirement: str,
                   chapter_range: tuple[int, int] | None = None) -> tuple[dict, list[dict], list[str]]:
        goal = context.get("goal") or {}
        topic = str(goal.get("title") or goal.get("knowledgeDomainName") or "当前学习领域")
        query = f"{topic} {goal.get('description') or ''} 课程大纲 核心知识 先修关系 实践路径"[:500]
        evidence, tools_used = await self._retrieve(query)
        fallback = self._fallback(context, chapter_count)
        if chapter_range:
            minimum, maximum = chapter_range
            count_clause = f"章节数量：根据知识库与网页检索证据的实际覆盖情况，在 {minimum}-{maximum} 章之间自主确定（至少 {minimum} 章、至多 {maximum} 章），证据越充分章节数越多，宁精勿滥"
        else:
            count_clause = f"必须生成：{chapter_count}章"
        prompt = f"课程主题：{topic}\n课程深度：{depth}\n{count_clause}\n用户额外要求：{extra_requirement}\n学习上下文：{json.dumps(context, ensure_ascii=False)[:6000]}\nRAG与网页检索证据：{json.dumps(evidence, ensure_ascii=False)[:9000]}\n\n按知识依赖关系递进，不得用空泛的背景/理论/实践/展望模板拼凑。每章聚焦一个明确能力阶段且互不重复；每章必须有3至6个可授课小节，小节标题必须是具体知识或技能。章、节标题与课程title必须是简洁具体的名词短语（如“ReAct循环机制”“工具调用与Function Calling”），禁止“第X章”等编号前缀，禁止“深入解析”“全面掌握”“赋能”“助力”“打造”等空洞修饰词；summary用一句话说明本章具体学什么，禁止“围绕X建立第N阶段能力”这类模板句。检索证据不足时只能采用稳定基础知识，不得编造事实。仅返回JSON：title,description,chapters。chapters每项包含title,summary,objectives(2-5项),sections(3-6项)；sections每项包含title,summary,keyTopics(1-6项)。"
        try:
            plan = await asyncio.wait_for(self.llm.complete_json(
                system="你是交互导学系统中的课程目录规划Agent。依据知识库和Web Search证据生成准确、规范、可教学的课程结构，只输出合法JSON。",
                prompt=prompt, fallback=fallback, provider="mimo", max_tokens=3000,
                max_retries=1, thinking=False,
            ), self.PLANNING_TIMEOUT_SECONDS)
        except TimeoutError:
            plan = fallback
        return self._normalize(plan, fallback, chapter_count, chapter_range), evidence, tools_used
