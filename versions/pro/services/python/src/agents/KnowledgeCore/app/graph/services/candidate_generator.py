"""候选对生成器：diff 对账式增量建边的"差异发现"环节（dag-design.md §8.5）.

输入：目录树（knowledge_category）+ 现有有效边（active/proposed）
输出：候选先修对（仅白名单内方向，跨章零对）+ 变更报告（新增节点/移动/孤儿边）

候选规则（对齐防线 1 白名单）：
- 同章知识点对：parent 相同、level3、sort_order 低→高
- 章节→知识点：level2 章节 → 其直接包含的 level3 子节点
- 章节→章节（L1 边）：人工维护，不生成候选
- 已有有效边（active/proposed，任意来源）→ 跳过（幂等）

T3.2 证据通道（本文件新增）：
- 输入 T3.1 的 knowledge_chunk_enrichment（defines_json/uses_json）按 chunk 展开后
  的 (chunk_id, category_id, defines, uses) 行；全量读入内存后做"B 的 chunk uses 了
  A 的 chunk defines 的概念"跨知识点 join（数据量仅百级知识点，无需下推 SQL）。
- 产出的 CandidatePair 带 evidence（{"concept", "def_chunk", "use_chunk"}），
  与结构候选走同一条 build_candidates→sync 管线：仍过现有四道防线，proposed
  状态机，不直接激活。
- 顺手：defines 中形如 "X（Y)" 的括注 → 抽取为 knowledge_category_alias 候选
  （source='definition_extract'），供调用方批量写入别名表。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

MAX_PAIRS_PER_CHAPTER = 45  # C(10,2)，同章知识点两两上限（成本控制）

# "概念（别名/英文缩写)" 括注抽取：外层为概念本身，括注内容作为该概念所在
# 知识点的别名候选（中英文括号均支持）。
_BRACKET_ALIAS_RE = re.compile(r"^(?P<concept>.+?)[（(](?P<alias>[^（）()]+)[）)]$")


@dataclass
class CategoryRow:
    """目录树节点（sync 需要的最小字段集）."""

    id: int
    domain_id: int
    parent_id: int | None
    name: str
    description: str = ""
    level: int = 0
    sort_order: int = 0
    node_type: str = "category"


@dataclass
class CandidatePair:
    """候选先修对：prereq（先修）→ target（后修）."""

    prereq_id: int
    prereq_name: str
    target_id: int
    target_name: str
    chapter_id: int | None = None
    chapter_name: str = ""
    # T3.2：证据通道产出的候选带 {"concept": str, "def_chunk": int, "use_chunk": int}；
    # 结构候选（同章/章节→知识点）为 None。
    evidence: dict | None = None


@dataclass
class ChunkConceptRow:
    """T3.2 证据通道输入行：一个 chunk 在 knowledge_chunk_enrichment 中的定义/使用概念.

    由调用方（graph_sync 或等价编排层）从 knowledge_chunk_enrichment JOIN
    knowledge_chunk_category 展开而来：defines_json/uses_json 已解析为字符串列表。
    """

    chunk_id: int
    category_id: int
    defines: list[str] = field(default_factory=list)
    uses: list[str] = field(default_factory=list)


@dataclass
class SyncDiff:
    """一次 diff 的产出."""

    new_categories: list[CategoryRow] = field(default_factory=list)
    moved_categories: list[CategoryRow] = field(default_factory=list)
    orphan_edges: list[int] = field(default_factory=list)  # 边 id（引用已删除的 category）
    candidates: list[CandidatePair] = field(default_factory=list)


def build_candidates(
    categories: list[CategoryRow],
    existing_edges: list[tuple[int, int, str]],  # (prereq_id, target_id, edge_type)
    max_pairs_per_chapter: int = MAX_PAIRS_PER_CHAPTER,
) -> SyncDiff:
    """对目录树做候选对 diff.

    - categories:     领域下全部目录树节点
    - existing_edges: 有效边（active/proposed 的 prerequisite/cross_domain），
                      (prereq_category_id, category_id, edge_type)
    """
    diff = SyncDiff()
    by_id = {c.id: c for c in categories}

    # 已有边集合（幂等跳过）
    existing: set[tuple[int, int]] = {(p, t) for p, t, _ in existing_edges}

    # 新增节点：目录树中没有任何边（先修或后修）的 level2/3 节点
    involved: set[int] = set()
    for p, t, _ in existing_edges:
        involved.add(p)
        involved.add(t)
    for c in categories:
        if c.level >= 2 and c.id not in involved:
            diff.new_categories.append(c)

    # 章节分组（level2 → 其 level3 子节点）
    chapters: dict[int, list[CategoryRow]] = {}
    for c in categories:
        if c.level == 2:
            chapters.setdefault(c.id, [])
    for c in categories:
        if c.level == 3 and c.parent_id in chapters:
            chapters[c.parent_id].append(c)

    # 同章知识点两两（sort_order 低 → 高）
    for ch_id, kps in chapters.items():
        kps_sorted = sorted(kps, key=lambda k: k.sort_order)
        pairs: list[tuple[CategoryRow, CategoryRow]] = []
        for i, lo in enumerate(kps_sorted):
            for hi in kps_sorted[i + 1 :]:
                if (lo.id, hi.id) not in existing:
                    pairs.append((lo, hi))
        # 出度上限约束下的候选剪枝：每个先修至多贡献 (MAX_OUTDEGREE + 余量) 个候选
        # （dag-design.md 规则 3：出度 ≤5；生成候选略多让审核有选择，但控制总量）
        if len(pairs) > max_pairs_per_chapter:
            pairs = pairs[:max_pairs_per_chapter]
        for lo, hi in pairs:
            diff.candidates.append(
                CandidatePair(
                    prereq_id=lo.id,
                    prereq_name=lo.name,
                    target_id=hi.id,
                    target_name=hi.name,
                    chapter_id=ch_id,
                    chapter_name=by_id[ch_id].name if ch_id in by_id else "",
                )
            )

    # 章节→其知识点（level2→3 同章）
    for ch_id, kps in chapters.items():
        ch = by_id.get(ch_id)
        if ch is None:
            continue
        for kp in sorted(kps, key=lambda k: k.sort_order):
            if (ch_id, kp.id) not in existing:
                diff.candidates.append(
                    CandidatePair(
                        prereq_id=ch_id,
                        prereq_name=ch.name,
                        target_id=kp.id,
                        target_name=kp.name,
                        chapter_id=ch_id,
                        chapter_name=ch.name,
                    )
                )

    # 孤儿边：边引用的 category 不在目录树 → deprecated（交由 sync 处理）
    for p, t, _ in existing_edges:
        if p not in by_id or t not in by_id:
            # 无法从 existing_edges 拿边 id，由 sync 单独查表定位
            diff.orphan_edges.append(t if t not in by_id else p)

    # 章节移动/排序变化：与上一轮快照对比由调用方负责（此处标记所有
    # "有边但仍存在"的章节，sync 可据此重算其子树候选）——简化版不做
    return diff


def pair_cache_key(prereq_id: int, target_id: int) -> str:
    """缓存键：先修:目标（与表方向一致）."""
    return f"{prereq_id}:{target_id}"


# ── T3.2：证据通道（defines/uses 概念共现 → 跨知识点候选边） ──────────────


def build_evidence_candidates(
    rows: list[ChunkConceptRow],
    existing_edges: list[tuple[int, int, str]] | set[tuple[int, int]] | None = None,
    category_lookup: dict[int, CategoryRow] | None = None,
) -> list[CandidatePair]:
    """内存 join："B 的 chunk uses 了 A 的 chunk defines 的概念" → A→B 候选边.

    - rows: 全量 chunk 的 (chunk_id, category_id, defines, uses)（调用方已从
      knowledge_chunk_enrichment 读出并按 category 展开，量级仅百级知识点）。
    - existing_edges: 已有有效边（幂等跳过，语义与 build_candidates 一致）；接受
      build_candidates 同款 (prereq_id, target_id, edge_type) 三元组列表，也接受
      纯 (prereq_id, target_id) 二元组集合，方便调用方直接复用两处结果。
    - category_lookup: 可选，补全 CandidatePair 的 prereq_name/target_name。

    同一 (prereq, target) 对可能被多个概念命中，只保留首次出现的证据（单条
    候选边只能携带一份 evidence_json，且防线层按 (category_id, prereq_category_id)
    唯一约束建边，多条重复证据无意义）。跳过同知识点自定义自用（prereq==target）。
    """
    existing: set[tuple[int, int]] = set()
    for item in existing_edges or []:
        existing.add((item[0], item[1]))

    # 概念 → 定义它的 (category_id, chunk_id) 列表（同一概念可能被多个知识点定义，
    # 保留全部，join 时逐一匹配；用列表而非首个，避免丢失跨章重复定义场景）。
    defined_by: dict[str, list[tuple[int, int]]] = {}
    for row in rows:
        for concept in row.defines:
            key = concept.strip()
            if not key:
                continue
            defined_by.setdefault(key, []).append((row.category_id, row.chunk_id))

    seen_pairs: set[tuple[int, int]] = set()
    candidates: list[CandidatePair] = []
    for row in rows:
        for concept in row.uses:
            key = concept.strip()
            if not key:
                continue
            for def_cat, def_chunk in defined_by.get(key, []):
                if def_cat == row.category_id:
                    continue  # 同知识点内定义即用，不构成跨知识点先修证据
                pair = (def_cat, row.category_id)
                if pair in existing or pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                prereq_cat = category_lookup.get(def_cat) if category_lookup else None
                target_cat = category_lookup.get(row.category_id) if category_lookup else None
                candidates.append(
                    CandidatePair(
                        prereq_id=def_cat,
                        prereq_name=prereq_cat.name if prereq_cat else "",
                        target_id=row.category_id,
                        target_name=target_cat.name if target_cat else "",
                        evidence={
                            "concept": key,
                            "def_chunk": def_chunk,
                            "use_chunk": row.chunk_id,
                        },
                    )
                )
    return candidates


# ── T4.4：contrasts_with 候选（概念共现 → 易混淆知识点对） ──────────────────


@dataclass
class ContrastCandidatePair:
    """易混淆知识点候选对（对称，无 prereq/target 方向语义）."""

    a_id: int
    a_name: str
    b_id: int
    b_name: str
    # {"co_occurrence_chunk": int}：两个概念被并列使用（uses）的 chunk_id。
    evidence: dict | None = None


def build_contrast_candidates(
    rows: list[ChunkConceptRow],
    existing_pairs: set[tuple[int, int]] | None = None,
    category_lookup: dict[int, CategoryRow] | None = None,
) -> list[ContrastCandidatePair]:
    """T4.4：概念共现 → 易混淆知识点候选对（对称，无方向）.

    启发式：同一 chunk 的 uses 列表中，若命中了分属不同知识点 defines 的多个概念，
    说明这些知识点的概念在同一语境下被并列提及/讨论——是"容易混淆的相邻概念"候选
    （供 LLM 把关后写 contrasts_with 边，proposed 状态，不直接激活）。

    - rows: 与 build_evidence_candidates 同款输入（调用方从
      knowledge_chunk_enrichment 展开的 defines/uses）。
    - existing_pairs: 已有有效边的 (a, b) 集合（幂等跳过，任意方向命中即跳过，
      因为 contrasts_with 无方向语义）。
    - category_lookup: 可选，补全候选的 a_name/b_name。
    """
    existing = existing_pairs or set()
    defined_by: dict[str, int] = {}
    for row in rows:
        for concept in row.defines:
            key = concept.strip()
            if key and key not in defined_by:
                defined_by[key] = row.category_id

    seen: set[tuple[int, int]] = set()
    candidates: list[ContrastCandidatePair] = []
    for row in rows:
        cats_in_chunk: set[int] = set()
        for concept in row.uses:
            key = concept.strip()
            if not key:
                continue
            cat = defined_by.get(key)
            if cat is not None:
                cats_in_chunk.add(cat)
        ordered = sorted(cats_in_chunk)
        for i in range(len(ordered)):
            for j in range(i + 1, len(ordered)):
                a, b = ordered[i], ordered[j]
                pair = (a, b)
                if pair in seen or pair in existing or (b, a) in existing:
                    continue
                seen.add(pair)
                a_cat = category_lookup.get(a) if category_lookup else None
                b_cat = category_lookup.get(b) if category_lookup else None
                candidates.append(
                    ContrastCandidatePair(
                        a_id=a,
                        a_name=a_cat.name if a_cat else "",
                        b_id=b,
                        b_name=b_cat.name if b_cat else "",
                        evidence={"co_occurrence_chunk": row.chunk_id},
                    )
                )
    return candidates


def extract_bracket_aliases(rows: list[ChunkConceptRow]) -> list[dict]:
    """defines 中形如 "X（Y)" 的括注 → knowledge_category_alias 候选记录.

    返回 [{"category_id": int, "alias": str, "source": "definition_extract"}, ...]，
    调用方按 T1.5 表结构去重后 INSERT（UNIQUE(category_id, alias) 天然幂等）。
    """
    aliases: list[dict] = []
    seen: set[tuple[int, str]] = set()
    for row in rows:
        for concept in row.defines:
            m = _BRACKET_ALIAS_RE.match(concept.strip())
            if not m:
                continue
            alias = m.group("alias").strip()
            if not alias:
                continue
            key = (row.category_id, alias)
            if key in seen:
                continue
            seen.add(key)
            aliases.append(
                {
                    "category_id": row.category_id,
                    "alias": alias,
                    "source": "definition_extract",
                }
            )
    return aliases
