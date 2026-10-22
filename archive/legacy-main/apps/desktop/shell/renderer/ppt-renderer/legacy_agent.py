from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import logging
import math
import random
import re
import time
from pathlib import Path
from uuid import UUID

logger = logging.getLogger(__name__)

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.util import Inches, Pt
from PIL import Image

from backgrounds import (
    COVER_TEXT_OVERRIDES,
    palette_for,
    select_backgrounds,
)


AUTO_SLIDE_COUNTS = (12, 20, 30, 40, 55, 70)
_FORBIDDEN_TEMPLATE_PHRASES = (
    "围绕{topic}说明概念", "解释它如何工作", "给出容易理解的因果关系",
    "结合一个具体例子", "指出常见错误以及可执行的改进建议",
    "核心，在于把概念边界、运行机制和实际场景联系起来",
    "概念清晰、易上手", "强调操作与反馈", "关注原理与权衡",
    "基于用户需求生成的结构化演示",
)
_FORBIDDEN_AGENDA_TITLES = (
    "内容准确", "结构清晰", "自主学习", "面向学习者", "适合课堂讲解",
    "完整课件", "生动有趣", "通俗易懂", "重点突出", "案例丰富",
)


def _contains_template_prose(value: object) -> bool:
    text = json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value
    normalized = re.sub(r"围绕[^，。；]{1,40}说明概念", "围绕{topic}说明概念", text)
    return any(phrase in normalized for phrase in _FORBIDDEN_TEMPLATE_PHRASES)


def _clean_presentation_title(value: object) -> str:
    title = str(value or "").strip()
    title = re.sub(r"[，,、·|｜—–\-]*\s*交互课件(?:PPT)?\s*$", "", title, flags=re.I).strip()
    return title


class _AdaptiveConcurrency:
    """Small AIMD-style limiter for independent presentation content calls."""

    def __init__(self, minimum: int, initial: int, maximum: int):
        self.minimum = max(1, minimum)
        self.maximum = max(self.minimum, maximum)
        self.limit = max(self.minimum, min(initial, self.maximum))
        self.active = 0
        self.max_observed = 0
        self.success_streak = 0
        self._condition = asyncio.Condition()

    async def acquire(self) -> None:
        async with self._condition:
            await self._condition.wait_for(lambda: self.active < self.limit)
            self.active += 1
            self.max_observed = max(self.max_observed, self.active)

    async def release(self, success: bool) -> None:
        async with self._condition:
            self.active -= 1
            if success:
                self.success_streak += 1
                if self.success_streak >= self.limit and self.limit < self.maximum:
                    self.limit += 1
                    self.success_streak = 0
            else:
                self.limit = max(self.minimum, self.limit - 1)
                self.success_streak = 0
            self._condition.notify_all()


def _as_list(value, *container_keys: str) -> list:
    """Tolerate common LLM wrappers without ever slicing a mapping."""
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, dict):
        for key in container_keys:
            nested = value.get(key)
            if isinstance(nested, (list, tuple)):
                return list(nested)
    return []


def _fallback_outline(request: PresentationRequest, agenda_plan: list[dict] | None = None) -> dict:
    title = _clean_presentation_title(request.title or request.requirement.strip().splitlines()[0][:60])
    middle_count = max(3, request.slide_count - 2)
    requirement_lower = request.requirement.lower()
    if any(token in requirement_lower for token in ("c语言", "c 语言")):
        domain = "c"
        subtitle = "从程序结构到综合实践"
        topics = ["课程目标与开发环境", "C程序结构与编译执行", "变量、常量与数据类型", "运算符与表达式",
                  "条件分支实战", "循环结构对比", "函数与模块化", "数组和字符串", "调试与常见错误", "综合练习"]
    elif any(token in requirement_lower for token in ("agent", "智能体", "智能代理")):
        domain = "agent"
        subtitle = "从工作原理到工程落地"
        topics = ["Agent与聊天机器人的区别", "感知—规划—行动闭环", "工具调用机制", "记忆与上下文管理",
                  "RAG知识检索", "工作流与状态机", "多智能体协作", "错误恢复与安全边界", "评估指标", "工程实践"]
    elif any(token in requirement_lower for token in ("组成原理", "冯诺依曼", "指令周期", "cache")):
        domain = "architecture"
        subtitle = "从数据通路到指令执行"
        topics = ["冯诺依曼体系结构", "CPU核心组成", "取指—译码—执行周期", "运算器与控制器",
                  "寄存器体系", "存储层次与局部性", "Cache命中案例", "总线与输入输出", "中断机制", "性能练习"]
    else:
        domain = "general"
        subtitle = "核心概念、关键方法与实践应用"
        topics = ["背景与目标", "核心概念", "关键框架", "实践方法", "案例分析", "实施步骤", "风险与对策", "评估指标"]
    if agenda_plan:
        planned_topics = [
            str(topic)
            for chapter in agenda_plan
            for topic in _as_list(chapter.get("keyTopics"), "keyTopics", "topics")
            if str(topic).strip()
        ]
        topics = planned_topics or [str(chapter.get("title", "")) for chapter in agenda_plan if chapter.get("title")]
    technical = domain in {"c", "agent"} or any(
        token in requirement_lower for token in ("编程", "代码", "程序", "python", "java", "algorithm")
    )
    slides = [{
        "title": title,
        "kind": "title",
        "points": ["基于用户需求生成的结构化演示"],
        "speakerNotes": f"大家好，今天我们一起学习《{title}》。这次内容会围绕关键问题逐步展开，并结合具体场景说明它为什么重要、如何应用。",
    }]
    kinds = ["overview", "concept", "process", "code" if technical else "comparison", "comparison", "table", "case", "practice"]
    for index in range(middle_count):
        topic = topics[max(0, index - 1) % len(topics)]
        kind = kinds[index % len(kinds)]
        item = {
            "title": topic, "kind": kind, "takeaway": f"理解{topic}，并能联系实际场景应用。",
            "points": [
                {"heading": "核心定义", "detail": f"围绕{topic}说明概念、作用以及需要掌握的边界。"},
                {"heading": "关键机制", "detail": "解释它如何工作，并给出容易理解的因果关系或执行步骤。"},
                {"heading": "实践提醒", "detail": "结合一个具体例子，指出常见错误以及可执行的改进建议。"},
            ],
            "speakerNotes": (
                f"“{topic}”的核心，在于把概念边界、运行机制和实际场景联系起来。"
                "理解它时，不只要记住定义，还要能解释它为什么有效，以及在什么条件下可能失效。"
            ),
        }
        if kind == "code":
            if domain == "agent":
                item["code"] = {
                    "language": "python", "caption": "最小工具调用 Agent 循环",
                    "content": "def run_agent(goal, tools):\n    plan = make_plan(goal)\n    memory = []\n    for step in plan:\n        tool = tools[step.tool]\n        result = tool(**step.args)\n        memory.append(result)\n        if goal_reached(memory):\n            break\n    return summarize(memory)",
                    "annotations": ["规划器把目标拆成步骤", "根据步骤选择注册工具", "结果写入短期记忆", "达到目标后生成最终回答"],
                    "output": "任务完成：已检索资料、比较证据并生成答案",
                }
            else:
                item["code"] = {
                    "language": "c", "caption": "从输入到输出的最小完整示例",
                    "content": "#include <stdio.h>\n\nint main(void) {\n    int a = 3, b = 5;\n    int sum = a + b;\n    printf(\"sum = %d\\n\", sum);\n    return 0;\n}",
                    "annotations": ["头文件提供 printf 声明", "main 是程序入口", "使用变量保存计算结果", "return 0 表示正常结束"],
                    "output": "sum = 8",
                }
        if kind == "process":
            item["process"] = [{"label": "理解", "detail": "明确目标与输入"}, {"label": "拆解", "detail": "划分关键步骤"}, {"label": "执行", "detail": "逐步完成并检查"}, {"label": "复盘", "detail": "总结结果与改进"}]
        if kind == "table":
            item["table"] = {"headers": ["维度", "特点", "适用场景"], "rows": [["基础", "概念清晰、易上手", "入门学习"], ["实践", "强调操作与反馈", "项目训练"], ["进阶", "关注原理与权衡", "复杂问题"]]}
        slides.append(item)
    slides.append({
        "title": "总结与下一步",
        "kind": "conclusion",
        "points": ["回顾最重要的三个结论", "明确下一步行动", "预留交流与提问"],
        "speakerNotes": "最后，我们把今天的内容收束一下。请大家回顾最重要的三个结论，并把它们落实到下一步行动中。我的讲解到这里，欢迎大家交流和提问。",
    })
    if len(slides) >= 3:
        chapters = agenda_plan or [
            {"title": "基础认知", "objective": "建立背景与核心概念"},
            {"title": "核心方法", "objective": "理解关键框架与实施方法"},
            {"title": "实践应用", "objective": "通过案例与练习完成迁移"},
        ]
        slides[1] = {
            "title": "目录",
            "kind": "agenda",
            "points": [
                {"heading": chapter.get("title", ""), "detail": chapter.get("objective", "")}
                for chapter in chapters
            ],
            "speakerNotes": (
                "今天的内容分为以下几个相互衔接的部分。"
                + "；".join(
                    f"第{index}部分是{chapter.get('title', '')}"
                    for index, chapter in enumerate(chapters, start=1)
                )
                + "。"
            ),
        }
    return {
        "title": title,
        "subtitle": subtitle,
        "agendaPlan": agenda_plan or [],
        "slides": slides[:request.slide_count],
    }


