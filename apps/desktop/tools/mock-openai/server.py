"""本地 OpenAI 兼容 mock 服务，仅用于开发自测，不接入任何真实模型。

用法：python server.py [port]

它会按提示词判断内核想要什么，并返回**结构正确**的结果，这样整条链路
（检索 → 大纲 → 逐节写作 → 出题 → 引用自检 → 落盘 → 引用登记）都能在离网环境里跑通：

- 要「JSON 字符串数组」（大纲）→ 返回 3 个小节名
- 要「撰写第 n 节」（正文）→ 返回带 [1] 出处的 Markdown
- 要「单选题 / JSON 数组」（交互出题）→ 返回可解析的题目数组
- 要「分层练习题」（练习册）→ 返回带答案与解析的 Markdown
- 带 image_url 的请求（图片描述）→ 返回一句图片说明
- stream=true 时按真实供应商的样子回 SSE（含一行 `: PROCESSING` 前导与 reasoning_content 增量），
  stream=false 时回整体 JSON；两条路径都要能验证。

向量维度可通过环境变量调整，便于做真实规模下的容量验证。
"""
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer


EMBED_DIM = int(os.environ.get("ITN_MOCK_EMBED_DIM", "3"))
# 每段流式分片之间的间隔，用来模拟慢模型，验证内核能否并发处理其他请求
CHUNK_DELAY = float(os.environ.get("ITN_MOCK_CHUNK_DELAY_MS", "5")) / 1000.0

OUTLINE = ["第一节 基本概念", "第二节 典型流程", "第三节 常见问题与做法"]

# 正文（不含标题）：真模型写小节时通常会把小节标题再抄一遍，strip 掉的那行标题由 reply_for 加上
SECTION_BODY = """mock 模型依据资料写的一段正文，用来验证讲义链路。资料里强调过：把任务、约束和输出格式写清楚，产出会更稳定。[1]

### 做法

1. 先检索资料，再让模型作答。[1]
2. 每个论断后面标注出处编号。[2]

> 注意：这里的内容只用于自测，不是真实模型输出。"""

# 固定流水线 PPT 子 Agent 的自测提纲：6 个输入页，渲染器会按章节补 section 页。
PPT_AGENT_OUTLINE = {
    "title": "输入与输出的约定",
    "subtitle": "从可复现样例到可靠验收",
    "agendaPlan": [
        {"title": "先约定输入", "objective": "让任务边界可检查", "keyTopics": ["输入样例", "范围"]},
        {"title": "再做完整处理", "objective": "让过程可以复现", "keyTopics": ["执行", "证据"]},
        {"title": "最后验收结果", "objective": "让结果可以被判断", "keyTopics": ["边界", "复盘"]},
    ],
    "slides": [
        {"title": "输入与输出的约定", "kind": "title", "points": [],
         "speakerNotes": "大家好，今天我们围绕输入、输出和验收建立一套可以复现的约定。先明确任务边界，再观察执行过程，最后用证据判断结果是否可靠。"},
        {"title": "本讲路线", "kind": "agenda", "points": [
            {"heading": "先约定输入", "detail": "写清数据来源、格式和允许范围。"},
            {"heading": "再做完整处理", "detail": "记录关键中间结果和验证依据。"},
            {"heading": "最后验收结果", "detail": "用正常、边界和异常样例判断结果。"},
        ], "speakerNotes": "这次分享按三步推进：先约定输入，再做完整处理，最后用样例验收结果。"},
        {"title": "输入样例要能被检查", "kind": "concept", "points": [
            {"heading": "来源", "detail": "说明数据来自哪里，避免把猜测当成事实。"},
            {"heading": "格式", "detail": "给出字段、类型和允许取值，让程序可以直接读取。"},
            {"heading": "范围", "detail": "明确空值、极值和异常输入应该如何处理。"},
        ], "speakerNotes": "输入不是一句自然语言要求，而是可以检查的样例集合。来源决定事实边界，格式决定程序能否读取，范围决定异常是否会被遗漏。"},
        {"title": "把处理过程留下证据", "kind": "process", "process": [
            {"label": "读取", "detail": "校验输入并记录版本。"},
            {"label": "执行", "detail": "保存关键中间状态。"},
            {"label": "校验", "detail": "对照预期输出检查结果。"},
            {"label": "复盘", "detail": "记录失败原因和下一次改法。"},
        ], "points": [
            {"heading": "先校验", "detail": "读取后立刻检查字段和范围。"},
            {"heading": "留证据", "detail": "把中间状态与错误信息保存下来。"},
        ], "speakerNotes": "处理阶段最重要的是留下可追溯的证据。先校验输入，再执行操作，然后把关键中间状态保存下来，最后对照预期输出检查结果。"},
        {"title": "好约定与坏约定", "kind": "comparison", "points": [
            {"heading": "可验收", "detail": "输入、输出和失败条件都有明确样例。"},
            {"heading": "不可验收", "detail": "只要求尽量做好，没有可观察的判断依据。"},
        ], "speakerNotes": "可验收的约定会把输入、输出和失败条件都写成样例。相反，只写一句尽量做好，后续就无法判断结果到底是否达标。"},
        {"title": "结论与下一步", "kind": "conclusion", "points": [
            {"heading": "先写样例", "detail": "把正常、边界和异常输入写出来。"},
            {"heading": "再做验证", "detail": "保存结果和证据，按约定复盘。"},
        ], "speakerNotes": "最后记住两件事：先把正常、边界和异常样例写清楚，再用可复现的证据验证结果。这样每一次交付都能被检查和继续改进。"},
    ],
}
SECTION_MD = "## 基本概念\n\n" + SECTION_BODY

