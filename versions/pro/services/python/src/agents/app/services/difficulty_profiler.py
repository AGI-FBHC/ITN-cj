"""画像-资源难度判定服务（our method v1 prototype）。

设计目的
--------
当前系统多处直接用“分数阈值 <55 / 55~75 / >75”决定 零基础/标准/进阶。
本服务在不改变外部返回结构的前提下，把难度判定升级为
“画像角色先验 + 知识点业务类别修正”的可解释规则。

适用范围/注意
--------------
- 输入建议使用现有 learner 画像字段：role / tag / education / targetJob /
  background / goal / learningStyle / scores。
- 如果 role 无法识别，会安全降级为纯阈值规则，不影响现有逻辑。
- 该版本规则先按“证据包 81 组画像”做过快速校准；正式接入前应再做人审/留一画像验证。
"""
from __future__ import annotations

import re
from typing import Any

DIFFICULTY_ZERO = "零基础"
DIFFICULTY_STANDARD = "标准"
DIFFICULTY_ADVANCED = "进阶"
DIFFICULTY_ORDER = (DIFFICULTY_ZERO, DIFFICULTY_STANDARD, DIFFICULTY_ADVANCED)

# 证据包 K1~K9 -> 六维维度 + 业务类别（便于和现有六维分对齐/审计）
TARGET_DIM: dict[str, str] = {
    "K1": "D1", "K2": "D2", "K3": "D3", "K4": "D4", "K5": "D5",
    "K6": "D6", "K7": "D1", "K8": "D2", "K9": "D6",
}
TARGET_CATEGORY: dict[str, str] = {
    "K1": "concept", "K2": "framework", "K3": "memory/rag", "K4": "tool/protocol",
    "K5": "eval", "K6": "agentops", "K7": "prompt", "K8": "tool/system", "K9": "security",
}
CHAPTER_CATEGORY: dict[str, str] = {
    "ch1-intro": "concept", "ch2-history": "concept", "ch3-llm": "prompt",
    "ch4-paradigms": "framework", "ch5-lowcode": "framework", "ch6-frameworks": "framework",
    "ch7-helloagents": "tool/system", "ch8-memory-rag": "memory/rag", "ch9-context": "memory/rag",
    "ch10-protocols": "tool/protocol", "ch11-agentic-rl": "eval", "ch12-evaluation": "eval",
    "ch13-travel": "framework", "ch14-research": "concept", "ch15-cyber": "security",
    "ch16-graduation": "agentops",
}

# 真实知识点按 编码/名称/路径 的兜底归类关键词
# 少数叶子知识点与父章节默认类别不一致时的显式覆盖
LEAF_CATEGORY_OVERRIDES: dict[str, str] = {
    "kp-11-6": "agentops",  # 训练过程可视化与监控：属于生产工程化/监控，而非纯评估
}

CATEGORY_KEYWORDS: list[tuple[tuple[str, ...], str]] = [
    (("定义", "核心特征", "初识智能体", "发展史", "历史", "概念", "是什么"), "concept"),
    (("提示工程", "分词", "Token", "token", "Scaling Laws", "幻觉问题"), "prompt"),
    (("ReAct", "范式", "框架", "低代码", "构建", "函数调用", "工具系统", "自定义工具"), "framework"),
    (("记忆", "检索", "RAG", "上下文工程", "向量数据库"), "memory/rag"),
    (("MCP", "协议", "Stdio", "HTTP", "工具使用"), "tool/protocol"),
    (("RL", "强化学习", "评估", "LLM Judge", "Win Rate", "基准", "评测"), "eval"),
    (("AgentOps", "可观测", "调试", "生产", "工程化", "监控"), "agentops"),
    (("安全", "注入", "防御", "治理", "伦理", "风险"), "security"),
]

_CATEGORY_OF_DIM: dict[str, set[str]] = {
    "framework": {"K2", "K8"},
    "tool/protocol": {"K4"},
    "tool/system": {"K8"},
}