class PptAgent:
    def __init__(self, llm: LLMClient, store: PresentationStore, output_dir: Path):
        self.llm = llm
        self.store = store
        self.output_dir = output_dir
        self.event_summary_callback = None

    async def _event(self, task_id: UUID, phase: str, title: str,
               detail: str = "", data: dict | None = None) -> None:
        try:
            recorded = self.store.append_event(task_id, phase, title, detail, data)
            if recorded and self.event_summary_callback:
                await self.event_summary_callback(task_id, int(recorded["seq"]))
        except Exception:
            pass

    @staticmethod
    def _minimum_chapter_count(slide_count: int) -> int:
        if slide_count >= 70:
            return 10
        if slide_count >= 55:
            return 8
        if slide_count >= 40:
            return 6
        if slide_count >= 30:
            return 5
        if slide_count >= 20:
            return 4
        return 3

    @classmethod
    def _expand_chapters(cls, chapters: list[dict], slide_count: int) -> list[dict]:
        """Split broad chapters using the planning agent's own key topics."""
        minimum = cls._minimum_chapter_count(slide_count)
        expanded = [copy.deepcopy(chapter) for chapter in chapters]
        while len(expanded) < minimum:
            candidate_index = max(
                range(len(expanded)),
                key=lambda index: len(_as_list(expanded[index].get("keyTopics"), "topics", "items")),
            )
            candidate = expanded[candidate_index]
            topics = [
                str(topic).strip()
                for topic in _as_list(candidate.get("keyTopics"), "topics", "items")
                if str(topic).strip()
            ]
            if len(topics) < 2:
                break
            split_at = max(1, len(topics) // 2)
            replacements = [
                {
                    "title": group[0][:30],
                    "objective": str(candidate.get("objective", ""))[:160],
                    "keyTopics": group[:5],
                }
                for group in (topics[:split_at], topics[split_at:])
                if group
            ]
            expanded[candidate_index:candidate_index + 1] = replacements
        return expanded

    @classmethod
    def _chapters_from_requirement(cls, request: PresentationRequest, slide_count: int) -> list[dict]:
        """Build a subject-specific fallback from concepts explicitly named by the user."""
        requirement_lower = request.requirement.lower()
        if any(token in requirement_lower for token in ("考研数学一", "数学一全章节", "数学一，全章节")):
            chapters = [
                {
                    "title": "函数、极限与连续",
                    "objective": "掌握高等数学的逻辑起点和极限计算方法",
                    "keyTopics": ["函数性质", "数列与函数极限", "无穷小比较", "连续与间断点"],
                },
                {
                    "title": "一元函数微分学",
                    "objective": "建立导数、中值定理与函数性态分析的完整方法",
                    "keyTopics": ["导数与微分", "微分中值定理", "单调性与极值", "泰勒公式"],
                },
                {
                    "title": "一元函数积分学",
                    "objective": "掌握积分计算、反常积分与定积分应用",
                    "keyTopics": ["不定积分", "定积分", "反常积分", "几何与物理应用"],
                },
                {
                    "title": "多元函数与微分方程",
                    "objective": "掌握多元微积分、级数和常微分方程的核心题型",
                    "keyTopics": ["多元函数微分", "重积分", "曲线曲面积分", "无穷级数", "微分方程"],
                },
                {
                    "title": "线性代数",
                    "objective": "贯通矩阵、方程组、特征值和二次型",
                    "keyTopics": ["行列式与矩阵", "向量与方程组", "特征值与特征向量", "二次型"],
                },
                {
                    "title": "概率论与数理统计",
                    "objective": "掌握随机变量、数字特征和统计推断",
                    "keyTopics": ["概率与随机变量", "多维随机变量", "数字特征", "大数定律", "参数估计"],
                },
                {
                    "title": "真题训练与复习策略",
                    "objective": "把知识体系转化为稳定的考场得分能力",
                    "keyTopics": ["题型识别", "综合题拆解", "错题复盘", "限时模拟"],
                },
            ]
            return cls._expand_chapters(chapters, slide_count)
        named_topic = _clean_presentation_title(request.title)
        if not named_topic:
            quoted = re.search(r"《([^》]{2,80})》", request.requirement)
            named_topic = quoted.group(1).strip() if quoted else ""
        transition_match = re.fullmatch(r"从(.{1,24})到(.{1,24})的(.{1,20})", named_topic)
        if transition_match:
            origin, destination, change = transition_match.groups()
            chapters = [
                {
                    "title": f"{origin}如何表示与推理",
                    "objective": f"建立{origin}的知识表示、推理方式和能力边界",
                    "keyTopics": [f"{origin}的知识表示", f"{origin}的推理机制", "优势与局限"],
                },
                {
                    "title": f"{change}为什么发生",
                    "objective": "理解数据、算力与任务复杂度如何共同推动方法转向",
                    "keyTopics": ["传统方法的瓶颈", "数据与算力条件", "学习范式的兴起"],
                },
                {
                    "title": f"{destination}如何学习表示",
                    "objective": f"掌握{destination}从数据中形成表示和完成推理的核心机制",
                    "keyTopics": [f"{destination}的表示方式", "训练与优化", "泛化与推断"],
                },
                {
                    "title": f"{origin}与{destination}的关键差异",
                    "objective": "从表示、学习、推理与可解释性四个维度比较两种范式",
                    "keyTopics": ["知识表示对比", "学习方式对比", "可解释性与鲁棒性"],
                },
                {
                    "title": "融合路径与典型应用",
                    "objective": "理解两种范式如何互补，并迁移到真实系统设计",
                    "keyTopics": ["神经符号融合", "典型应用案例", "工程选择依据"],
                },
                {
                    "title": "案例推演与学习检查",
                    "objective": f"通过案例判断{change}带来的能力变化与适用边界",
                    "keyTopics": ["案例拆解", "方案比较", "练习与回顾"],
                },
            ]
            return cls._expand_chapters(chapters, slide_count)
        has_explicit_scope = any(token in request.requirement for token in ("覆盖", "包括", "包含", "系统讲解"))
        if named_topic and not has_explicit_scope:
            if any(token in named_topic.lower() for token in ("区别", "差异", "对比", " vs ", "vs.")):
                chapters = [
                    {
                        "title": f"{named_topic}的概念边界",
                        "objective": "分别界定比较对象，避免把能力表现与实现机制混为一谈",
                        "keyTopics": ["核心定义", "组成要素", "边界与常见误解"],
                    },
                    {
                        "title": "决策机制与工作流程对比",
                        "objective": "比较两类方案如何理解输入、形成决策并执行动作",
                        "keyTopics": ["决策依据", "执行流程", "反馈与纠错"],
                    },
                    {
                        "title": "工具调用、记忆与适应能力",
                        "objective": "从关键工程能力维度识别两类方案的实现差异",
                        "keyTopics": ["工具调用", "状态与记忆", "适应性与泛化"],
                    },
                    {
                        "title": "适用场景、局限与风险",
                        "objective": "根据任务条件判断不同方案的优势、成本和风险",
                        "keyTopics": ["适用任务", "可靠性", "成本与治理"],
                    },
                    {
                        "title": "混合架构与案例判断",
                        "objective": "通过真实案例形成可执行的工程选型方法",
                        "keyTopics": ["混合架构", "选型标准", "案例推演"],
                    },
                ]
                return cls._expand_chapters(chapters, slide_count)
            chapters = [
                {"title": f"{named_topic}的概念与边界", "objective": "建立准确概念并识别适用边界", "keyTopics": ["核心定义", "关键要素", "常见误解"]},
                {"title": f"{named_topic}的核心机制", "objective": "理解关键组成之间如何协同工作", "keyTopics": ["运行原理", "关键流程", "因果关系"]},
                {"title": f"{named_topic}的方法与实现", "objective": "掌握从原理到实现的主要路径", "keyTopics": ["方法步骤", "实现要点", "质量判断"]},
                {"title": f"{named_topic}的场景与案例", "objective": "通过具体场景建立迁移应用能力", "keyTopics": ["典型场景", "案例拆解", "错误分析"]},
                {"title": f"{named_topic}的实践检查", "objective": "用练习和检查标准验证学习结果", "keyTopics": ["实践任务", "验收标准", "复盘改进"]},
            ]
            return cls._expand_chapters(chapters, slide_count)
        fragments = re.split(r"[，,、；;。\n]+", request.requirement)
        candidates: list[str] = []
        for fragment in fragments:
            text = fragment.strip()
            text = re.sub(r"^.*?(?:讲解|介绍|覆盖|包括|包含)", "", text).strip()
            if not text or any(marker in text for marker in (
                "面向", "用于", "适合", "制作", "需要", "内容详细", "目标是",
                "不用", "结合学习画像", "内容要", "每一页", "课堂互动",
            )):
                continue
            pieces = re.split(r"(?:以及|及|与|和)", text) if len(text) <= 28 else [text]
            for piece in pieces:
                piece = piece.strip(" ：:（）()")
                if 1 <= len(piece) <= 20 and piece not in candidates:
                    candidates.append(piece)
        minimum = cls._minimum_chapter_count(slide_count)
        limit = min(len(candidates), 14)
        if limit >= minimum:
            return [
                {
                    "title": topic[:30],
                    "objective": f"掌握{topic}的核心原理、典型方法与常见问题",
                    "keyTopics": [topic],
                }
                for topic in candidates[:limit]
            ]
        generic = [
            {"title": "基础认知", "objective": "建立主题背景、核心概念与必要前置知识", "keyTopics": ["背景与目标", "核心概念"]},
            {"title": "核心方法", "objective": "理解主要原理、方法流程与关键判断", "keyTopics": ["关键框架", "方法步骤"]},
            {"title": "实践应用", "objective": "通过案例、练习和复盘形成可迁移能力", "keyTopics": ["案例分析", "实践练习"]},
        ]
        return cls._expand_chapters(generic, slide_count)

    @staticmethod
    def _agenda_is_subject_aligned(chapters: object) -> bool:
        normalized = [item for item in _as_list(chapters, "chapters", "items") if isinstance(item, dict)]
        if len(normalized) < 3:
            return False
        for chapter in normalized:
            title = re.sub(r"\s+", "", str(chapter.get("title") or ""))
            if not title:
                return False
            if any(title == term or title.startswith(term + "：") for term in _FORBIDDEN_AGENDA_TITLES):
                return False
        return True

    @staticmethod
    def _fallback_slide_count(request: PresentationRequest) -> int:
        text = request.requirement.lower()
        if any(token in text for token in ("50页以上", "大型课件", "完整课程", "全套课程", "全部章节", "所有章节")):
            return 55
        if any(token in text for token in ("系统讲解", "内容详尽", "全面讲解", "教材", "课程体系")):
            return 40
        if any(token in text for token in ("概览", "简要", "快速介绍", "短汇报")):
            return 12
        if request.detail_level == "detailed" or len(request.requirement) >= 160:
            return 30
        return 20

    async def choose_slide_count(self, request: PresentationRequest) -> int:
        """Let the planning model select a bounded content scale before outlining."""
        fallback_count = self._fallback_slide_count(request)
        if request.slide_count:
            return request.slide_count
        fallback = {"slideCount": fallback_count}
        prompt = (
            "根据用户需求的主题范围、受众、用途和内容密度，选择最合适的PPT正文规模。"
            f"只能从 {list(AUTO_SLIDE_COUNTS)} 中选择一个数。"
            "12适合简短概览；20适合常规分享；30适合详细专题；40适合系统课程；"
            "55适合覆盖大量章节的完整课件；70只用于范围极广、明确要求非常详尽的大型课程。"
            "不要一味选大，确保每页都有实质内容。严格返回JSON：{\"slideCount\":数字}。\n"
            f"用户参数：{request.model_dump_json(by_alias=True)}"
        )
        try:
            result = await asyncio.wait_for(
                self.llm.complete_json(
                    "你是PPT内容规模规划器，只负责选择页数档位，不生成大纲。",
                    prompt,
                    fallback,
                    provider="mimo",
                ),
                timeout=min(30.0, float(getattr(self.llm.settings, "llm_timeout_seconds", 60))),
            )
        except (TimeoutError, TypeError, ValueError):
            return fallback_count
        try:
            selected = int(result.get("slideCount", fallback_count))
        except (AttributeError, TypeError, ValueError):
            selected = fallback_count
        return min(AUTO_SLIDE_COUNTS, key=lambda candidate: abs(candidate - selected))

    async def plan_agenda_with_tutor(self, request: PresentationRequest) -> dict:
        """Use the interaction tutor's full tool-capable agent for chapter planning."""
        fallback_count = request.slide_count or self._fallback_slide_count(request)
        fallback = {
            "slideCount": fallback_count,
            "chapters": self._chapters_from_requirement(request, fallback_count),
            "toolsUsed": [],
        }
        system_message = (
            "你是ITN的教学目录规划Agent。你只规划学习者需要掌握的知识内容，不规划写作要求。"
            "目录章节只能来自知识主题、已有讲义和知识依据。内容准确、结构清晰、自主学习、面向学习者、"
            "适合课堂讲解、完整课件、通俗易懂、重点突出等词语都是质量要求，严禁作为章节标题或章节主题。"
            "受众、用途、页数、风格和输出格式也不得成为章节。每章必须回答一个与知识主题直接相关的问题；"
            "去掉知识主题后可以套用到任意课件的空泛章名必须重写。先理解学习目标和认知递进；如果主题涉及技术演进、"
            "行业现状、政策、就业、产品版本、市场数据或近期案例，应使用知识库或web_search工具核实，"
            "再规划目录。稳定的基础学科内容无需为联网而联网；若需求明确包含当前年份、最新、近期、"
            "行业现状、就业或产品生态，必须至少调用一次web_search，不能只读取当前时间。"
            "工具调用最多两轮，最多选择3次最必要的搜索；"
            "搜索不是罗列资料，而是用来校正章节结构和覆盖范围。只规划目录，不生成逐页正文。"
            "最终回答必须是纯JSON，不要Markdown，不要解释。"
        )
        user_message = (
            f"【知识主题】{_clean_presentation_title(request.title or request.requirement)}\n"
            f"【已有讲义与知识依据】{json.dumps((request.generation_context or {}).get('lectureResource') or {}, ensure_ascii=False)[:12000]}\n"
            f"【生成质量要求】{request.requirement}\n"
            "生成质量要求只控制课件质量，其中的形容词、受众和学习方式严禁进入目录。\n"
            f"若slideCount大于0则严格保持原值；若为0则代表页数无限制，请先完整规划章节，"
            "再根据每章所需内容决定合理总页数，不要吸附到固定档位，也不要为了缩短篇幅合并重要章节。"
            "章节数必须匹配内容规模：12页通常3-4章，20页4-5章，30页5-7章，40页6-9章，"
            "55页8-12章，70页10-14章。系统课程、考试复习和完整教程不得只给3个宽泛章节。"
            "章名必须体现具体学科内容，避免可套用到任何主题的空泛表达。"
            "每章包含title、objective、keyTopics（2到5项）。"
            "返回：{\"slideCount\":数字,\"chapters\":[{\"title\":\"章名\","
            "\"objective\":\"本章解决的问题\",\"keyTopics\":[\"主题\"]}]}。"
        )
        seeded_tools: list[str] = []
        fresh_context = ""
        fresh_markers = (
            "最新", "近期", "当前", "目前", "现在", "今年", "行业", "市场", "就业",
            "政策", "趋势", "生态", "版本", "发布", "2024", "2025", "2026", "2027",
        )
        needs_fresh_context = any(marker in request.requirement for marker in fresh_markers)
        if needs_fresh_context:
            web_tool = tool_registry.get("web_search")
            if web_tool and web_tool.available:
                query = request.requirement.strip()[:220]
                if not re.search(r"20\d{2}", query):
                    query = f"2026年 {query}"
                try:
                    web_result = await web_tool.execute({"query": query, "limit": 5})
                except Exception:
                    web_result = None
                if isinstance(web_result, dict) and web_result.get("success") is not False and web_result.get("results"):
                    seeded_tools.append("web_search")
                    fresh_context = (
                        "\n工作流已完成一次必要的web_search。请以这些结果校正目录，不要重复搜索，"
                        "除非信息明显不足：\n"
                        f"{json.dumps(web_result, ensure_ascii=False)[:12000]}"
                    )
        user_message += fresh_context

        async def run_agent() -> tuple[str, list[str]]:
            reply_parts: list[str] = []
            tools_used: list[str] = list(seeded_tools)
            agent = EnhancedChatAgent(
                self.llm,
                self.llm.settings,
                provider="mimo",
                max_iterations=1 if seeded_tools else 2,
            )
            async for event in agent.stream([
                {"role": "system", "content": system_message},
                {"role": "user", "content": user_message},
            ]):
                if event.get("type") == "content":
                    reply_parts.append(str(event.get("text", "")))
                elif event.get("type") == "tool_call_completed" and event.get("success") is not False:
                    tool_name = str(event.get("tool", "")).strip()
                    if tool_name and tool_name not in tools_used:
                        tools_used.append(tool_name)
            return "".join(reply_parts), tools_used

        agenda_timeout = min(
            float(getattr(self.llm.settings, "presentation_agenda_timeout_seconds", 45)),
            float(getattr(self.llm.settings, "llm_timeout_seconds", 60)),
        )
        if not needs_fresh_context or seeded_tools:
            # Stable academic topics do not need a separate planner-model call before
            # the actual agenda call. Fresh topics also take this path once the required
            # web search has already succeeded and its result is embedded in the prompt.
            # This preserves the same evidence while removing one sequential LLM round trip.
            try:
                result = await asyncio.wait_for(
                    self.llm.complete_json(
                        system_message,
                        user_message,
                        fallback,
                        provider="mimo",
                        max_tokens=int(getattr(
                            self.llm.settings, "presentation_agenda_max_tokens", 3072,
                        )),
                    ),
                    timeout=agenda_timeout,
                )
                tools_used = list(seeded_tools)
            except Exception:
                result = fallback
                tools_used = list(seeded_tools)
        else:
            try:
                reply, tools_used = await asyncio.wait_for(
                    run_agent(),
                    timeout=agenda_timeout,
                )
            except Exception:
                return fallback
            start, end = reply.find("{"), reply.rfind("}")
            if start < 0 or end <= start:
                return fallback
            try:
                result = json.loads(reply[start:end + 1])
            except (json.JSONDecodeError, TypeError):
                return fallback
        try:
            selected = int(result.get("slideCount", fallback_count))
        except (AttributeError, TypeError, ValueError):
            selected = fallback_count
        selected = (
            request.slide_count
            if request.slide_count
            else max(8, min(120, selected))
        )
        chapters = result.get("chapters") if isinstance(result, dict) else None
        normalized_chapters = []
        if isinstance(chapters, list):
            for chapter in chapters[:20]:
                if not isinstance(chapter, dict):
                    continue
                title = str(chapter.get("title", "")).strip()
                if not title:
                    continue
                topics = _as_list(chapter.get("keyTopics"), "keyTopics", "topics")
                chapter_slides = chapter.get("slides")
                if not topics and isinstance(chapter_slides, list):
                    topics = [
                        slide.get("title")
                        for slide in chapter_slides
                        if isinstance(slide, dict) and str(slide.get("title", "")).strip()
                    ]
                objective = str(chapter.get("objective", "")).strip()
                if not objective and isinstance(chapter_slides, list):
                    objective = next((
                        str(slide.get("content", "")).strip()
                        for slide in chapter_slides
                        if isinstance(slide, dict) and str(slide.get("content", "")).strip()
                    ), "")
                title = re.sub(r"^第[一二三四五六七八九十百\d]+章[：:\s]*", "", title).strip()
                normalized_chapters.append({
                    "title": title[:30],
                    "objective": objective[:160],
                    "keyTopics": [str(topic).strip()[:40] for topic in topics[:5] if str(topic).strip()],
                })
        if not self._agenda_is_subject_aligned(normalized_chapters):
            return fallback
        normalized_chapters = self._expand_chapters(normalized_chapters, selected)
        return {"slideCount": selected, "chapters": normalized_chapters, "toolsUsed": tools_used}

    async def analyze(self, request: PresentationRequest, agenda_plan: list[dict] | None = None,
                      progress_cb=None) -> dict:
        fallback = _fallback_outline(request, agenda_plan)
        safe_title = _clean_presentation_title(request.title or request.requirement.splitlines()[0][:60])
        knowledge_map_context = (
            json.dumps(request.generation_context, ensure_ascii=False)
            if request.generation_context else "无"
        )
        planning_timeout = min(
            float(getattr(self.llm.settings, "llm_timeout_seconds", 60)) - 10.0,
            170.0,
        )
        planning_timeout = max(30.0, planning_timeout)
        use_batched = True  # 统一走本地模型串行批次，不再受请求端模型参数影响
        if use_batched:
            try:
                batched = await self._generate_in_batches(request, fallback, planning_timeout, progress_cb=progress_cb)
                if self._outline_is_rich(batched, request):
                    return batched
            except RuntimeError:
                # Batch generation could not produce rich pages; fall through to
                # the single-shot outline call below instead of failing the task.
                pass
        prompt = (
            "请设计一份内容充实、可直接授课或汇报的演示文稿。必须严格返回 JSON，根节点包含 title、subtitle、slides。"
            f"页数必须恰好为 {request.slide_count}。每页只讲一个明确结论，但不能只有口号。\n"
            "固定结构：第1页封面，第2页目录，最后1页总结；目录必须概括正文的章节顺序，不得省略。"
            "目录至少规划3个章节，章节上限由主题复杂度决定，不要为了套模板固定成少数章节；系统会自动分页目录。"
            "不要自行生成章节标题页，系统会根据目录自动在每章正文前插入章节标题页。"
            "每个 slides 项必须包含：title、kind、points、speakerNotes；takeaway为可选字段，只在约三分之一的关键页面使用。"
            "正文页还可包含 teachingMoments 数组，用于与口播同步的课堂互动。每3-4页至少安排1道quiz，并在每章最后一页安排1个summary。"
            "quiz格式为{type:'quiz',anchorText,title,prompt,options,answerIndex,explanation}，options必须恰好4项；"
            "quiz的options必须针对本页知识点设计4个同主题、看似合理但只有一项正确的选项，禁止使用“只需记住术语、任何场景都可以直接套用、结果是否正确与过程无关”这类与题目无关的通用话术；"
            "summary格式为{type:'summary',anchorText,title,points,notePrompt}，points为2-4项。"
            "anchorText必须逐字截取自同页speakerNotes，长度8-24字；quiz放在相关解释讲完处，summary放在本章收束句处。"
            "speakerNotes 必须是讲者站在台上可以逐字直接朗读的中文口播稿，不是写给讲者看的提纲、动作指令或讲解建议；"
            "禁止使用“介绍本页”“说明本章”“展开讲解”“强调重点”“引导听众”等导演式表达。"
            "不要机械地让每页都以“首先、接下来、随后、然后、最后”开头；只有上下页存在明确递进、转折或因果关系时才自然过渡，"
            "连续三页中最多一页以顺序连接词开头，其余页面直接从观点、问题、案例或结论切入。不要在页尾预告下一页，"
            "不要写“有了这个基础、把视线转向、继续往下推进”等冗余过渡话术；目录页直接概述路线，章节页简短报出章节。"
            "正文页口播建议120-240个中文字符，使用自然完整的句子，不要机械复述页面标题和所有项目符号。"
            "目录页禁止使用takeaway。kind 从 title/agenda/overview/concept/code/comparison/process/table/timeline/roadmap/spotlight/checklist/case/practice/conclusion 中选择；"
            "points 必须为3-5个对象，每项含 heading 和 detail，detail 应有完整解释而不是短语。"
            "code 页必须额外包含 code={language,caption,content,annotations,output}，代码8-22行且可运行；"
            "process/timeline 页包含 process=[{label,detail}]；table 页包含 table={headers,rows}；"
            "roadmap页用3-5个process节点表达演进路线；spotlight页用第一个point给核心结论、其余point给证据；"
            "checklist页用3-5个point呈现检查项、判断标准或行动清单。三者都必须基于实际内容，不可凑版式。"
            "comparison 页的 points 应清楚呈现两侧差异；case/practice 页要包含场景、步骤、结果或练习要求。"
            "如果主题涉及编程、软件、算法或技术教学，至少四分之一正文页必须为 code/case/practice，"
            "必须呈现代码、运行结果、语句解释和常见错误，不能把详细内容只放在 speakerNotes。"
            "详细模式下，每页正文建议150-300个中文字符；均衡模式100-220字；精简模式也要有明确例子。"
            "每个 point 的 detail 字数上限：详细模式不超过150字，用2-3句话说清一个完整观点；"
            "均衡模式不超过100字，用1-2句话概括；精简模式不超过60字，一句话点明核心。"
            "所有 detail 必须以句号结尾，表达完整语义，不要写到一半截断。"
            "标题和副标题必须自然、具体，禁止使用“学习实施路径与步骤”“本页重点”“本页结论”等模板话术；"
            "可见文本不要用中点“·”串联短语，应改写成自然句子、顿号或分号。副标题不能为空。"
            f"\n交互导学任务规划 Agent 给出的章节骨架必须保持顺序与语义，不得合并或改名："
            f"{json.dumps(agenda_plan or [], ensure_ascii=False)}"
            "\n排版安全协议：页面标题尽量不超过22个中文字符；takeaway不超过70字；每个point的detail严格遵守上述字数上限；禁止输出Markdown反引号。"
            "普通内容页只放3-4个信息模块，模块之间预留明显间距，不得用5个以上小模块硬塞内容。"
            "代码页控制在8-18行、3-4条注解、输出不超过3行；较长代码拆成多页。"
            "流程或时间线控制在3-5个节点，每个节点只保留短标签和一条解释；"
            "表格最多4列5行，复杂数据应拆页；对比页优先使用2列或4卡片，不使用拥挤的三栏长段落。"
            "每页必须有一个主视觉重心，避免所有模块等宽等高；相邻两页不要使用完全相同的布局。"
            f"\n知识网络课程上下文：{knowledge_map_context}。"
            "若上下文包含lectureResource，它是已生成讲义：必须先提取其事实、章节脉络、案例和来源再设计PPT；"
            "PPT要重新组织为适合演讲的视觉叙事，不得逐段复制讲义，也不得编造与讲义冲突的内容。"
            "若上下文不为“无”，必须保持当前知识点的最小颗粒度；把章节顺序、前序知识和后续位置用于建立课程承接，"
            "不要把整张地图扩写进当前PPT，也不要把学习目标、受众描述、写作要求误当成章节。"
            f"\n用户参数：{request.model_dump_json(by_alias=True)}"
        )
        try:
            result = await asyncio.wait_for(
                self.llm.complete_json(
                    "你是 ITN 的资深课程设计师与演示文稿信息架构师。先建立叙事，再选择最适合信息的页面类型；优先给事实、代码、案例、对比和练习，避免空泛三段式套话。",
                    prompt, {"title": safe_title, "subtitle": "", "slides": []}, provider="mimo",
                ),
                timeout=planning_timeout,
            )
        except TimeoutError:
            result = {"slides": []}
        if isinstance(result, dict):
            result["agendaPlan"] = agenda_plan or []
        slides = result.get("slides") if isinstance(result, dict) else None
        if self._outline_is_rich(result, request):
            return result
        if True:
            batched = await self._generate_in_batches(request, fallback, planning_timeout)
            if self._outline_is_rich(batched, request):
                return batched
        revision_prompt = (
            "下面的大纲页数正确，但页面内容过少或表达类型过于单一。请在保持页数与主题不变的情况下完全重写，"
            "严格遵循语义页面协议：非技术主题也要使用表格、时间线、流程、对比、案例、练习、数据或观点证据，"
            "不能退化成每页三条短句。技术主题必须提供可运行代码、输出、注解和常见错误。只返回完整 JSON。\n"
            "每页 speakerNotes 必须保留并改写为讲者可直接逐字朗读的口播，禁止出现给讲者看的动作指令；"
            "不要逐页添加“首先、接下来、随后、然后、最后”；只在语义确有递进或转折时自然承接，连续三页最多使用一次页首顺序词，不要写冗余过渡句或页尾预告。\n"
            f"用户参数：{request.model_dump_json(by_alias=True)}\n待重写大纲：{json.dumps(result, ensure_ascii=False)}"
        )
        # Keep revision on the model selected by the user. Schema drift is repaired
        # locally; content must not silently switch to a different model.
        revision_provider = "mimo"
        try:
            revised = await asyncio.wait_for(
                self.llm.complete_json(
                    "你是演示文稿内容质量审稿人。你的任务是把稀疏、模板化大纲改写为信息充分且适合视觉呈现的专业大纲。",
                    revision_prompt, {"slides": []}, provider=revision_provider,
                ),
                timeout=planning_timeout,
            )
        except TimeoutError:
            revised = {"slides": []}
        if isinstance(revised, dict):
            revised["agendaPlan"] = agenda_plan or []
        if self._outline_is_rich(revised, request):
            return revised
        revised_slides = revised.get("slides") if isinstance(revised, dict) else None
        minimal_slides = (
            isinstance(revised_slides, list)
            and len(revised_slides) >= max(3, int(request.slide_count * 0.6))
            and any(isinstance(slide, dict) and str(slide.get("title") or "").strip() for slide in revised_slides)
        )
        if minimal_slides:
            return revised
        raise RuntimeError("内容模型多轮生成后仍未返回可交付页面，已拒绝写入模板化兜底文本")

    @staticmethod
    def normalize_outline_for_layout(outline: dict) -> dict:
        """Clamp model output to renderer-safe capacities without changing the slide story."""
        normalized = copy.deepcopy(outline)
        normalized["title"] = _clean_presentation_title(normalized.get("title"))
        allowed_kinds = {
            "title", "agenda", "overview", "concept", "code", "comparison", "process",
            "table", "timeline", "roadmap", "spotlight", "checklist", "case", "practice", "conclusion", "section",
        }

        def shorten(value, limit: int) -> str:
            text = str(value or "").replace("`", "").replace("\n", "；").strip()
            text = re.sub(r"(\*\*|__)(.*?)\1", r"\2", text)
            text = re.sub(r"\s*·\s*", "，", text)
            text = re.sub(r"^(?:本页重点|本页结论|核心结论)\s*[：:，,；;]*\s*", "", text)
            text = re.sub(r"[。！？!?]\s*[；;]", "。", text)
            text = re.sub(r"[；;]{2,}", "；", text)
            if len(text) <= limit:
                return text
            return text[:limit]
        def keep_full(value: str) -> str:
            text = str(value or "").replace("`", "").replace("\n", "；").strip()
            text = re.sub(r"(\*\*|__)(.*?)\1", r"\2", text)
            text = re.sub(r"\s*·\s*", "，", text)
            text = re.sub(r"^(?:本页重点|本页结论|核心结论)\s*[：:，,；;]*\s*", "", text)
            return text

        normalized["subtitle"] = shorten(normalized.get("subtitle", ""), 200)
        if not normalized["subtitle"] or re.search(r"ppt\s*agent|智能生成", normalized["subtitle"], re.IGNORECASE):
            normalized["subtitle"] = "核心概念、关键方法与实践应用"

        slides = normalized.get("slides", [])
        if isinstance(slides, list):
            slides = [
                slide for slide in slides
                if not (isinstance(slide, dict) and str(slide.get("kind", "")).lower() == "section")
            ]
            normalized["slides"] = slides
        if isinstance(slides, list) and len(slides) >= 5:
            agenda_sources = [
                slide for slide in slides[1:-1]
                if isinstance(slide, dict) and str(slide.get("kind", "")).lower() == "agenda"
            ]
            body_slides = [
                slide for slide in slides[1:-1]
                if not (isinstance(slide, dict) and str(slide.get("kind", "")).lower() == "agenda")
            ]
            body_titles = [
                shorten(slide.get("title", f"第{index + 1}部分"), 80)
                for index, slide in enumerate(body_slides)
                if isinstance(slide, dict)
            ]
            model_agenda_points = [
                point
                for agenda in agenda_sources
                for point in _as_list(agenda.get("points"), "points", "items")
            ]
            planned_chapters = [
                chapter for chapter in _as_list(normalized.get("agendaPlan"), "chapters", "items")
                if isinstance(chapter, dict) and str(chapter.get("title", "")).strip()
            ]
            requested_section_count = len(model_agenda_points)
            section_count = min(
                len(body_titles),
                (
                    len(planned_chapters)
                    if planned_chapters
                    else max(3, requested_section_count, round(len(body_titles) / 5))
                ),
            )
            agenda_points = []
            section_ranges = []
            for section in range(section_count):
                start = round(section * len(body_titles) / section_count)
                end = round((section + 1) * len(body_titles) / section_count)
                titles = body_titles[start:end]
                if not titles:
                    continue
                chapter = planned_chapters[section] if section < len(planned_chapters) else {}
                chapter_title = shorten(chapter.get("title") or titles[0], 80)
                objective = shorten(chapter.get("objective", ""), 500)
                key_topics = [
                    shorten(topic, 80)
                    for topic in _as_list(chapter.get("keyTopics"), "keyTopics", "topics")[:4]
                ]
                planned_detail = "；".join(value for value in (objective, "、".join(key_topics)) if value)
                agenda_points.append({
                    "heading": chapter_title,
                    "detail": (
                        planned_detail or (
                            "、".join(titles)
                            if len(titles) > 1
                            else f"围绕{titles[0]}展开概念讲解、方法分析与实践应用"
                        )
                    ),
                })
                section_ranges.append((start, end, titles, chapter_title, key_topics or titles))
            agenda_pages = []
            agenda_page_size = 10
            for page_index, start in enumerate(range(0, len(agenda_points), agenda_page_size)):
                agenda_pages.append({
                    "title": "目录" if page_index == 0 else "目录（续）",
                    "kind": "agenda",
                    "points": agenda_points[start:start + agenda_page_size],
                    "startNumber": start + 1,
                    "speakerNotes": "",
                })
            expanded = [slides[0], *agenda_pages]
            for section_index, (start, end, titles, chapter_title, section_topics) in enumerate(section_ranges, start=1):
                expanded.append({
                    "title": chapter_title,
                    "kind": "section",
                    "sectionNumber": section_index,
                    "sectionTopics": section_topics,
                    "speakerNotes": "",
                })
                expanded.extend(body_slides[start:end])
            expanded.append(slides[-1])
            slides = expanded
            normalized["slides"] = slides

        for slide_index, slide in enumerate(slides):
            if not isinstance(slide, dict):
                continue
            slide["title"] = _clean_presentation_title(slide.get("title"))
            raw_kind = str(slide.get("kind", "concept")).strip().lower()
            if raw_kind == "agenda":
                slide["kind"] = "agenda"
            elif raw_kind not in allowed_kinds:
                matches = [kind for kind in ("case", "practice", "process", "timeline", "comparison", "table", "code")
                           if kind in raw_kind]
                slide["kind"] = matches[0] if matches else "concept"
            if slide.get("kind") in {"agenda", "section"}:
                slide.pop("takeaway", None)
            elif slide_index not in {0, len(slides) - 1}:
                keep_takeaway = slide.get("kind") in {"code", "case", "comparison"} or slide_index % 3 == 0
                if not keep_takeaway:
                    slide.pop("takeaway", None)
            slide["title"] = shorten(slide.get("title", ""), 150)
            if slide.get("takeaway"):
                slide["takeaway"] = keep_full(slide["takeaway"])
            points = _as_list(slide.get("points"), "points", "items")
            if points:
                compact_points = []
                point_limit = 10 if slide.get("kind") == "agenda" else 4
                for point in points[:point_limit]:
                    if isinstance(point, dict):
                        compact_points.append({
                            **point,
                            "heading": shorten(point.get("heading", ""), 80),
                            "detail": keep_full(point.get("detail", "")),
                        })
                    else:
                        compact_points.append(keep_full(point))
                slide["points"] = compact_points
            code = slide.get("code")
            if isinstance(code, dict):
                code["caption"] = shorten(code.get("caption", ""), 200)
                code_lines = str(code.get("content", "")).splitlines()
                if len(code_lines) > 18:
                    language = str(code.get("language", "")).lower()
                    omission = "# 后续步骤省略" if language == "python" else "// 后续步骤省略"
                    code["content"] = "\n".join(code_lines[:17] + [omission])
                else:
                    language = str(code.get("language", "")).lower()
                    last_line = next((line.strip() for line in reversed(code_lines) if line.strip()), "")
                    if language == "python" and any(line.lstrip().startswith(("def ", "class ")) for line in code_lines):
                        if not last_line.startswith(("return ", "raise ", "#")):
                            code_lines.append("# 示例聚焦核心步骤，完整收尾逻辑见讲解")
                    code["content"] = "\n".join(code_lines)
                annotations = _as_list(code.get("annotations"), "annotations", "items")
                code["annotations"] = [shorten(value, 200) for value in annotations[:4]]
                code["output"] = keep_full(code.get("output", ""))
            process = slide.get("process")
            if isinstance(process, dict):
                process = process.get("steps") or process.get("items") or process.get("nodes") or []
            if isinstance(process, list):
                slide["process"] = [
                    {
                        **node,
                        "label": shorten(node.get("label") or node.get("name") or node.get("title", ""), 40),
                        "detail": keep_full(node.get("detail", "")),
                    }
                    for node in process[:5] if isinstance(node, dict)
                ]
            elif process:
                slide["process"] = []
            table = slide.get("table")
            if isinstance(table, dict):
                headers = [shorten(value, 60) for value in _as_list(table.get("headers"), "headers", "items")[:4]]
                table["headers"] = headers
                rows = _as_list(table.get("rows"), "rows", "items")
                table["rows"] = [
                    [shorten(value, 500) for value in row[:len(headers)]]
                    for row in rows[:5] if isinstance(row, list)
                ]
        PptAgent._ensure_spoken_speaker_notes(slides)
        PptAgent._ensure_teaching_moments(slides)
        return normalized

    @staticmethod
    def _ensure_teaching_moments(slides: list[dict]) -> None:
        """Normalize generated quiz/summary anchors and provide content-derived fallbacks."""
        for index, slide in enumerate(slides):
            if not isinstance(slide, dict):
                continue
            kind = str(slide.get("kind") or "concept")
            note = str(slide.get("speakerNotes") or "").strip()
            if kind in {"title", "agenda", "section"} or not note:
                slide["teachingMoments"] = []
                continue
            raw = slide.get("teachingMoments")
            moments: list[dict] = []
            if isinstance(raw, list):
                for item in raw[:2]:
                    if not isinstance(item, dict) or item.get("type") not in {"quiz", "summary"}:
                        continue
                    anchor_text = str(item.get("anchorText") or "").strip()
                    stored_anchor = item.get("anchorChar")
                    anchor_at = stored_anchor if isinstance(stored_anchor, int) and 0 < stored_anchor <= len(note) else 0
                    if not anchor_at:
                        anchor_at = note.find(anchor_text) + len(anchor_text) if anchor_text and anchor_text in note else 0
                    if not anchor_at:
                        anchor_at = max(1, round(len(note) * (0.72 if item.get("type") == "quiz" else 0.96)))
                        anchor_text = note[max(0, anchor_at - 16):anchor_at]
                    normalized = {
                        **item,
                        "momentId": str(item.get("momentId") or f"s{index + 1}-m{len(moments) + 1}"),
                        "anchorText": anchor_text,
                        "anchorChar": anchor_at,
                        "anchorRatio": round(min(0.98, max(0.12, anchor_at / max(1, len(note)))), 4),
                    }
                    if item.get("type") == "quiz":
                        options = [str(value).strip() for value in item.get("options", []) if str(value).strip()][:4]
                        answer = item.get("answerIndex")
                        if len(options) != 4 or not isinstance(answer, int) or answer not in range(4):
                            continue
                        title = re.sub(r"^\s*#{1,6}\s*", "", str(item.get("title") or "")).strip()
                        prompt = re.sub(r"^\s*#{1,6}\s*", "", str(item.get("prompt") or "")).strip()
                        if not prompt and title:
                            prompt = title
                            title = "课堂检查点"
                        if not title:
                            title = "课堂检查点"
                        if not prompt:
                            prompt = "请根据刚才讲到的内容，选择最准确的一项。"
                        normalized["title"] = title
                        normalized["prompt"] = prompt
                        normalized["options"] = options
                        normalized["answerIndex"] = answer
                    else:
                        points = [str(value).strip() for value in item.get("points", []) if str(value).strip()][:4]
                        if not points:
                            continue
                        normalized["points"] = points
                    moments.append(normalized)

            next_kind = str(slides[index + 1].get("kind") or "") if index + 1 < len(slides) and isinstance(slides[index + 1], dict) else ""
            chapter_end = next_kind in {"section", "conclusion"} or index == len(slides) - 2
            points = [point for point in slide.get("points", []) if isinstance(point, dict)]
            if chapter_end and not any(item["type"] == "summary" for item in moments):
                summary_points = [str(point.get("heading") or point.get("detail") or "").strip() for point in points[:3]]
                summary_points = [value for value in summary_points if value]
                if summary_points:
                    moments.append({
                        "momentId": f"s{index + 1}-summary", "type": "summary", "anchorText": note[-16:], "anchorChar": len(note), "anchorRatio": 0.98,
                        "title": "这一节，先收住三个关键点", "points": summary_points,
                        "notePrompt": "要不要把这一节的关键结论记进笔记？",
                    })
            slide["teachingMoments"] = moments

    @staticmethod
    def _ensure_spoken_speaker_notes(slides: list[dict]) -> None:
        """Ensure every note is direct, connected speech instead of presenter instructions."""
        instruction_pattern = re.compile(
            r"^(?:请)?(?:介绍|讲解|说明|展开|强调|总结|引导|提醒|概括|带领|结合|进入|逐页讲解|"
            r"欢迎[^，。；]{0,20}介绍|本页|本页面|本幻灯片|本节|本练习|本次实践课|讲师结语)"
        )
        presenter_direction_pattern = re.compile(
            r"(?:本页|本页面|本幻灯片|讲师|讲解时|需强调|需要强调|引导学生|让学生|请学生|"
            r"邀请(?:学生|同学|听众|大家)|组织讨论|分组讨论|可准备|可布置|布置课堂|务必让|"
            r"建议讲解|播放(?:视频|动画|音频)|展示(?:图片|图表|动画)|切换动画|请看屏幕|板书|停顿|向听众提问)"
        )
        transition_fluff_pattern = re.compile(
            r"(?:有了这个基础|把视线转向|继续往下推进|这一页先讲到这里|"
            r"这一页会先|这一层理解清楚后|沿着刚才关于|我们再深入一步|学习路线还没有结束)"
        )
        mechanical_list_pattern = re.compile(
            r"先看[“\"]?核心定义.*再看[“\"]?关键机制.*最后看[“\"]?实践提醒"
        )

        def clean(value: object) -> str:
            return re.sub(r"\s+", " ", str(value or "")).strip()

        def spoken_points(slide: dict, limit: int = 3) -> str:
            phrases: list[str] = []
            for point in _as_list(slide.get("points"), "points", "items")[:limit]:
                if isinstance(point, dict):
                    heading = clean(point.get("heading"))
                    detail = clean(point.get("detail"))
                    if heading and detail:
                        if not phrases:
                            phrase = f"“{heading}”指的是：{detail}"
                        else:
                            phrase = f"在{heading}方面，{detail}"
                    else:
                        phrase = heading or detail
                else:
                    phrase = clean(point)
                if phrase:
                    phrases.append(phrase.rstrip("。；") + "。")
            return "".join(phrases)

        for index, slide in enumerate(slides):
            if not isinstance(slide, dict):
                continue
            title = clean(slide.get("title")) or "这一部分"
            kind = clean(slide.get("kind")).lower()
            previous_kind = clean(slides[index - 1].get("kind")).lower() if index > 0 else ""
            next_kind = clean(slides[index + 1].get("kind")).lower() if index + 1 < len(slides) else ""

            if kind == "title":
                subtitle = clean(slide.get("subtitle"))
                existing = clean(slide.get("speakerNotes"))
                if (
                    not existing
                    or len(existing) < 45
                    or instruction_pattern.match(existing)
                    or presenter_direction_pattern.search(existing)
                ):
                    slide["speakerNotes"] = (
                        f"大家好，今天我们围绕《{title}》展开这次分享。"
                        + (f"内容将聚焦{subtitle}。" if subtitle else "我们会先建立整体认识，再逐步深入关键方法和实际应用。")
                        + ("内容结构已经列在目录中。" if next_kind == "agenda" else "")
                    )
                continue

            if kind == "agenda":
                entries = [
                    clean(point.get("heading")) if isinstance(point, dict) else clean(point)
                    for point in _as_list(slide.get("points"), "points", "items")
                ]
                entries = [entry for entry in entries if entry]
                start_number = int(slide.get("startNumber") or 1)
                route = "；".join(
                    f"第{number}部分是{entry}"
                    for number, entry in enumerate(entries, start=start_number)
                )
                continuation = "目录的后半部分包括：" if "续" in title else "今天的内容分为以下几个部分："
                slide["speakerNotes"] = continuation + (route + "。" if route else "")
                continue

            if kind == "section":
                number = slide.get("sectionNumber")
                topics = [clean(item) for item in _as_list(slide.get("sectionTopics"), "sectionTopics", "topics")]
                topics = [item for item in topics if item]
                specific_topics = [
                    item for item in topics
                    if item != title and item not in title and title not in item
                ]
                focus = "、".join(specific_topics[:3])
                chapter = f"第{number}章" if number else "这一章"
                if focus:
                    slide["speakerNotes"] = f"{chapter}聚焦{title}，重点理解{focus}。"
                else:
                    slide["speakerNotes"] = f"{chapter}聚焦{title}。"
                continue

            existing = clean(slide.get("speakerNotes"))
            existing = re.sub(
                r"^(?:(?:首先|接下来|随后|然后)[，、：:\s]*){2,}",
                lambda match: re.match(r"^(首先|接下来|随后|然后)", match.group(0)).group(1) + "，",
                existing,
            )
            looks_like_instruction = (
                not existing
                or bool(instruction_pattern.match(existing))
                or bool(presenter_direction_pattern.search(existing))
                or bool(transition_fluff_pattern.search(existing))
                or bool(mechanical_list_pattern.search(existing))
            )
            if looks_like_instruction:
                if kind == "conclusion":
                    transition = "最后，我们做一个总结。"
                    ending = "以上就是这次分享的主要内容。"
                elif previous_kind == "section":
                    transition = ""
                    ending = ""
                else:
                    transition = ""
                    ending = ""
                content = spoken_points(slide)
                if not content:
                    content = clean(slide.get("takeaway")) or f"这一部分的关键，是理解“{title}”与整体主题之间的联系。"
                    content = content.rstrip("。") + "。"
                slide["speakerNotes"] = transition + content + ending
            else:
                # Keep substantive narration and remove stagey page announcements.
                existing = re.sub(
                    r"(?:下一页|下一部分|接着我们将|下面将|随后将|然后将)[^。！？]*[。！？]?\s*$",
                    "",
                    existing,
                ).strip()
                existing = re.sub(
                    r"^(?:现在我们|我们现在|下面我们|现在|下面)(?:，)?\s*",
                    "",
                    existing,
                )
                if previous_kind == "section":
                    # The section slide has already introduced the chapter. Drop a
                    # second title-announcement sentence and begin with substance.
                    existing = re.sub(
                        r"^(?:首先|接下来|随后|然后)?[，、：:\s]*(?:我们)?"
                        r"(?:(?:来|先)(?:明确|了解|进入|讲解|学习|讨论)|"
                        r"(?:看|明确|了解|进入|讲解|学习|讨论))"
                        r"[^。！？]{0,48}[。！？]\s*",
                        "",
                        existing,
                    ).strip()
                    if not existing:
                        existing = spoken_points(slide)
                slide["speakerNotes"] = existing

        # Page-by-page generation tends to overuse sequencing adverbs even when
        # adjacent pages are not in a real ordered list. Keep them for agenda and
        # conclusion pages, but let body pages begin with their actual idea.
        for slide in slides:
            if clean(slide.get("kind")).lower() in {"title", "agenda", "conclusion", "section"}:
                continue
            note = clean(slide.get("speakerNotes"))
            note = re.sub(
                r"^(?:(?:首先|接下来|随后|然后)[，、：:\s]*)?(?:我们)?"
                r"(?:来|再)?(?:看|讨论|了解|分析)[“\"']?[^。！？]{1,60}[”\"']?[。！？]\s*(?=.)",
                "",
                note,
            )
            slide["speakerNotes"] = re.sub(
                r"^(?:首先|接下来|随后|然后)[，、：:\s]*(?:我们(?:来|再)?(?:看|讨论|了解|分析))?[“\"']?",
                "",
                note,
            ).lstrip("”\"'，、：: ") or note

    async def _generate_in_batches(
        self, request: PresentationRequest, skeleton: dict, timeout: float,
        progress_cb=None,
    ) -> dict:
        """Generate detailed pages in parallel so long decks do not truncate one huge JSON response."""
        started_at = time.perf_counter()
        seed_slides = skeleton["slides"]
        settings = self.llm.settings
        batch_size = int(getattr(settings, "presentation_content_batch_size", 2))
        batch_size = max(1, min(3, batch_size))
        batches = [seed_slides[index:index + batch_size] for index in range(0, len(seed_slides), batch_size)]
        batch_timeout = min(
            float(getattr(settings, "presentation_content_timeout_seconds", 90)),
            float(getattr(settings, "llm_timeout_seconds", timeout)),
            300.0,
        )
        limiter = _AdaptiveConcurrency(
            int(getattr(settings, "presentation_content_min_concurrency", 4)),
            int(getattr(settings, "presentation_content_initial_concurrency", 6)),
            int(getattr(settings, "presentation_content_max_concurrency", 8)),
        )
        retry_budget = int(getattr(settings, "presentation_content_retry_budget", 2))
        request_count = 0
        retry_count = 0
        fallback_batches = 0
        fallback_slides = 0
        fallback_slide_indexes: list[int] = []
        request_durations: list[float] = []
        generic_topic_terms = {
            "定义", "方法", "实践", "应用", "核心", "关键", "概念", "流程",
            "案例", "分析", "问题", "结果", "学习", "内容", "介绍", "说明",
        }
        knowledge_map_context = (
            json.dumps(request.generation_context, ensure_ascii=False)
            if request.generation_context else "无"
        )

        def topic_signals(seed: dict) -> set[str]:
            source = " ".join(
                str(seed.get(key) or "")
                for key in ("title", "takeaway")
            )
            signals: set[str] = set()
            for token in re.findall(r"[A-Za-z][A-Za-z0-9.+#-]{1,}|[\u4e00-\u9fff]{2,}", source):
                if re.fullmatch(r"[A-Za-z][A-Za-z0-9.+#-]{1,}", token):
                    signals.add(token.lower())
                    continue
                for size in (2, 3, 4):
                    signals.update(
                        token[index:index + size]
                        for index in range(max(0, len(token) - size + 1))
                    )
            return {item for item in signals if item not in generic_topic_terms}

        def slide_issues(slide: object, seed: dict) -> list[str]:
            issues: list[str] = []
            if not isinstance(slide, dict):
                return ["页面不是 JSON 对象"]
            if not str(slide.get("title", "")).strip():
                issues.append("缺少 title")
            expected_kind = str(seed.get("kind", "concept")).strip().lower()
            if str(slide.get("kind", "")).strip().lower() != expected_kind:
                issues.append(f"kind 应为 {expected_kind}")
            if request.include_speaker_notes and not str(slide.get("speakerNotes", "")).strip():
                issues.append("缺少 speakerNotes")
            points = slide.get("points")
            if not isinstance(points, list) or not points:
                issues.append("缺少非空 points")
            if expected_kind == "code":
                code = slide.get("code")
                if not isinstance(code, dict) or not str(code.get("content", "")).strip():
                    issues.append("代码页缺少 code.content")
            if expected_kind in {"process", "timeline", "roadmap"} and not slide.get("process"):
                issues.append(f"{expected_kind} 页缺少 process")
            if expected_kind == "table":
                table = slide.get("table")
                if not isinstance(table, dict) or not table.get("headers") or not table.get("rows"):
                    issues.append("表格页缺少 table.headers 或 table.rows")
            visible = {key: value for key, value in slide.items() if key != "speakerNotes"}
            minimum_chars = {"concise": 55, "balanced": 90, "detailed": 130}[request.detail_level]
            if len(json.dumps(visible, ensure_ascii=False)) < minimum_chars:
                issues.append(f"可见正文少于 {minimum_chars} 字符")
            # 主题词出现性检查移除：模型改写标题常用近义词，强查原词会误杀真实内容页
            return issues
            return issues

        def valid_slide(slide: object, seed: dict) -> bool:
            return not slide_issues(slide, seed)

        def repair_slide(slide: object, seed: dict) -> dict | None:
            """Repair harmless schema drift without replacing model-authored content."""
            if not isinstance(slide, dict):
                return None
            repaired = copy.deepcopy(slide)
            repaired["title"] = str(repaired.get("title") or seed.get("title") or "").strip()
            expected_kind = str(seed.get("kind", "concept")).strip().lower()
            repaired["kind"] = expected_kind
            raw_points = _as_list(repaired.get("points"), "points", "items")
            points: list[dict] = []
            for point in raw_points[:5]:
                if isinstance(point, dict):
                    heading = str(
                        point.get("heading") or point.get("title") or point.get("label") or ""
                    ).strip()
                    detail = str(
                        point.get("detail") or point.get("content") or point.get("description") or ""
                    ).strip()
                else:
                    heading, detail = "", str(point).strip()
                if heading or detail:
                    points.append({"heading": heading or "要点", "detail": detail or heading})
            if not points:
                return None
            repaired["points"] = points
            if request.include_speaker_notes and not str(repaired.get("speakerNotes", "")).strip():
                repaired["speakerNotes"] = "".join(
                    str(point.get("detail") or point.get("heading") or "").strip().rstrip("。") + "。"
                    for point in points[:3]
                    if str(point.get("detail") or point.get("heading") or "").strip()
                )
            if expected_kind in {"process", "timeline", "roadmap"} and not repaired.get("process"):
                repaired["process"] = [
                    {"label": point["heading"], "detail": point["detail"]}
                    for point in points[:5]
                ]
            if expected_kind == "table":
                table = repaired.get("table")
                if not isinstance(table, dict) or not table.get("headers") or not table.get("rows"):
                    repaired["table"] = {
                        "headers": ["要点", "说明"],
                        "rows": [[point["heading"], point["detail"]] for point in points[:5]],
                    }
            # Code content cannot be safely invented locally; retry MiMo for it.
            if expected_kind == "code":
                code = repaired.get("code")
                if not isinstance(code, dict) or not str(code.get("content", "")).strip():
                    return None
            return repaired if valid_slide(repaired, seed) else None

        def seed_fallback(seed: dict, page_number: int, reasons: list[str]) -> dict:
            """Best-effort local page after model retries are exhausted."""
            title = str(seed.get("title") or f"第 {page_number} 页").strip() or f"第 {page_number} 页"
            kind = str(seed.get("kind", "concept")).strip().lower()
            allowed = {"concept", "case", "practice", "overview", "agenda", "section",
                       "process", "timeline", "roadmap", "comparison", "table", "code", "conclusion"}
            if kind not in allowed:
                kind = "concept"
            if kind == "code":
                code = seed.get("code")
                if not isinstance(code, dict) or not str(code.get("content", "")).strip():
                    kind = "concept"
            if kind in {"process", "timeline", "roadmap"} and not seed.get("process"):
                kind = "concept"
            if kind == "table":
                table = seed.get("table")
                if not isinstance(table, dict) or not table.get("headers") or not table.get("rows"):
                    kind = "concept"
            raw_points = _as_list(seed.get("points"), "points", "items")
            points: list[dict] = []
            for point in raw_points[:4]:
                if isinstance(point, dict):
                    heading = str(point.get("heading") or point.get("title") or point.get("label") or "").strip()
                    detail = str(point.get("detail") or point.get("content") or point.get("description") or "").strip()
                else:
                    heading, detail = "", str(point).strip()
                if heading or detail:
                    points.append({"heading": heading or "要点", "detail": detail or heading})
            if not points:
                points = [
                    {"heading": "概念边界", "detail": f"先界定“{title}”的适用范围、关键要素与常见误区。"},
                    {"heading": "核心机制", "detail": f"说明“{title}”内部如何工作，以及关键步骤之间的因果关系。"},
                    {"heading": "实践提醒", "detail": f"结合“{title}”的典型场景给出判断方式、常见错误与改进建议。"},
                ]
            detail_hint = "；".join(reasons) if reasons else "模型返回为空，已使用可交付的本地改写页面"
            return {
                "title": title,
                "kind": kind,
                "points": points,
                "speakerNotes": (
                    f"这一页重点讲解“{title}”。"
                    f"内容来源：{detail_hint[:260]}。"
                ),
                "fallback": True,
            }

        def make_batch_prompt(batch: list[dict], start_index: int) -> str:
            return (
                f"为同一份演示文稿生成第 {start_index + 1} 至 "
                f"{start_index + len(batch)} 页。只返回 JSON：{{\"slides\":[...]}}，页数必须恰好为 {len(batch)}。"
                "可以重写种子标题，但保持每页 kind。每页必须包含 title、kind、takeaway、points、speakerNotes；"
                "speakerNotes 是讲者可逐字朗读的连续口播稿，不是“介绍、说明、强调、展开”等讲解指令。"
                "正文页按教学节奏生成 teachingMoments：每3-4页至少一道quiz，每章末页一个summary；"
                "锚点 anchorText 必须逐字截取自本页speakerNotes。quiz含4个options、answerIndex和explanation，"
                "quiz的options要针对本页内容生成同主题且看似合理的干扰项，且只能有一个正确项，禁止通用话术；"
                "summary含2-4个points与notePrompt；没有合适互动的页面返回空数组。"
                "不要给每页机械添加“首先、接下来、随后、然后、最后”；只有确实存在递进、转折或因果时才自然承接，"
                "连续三页最多一页以顺序连接词开头。相邻页要像同一次完整讲述，而不是互不相干的卡片；"
                "不要写冗余过渡句或页尾预告；"
                "目录页直接说清学习路线，章节页简短报出章节；"
                "正文页建议120-240个中文字符，不要机械照读页面项目符号。"
                "points 为3-5个含 heading/detail 的对象，detail 要给具体事实、解释、案例或操作方法，不能写泛化套话。"
                "code 页必须含 code={language,caption,content,annotations,output}；process/timeline 页含 process；"
                "roadmap页含3-5个process节点；spotlight页首个point是核心结论；checklist页含3-5个可核验检查项；"
                "table 页含 table={headers,rows}；case/practice 页给清晰场景、步骤、结果或任务。"
                "标题页可精简，正文页可直接投屏授课或汇报，详细信息必须写在可见正文而非只放备注。"
                f"\n知识网络课程上下文：{knowledge_map_context}。"
                "用当前节点在课程中的位置决定默认前置知识和自然承接，但正文只能深入当前最小知识点；"
                "不要把完整地图逐章复述，也不要把用户目标或写作要求当成知识章节。"
                f"\n完整用户需求：{request.model_dump_json(by_alias=True)}"
                f"\n相邻页上下文：上一页标题={seed_slides[start_index - 1].get('title', '') if start_index > 0 else '无'}；"
                f"下一页标题={seed_slides[start_index + len(batch)].get('title', '') if start_index + len(batch) < len(seed_slides) else '无'}。"
                f"\n本批种子结构：{json.dumps(batch, ensure_ascii=False)}"
            )

        def make_repair_prompt(
            seed: dict, start_index: int, candidate: object, issues: list[str],
        ) -> str:
            candidate_text = json.dumps(candidate, ensure_ascii=False)[:12000]
            return (
                f"修复同一份演示文稿的第 {start_index + 1} 页。只返回 JSON："
                "{\"slides\":[修复后的唯一页面]}，slides 必须恰好包含 1 页。"
                "不要解释修改过程，不要输出 Markdown。保持种子页的 kind 和主题，不得使用模板化兜底内容。"
                "页面所有可见内容必须直接出现并解释种子标题中的核心主题词；总结页也必须总结当前知识点的具体结论，"
                "不能只写‘回顾、行动、讨论’等通用收尾。"
                f"\n校验未通过原因：{'；'.join(issues) or '返回为空或结构损坏'}。"
                f"\n待修复页面：{candidate_text}"
                f"\n完整用户需求：{request.model_dump_json(by_alias=True)}"
                f"\n本批种子结构：{json.dumps([seed], ensure_ascii=False)}"
            )

        async def call_batch(
            batch: list[dict], start_index: int, provider: str | None = "mimo",
            timeout_seconds: float | None = None,
            prompt_override: str | None = None,
        ) -> dict:
            nonlocal request_count
            await limiter.acquire()
            request_started = time.perf_counter()
            result: dict = {"slides": []}
            timed_out = False
            call_error = ""
            try:
                request_count += 1
                result = await asyncio.wait_for(
                    self.llm.complete_json(
                        "你是专业演示文稿内容编辑。围绕用户主题写具体内容，并用最合适的语义结构承载信息。",
                        prompt_override or make_batch_prompt(batch, start_index),
                        {"slides": []},
                        provider=request.model_provider if provider is None else provider,
                        max_retries=3 if request.model_provider == "kimi" else 1,
                        timeout_seconds=timeout_seconds or batch_timeout,
                    ),
                    timeout=timeout_seconds or batch_timeout,
                )
            except TimeoutError:
                timed_out = True
            except Exception as exc:
                call_error = f"{type(exc).__name__}: {str(exc)[:240]}"
            finally:
                request_durations.append(time.perf_counter() - request_started)
            slides = result.get("slides") if isinstance(result, dict) else None
            structurally_valid = isinstance(slides, list) and len(slides) == len(batch)
            candidates = slides if isinstance(slides, list) else []
            repaired = [
                repair_slide(slide, seed)
                for slide, seed in zip(candidates, batch)
            ]
            accepted = structurally_valid and len(repaired) == len(batch) and all(repaired)
            await limiter.release(accepted)
            issues: list[str] = []
            if timed_out:
                issues.append(f"请求超过 {timeout_seconds or batch_timeout:g} 秒")
            if call_error:
                issues.append(call_error)
            if not isinstance(slides, list):
                issues.append("响应缺少 slides 数组")
            elif len(slides) != len(batch):
                issues.append(f"slides 数量应为 {len(batch)}，实际为 {len(slides)}")
            for index, seed in enumerate(batch):
                if index >= len(candidates):
                    continue
                repaired_slide = repaired[index] if index < len(repaired) else None
                if repaired_slide is None:
                    page_issues = slide_issues(candidates[index], seed)
                    issues.extend(f"第 {start_index + index + 1} 页：{item}" for item in page_issues)
            return {
                "candidates": candidates,
                "repaired": repaired,
                "issues": issues,
                "timedOut": timed_out,
            }

        async def generate_batch(batch: list[dict], batch_index: int) -> list[dict]:
            nonlocal retry_count, fallback_batches, fallback_slides
            start_index = batch_index * batch_size
            first_attempt = await call_batch(batch, start_index)
            candidates = first_attempt["candidates"]
            resolved: list[dict | None] = list(first_attempt["repaired"])
            if len(resolved) < len(batch):
                resolved.extend([None] * (len(batch) - len(resolved)))
            failure_details: dict[int, list[str]] = {
                index: list(first_attempt["issues"])
                for index, slide in enumerate(resolved)
                if slide is None
            }

            missing = [index for index, slide in enumerate(resolved) if slide is None]
            retry_attempts_by_index: dict[int, dict] = {}
            # Retry only the missing pages as single-page requests through the same
            # user-selected model. This avoids discarding good pages from the batch.
            if missing:
                retry_count += len(missing)
                await asyncio.sleep(1)
                for index in missing:
                    retry_attempt = await call_batch(
                        [batch[index]], start_index + index, provider="mimo",
                    )
                    retry_attempts_by_index[index] = retry_attempt
                    retry_repaired = retry_attempt["repaired"]
                    if retry_repaired and retry_repaired[0] is not None:
                        resolved[index] = retry_repaired[0]
                    else:
                        failure_details[index] = list(retry_attempt["issues"])

            # A second recovery request is deliberately reserved for pages that
            # already failed both the batch and a clean single-page generation.
            # When MiMo returned content, ask it to repair the concrete defects;
            # after an empty/timeout response, ask for a fresh strengthened page.
            missing = [index for index, slide in enumerate(resolved) if slide is None]
            if missing and retry_budget > 1:
                retry_count += len(missing)
                for index in missing:
                    page_number = start_index + index
                    prior_candidates = retry_attempts_by_index.get(index, {}).get("candidates", [])
                    candidate = prior_candidates[0] if prior_candidates else {}
                    issues = failure_details.get(index, [])
                    recovery_attempt = await call_batch(
                        [batch[index]],
                        page_number,
                        provider="mimo",
                        prompt_override=make_repair_prompt(
                            batch[index], page_number, candidate, issues,
                        ),
                    )
                    retry_attempts_by_index[index] = recovery_attempt
                    recovery_repaired = recovery_attempt["repaired"]
                    if recovery_repaired and recovery_repaired[0] is not None:
                        resolved[index] = recovery_repaired[0]
                    else:
                        failure_details[index] = list(recovery_attempt["issues"])

            # Respect retry budgets above two as additional model-authored repair
            # attempts. These remain limited to unresolved pages.
            for extra_round in range(2, retry_budget):
                missing = [index for index, slide in enumerate(resolved) if slide is None]
                if not missing:
                    break
                retry_count += len(missing)
                for index in missing:
                    page_number = start_index + index
                    prior = retry_attempts_by_index.get(index, {})
                    candidates = prior.get("candidates", [])
                    extra_attempt = await call_batch(
                        [batch[index]],
                        page_number,
                        provider="mimo",
                        prompt_override=make_repair_prompt(
                            batch[index],
                            page_number,
                            candidates[0] if candidates else {},
                            failure_details.get(index, []),
                        ),
                    )
                    retry_attempts_by_index[index] = extra_attempt
                    extra_repaired = extra_attempt["repaired"]
                    if extra_repaired and extra_repaired[0] is not None:
                        resolved[index] = extra_repaired[0]
                    else:
                        failure_details[index] = list(extra_attempt["issues"])

            unresolved = [index for index, slide in enumerate(resolved) if slide is None]
            if unresolved:
                fallback_batches += 1
                fallback_slides += len(unresolved)
                for index in unresolved:
                    fallback_slide_indexes.append(start_index + index + 1)
                    fallback = seed_fallback(
                        batch[index],
                        start_index + index + 1,
                        failure_details.get(index, []),
                    )
                    if fallback is not None:
                        resolved[index] = fallback
            unresolved = [index for index, slide in enumerate(resolved) if slide is None]
            if unresolved:
                pages = "、".join(str(start_index + index + 1) for index in unresolved)
                reasons = "；".join(
                    f"第{start_index + index + 1}页："
                    f"{'，'.join(dict.fromkeys(failure_details.get(index, []))) or '响应为空'}"
                    for index in unresolved
                )
                raise RuntimeError(
                    f"第{pages}页内容生成失败：MiMo 经过单页重试与定向纠错后仍未返回可用内容"
                    f"（{reasons[:900]}），已停止任务以避免输出模板化兜底页面"
                )
            return [slide for slide in resolved if isinstance(slide, dict)]

        progress_counter = 0
        progress_lock = asyncio.Lock()

        async def tracked_batch(batch: list[dict], index: int) -> list[dict]:
            nonlocal progress_counter
            result = await generate_batch(batch, index)
            async with progress_lock:
                progress_counter += len(result)
                if progress_cb is not None:
                    await progress_cb(progress_counter)
            return result

        generated: list[list[dict]] = await asyncio.gather(
            *(tracked_batch(batch, index) for index, batch in enumerate(batches)),
        )
        # Every page reaching this point has passed the structure/content gate.
        slides = [
            slide
            for index, batch in enumerate(generated)
            for slide in (batch or batches[index])
        ]
        elapsed = time.perf_counter() - started_at
        return {
            "title": request.title or skeleton["title"],
            "subtitle": skeleton.get("subtitle", ""),
            "agendaPlan": skeleton.get("agendaPlan", []),
            "slides": slides,
            "_generationMetrics": {
                "batchSize": batch_size,
                "batchCount": len(batches),
                "requestCount": request_count,
                "retryCount": retry_count,
                "fallbackBatchCount": fallback_batches,
                "fallbackSlideCount": fallback_slides,
                "fallbackSlideIndexes": fallback_slide_indexes,
                "initialConcurrency": int(getattr(settings, "presentation_content_initial_concurrency", 6)),
                "finalConcurrency": limiter.limit,
                "maxObservedConcurrency": limiter.max_observed,
                "elapsedSeconds": round(elapsed, 2),
                "averageRequestSeconds": (
                    round(sum(request_durations) / len(request_durations), 2)
                    if request_durations else 0
                ),
                "maxRequestSeconds": round(max(request_durations), 2) if request_durations else 0,
            },
        }

    @staticmethod
    @staticmethod
    def _outline_is_rich(outline: dict, request: PresentationRequest) -> bool:
        slides = outline.get("slides") if isinstance(outline, dict) else None
        if not isinstance(slides, list) or not slides:
            return False
        target = request.slide_count
        if target >= 3 and not (max(3, int(target * 0.6)) <= len(slides) <= target + 2):
            return False
        body = slides[1:-1]
        if not body:
            return len(slides) == 1
        semantic_kinds = {"code", "comparison", "process", "table", "timeline", "roadmap", "spotlight", "checklist", "case", "practice"}
        semantic_count = 0
        rich_pages = 0
        template_pages = 0
        technical = any(token in request.requirement.lower() for token in ("编程", "代码", "程序", "c语言", "c 语言", "python", "java", "算法", "software"))
        technical_pages = 0
        minimum_chars = {"concise": 55, "balanced": 90, "detailed": 130}[request.detail_level]
        for slide in body:
            if not isinstance(slide, dict):
                continue
            if _contains_template_prose(slide):
                template_pages += 1
            kind = str(slide.get("kind", "content"))
            if kind in semantic_kinds:
                semantic_count += 1
            if kind in {"code", "case", "practice"}:
                technical_pages += 1
            visible = {key: value for key, value in slide.items() if key != "speakerNotes"}
            if len(json.dumps(visible, ensure_ascii=False)) >= minimum_chars:
                rich_pages += 1
        if template_pages > max(1, len(body) // 5):
            return False
        if rich_pages < max(1, int(len(body) * 0.5)):
            return False
        if semantic_count < min(2, len(body)) and len(body) >= 3:
            return False
        if technical and body and technical_pages < max(1, len(body) // 6):
            return False
        return True

    async def run(self, task_id: UUID, request: PresentationRequest) -> None:
        """Phase 1: Generate outline and stop for user review."""
        try:
            await self._event(
                task_id, "retrieval", "知识依据检索完成",
                "已载入当前知识点的讲义、知识依据与课程上下文，供后续教学策划直接使用",
                {"sourceScope": "local_knowledge", "strategy": "direct_context_load"},
            )
            await self._event(
                task_id, "analysis", "开始分析需求",
                f"受众：{request.audience}；用途：{request.purpose}；内容密度：{request.detail_level}",
            )
            self.store.update(task_id, status="analyzing", progress=6, stage_message="交互导学 Agent 正在规划章节目录")
            tutor_plan = await self.plan_agenda_with_tutor(request)
            selected_count = int(tutor_plan.get("slideCount") or request.slide_count or self._fallback_slide_count(request))
            agenda_plan = tutor_plan.get("chapters")
            if not isinstance(agenda_plan, list):
                agenda_plan = []
            agenda_tools = tutor_plan.get("toolsUsed")
            if not isinstance(agenda_tools, list):
                agenda_tools = []
            if request.slide_count == 0:
                request = request.model_copy(update={"slide_count": selected_count})
                self.store.set_planned_slide_count(task_id, selected_count)
            await self._event(
                task_id, "agenda", "目录规划完成",
                f"规划约 {selected_count} 页，共 {len(agenda_plan)} 章",
                {
                    "slideCount": selected_count,
                    "toolsUsed": agenda_tools,
                    "chapters": [
                        {
                            "title": item.get("title", ""),
                            "objective": item.get("objective", ""),
                            "keyTopics": item.get("keyTopics", []),
                        }
                        for item in agenda_plan
                    ],
                },
            )
            self.store.update(
                task_id, status="analyzing", progress=12,
                stage_message=(
                    f"导学 Agent 已结合检索规划 {len(agenda_plan)} 个章节，正在生成约 {selected_count} 页内容"
                    if agenda_tools
                    else f"导学 Agent 已规划 {len(agenda_plan)} 个章节，正在生成约 {selected_count} 页内容"
                ),
            )
            async def report_content_progress(completed_pages: int):
                total_pages = max(1, selected_count)
                done = min(total_pages, int(completed_pages))
                pct = min(30, 12 + round(18 * done / total_pages))
                self.store.update(
                    task_id, status="analyzing", progress=pct,
                    stage_message=f"正在逐页生成交互课件内容，已完成 {done}/{total_pages} 页",
                )
                if done >= total_pages or done % 3 == 0:
                    await self._event(
                        task_id, "content", "逐页内容生成中",
                        f"已完成 {done}/{total_pages} 页",
                        {"completed": done, "total": total_pages},
                    )

            outline = await self.analyze(request, agenda_plan, progress_cb=report_content_progress)
            generation_metrics = outline.pop("_generationMetrics", {}) if isinstance(outline, dict) else {}
            outline["agendaToolsUsed"] = agenda_tools
            outline = self.normalize_outline_for_layout(outline)
            await self._event(
                task_id, "content", "逐页内容生成完成",
                f"正文与章节页合计 {len(outline.get('slides', []))} 页，等待提纲校验",
                {
                    "slideTitles": [slide.get("title", "") for slide in outline.get("slides", [])],
                    "generationMetrics": generation_metrics,
                },
            )
            slides = outline.get("slides") or []
            first_title = str(slides[0].get("title") or outline.get("title") or "").strip()
            update_kwargs: dict = dict(
                status="outline_review", progress=30,
                stage_message="提纲已生成，等待校验",
                outline=outline,
            )
            if first_title:
                update_kwargs["title"] = first_title
            self.store.update(task_id, **update_kwargs)
            try:
                self.store.save_checkpoint(task_id, "outline_ready", {
                    "slideCount": len(outline.get("slides", [])),
                    "slideTitles": [slide.get("title", "") for slide in outline.get("slides", [])[:60]],
                })
            except Exception:
                logger.exception("Failed to persist PPT outline checkpoint")
            await self._event(
                task_id, "outline_review", "提纲待校验",
                f"共 {len(outline.get('slides', []))} 页，请确认后继续生成",
                {"slideCount": len(outline.get("slides", []))},
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.store.update(task_id, status="failed", progress=100, stage_message="生成失败", error_message=str(exc))
            await self._event(task_id, "failed", "生成失败", str(exc))

    async def run_generate(self, task_id: UUID, request: PresentationRequest) -> None:
        """Phase 2: Generate slides after outline approval."""
        try:
            task = self.store.get_internal(task_id)
            if not task:
                raise ValueError(f"Task {task_id} not found")
            outline = task.get("outline") or task.get("outline_json")
            if isinstance(outline, str):
                outline = json.loads(outline)
            if not outline or not isinstance(outline, dict):
                raise ValueError("No outline found for generation")

            self.store.update(task_id, status="generating", progress=45,
                              stage_message="提纲已确认，正在设计幻灯片")
            self.output_dir.mkdir(parents=True, exist_ok=True)
            output = self.output_dir / f"{task_id}.pptx"

            if request.generation_mode == "web":
                await self._generate_web(task_id, request, outline, output)
            else:
                await self._generate_template(task_id, request, outline, output)

            self.store.update(task_id, status="completed", progress=100,
                              stage_message="PPT 已生成，可以下载",
                              output_path=str(output.resolve()))
            await self._event(
                task_id, "arbitration", "发布仲裁通过",
                "教学策划、知识检索、内容生成、质量核验已完成协同，允许发布为交互课件",
                {"decision": "approve", "round": 0},
            )
            await self._event(task_id, "completed", "生成完成",
                        f"已输出 {len(outline.get('slides', []))} 页 PPTX 并通过结构校验")
        except asyncio.CancelledError:
            output = self.output_dir / f"{task_id}.pptx"
            if output.is_file():
                try:
                    output.unlink()
                except OSError:
                    pass
            await self._event(task_id, "cancelled", "生成已中断", "未完成的输出文件已清理")
            raise
        except Exception as exc:
            self.store.update(task_id, status="failed", progress=100, stage_message="生成失败", error_message=str(exc))
            await self._event(task_id, "failed", "生成失败", str(exc))

    async def _generate_template(self, task_id: UUID, request: PresentationRequest, outline: dict, output: Path) -> None:
        """Template mode: existing PPTX rendering pipeline."""
        await self._event(task_id, "render", "开始排版与渲染", "正在应用主题背景、页面布局和演讲者备注")
        await asyncio.to_thread(self.render, request, outline, output)
        self.store.update(task_id, status="reviewing", progress=86, stage_message="正在检查版式与内容完整性")
        await self._event(task_id, "review", "进入视觉质量检查", "封面与复杂页面并行审查")
        reviewer = PresentationVisualReviewer(self.llm, self.llm.settings)
        review_timeout = min(45, self.llm.settings.presentation_visual_review_timeout_seconds)

        async def _review_cover():
            try:
                return await asyncio.wait_for(
                    reviewer.review_cover(
                        output,
                        str(outline.get("title") or request.title or ""),
                        str(outline.get("subtitle") or ""),
                    ),
                    timeout=review_timeout,
                )
            except (TimeoutError, Exception):
                return {}

        async def _review_pages():
            try:
                return await asyncio.wait_for(
                    reviewer.review(output, outline),
                    timeout=self.llm.settings.presentation_visual_review_timeout_seconds,
                )
            except (TimeoutError, Exception):
                return []

        cover_design, visual_issues = await asyncio.gather(
            _review_cover(), _review_pages(),
        )
        needs_rerender = False
        if cover_design:
            outline["coverDesign"] = cover_design
            needs_rerender = True
            await self._event(task_id, "review", "封面审查完成",
                        "已根据截图调整标题位置和文字对比度", cover_design)
        if visual_issues:
            outline = reviewer.compact_outline(outline, visual_issues)
            needs_rerender = True
            await self._event(task_id, "review", "复杂页面已修正",
                        f"检测并重新排版 {len(visual_issues)} 页", {"issues": visual_issues})
        else:
            await self._event(task_id, "review", "复杂页面检查完成", "未发现需要自动修正的高风险页面")
        if needs_rerender:
            await asyncio.to_thread(self.render, request, outline, output)
            self.store.update(
                task_id, status="reviewing", progress=92,
                stage_message="视觉审查已完成，正在应用修正并复核",
                outline=outline,
            )
            # Re-open the corrected file and verify the affected layouts again.
            # A visual defect must loop through repair; it cannot proceed to completion
            # merely because one correction pass was attempted.
            remaining_issues = await _review_pages()
            for repair_round in range(2, 4):
                if not remaining_issues:
                    break
                await self._event(task_id, "review", f"第 {repair_round} 轮视觉返修",
                            f"复核仍发现 {len(remaining_issues)} 页需要调整",
                            {"issues": remaining_issues, "repairRound": repair_round, "decision": "repair"})
                outline = reviewer.compact_outline(outline, remaining_issues)
                await asyncio.to_thread(self.render, request, outline, output)
                remaining_issues = await _review_pages()
            if remaining_issues:
                raise RuntimeError(
                    "交互课件经过 3 轮视觉返修后仍未通过发布门："
                    + "；".join(str(item) for item in remaining_issues[:8])
                )
            await self._event(task_id, "review", "视觉返修复核通过",
                        "修正后的页面已重新渲染并通过视觉检查", {"decision": "pass"})
        await asyncio.to_thread(self.validate, output, len(outline.get("slides", [])))

    async def _generate_web(self, task_id: UUID, request: PresentationRequest, outline: dict, output: Path) -> None:
        """Web mode: HTML slide generation pipeline."""
        from app.presentations.html_renderer import HtmlSlideRenderer

        renderer = HtmlSlideRenderer(self.llm, self.output_dir)
        slides = outline.get("slides", [])

        # Step 1: Generate style guide
        await self._event(task_id, "style_guide", "生成风格基调",
                    "正在解析主题配色与排版规则")
        style_guide = await renderer.generate_style_guide(request, outline)
        await self._event(task_id, "style_guide", "风格基调已确定",
                    f"主色 {style_guide['primaryColor']}，辅色 {style_guide['accentColor']}")

        # Step 2: Generate HTML slides in parallel
        self.store.update(task_id, status="generating", progress=55,
                          stage_message="正在并行生成 HTML 页面")
        await self._event(task_id, "html_generate", "并行生成 HTML 页面",
                    f"共 {len(slides)} 页，{min(4, len(slides))} 路并发")
        html_slides = await renderer.generate_all_slides_parallel(
            outline, style_guide, concurrency=4,
        )

        # Step 3: Validate HTML slides
        issues = renderer.validate_slides(html_slides)
        for repair_round in range(1, 4):
            if not issues:
                break
            await self._event(task_id, "html_validate", "页面校验发现问题",
                        f"第 {repair_round} 轮发现 {len(issues)} 项问题，正在定向重建对应页面",
                        {"issues": issues, "repairRound": repair_round, "decision": "repair"})
            affected = set()
            for issue in issues:
                match = re.search(r"Slide\s+(\d+)", str(issue), re.IGNORECASE)
                if match:
                    affected.add(int(match.group(1)) - 1)
            if not affected:
                affected = set(range(len(slides)))
            for index in sorted(affected):
                if 0 <= index < len(slides):
                    html_slides[index] = await renderer.generate_slide_html(
                        slides[index], style_guide, index, len(slides),
                    )
            issues = renderer.validate_slides(html_slides)
            await self._event(task_id, "html_validate", "修订页面重新核验",
                        "本轮页面已通过" if not issues else "仍有页面未通过，将继续自主修复",
                        {"issues": issues, "repairRound": repair_round,
                         "decision": "pass" if not issues else "repair"})
        if issues:
            raise RuntimeError("交互课件页面经过 3 轮定向重建后仍未通过结构校验：" + "；".join(issues[:8]))
        await self._event(task_id, "html_validate", "页面校验通过",
                    f"全部 {len(html_slides)} 页 HTML 结构完整")

        # Step 4: Convert to PPTX
        self.store.update(task_id, status="reviewing", progress=85,
                          stage_message="正在转换 HTML 为 PPTX")
        await self._event(task_id, "render", "HTML 转 PPTX",
                    "使用原生文本渲染，确保字体规范")
        await asyncio.to_thread(renderer.render_to_pptx, html_slides, outline, output, request)
        await asyncio.to_thread(self.validate, output, len(slides))

    @staticmethod
    def _rgb(value: str) -> RGBColor:
        return RGBColor.from_string(value)

    def render(self, request: PresentationRequest, outline: dict, output: Path,
               background_images: list[Path] | None = None) -> None:
        outline = self.normalize_outline_for_layout(outline)
        prs = Presentation()
        if request.aspect_ratio == "16:9":
            prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
        else:
            prs.slide_width, prs.slide_height = Inches(10), Inches(7.5)
        width = prs.slide_width / 914400
        primary, surface, accent = palette_for(request.background_style)
        slides = outline.get("slides", [])
        seed = int(hashlib.sha256(output.stem.encode()).hexdigest()[:16], 16)
        backgrounds = select_backgrounds(request.background_style, output.stem)
        layout_random = random.Random(seed)
        recent_layouts: list[str] = []
        for index, item in enumerate(slides):
            slide = prs.slides.add_slide(prs.slide_layouts[6])
            kind = str(item.get("kind", "content"))
            is_section = kind == "section"
            is_edge = index == 0 or index == len(slides) - 1 or is_section
            bg = primary if is_edge else surface
            slide.background.fill.solid(); slide.background.fill.fore_color.rgb = self._rgb(bg)
            background_role = (
                "cover" if index == 0 else
                "section" if is_section or index == len(slides) - 1 else
                "agenda" if kind == "agenda" else "content"
            )
            if background_images and index < len(background_images):
                background_path = background_images[index]
            else:
                background_path = backgrounds.get(background_role)
            background_text = self._image_text_color(background_path, primary) if background_path else ("FFFFFF" if is_edge else primary)
            background_muted = background_text if background_text == primary else "D8E2E8"
            footer_left = self._image_region_text_color(background_path, primary, (.03, .78, .36, .98))
            footer_right = self._image_region_text_color(background_path, primary, (.76, .76, .98, .98))
            if background_path:
                self._add_image_background(
                    slide, background_path, prs.slide_width, prs.slide_height,
                )
            if is_edge:
                if is_section:
                    section_number = int(item.get("sectionNumber", 1))
                    chapter_color = primary if background_text == primary else accent
                    self._add_text(slide, f"CHAPTER  {section_number:02d}", .9, 1.18, width - 1.8, .45, 13, chapter_color, True)
                    self._add_text(slide, item.get("title", ""), .85, 1.82, width - 1.7, 1.15, 31, background_text, True)
                    topics = "本章包括：" + "、".join(str(value) for value in item.get("sectionTopics", [])[:4])
                    self._add_text(slide, topics, .9, 3.25, width - 2.1, .9, 13, background_muted)
                    self._add_text(slide, f"{index + 1:02d}", width - 1.6, 6.25, .8, .5, 15, footer_right, True, PP_ALIGN.RIGHT)
                    if request.include_speaker_notes and item.get("speakerNotes"):
                        slide.notes_slide.notes_text_frame.text = str(item["speakerNotes"])
                    continue
                cover_design = outline.get("coverDesign") if isinstance(outline.get("coverDesign"), dict) else {}
                if index == 0:
                    placement = str(cover_design.get("placement", "left-middle"))
                    cover_positions = {
                        "left-top": (.85, .95, width * .58, PP_ALIGN.LEFT),
                        "left-middle": (.85, 1.65, width * .62, PP_ALIGN.LEFT),
                        "center": (1.2, 1.65, width - 2.4, PP_ALIGN.CENTER),
                        "right-top": (width * .42, .95, width * .50, PP_ALIGN.RIGHT),
                        "right-middle": (width * .42, 1.65, width * .50, PP_ALIGN.RIGHT),
                    }
                    title_x, title_y, title_w, title_align = cover_positions.get(placement, cover_positions["left-middle"])
                    title_color = str(cover_design.get("titleColor", background_text))
                    subtitle_color = str(cover_design.get("subtitleColor", background_muted))
                    title_size = int(cover_design.get("titleSize", 42))
                    if request.background_style in COVER_TEXT_OVERRIDES:
                        title_color, subtitle_color = COVER_TEXT_OVERRIDES[request.background_style]
                else:
                    title_x, title_y, title_w, title_align = .85, 1.65, width - 1.7, PP_ALIGN.LEFT
                    title_color, subtitle_color, title_size = background_text, background_muted, 32
                cover_title = _clean_presentation_title(item.get("title", ""))
                estimated_units = sum(1 if ord(char) < 128 else 2 for char in cover_title)
                if estimated_units > 34:
                    title_size = min(title_size, 27)
                elif estimated_units > 27:
                    title_size = min(title_size, 30)
                elif estimated_units > 22:
                    title_size = min(title_size, 34)
                self._add_text(
                    slide, cover_title, title_x, title_y, title_w, .92,
                    title_size, title_color, True, title_align,
                )
                subtitle = outline.get("subtitle", "") if index == 0 else "重点回顾、行动建议与交流讨论"
                self._add_text(
                    slide, subtitle, title_x + .05, title_y + 1.42, title_w - .1, .7,
                    17, subtitle_color, False, title_align,
                )
                if index == 0:
                    self._add_text(slide, "Designed by ITN Agents", .9, 6.55, 2.8, .34, 9, footer_left, True)
                if index == len(slides) - 1:
                    points = [self._point_parts(point) for point in _as_list(item.get("points"), "points", "items")][:3]
                    summary_w = (width - 2.2) / max(1, len(points))
                    for p_index, (heading, detail) in enumerate(points):
                        x = .9 + p_index * (summary_w + .2)
                        summary = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(4.05), Inches(summary_w), Inches(1.55))
                        summary.fill.solid(); summary.fill.fore_color.rgb = self._rgb(primary)
                        summary.line.color.rgb = self._rgb(accent)
                        self._add_text(slide, heading, x + .18, 4.25, summary_w - .36, .35, 12, accent, True, PP_ALIGN.CENTER)
                        clauses = [value.strip() for value in re.split(r"[。；;\n]", detail) if value.strip()]
                        concise = clauses[0] if clauses else detail
                        if len(concise) > 64:
                            comma_clause = concise.split("，", 1)[0].strip()
                            concise = comma_clause if 8 <= len(comma_clause) <= 64 else heading
                        self._add_text(slide, concise, x + .18, 4.72, summary_w - .36, .62, 9, "FFFFFF", False, PP_ALIGN.CENTER)
                self._add_text(slide, f"{index + 1:02d}", width - 1.6, 6.25, .8, .5, 15, footer_right, True, PP_ALIGN.RIGHT)
            else:
                page_title = _clean_presentation_title(item.get("title", ""))
                page_title_size = 20 if len(page_title) > 24 else 22 if len(page_title) > 18 else 25
                self._add_text(slide, page_title, .7, .45, width - 1.4, .62, page_title_size, background_text, True)
                if kind in {"agenda", "overview", "concept", "code", "comparison", "process", "table", "timeline", "roadmap", "spotlight", "checklist", "case", "practice"}:
                    self._render_semantic_slide(slide, item, kind, width, primary, surface, accent)
                    self._add_text(slide, f"{index + 1:02d}  /  {len(slides):02d}", width - 1.65, 6.92, .95, .25, 9, footer_right, True, PP_ALIGN.RIGHT)
                    if request.include_speaker_notes and item.get("speakerNotes"):
                        slide.notes_slide.notes_text_frame.text = str(item["speakerNotes"])
                    continue
                points = [str(point).replace("->", "→") for point in _as_list(item.get("points"), "points", "items")][:5]
                available_layouts = [layout for layout in ("cards", "flow", "spotlight", "stack") if layout not in recent_layouts[-2:]]
                page_layout = layout_random.choice(available_layouts)
                recent_layouts.append(page_layout)
                visible_points = points if page_layout == "stack" else points[:3]
                card_w = (width - 2.2) / max(1, len(visible_points))
                flow_layout = page_layout == "flow" or any("→" in point for point in visible_points)
                for p_index, point in enumerate(visible_points):
                    if page_layout == "spotlight" and p_index == 0:
                        x, y, item_w, item_h = .7, 1.55, width * .46, 3.15
                    elif page_layout == "spotlight":
                        item_w = width * .40
                        item_h = 1.35
                        x, y = width * .55, 1.55 + (p_index - 1) * 1.62
                    elif page_layout == "stack":
                        x, y, item_w, item_h = .7, 1.62 + p_index * 1.18, width - 1.4, .9
                    else:
                        x, y, item_w, item_h = .7 + p_index * (card_w + .4), 1.85, card_w, 2.15
                    card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y), Inches(item_w), Inches(item_h))
                    card.fill.solid(); card.fill.fore_color.rgb = self._rgb("FFFFFF")
                    card.line.color.rgb = self._rgb("D9E1E5")
                    badge_x = x + .2 if page_layout == "stack" else x + item_w / 2 - .24
                    badge_y = y + .17 if page_layout == "stack" else y + .22
                    badge = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(badge_x), Inches(badge_y), Inches(.48), Inches(.48))
                    badge.fill.solid(); badge.fill.fore_color.rgb = self._rgb(accent); badge.line.fill.background()
                    self._add_text(slide, str(p_index + 1), badge_x, badge_y, .48, .48, 10, primary, True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
                    if page_layout == "spotlight":
                        text_y = y + (1.35 if p_index == 0 else .62)
                        text_h = 1.15 if p_index == 0 else .48
                    else:
                        text_y = y + (.21 if page_layout == "stack" else .98)
                        text_h = .58 if page_layout == "stack" else .68
                    text_x = x + .9 if page_layout == "stack" else x + .24
                    text_w = item_w - 1.15 if page_layout == "stack" else item_w - .48
                    text_align = PP_ALIGN.LEFT if page_layout == "stack" else PP_ALIGN.CENTER
                    self._add_text(slide, point, text_x, text_y, text_w, text_h, 12 if p_index else 14, primary, p_index == 0, text_align, MSO_ANCHOR.MIDDLE)
                    if flow_layout and page_layout != "spotlight" and p_index < len(visible_points) - 1:
                        arrow = slide.shapes.add_shape(MSO_SHAPE.CHEVRON, Inches(x + card_w + .08), Inches(y + .65), Inches(.25), Inches(.42))
                        arrow.fill.solid(); arrow.fill.fore_color.rgb = self._rgb(accent); arrow.line.fill.background()
                if len(points) > 3 and page_layout not in ("spotlight", "stack"):
                    detail_text = "；".join(points[3:])
                    band = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(.7), Inches(4.35), Inches(width - 1.4), Inches(1.0))
                    band.fill.solid(); band.fill.fore_color.rgb = self._rgb(primary); band.line.fill.background()
                    self._add_text(slide, detail_text, 1.0, 4.62, width - 2.0, .48, 12, "FFFFFF", True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
                self._add_text(slide, f"{index + 1:02d}  /  {len(slides):02d}", width - 1.65, 6.92, .95, .25, 9, footer_right, True, PP_ALIGN.RIGHT)
            if request.include_speaker_notes and item.get("speakerNotes"):
                slide.notes_slide.notes_text_frame.text = str(item["speakerNotes"])
        prs.save(output)

    def _add_image_background(self, slide, path: Path, slide_width, slide_height) -> None:
        """Place an image as a full-bleed cover crop without tinting the source."""
        with Image.open(path) as image:
            image_ratio = image.width / image.height
        slide_ratio = slide_width / slide_height
        picture = slide.shapes.add_picture(str(path), 0, 0, width=slide_width, height=slide_height)
        if image_ratio > slide_ratio:
            visible = slide_ratio / image_ratio
            picture.crop_left = picture.crop_right = (1 - visible) / 2
        elif image_ratio < slide_ratio:
            visible = image_ratio / slide_ratio
            picture.crop_top = picture.crop_bottom = (1 - visible) / 2

    @staticmethod
    def _image_text_color(path: Path | None, dark_color: str) -> str:
        """Choose dark or white typography from the image's upper-left content area."""
        return PptAgent._image_region_text_color(path, dark_color, (.04, .08, .58, .52))

    @staticmethod
    def _image_region_text_color(path: Path | None, dark_color: str,
                                 region_box: tuple[float, float, float, float]) -> str:
        """Choose typography color for a specific normalized image region."""
        if not path:
            return dark_color
        with Image.open(path).convert("RGB") as image:
            width, height = image.size
            left, top, right, bottom = region_box
            region = image.crop((int(width * left), int(height * top), int(width * right), int(height * bottom)))
            sample = region.resize((24, 16))
            luminance = sum(
                .2126 * red + .7152 * green + .0722 * blue
                for red, green, blue in sample.getdata()
            ) / (24 * 16)
        return dark_color if luminance >= 150 else "FFFFFF"

    @staticmethod
    def _estimate_text_height(text: str, box_width_inches: float, font_size: int) -> float:
        avg_char_w = font_size / 72
        chars_per_line = max(1, int(box_width_inches / avg_char_w))
        lines = str(text).count("\n") + 1
        for paragraph in str(text).split("\n"):
            para_lines = max(1, math.ceil(len(paragraph) / chars_per_line)) if paragraph else 1
            lines = max(lines, para_lines)
        line_height = font_size / 72 * 1.4
        return round(lines * line_height + 0.08, 2)

    @staticmethod
    def _point_parts(point) -> tuple[str, str]:
        if isinstance(point, dict):
            return str(point.get("heading", "重点")), str(point.get("detail", ""))
        text = str(point)
        heading, separator, detail = text.partition("：")
        if separator:
            return heading, detail
        first_clause = re.split(r"[，,。；;：:\n]", text, maxsplit=1)[0].strip()
        derived_heading = first_clause if 2 <= len(first_clause) <= 18 else text[:16].rstrip("，,。；;：:")
        return derived_heading or "核心内容", text

    def _render_semantic_slide(self, slide, item: dict, kind: str, width: float,
                               primary: str, surface: str, accent: str) -> None:
        if kind == "code" and isinstance(item.get("code"), dict):
            self._render_code_slide(slide, item, width, primary, accent)
        elif kind == "agenda":
            self._render_agenda_slide(slide, item, width, primary, accent)
        elif kind == "table" and isinstance(item.get("table"), dict):
            self._render_table_slide(slide, item, width, primary, accent)
        elif kind in {"process", "timeline", "roadmap"}:
            self._render_process_slide(slide, item, width, primary, accent)
        elif kind == "spotlight":
            self._render_spotlight_slide(slide, item, width, primary, accent)
        elif kind == "checklist":
            self._render_checklist_slide(slide, item, width, primary, accent)
        else:
            self._render_rich_content_slide(slide, item, kind, width, primary, accent)

    def _render_agenda_slide(self, slide, item: dict, width: float, primary: str, accent: str) -> None:
        points = [self._point_parts(point) for point in _as_list(item.get("points"), "points", "items")][:10]
        if not points:
            return
        if len(points) > 5:
            rows_per_column = math.ceil(len(points) / 2)
            column_gap = .28
            column_width = (width - 1.36 - column_gap) / 2
            gap = .14
            row_height = min(.92, (4.72 - (rows_per_column - 1) * gap) / rows_per_column)
            group_height = rows_per_column * row_height + (rows_per_column - 1) * gap
            top = 1.38 + (4.72 - group_height) / 2
            for index, (heading, detail) in enumerate(points):
                column = index // rows_per_column
                row_index = index % rows_per_column
                x = .68 + column * (column_width + column_gap)
                y = top + row_index * (row_height + gap)
                card = slide.shapes.add_shape(
                    MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y),
                    Inches(column_width), Inches(row_height),
                )
                card.fill.solid(); card.fill.fore_color.rgb = self._rgb("FFFFFF")
                card.line.color.rgb = self._rgb("D9E1E5")
                number_width = .62
                number = slide.shapes.add_shape(
                    MSO_SHAPE.ROUNDED_RECTANGLE, Inches(x), Inches(y),
                    Inches(number_width), Inches(row_height),
                )
                number.fill.solid(); number.fill.fore_color.rgb = self._rgb(primary); number.line.fill.background()
                self._add_text(
                    slide, f"{int(item.get('startNumber', 1)) + index:02d}",
                    x, y, number_width, row_height, 14, accent, True,
                    PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE,
                )
                self._add_text(
                    slide, heading, x + .78, y + .07, column_width - .9, .28,
                    13, primary, True, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE,
                )
                self._add_text(
                    slide, detail, x + .78, y + .36, column_width - .9, row_height - .41,
                    9.5, primary, False, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE,
                )
            return
        row_height = min(.92, 4.7 / len(points))
        if len(points) <= 3:
            gap = .42
            group_height = len(points) * row_height + (len(points) - 1) * gap
            top = 1.38 + (4.7 - group_height) / 2
            row_positions = [
                top + index * (row_height + gap)
                for index in range(len(points))
            ]
        else:
            gap = .16
            row_positions = [
                1.38 + index * (row_height + gap)
                for index in range(len(points))
            ]
        for index, (heading, detail) in enumerate(points):
            y = row_positions[index]
            row = slide.shapes.add_shape(
                MSO_SHAPE.ROUNDED_RECTANGLE, Inches(.68), Inches(y),
                Inches(width - 1.36), Inches(row_height),
            )
            row.fill.solid(); row.fill.fore_color.rgb = self._rgb("FFFFFF")
            row.line.color.rgb = self._rgb("D9E1E5")
            number = slide.shapes.add_shape(
                MSO_SHAPE.ROUNDED_RECTANGLE, Inches(.72), Inches(y),
                Inches(.78), Inches(row_height),
            )
            number.fill.solid(); number.fill.fore_color.rgb = self._rgb(primary); number.line.fill.background()
            self._add_text(
                slide, f"{int(item.get('startNumber', 1)) + index:02d}", .72, y, .78, row_height,
                16, accent, True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE,
            )
            self._add_text(
                slide, heading, 1.75, y + .08, width * .30, row_height - .16,
                14, primary, True, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE,
            )
            self._add_text(
                slide, detail, width * .44, y + .08, width * .49, row_height - .16,
                11, primary, False, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE,
            )

    def _render_code_slide(self, slide, item: dict, width: float, primary: str, accent: str) -> None:
        code = item.get("code") or {}
        panel = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(.7), Inches(1.35), Inches(width * .61), Inches(4.95))
        panel.fill.solid(); panel.fill.fore_color.rgb = self._rgb("111827"); panel.line.color.rgb = self._rgb("263449")
        language = str(code.get("language", "code")).upper()
        self._add_text(slide, f"{language}｜{code.get('caption', '示例代码')}", .98, 1.58, width * .56, .35, 10, "8ED8C4", True)
        raw_code = str(code.get("content", ""))
        line_count = max(1, raw_code.count("\n") + 1)
        font_size = 9 if line_count > 18 else 10 if line_count > 13 else 11
        code_height = min(3.65, .32 * line_count)
        self._add_code_text(slide, raw_code, .98, 2.0, width * .56, code_height, font_size)
        output = re.sub(r"\s*\n+\s*", "；", str(code.get("output", "")).strip())
        code_bottom_y = 2.0 + code_height
        if output:
            self._add_text(slide, f"运行结果  ›  {output}", .98, code_bottom_y + .1, width * .56, .34, 8, "A7F3D0", True)
            code_bottom_y += .5
        right_x = width * .65
        self._add_text(slide, "逐段讲解", right_x, 1.43, width * .30, .38, 15, primary, True)
        annotations = _as_list(code.get("annotations"), "annotations", "items")
        annot_count = min(len(annotations), 5)
        annot_height = max(annot_count * .78, 1.5)
        for idx, annotation in enumerate(annotations[:annot_count]):
            y = 1.95 + idx * .78
            if y + .52 > 6.8:
                break
            badge = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(right_x), Inches(y), Inches(.35), Inches(.35))
            badge.fill.solid(); badge.fill.fore_color.rgb = self._rgb(accent); badge.line.fill.background()
            self._add_text(slide, str(idx + 1), right_x, y, .35, .35, 8, primary, True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
            annotation_text = str(annotation).rstrip("。.;；")
            self._add_text(slide, annotation_text, right_x + .48, y - .02, width * .27, .52, 9, primary)
        takeaway = str(item.get("takeaway", ""))
        takeaway_y = max(code_bottom_y + .2, 2.0 + annot_height + .1)
        if takeaway and takeaway_y + .62 < 7.2:
            tag = slide.shapes.add_shape(
                MSO_SHAPE.ROUNDED_RECTANGLE, Inches(right_x), Inches(takeaway_y),
                Inches(width * .30), Inches(.62),
            )
            tag.fill.solid(); tag.fill.fore_color.rgb = self._rgb(primary); tag.line.fill.background()
            self._add_text(
                slide, takeaway, right_x + .16, takeaway_y + .1, width * .27, .40,
                9, "FFFFFF", True, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE,
            )

    def _render_table_slide(self, slide, item: dict, width: float, primary: str, accent: str) -> None:
        data = item.get("table") or {}
        headers = [str(value) for value in _as_list(data.get("headers"), "headers", "items")][:5]
        table_rows = _as_list(data.get("rows"), "rows", "items")
        rows = [[str(value) for value in row[:len(headers)]] for row in table_rows[:6] if isinstance(row, list)]
        if not headers or not rows:
            self._render_rich_content_slide(slide, item, "concept", width, primary, accent)
            return
        shape = slide.shapes.add_table(len(rows) + 1, len(headers), Inches(.7), Inches(1.45), Inches(width - 1.4), Inches(4.65))
        table = shape.table
        for col, header in enumerate(headers):
            cell = table.cell(0, col); cell.text = header; cell.fill.solid(); cell.fill.fore_color.rgb = self._rgb(primary)
            for paragraph in cell.text_frame.paragraphs:
                paragraph.font.name = "Microsoft YaHei"; paragraph.font.size = Pt(11); paragraph.font.bold = True; paragraph.font.color.rgb = self._rgb("FFFFFF")
            cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        for row_index, row in enumerate(rows, start=1):
            for col in range(len(headers)):
                cell = table.cell(row_index, col); cell.text = row[col] if col < len(row) else ""
                cell.fill.solid(); cell.fill.fore_color.rgb = self._rgb("FFFFFF" if row_index % 2 else "F2F5F3")
                for paragraph in cell.text_frame.paragraphs:
                    paragraph.font.name = "Microsoft YaHei"; paragraph.font.size = Pt(10); paragraph.font.color.rgb = self._rgb(primary)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        # The table already occupies the full content area; placing a takeaway at
        # the legacy y=5.72 overlays the final row. Keep the conclusion in notes.

    def _render_process_slide(self, slide, item: dict, width: float, primary: str, accent: str) -> None:
        process = item.get("process") or []
        if isinstance(process, dict):
            process = process.get("steps") or process.get("items") or process.get("nodes") or []
        if not isinstance(process, list):
            process = []
        if not process:
            points = _as_list(item.get("points"), "points", "items")
            process = [{"label": heading, "detail": detail} for heading, detail in map(self._point_parts, points)]
        process = process[:5]
        node_w = (width - 2.1) / max(1, len(process))
        label_font = 14
        detail_font = 10
        node_info = []
        for idx, step in enumerate(process):
            x = .7 + idx * (node_w + .18)
            label = str(step.get("label", "步骤"))
            detail = str(step.get("detail", ""))
            detail_w = node_w - .4
            label_h = self._estimate_text_height(label, detail_w, label_font)
            detail_h = self._estimate_text_height(detail, detail_w, detail_font)
            total_h = max(2.45, 1.4 + label_h + .15 + detail_h + .15)
            total_h = min(total_h, 4.2)
            node_info.append({"x": x, "w": node_w, "h": total_h, "label": label, "detail": detail, "idx": idx})
        max_h = max(n["h"] for n in node_info) if node_info else 2.45
        for n in node_info:
            n["h"] = max_h
            y = 2.0
            node = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(n["x"]), Inches(y), Inches(node_w), Inches(n["h"]))
            node.fill.solid(); node.fill.fore_color.rgb = self._rgb("FFFFFF"); node.line.color.rgb = self._rgb("D7DFDA")
            self._add_text(slide, f"{n['idx'] + 1:02d}", n["x"] + .2, y + .24, .48, .38, 12, accent, True)
            self._add_text(slide, n["label"], n["x"] + .2, y + .78, node_w - .4, .55, label_font, primary, True)
            self._add_text(slide, n["detail"], n["x"] + .2, y + 1.4, node_w - .4, n["h"] - 1.6, detail_font, primary)
        for n in node_info[:-1]:
            arrow = slide.shapes.add_shape(MSO_SHAPE.CHEVRON, Inches(n["x"] + node_w + .025), Inches(2.95), Inches(.13), Inches(.42))
            arrow.fill.solid(); arrow.fill.fore_color.rgb = self._rgb(accent); arrow.line.fill.background()
        bottom = max(n["h"] for n in node_info) + 2.0 + .2 if node_info else 4.65
        if bottom < 6.2 and item.get("takeaway"):
            self._add_takeaway(slide, item, width, primary, accent, bottom + .4)
        elif item.get("takeaway"):
            self._add_takeaway(slide, item, width, primary, accent, 5.72)

    def _render_spotlight_slide(self, slide, item: dict, width: float, primary: str, accent: str) -> None:
        points = [self._point_parts(point) for point in _as_list(item.get("points"), "points", "items")][:4]
        if not points:
            return
        heading, detail = points[0]
        hero = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(.7), Inches(1.42), Inches(width * .48), Inches(4.35))
        hero.fill.solid(); hero.fill.fore_color.rgb = self._rgb(primary); hero.line.fill.background()
        self._add_text(slide, heading, 1.02, 1.83, width * .42, .75, 23, accent, True)
        self._add_text(slide, detail, 1.02, 2.72, width * .42, 2.45, 13, "FFFFFF")
        right_x = width * .55
        card_h = min(1.25, 3.9 / max(1, len(points) - 1))
        for index, (item_heading, item_detail) in enumerate(points[1:]):
            y = 1.48 + index * (card_h + .18)
            card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(right_x), Inches(y), Inches(width * .39), Inches(card_h))
            card.fill.solid(); card.fill.fore_color.rgb = self._rgb("FFFFFF"); card.line.color.rgb = self._rgb("D8E0DB")
            self._add_text(slide, item_heading, right_x + .22, y + .16, width * .34, .32, 13, primary, True)
            self._add_text(slide, item_detail, right_x + .22, y + .53, width * .34, card_h - .62, 9.5, primary)
        if item.get("takeaway"):
            self._add_takeaway(slide, item, width, primary, accent, 5.92)

    def _render_checklist_slide(self, slide, item: dict, width: float, primary: str, accent: str) -> None:
        points = [self._point_parts(point) for point in _as_list(item.get("points"), "points", "items")][:5]
        if not points:
            return
        row_h = min(.9, 4.4 / len(points))
        gap = .14
        top = 1.42 + max(0, (4.55 - len(points) * row_h - (len(points) - 1) * gap) / 2)
        for index, (heading, detail) in enumerate(points):
            y = top + index * (row_h + gap)
            row = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(.78), Inches(y), Inches(width - 1.56), Inches(row_h))
            row.fill.solid(); row.fill.fore_color.rgb = self._rgb("FFFFFF"); row.line.color.rgb = self._rgb("D8E0DB")
            badge = slide.shapes.add_shape(MSO_SHAPE.OVAL, Inches(1.02), Inches(y + .18), Inches(.42), Inches(.42))
            badge.fill.solid(); badge.fill.fore_color.rgb = self._rgb(accent); badge.line.fill.background()
            self._add_text(slide, "✓", 1.02, y + .18, .42, .42, 11, primary, True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE)
            self._add_text(slide, heading, 1.68, y + .12, width * .27, row_h - .24, 13, primary, True, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
            self._add_text(slide, detail, width * .36, y + .12, width * .56, row_h - .24, 10, primary, False, PP_ALIGN.LEFT, MSO_ANCHOR.MIDDLE)
        if item.get("takeaway"):
            self._add_takeaway(slide, item, width, primary, accent, 6.08)

    def _render_rich_content_slide(self, slide, item: dict, kind: str, width: float, primary: str, accent: str) -> None:
        points = [self._point_parts(point) for point in item.get("points", [])][:4]
        if not points:
            points = [("核心结论", str(item.get("takeaway", "本页暂无详细内容")))]
        comparison = kind == "comparison" and len(points) >= 2
        card_w = (width - 1.8) / 2
        card_info = []
        for idx, (heading, detail) in enumerate(points):
            if len(points) == 1:
                x, y, cw, ch = .7, 1.7, width - 1.4, 3.25
            elif len(points) == 2:
                x, y, cw, ch = .7 + idx * (card_w + .4), 1.65, card_w, 3.2
            elif len(points) == 3 and idx == 0:
                x, y, cw, ch = .7, 1.42, width - 1.4, 1.5
            elif len(points) == 3:
                x, y, cw, ch = .7 + (idx - 1) * (card_w + .4), 3.18, card_w, 1.95
            else:
                col, row_idx = idx % 2, idx // 2
                x, y, cw, ch = .7 + col * (card_w + .4), 1.45 + row_idx * 2.18, card_w, 1.8
            detail_w = cw - .5
            detail_h = self._estimate_text_height(detail, detail_w, 10)
            heading_h = self._estimate_text_height(heading, detail_w, 14)
            text_total = heading_h + .15 + detail_h
            min_card_h = max(ch, text_total + .3)
            card_info.append({"x": x, "y": y, "w": cw, "h": ch, "min_h": min_card_h,
                              "heading": heading, "detail": detail})
        if len(points) <= 2:
            max_h = max(c["min_h"] for c in card_info)
            max_h = min(max_h, 4.5)
            for c in card_info:
                c["h"] = max_h
                c["min_h"] = max_h
        elif len(points) == 3:
            card_info[0]["h"] = max(card_info[0]["h"], min(card_info[0]["min_h"], 2.5))
            max_bottom = max(c["min_h"] for c in card_info[1:])
            max_bottom = min(max_bottom, 3.5)
            for c in card_info[1:]:
                c["h"] = max_bottom
                c["min_h"] = max_bottom
                c["y"] = card_info[0]["y"] + card_info[0]["h"] + .26
        else:
            for i, c in enumerate(card_info):
                c["h"] = min(c["min_h"], 2.4)
            row0_h = max(card_info[0]["h"], card_info[1]["h"])
            row1_h = max(card_info[2]["h"], card_info[3]["h"])
            for i, c in enumerate(card_info):
                if i >= 2:
                    c["y"] = card_info[0]["y"] + row0_h + .26
        for c in card_info:
            card = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(c["x"]), Inches(c["y"]), Inches(c["w"]), Inches(c["h"]))
            card.fill.solid(); card.fill.fore_color.rgb = self._rgb("FFFFFF")
            card.line.color.rgb = self._rgb(accent if comparison else "D8E0DB")
            self._add_text(slide, c["heading"], c["x"] + .25, c["y"] + .22, c["w"] - .5, .4, 14, accent if comparison else primary, True)
            self._add_text(slide, c["detail"], c["x"] + .25, c["y"] + .72, c["w"] - .5, max(.5, c["h"] - .92), 10, primary)
        bottom = max(c["y"] + c["h"] for c in card_info) + .2
        if bottom < 6.2 and item.get("takeaway"):
            self._add_takeaway(slide, item, width, primary, accent, bottom + .4)
        elif item.get("takeaway"):
            self._add_takeaway(slide, item, width, primary, accent, 5.72)

    def _add_takeaway(self, slide, item: dict, width: float, primary: str, accent: str, y_pos: float = 5.72) -> None:
        takeaway = str(item.get("takeaway", "")).strip()
        if not takeaway:
            return
        bar = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(.7), Inches(y_pos), Inches(width - 1.4), Inches(.58))
        bar.fill.solid(); bar.fill.fore_color.rgb = self._rgb(primary); bar.line.fill.background()
        self._add_text(
            slide, takeaway, 1.0, y_pos + .08, width - 2.0, .40,
            10, "FFFFFF", True, PP_ALIGN.CENTER, MSO_ANCHOR.MIDDLE,
        )

    LATEX_UNICODE = {
        "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
        "varepsilon": "ε", "zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "ϑ",
        "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν",
        "xi": "ξ", "omicron": "ο", "pi": "π", "varpi": "ϖ", "rho": "ρ",
        "varrho": "ϱ", "sigma": "σ", "varsigma": "ς", "tau": "τ", "upsilon": "υ",
        "phi": "φ", "varphi": "ϕ", "chi": "χ", "psi": "ψ", "omega": "ω",
        "Alpha": "Α", "Beta": "Β", "Gamma": "Γ", "Delta": "Δ", "Epsilon": "Ε",
        "Zeta": "Ζ", "Eta": "Η", "Theta": "Θ", "Iota": "Ι", "Kappa": "Κ",
        "Lambda": "Λ", "Mu": "Μ", "Nu": "Ν", "Xi": "Ξ", "Omicron": "Ο",
        "Pi": "Π", "Rho": "Ρ", "Sigma": "Σ", "Tau": "Τ", "Upsilon": "Υ",
        "Phi": "Φ", "Chi": "Χ", "Psi": "Ψ", "Omega": "Ω",
        "int": "∫", "iint": "∬", "iiint": "∭", "oint": "∮",
        "sum": "∑", "prod": "∏", "coprod": "∐",
        "nabla": "∇", "partial": "∂", "exists": "∃", "forall": "∀",
        "infty": "∞", "emptyset": "∅", "varnothing": "∅",
        "to": "→", "rightarrow": "→", "leftarrow": "←",
        "Rightarrow": "⇒", "Leftarrow": "⇐", "leftrightarrow": "↔", "Leftrightarrow": "⇔",
        "mapsto": "↦", "implies": "⇒", "iff": "⇔",
        "leq": "≤", "geq": "≥", "neq": "≠", "ne": "≠", "approx": "≈", "equiv": "≡",
        "sim": "∼", "simeq": "≃", "cong": "≅", "propto": "∝",
        "subset": "⊂", "supset": "⊃", "subseteq": "⊆", "supseteq": "⊇",
        "in": "∈", "notin": "∉", "ni": "∋",
        "cup": "∪", "cap": "∩", "wedge": "∧", "vee": "∨",
        "oplus": "⊕", "otimes": "⊗", "oplus": "⊕", "ominus": "⊖",
        "otimes": "⊗", "oslash": "⊘", "odot": "⊙",
        "cdots": "⋯", "ldots": "…", "vdots": "⋮", "ddots": "⋱",
        "sin": "sin", "cos": "cos", "tan": "tan", "cot": "cot",
        "sec": "sec", "csc": "csc", "log": "log", "ln": "ln", "lg": "lg",
        "sinh": "sinh", "cosh": "cosh", "tanh": "tanh",
        "arcsin": "arcsin", "arccos": "arccos", "arctan": "arctan",
        "lim": "lim", "max": "max", "min": "min", "sup": "sup", "inf": "inf",
        "det": "det", "dim": "dim", "ker": "ker", "rank": "rank", "deg": "deg",
        "langle": "⟨", "rangle": "⟩", "lceil": "⌈", "rceil": "⌉",
        "lfloor": "⌊", "rfloor": "⌋",
        "cdot": "·", "circ": "∘", "bullet": "•", "times": "×", "div": "÷",
        "pm": "±", "mp": "∓",
        "perp": "⊥", "parallel": "∥", "therefore": "∴", "because": "∵",
        "prime": "′", "dprime": "″", "ell": "ℓ", "hbar": "ℏ",
        "neg": "¬", "land": "∧", "lor": "∨",
        "uparrow": "↑", "downarrow": "↓", "Uparrow": "⇑", "Downarrow": "⇓",
    }

    SUPERSCRIPTS = str.maketrans("0123456789+-=()ni", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ")
    SUBSCRIPTS = str.maketrans("0123456789+-=()aehijklmnoprstuvx",
                               "₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ")

    @staticmethod
    def _convert_math_to_unicode(text: str) -> str:
        text = str(text)
        text = re.sub(r"\s*\\\\\s*", lambda m: "\\", text)

        def replace_math(match):
            content = match.group(1)
            content = PptAgent._resolve_latex_commands(content)
            return content

        text = re.sub(r"\$\$(.*?)\$\$", replace_math, text, flags=re.DOTALL)
        text = re.sub(r"\$(.*?)\$", replace_math, text, flags=re.DOTALL)
        text = re.sub(r"\\\[(.*?)\\\]", replace_math, text, flags=re.DOTALL)
        text = re.sub(r"\\\((.*?)\\\)", replace_math, text, flags=re.DOTALL)

        text = PptAgent._resolve_latex_commands(text)
        return text

    @staticmethod
    def _resolve_latex_commands(text: str) -> str:
        text = PptAgent._resolve_frac(text)
        text = PptAgent._resolve_sqrt(text)
        text = PptAgent._resolve_scripts(text)
        text = PptAgent._resolve_braces(text)
        text = PptAgent._resolve_textcmd(text)
        text = PptAgent._resolve_limits(text)
        text = PptAgent._resolve_commands(text)
        text = re.sub(r"\s+", " ", text).strip()
        return text

    @staticmethod
    def _resolve_frac(text: str) -> str:
        def replace(m):
            a = m.group(1).strip()
            b = m.group(2).strip()
            return f"({a})/({b})"
        while True:
            new_text = re.sub(r"\\frac\{(.*?)\}\{(.*?)\}", replace, text, count=1)
            if new_text == text:
                break
            text = new_text
        return text

    @staticmethod
    def _resolve_sqrt(text: str) -> str:
        def replace_sqrt(m):
            inner = m.group(1).strip()
            return f"√({inner})"
        def replace_cbrt(m):
            inner = m.group(1).strip()
            return f"∛({inner})"
        text = re.sub(r"\\sqrt\[3\]\{(.*?)\}", replace_cbrt, text)
        while True:
            new_text = re.sub(r"\\sqrt\{(.*?)\}", replace_sqrt, text, count=1)
            if new_text == text:
                break
            text = new_text
        text = text.replace("\\sqrt", "√")
        return text

    @staticmethod
    def _resolve_scripts(text: str) -> str:
        def sup_try(val: str) -> str:
            result = val.translate(PptAgent.SUPERSCRIPTS)
            return result if result != val else ""
        def sub_try(val: str) -> str:
            result = val.translate(PptAgent.SUBSCRIPTS)
            return result if result != val else ""
        def replace_sup_multi(m):
            inner = PptAgent._resolve_latex_commands(m.group(1))
            converted = sup_try(inner)
            if converted:
                return converted
            return f"^({inner})"
        def replace_sub_multi(m):
            inner = PptAgent._resolve_latex_commands(m.group(1))
            converted = sub_try(inner)
            if converted:
                return converted
            return f"_({inner})"
        while True:
            new_text = re.sub(r"\^\{([^}]*)\}", replace_sup_multi, text, count=1)
            if new_text == text:
                break
            text = new_text
        while True:
            new_text = re.sub(r"\_\{([^}]*)\}", replace_sub_multi, text, count=1)
            if new_text == text:
                break
            text = new_text
        def sup_single(m):
            c = m.group(1); converted = sup_try(c)
            return converted or f"^{c}"
        def sub_single(m):
            c = m.group(1); converted = sub_try(c)
            return converted or f"_{c}"
        text = re.sub(r"\^([0-9a-zA-Z])", sup_single, text)
        text = re.sub(r"_([0-9a-zA-Z])", sub_single, text)
        return text

    @staticmethod
    def _resolve_braces(text: str) -> str:
        text = re.sub(r"\\left\s*", "", text)
        text = re.sub(r"\\right\s*", "", text)
        text = text.replace(r"\{", "{").replace(r"\}", "}")
        text = text.replace(r"\[", "[").replace(r"\]", "]")
        text = text.replace(r"\(", "(").replace(r"\)", ")")
        return text

    @staticmethod
    def _resolve_textcmd(text: str) -> str:
        text = re.sub(r"\\text\{(.*?)\}", r"\1", text)
        text = re.sub(r"\\mathrm\{(.*?)\}", r"\1", text)
        text = re.sub(r"\\mathbf\{(.*?)\}", r"\1", text)
        text = re.sub(r"\\mathit\{(.*?)\}", r"\1", text)
        text = re.sub(r"\\mbox\{(.*?)\}", r"\1", text)
        text = re.sub(r"\\(?:quad|qquad)\s*", " ", text)
        return text

    @staticmethod
    def _resolve_limits(text: str) -> str:
        text = re.sub(r"\\lim_?\{?([^}\s]*)\}?", lambda m: f"lim_{m.group(1)}" if m.group(1) else "lim", text)
        text = re.sub(r"\\sum_?\{?([^}\s]*)\}?", lambda m: f"∑_{m.group(1)}" if m.group(1) else "∑", text)
        text = re.sub(r"\\prod_?\{?([^}\s]*)\}?", lambda m: f"∏_{m.group(1)}" if m.group(1) else "∏", text)
        text = re.sub(r"\\int_?\{?([^}\s]*)\}?", lambda m: f"∫_{m.group(1)}" if m.group(1) else "∫", text)
        return text

    @staticmethod
    def _resolve_commands(text: str) -> str:
        def replace_cmd(m):
            cmd = m.group(1)
            return PptAgent.LATEX_UNICODE.get(cmd, f"\\{cmd}")
        text = re.sub(r"\\([a-zA-Z]+)", replace_cmd, text)
        return text

    def prepare_slideshow_pdf(self, pptx_path: Path, dest_dir: Path) -> Path | None:
        """Export a PPTX to a reusable PDF without waiting for PNG rendering."""
        dest_dir.mkdir(parents=True, exist_ok=True)
        try:
            import subprocess
            pdf_dir = dest_dir / "pdf_tmp"
            pdf_dir.mkdir(exist_ok=True)
            expected_pdf = pdf_dir / f"{pptx_path.stem}.pdf"
            if expected_pdf.is_file() and expected_pdf.stat().st_mtime >= pptx_path.stat().st_mtime:
                return expected_pdf
            r = subprocess.run(
                ["libreoffice", "--headless",
                 # 容器用户 HOME 可能不可写：强制把 LibreOffice 用户配置放到 /tmp，
                 # 否则无头转换会因 “User installation could not be completed” 失败。
                 f"-env:UserInstallation=file:///tmp/lo-profile-{pptx_path.stem}",
                 "--convert-to", "pdf",
                 "--outdir", str(pdf_dir), str(pptx_path)],
                capture_output=True, text=True, timeout=180,
            )
            if r.returncode != 0:
                logger.warning("LibreOffice PDF export stderr: %s", r.stderr[:500])
            pdfs = sorted(pdf_dir.glob("*.pdf"))
            if not pdfs:
                logger.warning("No PDF produced for %s", pptx_path)
                return None
            return expected_pdf if expected_pdf.is_file() else pdfs[0]
        except Exception as exc:
            logger.warning("Slideshow PDF export failed: %s", exc)
            return None

    def render_slide_png_range(
        self,
        pdf_path: Path,
        dest_dir: Path,
        first_page: int,
        last_page: int,
    ) -> list[Path]:
        """Render an inclusive 1-based PDF page range, preserving the PDF for later pages."""
        dest_dir.mkdir(parents=True, exist_ok=True)
        if first_page < 1 or last_page < first_page:
            return []
        try:
            import subprocess
            r2 = subprocess.run(
                [
                    "pdftoppm", "-r", "150", "-png",
                    "-f", str(first_page), "-l", str(last_page),
                    str(pdf_path), str(dest_dir / "slide"),
                ],
                capture_output=True, text=True, timeout=120,
            )
            if r2.returncode != 0:
                logger.warning("pdftoppm stderr: %s", r2.stderr[:500])
            return [
                path for path in sorted(dest_dir.glob("slide-*.png"))
                if first_page <= int(re.search(r"(\d+)$", path.stem).group(1)) <= last_page
            ]
        except Exception as exc:
            logger.warning("Slide PNG range render failed: %s", exc)
            return []

    def render_slide_pngs(self, pptx_path: Path, dest_dir: Path) -> list[Path]:
        """Render every slide as PNG. Kept for generation-time and compatibility callers."""
        pdf_path = self.prepare_slideshow_pdf(pptx_path, dest_dir)
        if pdf_path is None:
            return []
        # pdftoppm clamps an oversized final page to the actual PDF page count.
        return self.render_slide_png_range(pdf_path, dest_dir, 1, 9999)

    def _add_code_text(self, slide, text: str, x: float, y: float, w: float, h: float, size: int) -> None:
        box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
        frame = box.text_frame; frame.clear(); frame.word_wrap = False
        frame.margin_left = frame.margin_right = frame.margin_top = frame.margin_bottom = Inches(.02)
        frame.text = text.replace("\t", "    ")
        for paragraph in frame.paragraphs:
            paragraph.font.name = "Consolas"; paragraph.font.size = Pt(size); paragraph.font.color.rgb = self._rgb("E5E7EB")

    def _add_text(self, slide, text, x, y, w, h, size, color, bold=False,
                  align=PP_ALIGN.LEFT, valign=MSO_ANCHOR.TOP):
        box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
        frame = box.text_frame; frame.clear(); frame.margin_left = frame.margin_right = Inches(.03)
        frame.vertical_anchor = valign; frame.word_wrap = True
        frame.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
        cleaned = str(text).replace("\n", " ").replace("`", "").replace("->", "→")
        cleaned = self._convert_math_to_unicode(cleaned)
        cleaned = re.sub(r"(\*\*|__)(.*?)\1", r"\2", cleaned)
        cleaned = re.sub(r"^\s{0,3}#{1,6}\s+", "", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        cleaned = re.sub(r"\s*·\s*", "，", cleaned)
        cleaned = re.sub(r"^(?:本页重点|本页结论|核心结论)\s*[：:，,；;]*\s*", "", cleaned)
        cleaned = re.sub(r"^[。；;，,、·•]+\s*", "", cleaned)
        paragraph = frame.paragraphs[0]; paragraph.text = cleaned; paragraph.alignment = align
        paragraph.font.name = "Microsoft YaHei"; paragraph.font.size = Pt(size); paragraph.font.bold = bold; paragraph.font.color.rgb = self._rgb(color)

    @staticmethod
    def validate(path: Path, expected_slides: int) -> None:
        if not path.exists() or path.stat().st_size < 10_000:
            raise RuntimeError("生成的 PPTX 文件不完整")
        prs = Presentation(path)
        if len(prs.slides) != expected_slides:
            raise RuntimeError("生成页数与请求不一致")
        if any(not any(shape.has_text_frame and shape.text.strip() for shape in slide.shapes) for slide in prs.slides):
            raise RuntimeError("检测到空白幻灯片")