QUIZ_MD = """### 第 1 题（单选）

下面哪一项是资料里强调的做法？[1]

A. 不写约束
B. 把任务、约束和输出格式写清楚
C. 让模型自由发挥
D. 省略出处处

**答案：B**　**解析：** 资料里说写清楚任务、约束与输出格式，产出会更稳定。[1]

### 第 2 题（简答）

请用自己的话说明检索增强生成的基本流程。[1]

**答案：** 先切片并向量化，检索时按相似度取回相关片段，再连同问题交给模型作答。[2]
**解析：** 关键在于模型只能依据取回的片段作答。[2]"""

# 桌面版把"生成讲义/练习册"当成一次 agent 任务（/api/agent/task-pi），提示词只说成品是什么样。
# 这两份就是给那条链路用的"像成品"的回答：带小标题、带 [1] 出处、末尾带资料来源。
TASK_LECTURE_MD = """## 一、概念

提示词是给模型的输入指令：把任务、约束和输出格式写清楚，产出会更稳定。[1]

## 二、为什么

模型的输出空间很大，约束越明确，结果越可控。[1]

## 三、怎么做

1. 先查资料，再作答。[1]
2. 每个论断后面标出处编号。[2]

---

资料来源：[1] 《提示词工程》> 基本概念（01-提示词.md）　[2] 《检索增强生成》> 流程（02-RAG.md）
"""

TASK_QUIZ_MD = """### 第 1 题（单选）

下面哪一项是资料里强调的做法？[1]

A. 不写约束　B. 把任务、约束和输出格式写清楚　C. 让模型自由发挥　D. 省略出处

**答案：B**　**解析：** 把任务、约束与输出格式写清楚，产出会更稳定。[1]

### 第 2 题（简答）

请说明检索增强生成的基本流程。[2]

**答案：** 先切片并向量化，检索时按相似度取回相关片段，再连同问题交给模型作答。[2]

---

资料来源：[1] 《提示词工程》> 基本概念　[2] 《检索增强生成》> 流程
"""

