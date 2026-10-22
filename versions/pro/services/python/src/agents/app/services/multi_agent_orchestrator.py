"""Multi-agent orchestration for cited response generation.

设计目标（避免幻觉、提速、流式输出）:
1. Planner「结构设计师」：从 sources 设计 2-4 个要点大纲，每个要点绑定 source_ids。
2. Extractors「原文片段提取器」xN 并行：对每个要点的来源，要求模型**只挑选原文里真实存在的片段**输出，
   并标注该片段在原文中的字符偏移量。后端再按偏移量从原文**精确切片**取回该片段（不依赖模型生成）。
   这样即使模型"幻觉"了 text 字段，我们后端会用偏移量强制取原文，输出仍是 100% 原文。
3. Composer「汇编师」：按大纲顺序把提取的原文片段拼装成最终回复，**逐句立即流出 content 事件**，
   用户逐字看到结果，且每个句子都自动挂上 source_id 引用。

事件协议（前端思考过程据此展示分工与产出）:
- {"type": "phase", "phase": "plan|extract|compose", "message": ...}
- {"type": "agent_started", "agent": "planner|extractor|composer", "name": ..., "detail": ...}
- {"type": "agent_completed", "agent": ..., "name": ..., "success": bool, "output": ...}
- {"type": "content", "text": ...}  (按句子逐个流出，每句都带 source_id)

失败回退：任何阶段产出为空/异常时，generate 不产出 content，调用方回退普通生成。
"""
import asyncio
from collections.abc import AsyncIterator
from typing import Any

from app.llm import LLMClient


