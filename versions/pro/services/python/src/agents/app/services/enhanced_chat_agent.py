"""Enhanced Chat Agent - plan, retrieve, execute tools, generate."""
import json
import re
from collections.abc import AsyncIterator
from typing import Any
import app.tools
from app.services.knowledge_decision import KnowledgeDecisionClient
from app.llm import LLMClient
from app.tools.base import tool_registry
from app.services.refusal import detect_refusal, refusal_banner_message

_CITATION_RE = re.compile(r"\[\^(\d+)\^\]")

_TOOL_RESULT_MAX_CHARS = 20000
_RAG_MIN_RESULTS = 1       # RAG 返回 ≥1 条高相似度结果时视为"充分"
_RAG_MIN_SIMILARITY = 0.2  # 综合相似度阈值（0.4 太严，会导致命中但低于阈值的提问也走工具循环，看不到 Agent 卡片）
_ANCHOR_RE = re.compile(r"\[\[ANCHOR:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\]")  # [[ANCHOR:source_id,start,end]]


def _smart_preview(result: Any) -> str:
    """Generate a human-friendly preview string from a tool result."""
    if isinstance(result, str):
        return result
    if not isinstance(result, dict):
        return str(result)
    if result.get("error"):
        return str(result["error"])
    # Time tool: show datetime + weekday
    if result.get("datetime"):
        parts = [result["datetime"]]
        if result.get("weekday"):
            parts.append(result["weekday"])
        return " ".join(parts)
    # Search results: show count + query
    if "count" in result and "query" in result:
        return f"找到 {result['count']} 条与「{result['query']}」相关的结果"
    # Anything with a title
    if result.get("title"):
        return str(result["title"])
    # Fallback: compact JSON (truncate)
    return json.dumps(result, ensure_ascii=False, separators=(",", ":"))


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            part.get("text", "") for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    return ""


def _extract_sources(tool_name: str, result: dict) -> list[dict]:
    """Extract source items from a tool result."""
    items: list[dict] = []
    if not isinstance(result, dict) or not result.get("success"):
        return items
    src = result.get("source", tool_name)
    if src == "ragflow":
        for c in result.get("chunks") or []:
            items.append({
                "type": "rag", "document": c.get("document") or "",
                "content": c.get("content") or "", "similarity": c.get("similarity", 0),
                "chunk_id": c.get("chunk_id") or "",
            })
    elif src == "tavily":
        for r in result.get("results") or []:
            items.append({
                "type": "web", "title": r.get("title") or "",
                "url": r.get("url") or "", "content": r.get("content") or "",
            })
    elif src == "url_fetch" and result.get("url"):
        items.append({
            "type": "url", "title": result.get("title") or result["url"],
            "url": result["url"], "content": result.get("summary") or "",
        })
    return items


def _validate_citations(content: str, sources: dict[int, dict]) -> list[dict]:
    """Validate citation markers in generated content against known sources.

    Returns a list of {id, valid, source_type, confidence, snippet} for each
    unique citation found in the content.
    """
    cited_ids = {int(m) for m in _CITATION_RE.findall(content)}
    results = []
    for sid in sorted(cited_ids):
        src = sources.get(sid)
        if not src:
            results.append({"id": sid, "valid": False, "source_type": None,
                            "confidence": 0, "snippet": ""})
            continue
        sim = src.get("similarity", 0)
        results.append({
            "id": sid,
            "valid": True,
            "source_type": src.get("type"),
            "confidence": round(sim, 3) if sim else None,
            "snippet": (src.get("content") or "")[:120],
        })
    return results


def _slice_by_offset(content: str, start: int, end: int) -> str:
    """按偏移量精确切片原文；越界自动 clamp，返回非空字符串。
    如果切出的片段是 markdown 代码块片段（以 ``` 开头但没有 ``` 闭合），
    自动补齐闭合围栏，避免 marked 渲染时把后续文字误当成代码块。
    """
    if not content or start is None or end is None:
        return ""
    n = len(content)
    s = max(0, min(int(start), n))
    e = max(s + 1, min(int(end), n))
    snippet = content[s:e].strip()
    # 检测：切出的片段以代码块围栏开头（``` 或 ```lang），但没有闭合围栏
    if snippet.startswith('```'):
        # 找到第一个换行后的内容（语言标记之后）
        first_newline = snippet.find('\n')
        after_fence = first_newline + 1 if first_newline > 0 else 0
        # 检查切出的部分是否已经包含闭合围栏（在剩下内容里）
        rest_after_open = snippet[after_fence:]
        # 闭合围栏必须在新行上（避免误判代码里包含 ``` 的情况）
        if '\n```' not in rest_after_open:
            snippet = snippet + '\n```'
    return snippet