MC_QUESTIONS = [
    {
        "question": "资料里说，写清楚任务、约束和输出格式会让模型的表现如何？",
        "options": ["更容易出错", "更稳定", "完全随机", "与提示词无关"],
        "answerIndex": 1,
        "explain": "资料中提到：把任务、约束和输出格式写清楚，模型的表现会更稳定。[1]",
        "source": "第一节 基本概念",
    },
    {
        "question": "检索增强生成的基本流程里，第一步是什么？",
        "options": ["先让模型自由发挥", "先把资料切片并向量化", "先写评测报告", "先做数据增强"],
        "answerIndex": 1,
        "explain": "先把资料切片并向量化，检索时按相似度取回相关片段。[2]",
        "source": "第二节 典型流程",
    },
    {
        "question": "为什么标注出处编号很重要？",
        "options": ["让页面好看", "方便把结论追回原文位置", "减少 token", "省去检索"],
        "answerIndex": 1,
        "explain": "标注出处编号后，每个结论都能指回资料原文位置。[2]",
        "source": "第二节 典型流程",
    },
]


def text_of(messages):
    """把请求里的最后一条用户消息取成纯文本，用于判断这次要什么。"""
    if not messages:
        return ""
    last = messages[-1].get("content")
    if isinstance(last, list):
        return " ".join(str(p.get("text") or "") for p in last if isinstance(p, dict))
    return str(last or "")


def all_text(messages):
    parts = []
    for m in messages:
        c = m.get("content")
        if isinstance(c, list):
            parts.append(" ".join(str(p.get("text") or "") for p in c if isinstance(p, dict)))
        else:
            parts.append(str(c or ""))
    return "\n".join(parts)


def has_image(messages):
    for m in messages:
        c = m.get("content")
        if isinstance(c, list) and any(isinstance(p, dict) and p.get("type") == "image_url" for p in c):
            return True
    return False


def _res_long_body(topic, i, title):
    """一段够长的讲义正文：带 [n] 引用，且含"示例/输入/输出/步骤/验证"这类具体性信号。"""
    return (
        "以「" + title + "」为例：先写清输入是什么、期望的输出是什么，再按步骤执行，最后逐条验证结果。[1]\n\n"
        "输入：一组可以重现的最小样例，例如把参数固定为默认值后只改一个字段；输出：能直接对照的结论或文件。[2]\n\n"
        "做法分三步：第一步把任务拆成能单独验证的小步；第二步每步都留下中间结果，出问题时能定位到具体一步；"
        "第三步用边界样例再跑一遍，确认限制条件与失败表现。[1]\n\n"
        "常见错误是把整个过程当成黑盒：一旦结果不对，只能整体重来。把中间状态写下来，既能定位错误，也方便别人复现。[2]\n\n"
        "验证方法：换一个人按这份说明从空目录做一遍；如果他不用口头提示也能得到同样结果，说明说明书写清楚了。[2]"
    )


def res_lecture_plan():
    sections = ["基本概念与适用范围", "输入与输出的约定", "按步骤执行", "中间状态怎么留证", "边界与失败表现", "验证与复盘"]
    chapters = [
        {"title": "第一部分 认识与准备", "introduction": "先把概念和边界说清楚，后面每一步才有判断依据。",
         "sections": [{"title": s} for s in sections[:3]]},
        {"title": "第二部分 执行与验证", "introduction": "把流程跑通，并且留下能复查的证据。",
         "sections": [{"title": s} for s in sections[3:]]},
    ]
    return {"title": "动手做一遍的完整讲义", "objective": "读完能独立按步骤完成一次任务并留下证据。",
            "objectives": ["说清输入与输出的约定", "按步骤完成一次执行", "用边界样例验证并复盘"],
            "chapters": chapters}


def res_lecture_full():
    plan = res_lecture_plan()
    for ch in plan["chapters"]:
        for sec in ch["sections"]:
            sec["content"] = _res_long_body("", 1, sec["title"])
        ch["summary"] = "这一章的重点是把判断依据写下来。"
    return plan