# 画像角色枚举（代码中统一使用，便于后续对接真实画像表）
def _classify_target(target_key: str, target_name: str = "", target_path: str = "") -> str:
    """把真实知识点绑定到业务类别：叶子覆盖 > K编号 > 章节编码 > 关键字兜底。"""
    if target_key in LEAF_CATEGORY_OVERRIDES:
        return LEAF_CATEGORY_OVERRIDES[target_key]
    if target_key in TARGET_CATEGORY:
        return TARGET_CATEGORY[target_key]
    # target_path 通常是完整知识路径，可能包含 ch 章节编码
    for chapter, category in CHAPTER_CATEGORY.items():
        if chapter in target_path:
            return category
    code = target_key or ""
    exact = CHAPTER_CATEGORY.get(code)
    if exact:
        return exact
    prefix = code.split("-")[0] if "-" in code else ""
    for chapter, category in CHAPTER_CATEGORY.items():
        if chapter == code or chapter.startswith(prefix + "-") or code.startswith(chapter + "-"):
            return category
    haystack = f"{code} {target_name} {target_path}"
    for keywords, category in CATEGORY_KEYWORDS:
        if any(keyword.lower() in haystack.lower() for keyword in keywords):
            return category
    return ""


ROLE_ZERO = "zero_basic"             # 全盘零基础 / 新领域零基础
ROLE_EXPERT = "expert"               # 全维高手
ROLE_BOUNDARY = "boundary"           # 阈值临界（54/55 附近）
ROLE_FRESH_CS = "fresh_cs"           # 应届/CS 出身、懂原理无工程
ROLE_BACKEND_TRANSFER = "backend_transfer"  # 后端转型 Agent，能工程缺理论/评估
ROLE_NOCODE_PM = "nocode_pm"         # AI PM / 无代码业务人员
ROLE_HIGH_SCORE_LOW_EXP = "high_score_low_exp"  # 高分低手/从未部署过 Agent
ROLE_LOPSIDED_HANDS_ON = "lopsided_hands_on"    # 偏科但会框架/工具，原理弱


def _band(score: float) -> str:
    """默认阈值：和 personalized_units 现状保持一致。"""
    if score < 55:
        return DIFFICULTY_ZERO
    if score <= 75:
        return DIFFICULTY_STANDARD
    return DIFFICULTY_ADVANCED


def _contains(text: str, *keywords: str) -> bool:
    text = text or ""
    return any(k in text for k in keywords)


def infer_role(learner: dict[str, Any]) -> str:
    """从画像字段推断角色；无法判断时返回 None（调用方再用纯阈值降级）。"""
    role = str(learner.get("role") or "")
    tag = str(learner.get("tag") or "")
    education = " ".join([
        str(learner.get("education") or learner.get("educationLevel") or ""),
        str(learner.get("major") or ""),
        str(learner.get("technicalFoundation") or ""),
    ])
    target_job = str(learner.get("targetJob") or "")
    background = str(learner.get("background") or "")
    goal_raw = learner.get("goal") or {}
    if isinstance(goal_raw, dict):
        goal = str(goal_raw.get("title") or "")
    else:
        goal = str(goal_raw or "")
    if isinstance(learner.get("goalData"), dict):
        goal += " " + str((learner.get("goalData") or {}).get("title") or "")
    text = " ".join([role, tag, education, target_job, background, goal, str(learner.get("learningPreference") or "")])

    # 明确极端 / 临界标签优先
    if _contains(text, "全盘零基础", "全维零基础", "零基础学员", "无任何经验", "完全无经验"):
        return ROLE_ZERO
    if _contains(text, "全维高手", "资深工程师", "接近满分", "各维接近满分"):
        return ROLE_EXPERT
    if _contains(text, "阈值54", "阈值 54", "临界学员", "阈值55", "阈值 55"):
        return ROLE_BOUNDARY
    if _contains(text, "高分低手", "零部署", "从未部署", "从未实操", "没有部署过"):
        return ROLE_HIGH_SCORE_LOW_EXP
    if _contains(text, "严重偏科", "偏科", "会框架", "用过MCP", "用过 MCP"):
        return ROLE_LOPSIDED_HANDS_ON
    if _contains(text, "产品经理", "PM", "无代码", "无代码背景", "AI PM"):
        return ROLE_NOCODE_PM
    if _contains(text, "后端", "Java", "Go", "微服务", "转型", "资深后端"):
        return ROLE_BACKEND_TRANSFER
    if _contains(text, "应届", "计算机", "本科", "CS", "ML/NLP", "Python 熟练"):
        return ROLE_FRESH_CS
    # 保守降级：不强行猜测
    return ""