def _find_first_incomplete_anchor(buf: str) -> int:
    """返回 buf 中第一个未闭合 [[ANCHOR: 的起始下标；如果全部闭合返回 -1。

    必须用正则扫描全部已闭合锚点，最后一个闭合锚点的结束下标之前的内容是"安全的"，
    之后如果有 [[ANCHOR: 但未闭合就是 pending 区。
    此外还要检测"截断的 [[ANCH"——长度 < len('[[ANCHOR:') 的疑似锚点开头也算未闭合。
    """
    last_closed_end = 0
    for m in _ANCHOR_RE.finditer(buf):
        last_closed_end = m.end()
    # 找 last_closed_end 之后第一个 "["，检查是否是未闭合的锚点开头
    rest = buf[last_closed_end:]
    # 用最小前缀 "[[ANCHOR:" 检测
    pref = '[[ANCHOR:'
    # 查找最后出现的 "[[" —— 锚点必须以 "[[" 开头
    cut_idx = -1
    pos = 0
    while True:
        i = rest.find('[[', pos)
        if i < 0:
            break
        # 检查从这里开始的字符是否是 "[[ANCHOR:" 的前缀
        ok = True
        for k in range(min(len(pref), len(rest) - i)):
            if rest[i + k] != pref[k]:
                ok = False
                break
        if ok:
            cut_idx = last_closed_end + i
            break
        pos = i + 1
    return cut_idx


def _drain_anchor_stream(buf: str, sources: dict[int, dict]) -> tuple[str, str]:
    """流式锚点解析：
    1) 扫描 buf 中所有已闭合的 [[ANCHOR:...]]，按 sid+start+end 切片原文替换为片段并追加 [^N^]；
    2) 已闭合锚点之前的内容保留为衔接文本原样输出；
    3) 第一个未闭合的 "[[ANCHOR:" 起始位置之后的内容留作 pending_buf，下次继续解析。
    返回 (已解析文本, 新 pending_buf)。
    """
    cut = _find_first_incomplete_anchor(buf)
    if cut < 0:
        # 全部闭合（或没有潜在锚点），整段可解析
        safe = buf
        pending = ""
    else:
        safe = buf[:cut]
        pending = buf[cut:]

    last_end = 0
    pieces: list[str] = []
    for m in _ANCHOR_RE.finditer(safe):
        if m.start() > last_end:
            pieces.append(safe[last_end:m.start()])
        sid = int(m.group(1)); start = int(m.group(2)); end = int(m.group(3))
        src_obj = sources.get(sid)
        if not src_obj:
            pieces.append("")
        else:
            snippet = _slice_by_offset(src_obj.get("content", ""), start, end)
            if snippet:
                # 原文片段 + 引用标记（前端 Markdown 才能识别为可点击的引用标注）
                pieces.append(snippet + f" [^{sid}^]")
            else:
                pieces.append("")
        last_end = m.end()
    if last_end < len(safe):
        pieces.append(safe[last_end:])
    return "".join(pieces), pending


def _resolve_anchors_in_text(raw: str, sources: dict[int, dict]) -> tuple[str, dict[int, dict]]:
    """后置解析 LLM 流式输出中的 [[ANCHOR:sid,start,end]] 占位符：
    按 sid+start+end 从 sources 原文精确切片替换；锚点间/外的文字（含衔接词）原样保留。
    替换后自动在原文片段末尾追加 [^N^] 引用标记，供前端 Markdown 渲染为可点击标注。
    返回 (最终文本, 被引用过的 sources)。
    """
    used_sids: dict[int, dict] = {}
    last_end = 0
    pieces: list[str] = []
    for m in _ANCHOR_RE.finditer(raw):
        if m.start() > last_end:
            pieces.append(raw[last_end:m.start()])
        sid = int(m.group(1)); start = int(m.group(2)); end = int(m.group(3))
        src_obj = sources.get(sid)
        if not src_obj:
            pieces.append("")
        else:
            snippet = _slice_by_offset(src_obj.get("content", ""), start, end)
            if snippet:
                pieces.append(snippet + f" [^{sid}^]")
                used_sids[sid] = src_obj
            else:
                pieces.append("")
        last_end = m.end()
    if last_end < len(raw):
        pieces.append(raw[last_end:])
    return "".join(pieces).strip(), used_sids