class MultiAgentOrchestrator:
    """Orchestrates a multi-agent pipeline for cited response generation."""

    def __init__(self, llm: LLMClient, provider: str = "kimi", max_concurrency: int = 3):
        self.llm = llm
        self.provider = provider
        self.max_concurrency = max(1, max_concurrency)

    @staticmethod
    def _slice_by_offset(content: str, start: int, end: int) -> str:
        """按偏移量精确切片；越界自动 clamp 并返回非空字符串。"""
        if not content or start is None or end is None:
            return ""
        n = len(content)
        s = max(0, min(int(start), n))
        e = max(s + 1, min(int(end), n))
        return content[s:e].strip()

    # ---- 结构设计师 ----

    async def _plan(self, question: str, sources: list[dict]) -> dict:
        """Planner: 设计 2-4 个要点大纲，每个要点绑定 1-3 个最相关 source_ids。"""
        source_list = "\n".join(
            f"[^{s['id']}^] ({s.get('type', 'unknown')}) {s.get('document') or s.get('title', '')}: {s['content'][:150]}"
            for s in sources
        )
        prompt = (
            f"你是回复结构设计师。请根据用户问题和参考来源，设计一个 2-4 个要点的回复大纲。\n\n"
            f"用户问题：{question}\n\n"
            f"参考来源（共 {len(sources)} 条）：\n{source_list}\n\n"
            f'输出 JSON：{{"outline": [{{"point": "要点描述（20-50字）", "source_ids": [1,2]}}, ...]}}\n'
            f"要求：\n"
            f"- 2-4 个要点，覆盖用户问题的核心方面，按回答顺序排列\n"
            f"- 每个要点绑定 1-3 个最相关的 source_ids（必须是上面出现过的编号）\n"
            f"- 优先选用 source_ids 充分覆盖全部 {len(sources)} 条来源，避免遗漏\n"
            f"- 不要编造来源中不存在的内容"
        )
        return await self.llm.complete_json(
            "你是回复结构设计师，只输出 JSON。",
            prompt,
            fallback={"outline": []},
            provider=self.provider,
        )

    # ---- 原文片段提取器 ----

    async def _extract(self, point: str, sources_with_offset: list[dict]) -> list[dict]:
        """要求模型只挑选原文里真实存在的片段，并给出字符偏移量。
        sources_with_offset 格式: [{id, document, content, start_offset (该 content 在拼接中的起始位置)}]
        """
        # 提供每条来源的全文 + 起始偏移，让模型给出相对偏移量
        chunks_text = []
        for s in sources_with_offset:
            chunks_text.append(
                f"[^{s['id']}^] 文档={s.get('document', '')} 起始偏移={s['start_offset']}\n{s['content']}"
            )
        joined = "\n\n---\n\n".join(chunks_text)

        prompt = (
            f"你是原文片段提取器。请从给定的原文里挑选与要点最相关的 1-3 段**连续片段**。\n\n"
            f"要点：{point}\n\n"
            f"原文（每段标注了来源编号与起始偏移）：\n{joined}\n\n"
            f'输出 JSON：{{"snippets": [{{"source_id": 1, "start": 120, "end": 230}}, ...]}}\n'
            f"硬性要求：\n"
            f"- start 和 end 是**该原文片段在你看到的「来源 [^{{[id]}}^] 起始偏移=N\n原文内容」格式里**"
            f"对原文部分【从起始偏移之后的内容】的相对字符偏移量（即从原文首字算起）\n"
            f"- 片段必须 1:1 复制原文中的连续文字（包括标点），不准改写、不准补字、不准跳字\n"
            f"- 优先选择完整句子或自然段落，不要截断句中词组\n"
            f"- 每段长度 30-200 字，不要选太短的（如单字、单词）\n"
            f"- 如果原文里找不到与要点相关的内容，返回 {{'snippets': []}}\n"
        )
        result = await self.llm.complete_json(
            "你是原文片段提取器，只输出 JSON，片段必须 1:1 复制原文。",
            prompt,
            fallback={"snippets": []},
            provider=self.provider,
        )
        return result.get("snippets", [])

    # ---- 汇编师 ----

    async def _assemble(self, plan: dict, results: list[dict]) -> AsyncIterator[dict]:
        """按大纲顺序，把每个要点对应的原文片段拼装为回复，逐句流式 content 送出。"""
        outline = plan.get("outline", [])
        # 按 outline 顺序对齐每个要点对应的原文片段
        per_point: list[tuple[str, list[dict]]] = []
        for i, item in enumerate(outline):
            point = (item.get("point") or "").strip()
            fragments = results[i]["fragments"] if i < len(results) else []
            per_point.append((point, fragments))

        yielded_any = False
        for idx, (point, fragments) in enumerate(per_point):
            if not fragments:
                continue
            # 要点小标题（用 markdown 加粗，让结构清晰）
            yield {"type": "content", "text": f"\n\n**{point}**\n\n"}
            yielded_any = True
            for frag in fragments:
                text = (frag.get("text") or "").strip()
                sid = frag.get("source_id")
                if not text:
                    continue
                # 每段原文片段后挂上引用标注
                suffix = f" [^{sid}^]" if sid else ""
                yield {"type": "content", "text": text + suffix}
        if yielded_any:
            yield {"type": "content", "text": "\n"}

    # ---- 主流程 ----

    async def generate(self, question: str, sources: list[dict]) -> AsyncIterator[dict]:
        if not sources:
            yield {"type": "phase", "phase": "plan", "message": "没有可用参考来源，跳过多智能体管线"}
            return

        # === 1) Planner：结构设计师 ===
        yield {"type": "phase", "phase": "plan", "message": "结构设计师：规划回复大纲…"}
        yield {"type": "agent_started", "agent": "planner", "name": "结构设计师",
               "detail": f"分析问题与 {len(sources)} 条参考来源，设计 2-4 个要点大纲"}
        try:
            plan = await self._plan(question, sources)
        except Exception as exc:
            yield {"type": "agent_completed", "agent": "planner", "name": "结构设计师",
                   "success": False, "output": f"规划失败：{exc}"}
            return
        outline = plan.get("outline") or []
        outline = [o for o in outline if isinstance(o, dict) and (o.get("point") or "").strip()]
        if not outline:
            yield {"type": "agent_completed", "agent": "planner", "name": "结构设计师",
                   "success": False, "output": "未能产出有效大纲"}
            return
        plan_preview = "\n".join(
            f"{i + 1}. {o.get('point', '')}  [来源 {', '.join(map(str, o.get('source_ids') or []))}]"
            for i, o in enumerate(outline)
        )
        yield {"type": "agent_completed", "agent": "planner", "name": "结构设计师",
               "success": True, "output": plan_preview}

        # === 2) Extractors：原文片段提取器（并行）===
        yield {"type": "phase", "phase": "extract",
               "message": f"原文片段提取器并行处理 {len(outline)} 个要点…"}
        sem = asyncio.Semaphore(self.max_concurrency)

        # 为每条来源在它所属的要点 prompt 里附上相对偏移量
        # 我们把每条原文完整传过去，让模型给出相对偏移
        # 这里对每个要点只传它绑定的来源
        async def run_extractor(index: int, item: dict) -> dict:
            point = (item.get("point") or "").strip()
            bound_ids = [sid for sid in (item.get("source_ids") or [])
                         if sid in {s["id"] for s in sources}]
            relevant = [s for s in sources if s["id"] in bound_ids]
            if not relevant:
                return {"index": index, "point": point, "fragments": []}
            # 传入每条来源的全文 + 起始偏移为 0（每个 extractor 只看自己负责的来源，各自独立偏移）
            sources_for_extractor = [
                {"id": s["id"], "document": s.get("document", ""), "title": s.get("title", ""),
                 "content": s.get("content", ""), "start_offset": 0}
                for s in relevant
            ]
            async with sem:
                try:
                    snippets = await self._extract(point, sources_for_extractor)
                except Exception:
                    snippets = []
            fragments = []
            seen = set()
            for snip in snippets or []:
                sid = snip.get("source_id")
                start, end = snip.get("start"), snip.get("end")
                # 找到对应的完整原文（不再使用偏移量拼接，因为我们每个 extractor 只看自己来源）
                source_obj = next((s for s in relevant if s["id"] == sid), None)
                if not source_obj or start is None or end is None:
                    continue
                # start/end 是相对该来源原文的偏移
                snippet_text = self._slice_by_offset(source_obj["content"], start, end)
                if not snippet_text or len(snippet_text) < 10:
                    continue
                # 去重（同一段可能 LLM 重复输出）
                key = (sid, snippet_text[:30])
                if key in seen:
                    continue
                seen.add(key)
                fragments.append({"text": snippet_text, "source_id": sid})
            return {"index": index, "point": point, "fragments": fragments[:3]}

        tasks = [asyncio.create_task(run_extractor(i, item)) for i, item in enumerate(outline)]
        results = await asyncio.gather(*tasks)
        results.sort(key=lambda r: r["index"])

        for r in results:
            point = (r.get("point") or "")[:60]
            fragments = r.get("fragments") or []
            status = "✓" if fragments else "✗"
            preview = f"{status} 「{point}」：{len(fragments)} 段原文"
            if fragments:
                first = (fragments[0]["text"] or "")[:50]
                preview += f" · \"{first}…\""
            yield {"type": "agent_completed", "agent": "extractor", "name": "原文片段提取器",
                   "success": bool(fragments), "output": preview}

        # === 3) Composer：汇编师（流式拼装）===
        yield {"type": "phase", "phase": "compose", "message": "汇编师：按大纲拼装原文片段…"}
        yield {"type": "agent_started", "agent": "composer", "name": "汇编师",
               "detail": "按大纲顺序拼装原文片段，逐句立即送出"}
        # 流式产出 content 事件
        total_chars = 0
        async for chunk in self._assemble(plan, results):
            if chunk["type"] == "content":
                total_chars += len(chunk["text"])
                yield chunk
        if total_chars == 0:
            yield {"type": "agent_completed", "agent": "composer", "name": "汇编师",
                   "success": False, "output": "未能拼装出有效回复"}
            return
        yield {"type": "agent_completed", "agent": "composer", "name": "汇编师",
               "success": True, "output": f"已完成 {total_chars} 字回复（全部原文片段）"}