"""出题 Prompt 模板（DESIGN v2 §11 / §16）.

- 难度 rubric 五级定义（Generator 与 Reviewer 共用同一套标准）
- 强制 LLM 返回严格 JSON，且每题必须给出 evidence_chunk_ids
"""
from __future__ import annotations

from questionbank.services.knowledge_core.schemas import KnowledgeContext

DIFFICULTY_RUBRIC = """难度分级标准（生成题目时按此 rubric 定难度）：
1 —— 直接识别 / 定义 / 事实回忆，几乎不需要推理
2 —— 单知识点理解，简单判断
3 —— 单知识点应用，轻度场景推理
4 —— 多条件 / 多知识组合，较强分析（可结合前置知识）
5 —— 复杂迁移，综合推理，深层分析（需结合前置与相关知识）"""

SYSTEM_PROMPT = f"""你是一名严谨的学科出题专家，负责基于给定的知识证据生成高质量题目。

规则：
1. 只允许使用下方 Evidence 中提供的事实出题，严禁编造证据之外的内容。
2. 每道题必须给出 evidence_chunk_ids：引用你依据的证据切片（chunk_id 数字或 ragflow_chunk_id 字符串），
   只允许引用给定 Evidence 中存在的 id，禁止自创。
3. 认知层级取值：remember / understand / apply / analyze / evaluate / create。
4. 答案必须明确且无歧义。
5. 解析必须是一段完整可读的话：直接讲清该题的知识点与每个选项对/错的依据，
   证据内容融入文字，不出现「证据显示」「根据证据」等字样开头。
   引用证据编号时用方括号直接跟在相关内容之后（如「…作为参数[1299]」），
   不要写成（id=1299）或「证据[xx]显示：」形式。
   参考解析风格：
   「ToolExecutor的registerTool方法接受名称、描述和可调用的执行函数作为参数[1299]；
   API密钥在工具函数内部处理（如search函数中通过环境变量获取[1298]），
   历史记录和最大步数是ReActAgent的构造参数[1302]」
6. 直接输出 JSON 结果，不要输出任何思考过程、解释或前后缀文字。

{DIFFICULTY_RUBRIC}

输出要求：只输出一个 JSON 对象，不要输出任何其他文字：
{{
  "questions": [
    {{
      "question_type": "single_choice",
      "difficulty": 1-5,
      "cognitive_level": "remember|understand|apply|analyze",
      "stem": "题干",
      "options": [{{"key": "A", "content": "选项内容"}}],   // 选择题必填，≥2 项
      "reference_answer": ["B"],
      "explanation": "解析（一段完整可读的话，编号用[1299]形式，不要'证据显示'开头）",
      "primary_category_id": 目标知识点ID,
      "secondary_category_ids": [前置/相关知识ID],
      "evidence_chunk_ids": ["1024", "rag_882"]
    }}
  ]
}}

各题型 reference_answer 格式（严格遵守，这是最常见错误）：
- single_choice：恰好 1 个选项字母，如 ["B"]
- multiple_choice：至少 2 个不同的选项字母，如 ["A", "C"]
- true_false：只能是 ["true"] 或 ["false"]，严禁使用选项字母（如 ["A"] 是错误格式）
- short_answer：参考答案文本，如 ["工具通过 JSON Schema 定义"]"""


def build_user_prompt(
    context: KnowledgeContext,
    *,
    question_type: str | None,
    difficulty: int,
    cognitive_level: str | None,
    count: int,
) -> str:
    """组装用户提示：知识点 + 前置 + 证据 + 生成要求."""
    lines: list[str] = []
    kp = context.knowledge_point
    lines.append(f"# 目标知识点\nID={kp.id}，名称：{kp.name}")

    if context.prerequisites:
        prereq = "、".join(f"{p.name}(ID={p.id})" for p in context.prerequisites[:10])
        lines.append(f"\n# 前置知识（可结合出难题，非必须）\n{prereq}")

    if context.contrasts:
        contrast_names = "、".join(c.name for c in context.contrasts[:10] if c.name)
        if contrast_names:
            lines.append(f"\n# 易混淆知识点\n干扰项优先改编自以下易混概念：{contrast_names}")

    lines.append("\n# Evidence（只能依据这些切片出题）")
    for idx, ev in enumerate(context.evidence[:8], start=1):
        ref = ev.chunk_id if ev.chunk_id > 0 else (ev.ragflow_chunk_id or "rag")
        content = ev.content.strip()[:900]
        source = ev.source
        lines.append(f"[{idx}] id={ref} (source={source})\n{content}")

    requirements: list[str] = [f"生成 {count} 道题目"]
    if question_type:
        requirements.append(f"题型：{question_type}")
    else:
        requirements.append("题型：可在四种题型中自行选择（建议以 single_choice / multiple_choice 为主）")
    requirements.append(f"难度：{difficulty}")
    if cognitive_level:
        requirements.append(f"认知层级：{cognitive_level}")
    lines.append("\n# 生成要求\n" + "；".join(requirements))
    lines.append("\n请输出 JSON。")
    return "\n".join(lines)
