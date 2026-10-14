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


def reply_for(body):
    messages = body.get("messages") or []
    if has_image(messages):
        return "MOCK 图片描述：这是一张教学资料里的示意图，画的是提示词与输出之间的对应关系。"
    joined = all_text(messages)
    ask = text_of(messages)
    # 工具回路：第一次问算术 -> 发起工具调用；拿到工具结果后再给最终回答
    if "工具 calc 的结果" in joined:
        return "算出来的结果是 15（按 (12+8)*3/4 计算）[1]。"
    if "调用工具" in joined and ("计算" in ask or "算一下" in ask or "多少" in ask):
        return json.dumps({"tool": "calc", "args": {"expr": "(12+8)*3/4"}}, ensure_ascii=False)
    if "调用工具" in joined and ("几点" in ask or "现在时间" in ask or "今天几号" in ask):
        return json.dumps({"tool": "current_time", "args": {}}, ensure_ascii=False)
    if "answerIndex" in joined or ("单选题" in joined and "JSON 数组" in joined):
        return json.dumps(MC_QUESTIONS, ensure_ascii=False)
    if "JSON 字符串数组" in joined:
        return json.dumps(OUTLINE, ensure_ascii=False)
    if "分层练习题" in joined or "测评设计者" in joined:
        return QUIZ_MD
    if "撰写" in joined or "教培内容作者" in joined:
        # 把小节标题照抄进正文，模拟真模型的行为（内核应当把这一行去掉）
        m = re.search(r"讲义的第 \d+ 节：「([^」]+)」", joined)
        title = m.group(1) if m else "本节"
        return "## " + title + "\n\n" + SECTION_BODY
    return "MOCK_REPLY:" + ask[:80]


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
            content = reply_for(body)
            if body.get("stream"):
                self.sse(model, content)
            else:
                out = {
                    "id": "mock-chat",
                    "object": "chat.completion",
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
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
        step = 24
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