def _evidence_role(profile_id: str) -> str:
    """仅用于证据包画像的显式映射；真实系统应优先走 infer_role。"""
    return {
        "P1": ROLE_FRESH_CS,
        "P2": ROLE_BACKEND_TRANSFER,
        "P3": ROLE_NOCODE_PM,
        "S1": ROLE_ZERO,
        "S2": ROLE_EXPERT,
        "S3": ROLE_BOUNDARY,
        "S4": ROLE_BOUNDARY,
        "S5": ROLE_HIGH_SCORE_LOW_EXP,
        "S6": ROLE_LOPSIDED_HANDS_ON,
    }.get(profile_id, "")


def _difficulty_by_role(role: str, target_key: str, score: float, target_name: str = "", target_path: str = "") -> str:
    """画像角色 + 靶点类别修正。"""
    category = _classify_target(target_key, target_name, target_path)
    if role == ROLE_ZERO:
        return DIFFICULTY_ZERO
    if role == ROLE_EXPERT:
        return DIFFICULTY_ADVANCED
    if role == ROLE_BOUNDARY:
        # 阈值 54/55 边界：默认标准；生产落地/安全类需要实操，给零基础
        if score < 55 and category in ("agentops", "security"):
            return DIFFICULTY_ZERO
        return DIFFICULTY_STANDARD
    if role == ROLE_FRESH_CS:
        # 应届 CS：懂原理可到标准，AgentOps 无工程/运维给零基础
        return DIFFICULTY_ZERO if category == "agentops" else DIFFICULTY_STANDARD
    if role == ROLE_BACKEND_TRANSFER:
        # 后端转 Agent：能工程；RL/评估空白、安全不冒进
        if category == "eval":
            return DIFFICULTY_ZERO
        if target_key in ("K1", "K7"):
            return DIFFICULTY_STANDARD
        if target_key == "K8":
            return DIFFICULTY_ADVANCED
        if target_key == "K9":
            return DIFFICULTY_STANDARD
        return _band(score)
    if role == ROLE_NOCODE_PM:
        # 无代码 PM：只有概念/提示可到标准，其它不给代码/工程/运维类
        if target_key in ("K1", "K7"):
            return DIFFICULTY_STANDARD
        return DIFFICULTY_ZERO
    if role == ROLE_HIGH_SCORE_LOW_EXP:
        # 高分低手：理论可进阶；工程/工具/安全降标准；AgentOps 归零
        if category == "agentops":
            return DIFFICULTY_ZERO
        if category in ("concept", "eval", "memory/rag"):
            return DIFFICULTY_ADVANCED
        return DIFFICULTY_STANDARD
    if role == ROLE_LOPSIDED_HANDS_ON:
        # 偏科但会框架/MCP：框架/工具类按分进阶；弱原理项至少标准
        if category in ("framework", "tool/protocol", "tool/system"):
            return DIFFICULTY_ADVANCED
        if target_key == "K6":
            return DIFFICULTY_ADVANCED
        return DIFFICULTY_STANDARD
    return _band(score)


def difficulty_for(
    learner: dict[str, Any],
    target_key: str = "",
    target_name: str = "",
    target_path: str = "",
    score: float | None = None,
    profile_id: str = "",
    prefer_evidence_role: bool = False,
) -> dict[str, str]:
    """返回 {'difficulty': '零基础|标准|进阶', 'reason': '...'}。

    - target_key 传证据包/业务侧稳定编号（如 K1）；也兼容按 target_name 关键字兜底。
    - score 若为空，取 learner.scores[target_key] 或 learner.scores[对应维度]。
    - prefer_evidence_role=True 仅用于离线证据回测，正式业务请保持 False。
    """
    role = _evidence_role(profile_id) if prefer_evidence_role else infer_role(learner)
    if not role:
        # 真实画像里没有 K 编号时，尝试按知识点名映射业务类别（本版暂以分数兜底）
        role = infer_role(learner)

    if score is None:
        score = float((learner.get("scores") or {}).get(target_key, 50))

    if not target_key:
        # 无法稳定定位业务类别时，保守回退阈值
        label = _band(score)
        return {"difficulty": label, "reason": f"无靶点编号，按分数 {score} 阈值分档", "role": role}

    label = _difficulty_by_role(role, target_key, score, target_name, target_path) if role else _band(score)
    role_label = role or "默认阈值"
    return {
        "difficulty": label,
        "reason": f"role={role_label}, target={target_key}({_classify_target(target_key, target_name, target_path)}), score={score}",
        "role": role,
    }