def res_practice():
    def step(title, instr, out, safety, warn=""):
        return {"title": title, "instruction": instr, "code": "", "expectedOutput": out, "safety": safety, "warning": warn}
    return {
        "title": "从零跑通一次完整流程",
        "objective": "照着做完一次可复现的执行，并留下输入、过程与输出的记录。",
        "estimatedMinutes": 60,
        "prerequisites": ["能创建和编辑文本文件", "读过本章讲义或了解基本术语"],
        "environment": ["任意可编辑 Markdown 的本地环境"],
        "steps": [
            step("准备输入与标准",
                 "新建一个以任务命名的练习目录，在 README.md 里写下这次任务的输入、处理步骤、预期输出和验收标准，并复制一份原始输入作为备份，确认主目录与副本都在。",
                 "README.md 能看清输入与完成标准，原始输入有备份。", "caution", "先确认输入不含敏感信息。"),
            step("按最小样例执行一次",
                 "用最小的一个样例执行完整流程，把每一步的输入、关键中间状态、输出和耗时写进 result.md；如果中途失败，保留完整错误信息并按发生位置定位原因，修改后重新执行。",
                 "result.md 有一组从输入到输出的完整记录，重复执行结果一致。", "safe"),
            step("换成边界样例再执行",
                 "把样例换成边界情况（最小、最大、异常输入各一个）再执行一遍，记录每一步输出与最终结果，说明从哪一步开始与预期不一致。",
                 "result.md 至少两组完整记录，能区分正常路径与边界路径。", "safe"),
            step("验收与复盘",
                 "依据 README.md 里的标准逐条验收，对不满足项写明证据和修复动作；再补一段复盘，说明当前方案的适用条件、一个已知限制、一个常见错误及改进方向。",
                 "每条验收标准都有结论和证据，复盘里有明确的限制与改进方向。", "safe"),
        ],
        "safetyChecklist": ["已备份原始输入与当前成果", "已确认输入中不含不应使用的敏感信息"],
        "safetyNotice": "改动文件前先留副本；涉及真实账号或生产数据时，先在测试环境验证。",
        "acceptanceCriteria": ["输入、过程和输出记录完整，别人照着能复现", "最小样例与边界样例都有明确结果和判断依据",
                               "至少记录一个限制、一个错误及对应修复动作"],
        "troubleshooting": [
            {"problem": "执行结果与预期不一致", "solution": "从输入字段、参数、中间状态到输出逐项比对，用最小样例定位第一处偏差。"},
            {"problem": "别人无法按文档复现", "solution": "补齐环境版本、文件位置与完整命令，并在空目录里重新走一遍。"},
        ],
        "challenge": "换一个与现有样例不同的异常输入，先预测结果再执行验证，并说明流程需要怎样调整。",
    }


def res_quiz_kp():
    return {"knowledgePoints": [
        {"id": "kp-1", "name": "输入与输出的约定", "description": "判断什么是输入、什么算完成。"},
        {"id": "kp-2", "name": "中间状态留证", "description": "判断出错时能否定位到具体一步。"},
        {"id": "kp-3", "name": "边界样例", "description": "判断方案在极端情况下是否仍然成立。"},
    ]}


def res_quiz_questions(n, topic):
    diff = ["easy", "medium", "hard"]
    out = []
    for i in range(n):
        target = i % 4
        correct = "先写清输入与完成标准，再执行并留下中间结果"
        options = [
            "先扩大任务范围，再决定要验证什么",
            "只记录最终结论，不保留输入与过程",
            "忽略边界条件，只要一次成功即可",
        ]
        options.insert(target, correct)
        out.append({
            "id": "q-" + str(i + 1),
            "knowledgePointId": "kp-" + str(i % 3 + 1),
            "difficulty": diff[i % 3],
            "stem": "在「" + topic + "」的第 " + str(i + 1) + " 个练习场景里，哪种做法最能让结论可复现、可验证？",
            "options": options,
            "correctIndex": target,
            "explanation": "正确做法同时保留输入、过程、输出与验收依据，所以别人能复现、出错能定位；其余做法会丢掉证据、扩大不确定性或忽略边界风险。",
        })
    return {"title": topic + "分阶测试", "questions": out}


def res_ppt(n, topic):
    slides = []
    for i in range(n):
        slides.append({
            "title": "第 " + str(i + 1) + " 页 · " + topic + " 要点" + str(i + 1),
            "bullets": ["要点一：先写清输入与输出", "要点二：每步留下中间结果",
                        "要点三：用边界样例验证"],
            "speakerNote": "这一页讲清第 " + str(i + 1) + " 个要点，并给一个最小例子说明它为什么重要。",
        })
    return {"title": topic + "演示稿", "subtitle": "一页一个要点", "slides": slides}