class EnhancedChatAgent:
    def __init__(self, llm: LLMClient, settings, max_iterations: int = 4, provider: str = "kimi"):
        self.llm = llm; self.settings = settings; self.max_iterations = max(1, max_iterations)
        self.provider = provider

    @staticmethod
    def _available_tools(): return tool_registry.list_available()

    async def stream(self, messages, include_reasoning=False, user_id=None) -> AsyncIterator[dict]:
        user_msg = next((_text_of(m["content"]) for m in reversed(messages) if m["role"] == "user"), "")
        yield {"type": "phase", "phase": "plan", "message": "正在分析问题…"}

        sources: dict[int, dict] = {}
        source_counter = 1

        # --- RAG-first retrieval (emit as visible tool call) ---
        rag_tool = tool_registry.get("rag_search")
        rag_query = user_msg[:200]
        rag_chunks: list[dict] = []
        rag_sufficient = False

        if user_id and self.settings.knowledge_resolve_enabled:
            yield {"type": "tool_call_started", "tool": "knowledge_resolve",
                   "name": "知识决策检索", "arguments": {"query": rag_query, "top_k": 5}}
            decision_result = await KnowledgeDecisionClient(self.settings).retrieve(rag_query, user_id, top_k=5)
            rag_chunks = decision_result.get("chunks") or []
            rag_sufficient = bool(rag_chunks)
            normalized = {**decision_result, "source": "ragflow"}
            yield {"type": "tool_call_completed", "tool": "knowledge_resolve",
                   "name": "知识决策检索", "success": rag_sufficient,
                   "preview": (f"{decision_result.get('retrieval_stage')} 阶段命中 {len(rag_chunks)} 条"
                               if rag_sufficient else "知识决策服务未命中，继续使用原有知识库检索"),
                   "result": json.dumps(decision_result, ensure_ascii=False)[:12000],
                   "sources": _extract_sources("rag_search", normalized)}
            for item in _extract_sources("rag_search", normalized):
                sid = source_counter; source_counter += 1
                item["id"] = sid
                sources[sid] = item

        if not rag_chunks and rag_tool and rag_tool.available:
            yield {"type": "tool_call_started", "tool": "rag_search",
                   "name": rag_tool.name, "arguments": {"query": rag_query, "top_k": 5}}
            try:
                rag_result = await rag_tool.execute({"query": rag_query, "top_k": 5})
            except Exception as exc:
                rag_result = {"success": False, "error": str(exc)}

            if rag_result.get("success"):
                rag_chunks = rag_result.get("chunks") or []
                good = [c for c in rag_chunks if c.get("similarity", 0) >= _RAG_MIN_SIMILARITY]
                rag_sufficient = len(good) >= _RAG_MIN_RESULTS

            is_err = not rag_result.get("success")
            if is_err:
                preview = str(rag_result.get("error", "检索失败"))[:120]
            else:
                top_sim = rag_chunks[0].get("similarity", 0) if rag_chunks else 0
                top_doc = rag_chunks[0].get("document", "") if rag_chunks else ""
                top_content = (rag_chunks[0].get("content", "")[:60] + "…") if rag_chunks else ""
                preview = (f"命中 {len(rag_chunks)} 条，最高匹配度 {top_sim:.2f}"
                           + (f"，[{top_doc}] {top_content}" if top_doc else ""))[:200]
            yield {"type": "tool_call_completed", "tool": "rag_search",
                   "name": rag_tool.name,
                   "success": not is_err,
                   "preview": preview,
                   "result": json.dumps(rag_result, ensure_ascii=False)[:12000],
                   "sources": _extract_sources("rag_search", rag_result)}

            for item in _extract_sources("rag_search", rag_result):
                sid = source_counter; source_counter += 1
                item["id"] = sid
                sources[sid] = item

        kb_ctx = ""
        if rag_chunks:
            parts = []
            for c in rag_chunks:
                doc = c.get("document", "")
                label = f"[{doc}] " if doc else ""
                sid = next((s["id"] for s in sources.values()
                            if s.get("type") == "rag" and s.get("content") == c.get("content")), None)
                ref = f"[^{sid}^] " if sid else ""
                parts.append(f"{ref}{label}{c['content']}")
            ref_block = "\n".join(
                f"[^{s['id']}^] {s.get('document','')}: {s['content'][:200]}"
                for s in sources.values() if s["type"] == "rag"
            )
            valid_ids = ", ".join(f"[^{s['id']}^]" for s in sources.values())
            kb_ctx = (
                "\n\n---知识库检索结果---\n" + "\n\n".join(parts) + "\n---检索结束---\n\n"
                + "以下是本次检索到的参考来源，回答中如涉及这些来源的知识，请用 [^id^] 标注出处。\n"
                + f"本次可用的引用编号为：{valid_ids}\n"
                + f"参考来源列表：\n{ref_block}\n\n"
                + "引用规则（务必遵守）：\n"
                + f"1. 只允许使用上述 {len(sources)} 个编号（{valid_ids}），禁止使用其他编号。\n"
                + "2. **以用户的问题为基准组织回复**，用自己的话讲解，参考来源只是依据，不要大段照搬原文。\n"
                + "3. 涉及来源中的具体事实、数据、定义、结论时，用 [^id^] 标注出处即可。\n"
                + "4. 不要为过渡句、修饰语、套话加引用。\n"
                + "5. 没有引用价值的来源不要强行标注，不被引用的来源不会展示给读者。\n"
                + "6. 一个事实可被多个来源支撑时，只用一个最贴切的编号，不要堆叠。\n\n"
            )
            yield {"type": "phase", "phase": "retrieved",
                   "message": f"知识库命中 {len(rag_chunks)} 条，相关度 {'充足' if rag_sufficient else '不足，将联网补充'}"}

        # If RAG is sufficient, skip tool calls entirely.
        needs_tools = not rag_sufficient

        working = list(messages)
        if kb_ctx:
            for i in range(len(working) - 1, -1, -1):
                if working[i]["role"] == "user":
                    content = working[i]["content"]
                    if isinstance(content, list):
                        working[i] = {"role": "user", "content": [{"type": "text", "text": kb_ctx}] + content}
                    else:
                        working[i] = {"role": "user", "content": kb_ctx + content}
                    break

        tools = self._available_tools()
        tool_defs = [t.get_tool_definition() for t in tools]
        iteration = 0
        # Accumulate reasoning + content across the whole turn so we can
        # emit a single 'refused' event the moment MiMo reveals it.
        reasoning_buf: list[str] = []
        content_buf: list[str] = []
        last_reasoning_flush: str = ""
        refused_yielded = False

        async def _check_refusal(force: bool = False):
            """Detect refusal mid-stream and emit a single refused event.

            Called every iteration with a small throttle so we don't
            scan the entire accumulated text on every chunk; `force`
            flushes the final check after the model says done.
            """
            nonlocal refused_yielded, last_reasoning_flush
            if refused_yielded:
                return
            full_reasoning = "".join(reasoning_buf)
            full_content = "".join(content_buf)
            if not force and len(full_reasoning) - len(last_reasoning_flush) < 200:
                return
            last_reasoning_flush = full_reasoning
            hit = detect_refusal(full_reasoning, full_content)
            if hit is not None:
                refused_yielded = True
                banner = refusal_banner_message(full_reasoning)
                reasoning_buf.clear()
                content_buf.clear()
                yield {"type": "refused", "signal": hit["signal"], "banner": banner}

        # 初版方案：RAG 检索后直接让 LLM 单次生成（保留 kb_ctx 引导引用）
        # 流程简洁、响应快；引用质量通过 prompt + 后置校验双重保证

        while True:
            allow = bool(tool_defs) and needs_tools and iteration < self.max_iterations
            calls = []
            # When max tool rounds reached, add instruction to finalize
            if not allow and iteration >= self.max_iterations:
                if sources:
                    ref_lines = []
                    for sid, s in sources.items():
                        if s["type"] == "rag":
                            ref_lines.append(f"[^{sid}^] {s.get('document','')}: {s['content'][:150]}")
                        else:
                            ref_lines.append(f"[^{sid}^] {s.get('title','')}: {s['content'][:150]}")
                    ref_block = "\n".join(ref_lines)
                    valid_ids = ", ".join(f"[^{sid}^]" for sid in sources)
                    working.append({"role": "user", "content": (
                        "请根据以上工具返回的信息，直接给出最终回答。不要使用任何工具，不要使用think标签。\n\n"
                        "以下是本次检索到的参考来源，回答中如涉及这些来源的知识，请用 [^id^] 标注出处。\n"
                        f"本次可用的引用编号为：{valid_ids}\n"
                        f"参考来源列表：\n{ref_block}\n\n"
                        "引用规则（务必遵守）：\n"
                        f"1. 只允许使用上述 {len(sources)} 个编号（{valid_ids}），禁止使用其他编号。\n"
                        + "2. **以用户的问题为基准组织回复**，用自己的话讲解，参考来源只是依据，不要大段照搬原文。\n"
                        + "3. 涉及来源中的具体事实、数据、定义、结论时，用 [^id^] 标注出处即可。\n"
                        + "4. 不要为过渡句、修饰语、套话加引用。\n"
                        + "5. 没有引用价值的来源不要强行标注，不被引用的来源不会展示给读者。\n"
                        + "6. 一个事实可被多个来源支撑时，只用一个最贴切的编号，不要堆叠。"
                    )})
                else:
                    working.append({"role": "user", "content": "请根据以上工具返回的信息，直接给出最终回答。不要使用任何工具，不要使用think标签。"})
            # Disable reasoning for final answer to prevent MiMo wrapping it in think tags
            use_reasoning = include_reasoning if allow else False
            try:
                async for chunk in self.llm.stream_chat_with_tools(working, tool_defs if allow else None, use_reasoning, self.provider):
                    if chunk["type"] == "content":
                        content_buf.append(chunk["text"])
                        if refused_yielded:
                            continue
                        yield chunk
                    elif chunk["type"] == "reasoning":
                        reasoning_buf.append(chunk["text"])
                        yield chunk
                    elif chunk["type"] == "tool_calls":
                        calls = chunk["calls"]
                    else:
                        yield chunk
                    if refused_yielded:
                        continue
                    if chunk["type"] in ("content", "reasoning"):
                        async for ev in _check_refusal():
                            yield ev
            except Exception:
                break
            if refused_yielded:
                break
            if not calls: break
            iteration += 1
            working.append({"role": "assistant", "content": "",
                "tool_calls": [{"id": c["id"] or f"call_{i}", "type": "function",
                    "function": {"name": c["name"], "arguments": c["arguments"] or "{}"}} for i, c in enumerate(calls)]})
            for i, c in enumerate(calls):
                tool = tool_registry.get(c["name"])
                aid = c["id"] or f"call_{i}"
                args = self._pa(c["arguments"])
                yield {"type": "tool_call_started", "tool": c["name"],
                    "name": tool.name if tool else c["name"], "arguments": args}
                if tool is None: result = {"success": False, "error": f"Unknown tool: {c['name']}"}
                else:
                    try: result = await tool.execute(args)
                    except Exception as e: result = {"success": False, "error": str(e)}
                tool_items = _extract_sources(c["name"], result) if isinstance(result, dict) else []
                for item in tool_items:
                    sid = source_counter; source_counter += 1
                    item["id"] = sid
                    sources[sid] = item
                is_err = isinstance(result, dict) and (result.get("success") is False or result.get("error"))
                result_str = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2)
                yield {"type": "tool_call_completed", "tool": c["name"],
                    "name": tool.name if tool else c["name"],
                    "success": not is_err,
                    "preview": _smart_preview(result)[:120],
                    "result": result_str[:12000],
                    "sources": tool_items}
                working.append({"role": "tool", "tool_call_id": aid, "content": (result if isinstance(result, str) else json.dumps(result, ensure_ascii=False))[:_TOOL_RESULT_MAX_CHARS]})
        # Final pass: if the loop ended without yielding `refused` but the
        # stream looks refused anyway (e.g. model said nothing), still fold
        # the whole reply into a banner instead of posting an empty
        # assistant turn.
        async for ev in _check_refusal(force=True):
            yield ev

        full_content = "".join(content_buf) if content_buf else ""
        # 关键：只把正文里实际被引用的 source 暴露给前端，未被引用的一律不展示
        cited_ids = {int(m) for m in _CITATION_RE.findall(full_content)} if full_content else set()
        referenced_sources = {sid: s for sid, s in sources.items() if sid in cited_ids} if sources else {}
        if referenced_sources:
            yield {"type": "sources", "sources": list(referenced_sources.values())}

        if referenced_sources and full_content:
            validation = _validate_citations(full_content, referenced_sources)
            if validation:
                yield {"type": "citation_validation", "citations": validation}


    async def run(self, messages, user_id=None) -> tuple[str, str]:
        reply_parts: list[str] = []
        reasoning_parts: list[str] = []
        async for event in self.stream(messages, user_id=user_id):
            if event["type"] == "content":
                reply_parts.append(event["text"])
            elif event["type"] == "reasoning":
                reasoning_parts.append(event["text"])
        return "".join(reply_parts), "".join(reasoning_parts)

    @staticmethod
    def _pa(raw: str) -> dict:
        if not raw: return {}
        try: p = json.loads(raw); return p if isinstance(p, dict) else {}
        except (json.JSONDecodeError, TypeError, ValueError): return {}