def _res_count(prompt, default):
    m = re.search(r"正好 (\d+) ", prompt)
    return int(m.group(1)) if m else default


# 自检开关：ITN_MOCK_THIN_FIRST=1 时，讲义大纲第一次故意给薄（1 章 1 节），
# 用来验证内核的质检→返修链路真的会跑（而不是摆设）。
_THIN_LEFT = 1 if os.environ.get("ITN_MOCK_THIN_FIRST") else 0


def _thin_lecture_plan():
    return {"title": "太薄的大纲", "chapters": [{"title": "只有一章", "sections": [{"title": "只有一节"}]}]}





def reply_for(body):
    messages = body.get("messages") or []
    # 会话命名器：内核第一次提问后会另起一次很小的请求让模型给会话起名。
    # 这里回一个"带引号又带句号"的名字，正好用来验清洗逻辑（见 cleanSessionTitle）。
    if "只输出名字本身" in all_text(messages):
        return '"Mock 会话名。"'
    if body.get("model") == "text-only" and has_image(messages):
        return "这个测试模型不能查看图片"
    if has_image(messages) and "验证码" in all_text(messages):
        return "K7-P4，左侧红色正方形，右侧蓝色圆形。"
    if has_image(messages):
        return "MOCK 图片描述：这是一张教学资料里的示意图，画的是提示词与输出之间的对应关系。"
    joined = all_text(messages)
    ask = text_of(messages)
    # ---- 四种资源（桌面版内核的新链路）----
    if "你是内容质检员" in joined:
        # 返修：按 resourceType 回一份"肯定能过质检"的内容
        if "resourceType: practice" in joined:
            return json.dumps(res_practice(), ensure_ascii=False)
        if "resourceType: quiz" in joined:
            m = re.search(r"应为 (\d+) 题", joined)
            n = int(m.group(1)) if m else 6
            fixed = res_quiz_questions(n, "返修主题")
            fixed.update(res_quiz_kp())
            return json.dumps(fixed, ensure_ascii=False)
        if "resourceType: ppt" in joined:
            return json.dumps(res_ppt(_res_count(joined, 8), "返修主题"), ensure_ascii=False)
        return json.dumps(res_lecture_full(), ensure_ascii=False)
    if "请设计一份内容充实、可直接授课或汇报的交互课件" in joined:
        return json.dumps(PPT_AGENT_OUTLINE, ensure_ascii=False)
    if "你是课程设计者" in joined:
        global _THIN_LEFT
        if _THIN_LEFT > 0:
            _THIN_LEFT -= 1
            return json.dumps(_thin_lecture_plan(), ensure_ascii=False)
        return json.dumps(res_lecture_plan(), ensure_ascii=False)
    if "你是实训导师" in joined:
        return json.dumps(res_practice(), ensure_ascii=False)
    if "你是演示稿设计者" in joined:
        return json.dumps(res_ppt(_res_count(joined, 8), "演示主题"), ensure_ascii=False)
    if "你是测评设计者" in joined or ('"knowledgePoints"' in ask and '"questions"' in ask):
        if '"questions"' in joined:
            result = res_quiz_questions(_res_count(joined, 3), "测试主题")
            if '"knowledgePoints"' in joined: result.update(res_quiz_kp())
            return json.dumps(result, ensure_ascii=False)
        return json.dumps(res_quiz_kp(), ensure_ascii=False)
    if "（属于《" in joined:
        # 桌面版四种资源的讲义逐节写作：回一段够长、带引用、带具体性信号的正文（开头那行标题故意重复，考验内核去重）
        m = re.search(r"讲义的第 \d+ 节：「([^」]+)」", joined)
        title = m.group(1) if m else "本节"
        return "## " + title + "\n\n" + _res_long_body("", 1, title)
    # 工具回路：第一次问算术 -> 发起工具调用；拿到工具结果后再给最终回答
    if "工具 calc 的结果" in joined:
        return "算出来的结果是 15（按 (12+8)*3/4 计算）[1]。"
    if "调用工具" in joined and ("计算" in ask or "算一下" in ask or "多少" in ask):
        return json.dumps({"tool": "calc", "args": {"expr": "(12+8)*3/4"}}, ensure_ascii=False)
    if "调用工具" in joined and ("几点" in ask or "现在时间" in ask or "今天几号" in ask):
        return json.dumps({"tool": "current_time", "args": {}}, ensure_ascii=False)
    if "表格渲染测试" in joined:
        return ("下面是对照表：\n\n"
                "| 做法 | 优点 | 风险 |\n"
                "| :--- | :---: | ---: |\n"
                "| 先定输入输出 | 可复现 `run.sh` | 前期多花几分钟 |\n"
                "| 边做边补文档 | 上手快 | 边界容易漏 |\n\n"
                "- [x] 已写清输入\n"
                "- [ ] 补边界样例\n\n"
                "详见 [文档](https://example.com/docs)，~~旧版本已废弃~~。")
    if "answerIndex" in joined or ("单选题" in joined and "JSON 数组" in joined):
        return json.dumps(MC_QUESTIONS, ensure_ascii=False)
    if "JSON 字符串数组" in joined:
        return json.dumps(OUTLINE, ensure_ascii=False)
    if "做成一份讲义" in joined:
        return TASK_LECTURE_MD
    if "出一份练习册" in joined:
        return TASK_QUIZ_MD
    if "分层练习题" in joined or "测评设计者" in joined:
        return QUIZ_MD
    if "撰写" in joined or "教培内容作者" in joined:
        # 把小节标题照抄进正文，模拟真模型的行为（内核应当把这一行去掉）
        m = re.search(r"讲义的第 \d+ 节：「([^」]+)」", joined)
        title = m.group(1) if m else "本节"
        return "## " + title + "\n\n" + SECTION_BODY
    return "MOCK_REPLY:" + ask[:80]


def native_reply(body):
    if not body.get("tools"):
        return reply_for(body)
    msgs = body.get("messages") or []
    if has_image(msgs):
        return reply_for(body)
    user_at = max((i for i, m in enumerate(msgs) if m.get("role") == "user"), default=-1)
    ask = text_of([msgs[user_at]]) if user_at >= 0 else ""
    def call(name, args):
        return {"tool_calls": [{"id": "mock-call-1", "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}
    # 慢速任务：验"一段会话在跑时，另一段会话照常新建/提问/插话"（每段自己跑自己的）
    joined_all = "\n".join(text_of([m]) for m in msgs)
    if "慢速任务测试" in joined_all:
        time.sleep(float(os.environ.get("ITN_MOCK_SLOW_MS", "10000")) / 1000.0)
        if "插话测试" in joined_all:
            return "慢速任务完成：收到插话。"
        if any(m.get("role") == "tool" for m in msgs[user_at + 1:]):
            return "慢速任务完成：没有插话。"
        return call("calc", {"expr": "1+1"})
    if any(m.get("role") == "tool" for m in msgs[user_at + 1:]):
        last_tools = [m for m in msgs[user_at + 1:] if m.get("role") == "tool"]
        # "读原文"：从上一轮检索结果的 `id: 路径#序号` 里取出切片 id 再读全文（读过了就收尾）。
        # 用来端到端验通用模式下的 read_chunk（没绑定知识库时要在全部已建索引的库里找）。
        if "读原文" in ask and not any("读到切片" in str(m.get("content")) for m in last_tools):
            for m in reversed(last_tools):
                mm = re.search(r"id:\s*([^\n#]+?)#(\d+)", str(m.get("content")))
                if mm:
                    return call("read_chunk", {"chunk_id": mm.group(1) + "#" + mm.group(2)})
        if any(m.get("name") == "kb_search" or "命中" in str(m.get("content")) for m in last_tools):
            return "提示词要写清任务、约束和输出格式；使用资料时标注出处，方便回到原文核实 [1]。"
        return "已完成工具调用，可在右侧成果中查看。"
    # 知识点自动记录：内核的 record_knowledge_point 工具（quote 必须是本轮用户原话的逐字片段）
    # 知识网络可见性：真实模型对“你能看到我的知识网络吗”会用空 query 发起检索；旧版会拿到空数组并误报“0 条”。
    if "知识网络可见性测试" in ask:
        return {"tool_calls": [
            {"id": "mock-call-1", "type": "function", "function": {"name": "get_learning_context", "arguments": "{}"}},
            {"id": "mock-call-2", "type": "function", "function": {"name": "search_personal_resources", "arguments": json.dumps({"query": ""})}},
        ]}
    if "知识点别名测试" in ask:
        return call("record_knowledge_point", {"title": "I/O 约定", "definition": "别名合并测试用的定义。", "quote": "请解释输入与输出", "note": "用已有知识点的确切别名发起记录。"})
    if "知识点测试" in ask:
        return call("record_knowledge_point", {"title": "输入与输出", "definition": "输入与输出是一种约定：先写清输入样例与期望输出，再执行并保留验证依据。", "quote": "请解释输入与输出的约定", "note": "本轮讨论了输入与输出的约定，并保留了一个具体例子。", "aliases": ["I/O 约定"]})
    if 'PPTX_AGENT' in ask:
        return call('create_presentation', {'requirement':'围绕输入、输出与验收制作一份 6 页交互课件，面向初学者，课堂讲解，简洁清新。','title':'输入与输出的约定','audience':'初学者','purpose':'课堂讲解','style':'简洁清新','backgroundStyle':'clean-minimal','language':'zh-CN','slideCount':6,'aspectRatio':'16:9','detailLevel':'balanced','includeSpeakerNotes':True})
    if 'PPTX_BRIDGE' in ask or 'create_presentation' in ask:
        return call('create_presentation', {'title':'输入与输出的约定','audience':'初学者','purpose':'课堂讲解','style':'简洁墨绿','slides':[
            {'title':'输入与输出的约定','layout':'cover','notes':'介绍今天的学习目标。'},
            {'title':'先把约定写清楚','layout':'bullets','bullets':['给出输入样例','明确期望输出','保留验证依据'],'notes':'引导学生先写输入和输出。'},
            {'title':'好约定与坏约定','layout':'comparison','columns':[{'title':'明确','body':'字段、边界和输出格式都有示例。'},{'title':'含糊','body':'只有一句尽量做好，没有验收依据。'}],'notes':'用两种写法对比说明。'},
            {'title':'把一次执行做完整','layout':'process','bullets':['约定输入','执行并记录','验证并复盘'],'notes':'总结三个步骤。'}]})
    session_link = re.search(r"lumin://thread/([A-Za-z0-9_-]+)", ask)
    if session_link:
        return call("read_session", {"session_id": session_link.group(0)})
    if "记住：" in ask:
        text = ask.split("记住：", 1)[1]
        return call("remember_learning_fact", {"kind": "preference", "text": text, "quote": text})
    if "修改资源" in ask:
        match = re.search(r"res-\d+", ask)
        if match:
            return call("revise_learning_resource", {"id": match.group(), "baseVersion": 1, "instruction": ask})
    kind = None
    for token, value in [("lecture", "lecture"), ("practice", "practice"), ("quiz", "quiz"), ("ppt", "ppt"), ("讲义", "lecture"), ("实操", "practice"), ("分阶测试", "quiz"), ("练习册", "quiz"), ("演示", "ppt")]:
        if token in ask:
            kind = value
            break
    if kind and any(x in ask for x in ("生成", "做成", "make:", "出一份")):
        match = re.search(r"(?:题量或页数 |count:)(\d+)", ask)
        count = int(match.group(1)) if match else (4 if kind == "quiz" else 8)
        topic_match = re.search(r"主题[「：]([^」]+)", ask)
        topic = topic_match.group(1) if topic_match else "输入与输出"
        return call("generate_learning_resource", {"kind": kind, "topic": topic, "detail": "balanced", "count": count})
    # 通用模式的两个资料工具（会话没绑定知识库）：列资料 / 先检索再读原文
    if any(t in ask for t in ("列资料", "有哪些资料", "资料清单")):
        return call("list_documents", {})
    if "读原文" in ask:
        return call("kb_search", {"query": "MCP", "top_k": 3})
    if any(t in ask for t in ("提示词", "资料", "这门课")) and not kind:
        return call("kb_search", {"query": "提示词", "top_k": 4})
    if "计算" in ask or "算一下" in ask:
        return call("calc", {"expr": "(12+8)*3/4"})
    # 写文件：用来验"这一轮改了哪些文件 + 逐文件 +/-"那张卡（details 里带 path/add/del）
    if "写个文件" in ask or "写文件测试" in ask:
        return call("write", {"path": "mock-test.md", "content": "# 测试文件\n\n第一行\n第二行\n第三行\n"})
    return reply_for(body)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        body = json.loads(raw) if raw else {}

        if self.path.endswith("/chat/completions"):
            model = body.get("model", "mock")
            logpath = os.environ.get("ITN_MOCK_LOG")
            if logpath:
                msgs = body.get("messages") or []
                rec = {"model": model, "stream": bool(body.get("stream")),
                       "roles": [m.get("role") for m in msgs], "n": len(msgs)}
                with open(logpath, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            content = native_reply(body)
            if body.get("stream"):
                self.sse(model, content)
            else:
                out = {
                    "id": "mock-chat",
                    "object": "chat.completion",
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "message": ({"role": "assistant", "content": None, **content} if isinstance(content, dict) else {"role": "assistant", "content": content}),
                        "finish_reason": "stop",
                    }],
                }
                self.json(out)
            return

        if self.path.endswith("/embeddings"):
            items = body.get("input")
            if isinstance(items, str):
                items = [items]
            items = items or []
            out = {
                "object": "list",
                "model": body.get("model", "mock-embed"),
                "data": [
                    {"object": "embedding", "index": i,
                     "embedding": [float((len(t) + i + j) % 7) / 7.0 for j in range(EMBED_DIM)]}
                    for i, t in enumerate(items)
                ],
            }
            self.json(out)
            return

        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def json(self, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def sse(self, model, content):
        """按真实供应商的样子分块下推，并先发一行注释前导。"""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(b": PROCESSING\n\n")
        self.wfile.flush()
        head = {"id": "mock-chat", "object": "chat.completion.chunk", "model": model,
                "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]}
        self.wfile.write(("data: " + json.dumps(head, ensure_ascii=False) + "\n\n").encode("utf-8"))
        if isinstance(content, dict):
            chunk = {"id": "mock-chat", "object": "chat.completion.chunk", "model": model,
                     "choices": [{"index": 0, "delta": {"tool_calls": [{"index": i, **c} for i, c in enumerate(content["tool_calls"])]}, "finish_reason": "tool_calls"}]}
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        # 真供应商会先推一段推理内容（reasoning_content）。这里也推一小段，
        # 好让"思考过程"那一块在自检里真的被渲染出来（否则前端那条路径没人验）。
        initial_delay = float(os.environ.get('ITN_MOCK_SILENT_MS', '0')) / 1000.0
        if initial_delay:
            time.sleep(initial_delay)
        step = 24
        think = "先看懂问题，再决定要不要检索。"
        for i in range(0, len(think), step):
            piece = think[i:i + step]
            chunk = {"id": "mock-chat", "object": "chat.completion.chunk", "model": model,
                     "choices": [{"index": 0, "delta": {"reasoning_content": piece}, "finish_reason": None}]}
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()
            time.sleep(CHUNK_DELAY)
        for i in range(0, len(content), step):
            piece = content[i:i + step]
            chunk = {"id": "mock-chat", "object": "chat.completion.chunk", "model": model,
                     "choices": [{"index": 0, "delta": {"content": piece, "reasoning_content": None}, "finish_reason": None}]}
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()
            time.sleep(CHUNK_DELAY)
        tail = {"id": "mock-chat", "object": "chat.completion.chunk", "model": model, "choices": []}
        self.wfile.write(("data: " + json.dumps(tail, ensure_ascii=False) + "\n\n").encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9999
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()