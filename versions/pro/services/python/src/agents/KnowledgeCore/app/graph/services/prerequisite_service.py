"""先修关系服务：四道防线防环 + 先修链查询（AGENT/dag-design.md §5-§6）.

防线 0：LLM 生成层过滤（在生成器/调用方，service 不涉及）
防线 1：方向白名单（level/sort_order 结构约束，构造性防环）
防线 2：插入前祖先检查（硬拦截：B 能到达 A 则 A→B 拒绝）
防线 3：proposed 状态机 + 激活时全图 Kahn（防多条 proposed 同时激活成环）

节点 = knowledge_category.id；边表 = knowledge_category_prerequisite。
行 (category_id=B, prereq_category_id=A) ⇔ 边 A→B ⇔ "A 是 B 的先修"。
"""

from __future__ import annotations

from collections import defaultdict

import networkx as nx
from sqlalchemy import bindparam, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.models.prerequisite import PrerequisiteEdgeORM

# 每个先修节点的出度上限（规则 3：超出的候选边降级为 related）
MAX_PREREQ_OUTDEGREE = 5

# contrasts_with（T4.4）：易混淆知识点，对称关系（无方向语义），不参与先修 DAG。
EDGE_TYPES = {"prerequisite", "cross_domain_prerequisite", "related", "contrasts_with"}
# 对称边类型：不做方向白名单/祖先环检测，出度不受 MAX_PREREQ_OUTDEGREE 约束。
SYMMETRIC_EDGE_TYPES = {"related", "contrasts_with"}
# redundant：T4.7 传递归约（离线批处理）判定为冗余的软删状态（区别于人工拒绝的 rejected）
# needs_review（T4.3/T4.6）：作答数据投票判定异常 / 图谱增量重审判定需人工复核的边
# （区别于 proposed——proposed 是"从未生效"，needs_review 是"曾经/本应生效但被标记复核"）。
STATUSES = {"proposed", "active", "rejected", "deprecated", "redundant", "needs_review"}


class DirectionViolationError(ValueError):
    """防线 1：方向白名单违规."""


class CycleDetectedError(ValueError):
    """防线 2/3：成环（插入或激活）. 携带环成员."""

    def __init__(self, message: str, cycle_members: list[int] | None = None):
        super().__init__(message)
        self.cycle_members = cycle_members or []


class OutdegreeExceededError(ValueError):
    """规则 3：出度上限（human 建边时拒绝，LLM 建边时自动降级 related）."""


class InvalidEdgeError(ValueError):
    """跨域/参数校验失败."""


class RedundantEdgeError(ValueError):
    """防线 4（T4.7 传递归约闸门）：待激活边已被图中其他路径传递蕴含，拒绝激活.

    携带冗余边明细（含替代路径 path），供审计/前端展示"为什么拒绝"。
    """

    def __init__(self, message: str, redundant_edges: list[dict] | None = None):
        super().__init__(message)
        self.redundant_edges = redundant_edges or []


def kahn_cycle_members(adj: dict[int, list[int]]) -> list[int]:
    """Kahn 拓扑排序定位环成员（入度永不归零的节点）.

    返回空列表表示无环；非空返回环上节点（供防线 3 告警/审计）。
    """
    nodes = set(adj.keys())
    for targets in adj.values():
        nodes.update(targets)

    in_deg: dict[int, int] = {n: 0 for n in nodes}
    for targets in adj.values():
        for t in targets:
            in_deg[t] = in_deg.get(t, 0) + 1

    queue = [n for n, d in in_deg.items() if d == 0]
    visited = 0
    while queue:
        n = queue.pop()
        visited += 1
        for t in adj.get(n, []):
            in_deg[t] -= 1
            if in_deg[t] == 0:
                queue.append(t)

    if visited < len(nodes):
        return sorted(n for n, d in in_deg.items() if d > 0)
    return []


class PrerequisiteService:
    """操作 knowledge_category_prerequisite 的先修图服务."""

    def __init__(self, db: AsyncSession):
        self.db = db

    # ── 建边（四道防线） ────────────────────────────────────────────────

    async def add_prerequisite(
        self,
        category_id: int,           # 目标（后修）B
        prereq_category_id: int,    # 先修 A（边 A→B）
        domain_id: int | None = None,
        edge_type: str = "prerequisite",
        source_domain_id: int | None = None,
        confidence: float = 1.0,
        rationale: str | None = None,
        source: str = "agent",
        created_by: str | None = None,
        direct_active: bool = False,
        evidence_json: dict | None = None,
    ) -> tuple[PrerequisiteEdgeORM, list[str]]:
        """新增先修边，返回 (edge, warnings).

        related 边：无方向语义，跳过防环检查，直接 active（不入 DAG）。
        contrasts_with 边（T4.4）：同样无方向语义、跳过防环检查、不占出度；
        但与 related 不同——默认 proposed（需人工审核后才生效，不直接激活）。
        prerequisite 边：防线 1 方向白名单 → 防线 2 祖先检查 → 规则 3 出度上限。
        cross_domain_prerequisite 边：仅人工（source=human）、先修必须是源域 L1 章节。
        evidence_json：T3.2 证据通道（defines/uses 概念共现）产出的候选边附带
        {"concept", "def_chunk", "use_chunk"}，仍全程走本方法的四道防线，不直接激活。
        """
        if edge_type not in EDGE_TYPES:
            raise InvalidEdgeError(f"edge_type 必须是 {sorted(EDGE_TYPES)}")
        if edge_type != "related" and source not in ("human", "agent", "llm", "derived"):
            raise InvalidEdgeError(f"source 非法: {source}")

        target = await self._load_category(category_id)
        prereq = await self._load_category(prereq_category_id)
        if target is None or prereq is None:
            raise InvalidEdgeError("category 节点不存在（检查 category_id / prereq_category_id）")

        # 重复边（含已删除的 deprecated）→ 幂等拒绝
        dup = await self._get_edge(category_id, prereq_category_id)
        if dup is not None:
            raise InvalidEdgeError(
                f"边已存在 (id={dup.id}, status={dup.status})，不允许重复建边"
            )

        # 对称边（related / contrasts_with）：跳过防环检查、不占先修出度。
        # related 无需审核直接生效；contrasts_with 默认 proposed（T4.4：需人工审核才生效，
        # 与 related 的语义差异——"易混淆"候选常来自共现启发式，比人工/结构候选更需把关）。
        if edge_type in SYMMETRIC_EDGE_TYPES:
            edge = PrerequisiteEdgeORM(
                domain_id=domain_id or target["domain_id"],
                category_id=category_id,
                prereq_category_id=prereq_category_id,
                edge_type=edge_type,
                source_domain_id=source_domain_id,
                confidence=confidence,
                rationale=rationale,
                status="active" if (edge_type == "related" or direct_active) else "proposed",
                source=source,
                created_by=created_by,
                evidence_json=evidence_json,
            )
            self.db.add(edge)
            await self.db.commit()
            await self.db.refresh(edge)
            return edge, []

        # 跨域边：仅人工 + 源域校验 + 只连源域章节
        if edge_type == "cross_domain_prerequisite":
            self._check_cross_domain(prereq, target, source_domain_id, source)

        # 防线 1：方向白名单（prerequisite 才校验；跨域方向约束见 _check_cross_domain）
        if edge_type == "prerequisite":
            self._check_direction(prereq, target, source)

        # 防线 2：祖先检查（跨域边同样参与：合并全域 active 边）
        await self._ancestor_check(prereq_category_id, category_id)

        # 规则 3：出度上限（LLM/agent 自动降级 related；human 拒绝）
        warnings: list[str] = []
        if edge_type == "prerequisite":
            out_deg = await self._occupied_outdegree(prereq_category_id)
            if out_deg >= MAX_PREREQ_OUTDEGREE:
                if source == "human":
                    raise OutdegreeExceededError(
                        f"先修出度已达上限 {MAX_PREREQ_OUTDEGREE}，请先整理再建边"
                    )
                edge_type = "related"
                warnings.append(
                    f"出度上限 {MAX_PREREQ_OUTDEGREE} 已满，边自动降级为 related"
                )

        edge = PrerequisiteEdgeORM(
            domain_id=domain_id or target["domain_id"],
            category_id=category_id,
            prereq_category_id=prereq_category_id,
            edge_type=edge_type,
            source_domain_id=source_domain_id,
            confidence=confidence,
            rationale=rationale,
            status="active" if direct_active or edge_type == "related" else "proposed",
            source=source,
            created_by=created_by,
            evidence_json=evidence_json,
        )
        self.db.add(edge)
        await self.db.commit()
        await self.db.refresh(edge)
        return edge, warnings

    # ── 防线 1：方向白名单 ─────────────────────────────────────────────

    def _check_direction(self, prereq: dict, target: dict, source: str) -> None:
        """prerequisite 边的方向白名单（dag-design.md §5 防线 1）.

        允许：level2→2（同父看 sort_order；跨父仅人工）、level2→3（同章）、level3→3（同章 sort_order）
        禁止：level3→2、任何涉及 level1 的边、跨章 level3 直连
        """
        pl, tl = prereq["level"], target["level"]

        if pl < 2 or tl < 2:
            raise DirectionViolationError("level1 顶层节点不参与先修边（依赖语义由章节边承载）")
        if pl > tl:
            raise DirectionViolationError(
                f"方向非法：先修层级({pl})不能高于目标层级({tl})（禁止 level3→level2）"
            )

        if pl == 2 and tl == 2:
            if prereq["parent_id"] == target["parent_id"]:
                if prereq["sort_order"] >= target["sort_order"]:
                    raise DirectionViolationError(
                        "同父章节先修必须来自 sort_order 更小的章节（章节序即拓扑序）"
                    )
            elif source != "human":
                raise DirectionViolationError("跨父章节边仅允许人工维护（source=human）")
            return

        if pl == 2 and tl == 3:
            if target["parent_id"] != prereq["id"]:
                raise DirectionViolationError("章节先修只约束其直接包含的知识点（同章）")
            return

        # pl == 3 and tl == 3
        if prereq["parent_id"] != target["parent_id"]:
            raise DirectionViolationError("跨章知识点禁止直连，必须由章节边传递闭包承载")
        if prereq["sort_order"] >= target["sort_order"]:
            raise DirectionViolationError("同章先修必须来自 sort_order 更小的知识点")

    def _check_cross_domain(
        self,
        prereq: dict,
        target: dict,
        source_domain_id: int | None,
        source: str,
    ) -> None:
        """跨域边约束（dag-design.md §6.2）：人工、源域匹配、只连源域 L1 章节."""
        if source != "human":
            raise InvalidEdgeError("跨域边一律人工审核，禁止 LLM/agent 自动生成")
        if source_domain_id is None or prereq["domain_id"] != source_domain_id:
            raise InvalidEdgeError("source_domain_id 必须等于先修节点所属领域")
        if prereq["level"] != 2:
            raise InvalidEdgeError("跨域边只允许连源领域 L1 章节节点（不深入到知识点）")
        if target["level"] != 2:
            raise InvalidEdgeError("跨域目标只允许本领域章节节点")

    # ── 防线 2：祖先检查 ────────────────────────────────────────────────

    async def _ancestor_check(
        self, prereq_id: int, target_id: int, exclude_edge_id: int | None = None
    ) -> None:
        """插 A→B 前：从 B 正向 BFS（B 能到达的全部节点），若到达 A → 成环拒绝.

        有效图 = active + proposed（proposed 同样占位：两条反向 proposed 也会成环），
        全域边（含跨域），93 节点毫秒级；业界：插边即查（Bernstein & Chechik 同思路）。
        `exclude_edge_id`：反转边场景排除被反转边自身（否则其自身构成的正向边会与
        待校验的反向边互为"两条反向边"误判成环）。
        """
        edges = await self._load_effective_edges()
        adj: dict[int, list[int]] = defaultdict(list)
        for e in edges:
            if exclude_edge_id is not None and e.id == exclude_edge_id:
                continue
            adj[e.prereq_category_id].append(e.category_id)

        reachable = self._bfs(adj, target_id)
        if prereq_id in reachable:
            raise CycleDetectedError(
                f"成环拒绝：{target_id} 已能到达 {prereq_id}（{target_id}→{prereq_id} 会构成环）",
                cycle_members=[prereq_id, target_id],
            )

    # ── 规则 3：出度上限 ────────────────────────────────────────────────

    async def _occupied_outdegree(self, prereq_id: int) -> int:
        """先修节点的出度占用：active + proposed 的先修边（不含 rejected/deprecated/related）.

        统计 proposed 是为了防止"审核批量激活后超限"——proposed 边同样占位。
        """
        result = await self.db.execute(
            select(PrerequisiteEdgeORM).where(
                PrerequisiteEdgeORM.prereq_category_id == prereq_id,
                PrerequisiteEdgeORM.status.in_(["active", "proposed"]),
                PrerequisiteEdgeORM.edge_type.in_(["prerequisite", "cross_domain_prerequisite"]),
            )
        )
        return len(list(result.scalars().all()))

    # ── 防线 3：审核（proposed → active，激活时全图 Kahn） ──────────────

    async def review_edge(self, edge_id: int, approve: bool = True) -> PrerequisiteEdgeORM:
        """审核单条边：approve 时临时置 active 跑全图 Kahn，成环则留在 proposed."""
        edge = await self._get_edge_by_id(edge_id)
        if edge is None:
            raise InvalidEdgeError(f"边不存在: {edge_id}")
        if edge.status != "proposed":
            raise InvalidEdgeError(f"边状态不是 proposed: {edge.status}")

        if approve:
            cycle = self._kahn_with_edges(await self._load_effective_edges())
            if cycle:
                raise CycleDetectedError(
                    f"激活成环拒绝（环成员 {cycle}），边保持 proposed", cycle_members=cycle
                )
            await self._transitive_reduction_check([edge])
            edge.status = "active"
        else:
            edge.status = "rejected"
        await self.db.commit()
        await self.db.refresh(edge)
        return edge

    async def review_batch(self, edge_ids: list[int], approve: bool = True) -> dict:
        """批量审核：全部 proposed 边先过全图 Kahn（新增边同批激活），失败整体留在 proposed.

        增量模式特有风险：单条各自无环 ≠ 多条同时激活无环。
        """
        if not edge_ids:
            return {"approved": 0, "rejected": 0, "error": None}

        result = await self.db.execute(
            select(PrerequisiteEdgeORM).where(
                PrerequisiteEdgeORM.id.in_(edge_ids),
                PrerequisiteEdgeORM.status == "proposed",
            )
        )
        edges = list(result.scalars().all())
        if len(edges) != len(set(edge_ids)):
            raise InvalidEdgeError("存在非 proposed 或不存在的边 id")

        if approve:
            # 有效图（active + 全部 proposed）整体 Kahn：本批边已在其中，
            # 与其他存量 proposed 未来激活的组合环一并拦截
            cycle = self._kahn_with_edges(await self._load_effective_edges())
            if cycle:
                raise CycleDetectedError(
                    f"批量激活成环（环成员 {cycle}），全部保持 proposed", cycle_members=cycle
                )
            # T4.7 传递归约闸门：本批待激活边若已被 active 图（含批内其他边）传递蕴含则拒绝
            await self._transitive_reduction_check(edges)
            for e in edges:
                e.status = "active"
        else:
            for e in edges:
                e.status = "rejected"
        await self.db.commit()
        return {"approved": len(edges), "rejected": 0 if approve else len(edges), "error": None}

    async def get_edge(self, edge_id: int) -> PrerequisiteEdgeORM | None:
        """按 id 查询单条边（路由层取 domain 等上下文用，如审计记录）."""
        return await self._get_edge_by_id(edge_id)

    async def reverse_edge(self, edge_id: int, created_by: str | None = None) -> dict:
        """T4.8：反转边方向（审核判定 LLM/agent 把方向建反了）.

        原边置 rejected（保留审计痕迹）；按反方向重新走 add_prerequisite 的四道防线
        （方向白名单 → 祖先检查 → 出度上限）生成新的 proposed 边——**不自动激活**，
        新边仍需走 approve 才会过 T4.7 传递归约闸门 + Kahn 检查（"activate_edges 闸门只在
        approve 时触发"）。仅支持 prerequisite 边；跨域边方向语义额外受源域约束，反转请人工
        删除后按需重建。
        """
        edge = await self._get_edge_by_id(edge_id)
        if edge is None:
            raise InvalidEdgeError(f"边不存在: {edge_id}")
        if edge.status != "proposed":
            raise InvalidEdgeError(f"边状态不是 proposed，无法反转: {edge.status}")
        if edge.edge_type != "prerequisite":
            raise InvalidEdgeError("仅 prerequisite 边支持反转（跨域边请人工删除后重建）")

        # 先探测反方向是否可行（不落库）：避免"原边已拒但新边建不成"的半失败状态。
        # 反转后：新先修 = 原目标(edge.category_id)，新目标 = 原先修(edge.prereq_category_id)。
        new_prereq = await self._load_category(edge.category_id)
        new_target = await self._load_category(edge.prereq_category_id)
        if new_prereq is None or new_target is None:
            raise InvalidEdgeError("category 节点不存在（检查边两端 id）")
        self._check_direction(new_prereq, new_target, source="human")
        await self._ancestor_check(
            edge.category_id, edge.prereq_category_id, exclude_edge_id=edge.id
        )

        edge.status = "rejected"
        await self.db.commit()
        await self.db.refresh(edge)

        new_edge, warnings = await self.add_prerequisite(
            category_id=edge.prereq_category_id,       # 反转：原先修 → 新目标
            prereq_category_id=edge.category_id,        # 反转：原目标 → 新先修
            domain_id=edge.domain_id,
            edge_type="prerequisite",
            confidence=edge.confidence,
            rationale=f"[反转自边 {edge.id}] {edge.rationale or ''}".strip(),
            source="human",
            created_by=created_by,
        )
        return {"old_edge": edge, "new_edge": new_edge, "warnings": warnings}

    async def reduce_redundant_edges(self, domain_id: int | None = None) -> dict:
        """T4.7 管理接口：对存量 active 边跑一次离线传递归约，冗余边软删为 status='redundant'.

        只处理 prerequisite / cross_domain_prerequisite（related 不入 DAG）。
        domain_id 缺省时对全部领域的 active 图统一归约（跨域边跨领域连接，归约应看全图）。
        """
        edges = await self._load_active_edges()
        if domain_id is not None:
            edges = [e for e in edges if e.domain_id == domain_id]
        if not edges:
            return {"checked": 0, "redundant": 0, "redundant_edge_ids": []}

        g = self._build_digraph(edges)
        if not nx.is_directed_acyclic_graph(g):
            adj: dict[int, list[int]] = defaultdict(list)
            for e in edges:
                adj[e.prereq_category_id].append(e.category_id)
            cycle = kahn_cycle_members(adj)
            raise CycleDetectedError(
                f"存量 active 图已存在环（环成员 {cycle}），无法归约，请先修复", cycle_members=cycle
            )

        reduced = nx.transitive_reduction(g)
        redundant_ids: list[int] = []
        for e in edges:
            if not reduced.has_edge(e.prereq_category_id, e.category_id):
                e.status = "redundant"
                redundant_ids.append(e.id)
        if redundant_ids:
            await self.db.commit()
        return {
            "checked": len(edges),
            "redundant": len(redundant_ids),
            "redundant_edge_ids": redundant_ids,
        }

    # ── 查询 ────────────────────────────────────────────────────────────

    async def query_prerequisites(self, category_id: int) -> dict:
        """先修链查询：从目标沿反向边 BFS（跨域边同样参与，节点带 domain 标注）."""
        edges = await self._load_active_edges()
        adj: dict[int, list[PrerequisiteEdgeORM]] = defaultdict(list)
        for e in edges:
            adj[e.category_id].append(e)

        chain_edges: list[dict] = []
        node_ids: dict[int, int] = {}  # category_id -> level（防重）
        seen_edges: set[int] = set()
        queue = [category_id]
        while queue:
            cur = queue.pop(0)
            for e in adj.get(cur, []):
                if e.id in seen_edges:
                    continue
                seen_edges.add(e.id)
                chain_edges.append(
                    {
                        "id": e.id,
                        "prereq_category_id": e.prereq_category_id,
                        "category_id": e.category_id,
                        "edge_type": e.edge_type,
                        "source_domain_id": e.source_domain_id,
                        "confidence": float(e.confidence),
                    }
                )
                node_ids.setdefault(e.prereq_category_id, 0)
                queue.append(e.prereq_category_id)

        # 补节点信息（name/level/domain_id）
        nodes = await self._load_categories(list(node_ids.keys()))
        return {
            "category_id": category_id,
            "nodes": nodes,
            "edges": chain_edges,
            "decision": "ok",
            "missing": [],  # 掌握度数据源不在相关表范围，由调用方自行判定
            "suggestion_type": "blocking",
        }

    async def list_contrasts(self, category_id: int) -> list[dict]:
        """T4.4：目标知识点的易混淆邻居（active contrasts_with 边，双向对称）.

        contrasts_with 无方向语义：边可能存成 (category_id=X, prereq_category_id=Y)
        或反过来，查询时两个方向都要看；只返回已审核生效（active）的边——proposed
        候选尚未确认，不应该出现在出题提示词里。
        """
        result = await self.db.execute(
            select(PrerequisiteEdgeORM).where(
                PrerequisiteEdgeORM.edge_type == "contrasts_with",
                PrerequisiteEdgeORM.status == "active",
                or_(
                    PrerequisiteEdgeORM.category_id == category_id,
                    PrerequisiteEdgeORM.prereq_category_id == category_id,
                ),
            )
        )
        edges = list(result.scalars().all())
        neighbor_ids = sorted(
            {
                (e.prereq_category_id if e.category_id == category_id else e.category_id)
                for e in edges
            }
        )
        if not neighbor_ids:
            return []
        nodes = await self._load_categories(neighbor_ids)
        by_id = {n["category_id"]: n for n in nodes}
        return [
            {"category_id": nid, "name": by_id.get(nid, {}).get("name")}
            for nid in neighbor_ids
            if nid in by_id
        ]

    async def list_edges(
        self,
        domain_id: int | None = None,
        status: str | None = None,
        edge_type: str | None = None,
    ) -> list[PrerequisiteEdgeORM]:
        query = select(PrerequisiteEdgeORM)
        if domain_id is not None:
            query = query.where(PrerequisiteEdgeORM.domain_id == domain_id)
        if status:
            if status not in STATUSES:
                raise InvalidEdgeError(f"status 非法: {status}")
            query = query.where(PrerequisiteEdgeORM.status == status)
        if edge_type:
            if edge_type not in EDGE_TYPES:
                raise InvalidEdgeError(f"edge_type 非法: {edge_type}")
            query = query.where(PrerequisiteEdgeORM.edge_type == edge_type)
        query = query.order_by(PrerequisiteEdgeORM.id)
        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def review_queue(self, domain_id: int | None = None) -> list[PrerequisiteEdgeORM]:
        """审核队列：proposed + needs_review 边（低置信度优先）.

        needs_review（T4.1-T4.3 交接遗留项 a）：作答数据投票（`qb graph-vote`）判定
        显著为负 / T4.6 图谱增量重审判定需复核的边，同样需要人工在此队列中看到。
        """
        query = select(PrerequisiteEdgeORM).where(
            PrerequisiteEdgeORM.status.in_(["proposed", "needs_review"])
        )
        if domain_id is not None:
            query = query.where(PrerequisiteEdgeORM.domain_id == domain_id)
        query = query.order_by(PrerequisiteEdgeORM.confidence)
        result = await self.db.execute(query)
        return list(result.scalars().all())

    # ── 路径规划 ──────────────────────────────────────────────────────

    async def plan_path(self, from_id: int, to_id: int) -> dict:
        """学习路径规划：from 已掌握 → 到 to 的学习路径（拓扑序）.

        - from 可达 to：返回 BFS 最短边路径（含中间节点）
        - from 不可达：返回 to 的全部先修链 + 提示缺连接（跨域边同样参与）
        """
        edges = await self._load_active_edges()
        adj: dict[int, list[int]] = defaultdict(list)
        for e in edges:
            adj[e.prereq_category_id].append(e.category_id)

        # BFS 找 from→to 路径
        parent: dict[int, int] = {}
        visited = {from_id}
        queue = [from_id]
        while queue and to_id not in visited:
            cur = queue.pop(0)
            for nxt in adj.get(cur, []):
                if nxt not in visited:
                    visited.add(nxt)
                    parent[nxt] = cur
                    queue.append(nxt)

        if to_id in visited:
            # 回溯路径（含两端）
            chain = [to_id]
            cur = to_id
            while cur in parent:
                cur = parent[cur]
                chain.append(cur)
            chain.reverse()
            nodes = await self._load_categories(chain)
            by_id = {n["category_id"]: n for n in nodes}
            return {
                "from_id": from_id,
                "to_id": to_id,
                "reachable": True,
                "path": [
                    {"category_id": cid, **{k: by_id[cid].get(k) for k in ("name", "level", "domain_id", "parent_id")}}
                    for cid in chain if cid in by_id
                ],
                "path_ids": chain,
            }

        # 不可达：返回 to 的先修链，标注 from 位置
        chain_result = await self.query_prerequisites(to_id)
        chain_ids = [n["category_id"] for n in chain_result["nodes"]]
        return {
            "from_id": from_id,
            "to_id": to_id,
            "reachable": False,
            "path": [],
            "path_ids": [],
            "missing_connection": f"{from_id} 不可达 {to_id}",
            "target_prerequisite_ids": chain_ids,
            "target_prerequisites": chain_result["nodes"],
        }

    # ── 一致性校验 ──────────────────────────────────────────────────────

    async def validate_consistency(self, domain_id: int | None = None) -> dict:
        """全图校验：引用完整性（孤儿边）+ Kahn 环检测（存量漂移兜底）."""
        errors: list[str] = []
        edges = await self.list_edges(domain_id)

        # 引用完整性：边两端的 category 必须存在
        cat_ids = {e.category_id for e in edges} | {e.prereq_category_id for e in edges}
        nodes = await self._load_categories(list(cat_ids))
        existing = {n["category_id"] for n in nodes}
        for e in edges:
            if e.category_id not in existing:
                errors.append(f"边 {e.id} 引用不存在的目标节点 {e.category_id}")
            if e.prereq_category_id not in existing:
                errors.append(f"边 {e.id} 引用不存在的先修节点 {e.prereq_category_id}")

        # 环检测：仅 prerequisite/cross_domain（related 不入 DAG）
        active = [e for e in edges if e.status == "active"
                  and e.edge_type in ("prerequisite", "cross_domain_prerequisite")]
        adj: dict[int, list[int]] = defaultdict(list)
        for e in active:
            adj[e.prereq_category_id].append(e.category_id)
        cycle = kahn_cycle_members(adj)
        if cycle:
            errors.append(f"检测到环，环成员: {cycle}")

        return {
            "is_consistent": len(errors) == 0,
            "errors": errors,
            "edge_count": len(edges),
            "active_prereq_count": len(active),
        }

    # ── 删除（软删，可审计） ────────────────────────────────────────────

    async def delete_edge(self, edge_id: int) -> PrerequisiteEdgeORM:
        """删除边：status → deprecated（不物理删除）."""
        edge = await self._get_edge_by_id(edge_id)
        if edge is None:
            raise InvalidEdgeError(f"边不存在: {edge_id}")
        edge.status = "deprecated"
        await self.db.commit()
        await self.db.refresh(edge)
        return edge

    # ── 内部工具 ────────────────────────────────────────────────────────

    async def _load_category(self, category_id: int) -> dict | None:
        result = await self.db.execute(
            text(
                "SELECT id, domain_id, parent_id, level, node_type, sort_order "
                "FROM knowledge_category WHERE id = :cid"
            ),
            {"cid": category_id},
        )
        row = result.mappings().first()
        if row is None:
            return None
        return {
            "id": row["id"],
            "domain_id": row["domain_id"],
            "parent_id": row["parent_id"],
            "level": row["level"],
            "node_type": row["node_type"],
            "sort_order": row["sort_order"] or 0,
        }

    async def _load_categories(self, category_ids: list[int]) -> list[dict]:
        if not category_ids:
            return []
        result = await self.db.execute(
            text(
                "SELECT id, domain_id, parent_id, name, level, node_type "
                "FROM knowledge_category WHERE id IN :ids"
            ).bindparams(
                bindparam("ids", expanding=True, type_=None)
            ),
            {"ids": category_ids},
        )
        rows = result.mappings().all()
        return [
            {
                "category_id": r["id"],
                "domain_id": r["domain_id"],
                "parent_id": r["parent_id"],
                "name": r["name"],
                "level": r["level"],
                "node_type": r["node_type"],
            }
            for r in rows
        ]

    async def _load_active_edges(self) -> list[PrerequisiteEdgeORM]:
        """仅 active 边（先修链查询/一致性校验用：proposed 未生效不参与）."""
        result = await self.db.execute(
            select(PrerequisiteEdgeORM).where(
                PrerequisiteEdgeORM.status == "active",
                PrerequisiteEdgeORM.edge_type.in_(["prerequisite", "cross_domain_prerequisite"]),
            )
        )
        return list(result.scalars().all())

    async def _load_effective_edges(self) -> list[PrerequisiteEdgeORM]:
        """有效边：active + proposed（rejected/deprecated 排除，related 不入 DAG）.

        祖先检查与激活 Kahn 都基于有效图——proposed 同样占位，
        防止"两条反向 proposed"或"存量 proposed + 新边"组合成环。
        """
        result = await self.db.execute(
            select(PrerequisiteEdgeORM).where(
                PrerequisiteEdgeORM.status.in_(["active", "proposed"]),
                PrerequisiteEdgeORM.edge_type.in_(["prerequisite", "cross_domain_prerequisite"]),
            )
        )
        return list(result.scalars().all())

    async def _get_edge(self, category_id: int, prereq_category_id: int) -> PrerequisiteEdgeORM | None:
        result = await self.db.execute(
            select(PrerequisiteEdgeORM).where(
                PrerequisiteEdgeORM.category_id == category_id,
                PrerequisiteEdgeORM.prereq_category_id == prereq_category_id,
            )
        )
        return result.scalar_one_or_none()

    async def _get_edge_by_id(self, edge_id: int) -> PrerequisiteEdgeORM | None:
        result = await self.db.execute(
            select(PrerequisiteEdgeORM).where(PrerequisiteEdgeORM.id == edge_id)
        )
        return result.scalar_one_or_none()

    async def _cycle_if_activated(self, edge: PrerequisiteEdgeORM) -> list[int]:
        """假设 edge 激活后的全图环检测（有效图 = active + proposed）."""
        return self._kahn_with_edges(await self._load_effective_edges())

    def _kahn_with_edges(self, edges: list[PrerequisiteEdgeORM]) -> list[int]:
        adj: dict[int, list[int]] = defaultdict(list)
        for e in edges:
            adj[e.prereq_category_id].append(e.category_id)
        return kahn_cycle_members(adj)

    # ── T4.7：传递归约闸门 ──────────────────────────────────────────────

    @staticmethod
    def _build_digraph(edges: list[PrerequisiteEdgeORM]) -> "nx.DiGraph":
        g = nx.DiGraph()
        for e in edges:
            g.add_edge(e.prereq_category_id, e.category_id)
        return g

    async def _transitive_reduction_check(self, candidate_edges: list[PrerequisiteEdgeORM]) -> None:
        """激活闸门内（与 Kahn 检查同处）：G = active 边 ∪ 本批待激活边.

        对 G 跑 nx.transitive_reduction；若某待激活边不在归约结果中，说明它已被图中
        其他路径传递蕴含（冗余边），拒绝激活并给出替代路径说明（供审计/前端展示）。
        调用前须已通过 Kahn 环检测（保证 G 是 DAG，否则 transitive_reduction 会报错）。
        """
        active_edges = await self._load_active_edges()
        g = self._build_digraph(list(active_edges) + list(candidate_edges))

        if not nx.is_directed_acyclic_graph(g):
            # 环检测已在 Kahn 步骤处理，这里防御性跳过（正常路径不会触发）
            return

        reduced = nx.transitive_reduction(g)
        redundant: list[dict] = []
        for e in candidate_edges:
            if reduced.has_edge(e.prereq_category_id, e.category_id):
                continue
            g_without = g.copy()
            g_without.remove_edge(e.prereq_category_id, e.category_id)
            try:
                path = nx.shortest_path(g_without, e.prereq_category_id, e.category_id)
            except nx.NetworkXNoPath:
                path = []
            redundant.append(
                {
                    "edge_id": e.id,
                    "prereq_category_id": e.prereq_category_id,
                    "category_id": e.category_id,
                    "path": path,
                }
            )

        if redundant:
            detail = "; ".join(
                f"边 {r['prereq_category_id']}→{r['category_id']}(id={r['edge_id']}) "
                f"已被路径 {'→'.join(str(n) for n in r['path'])} 传递蕴含，属冗余边，拒绝激活"
                for r in redundant
            )
            raise RedundantEdgeError(f"传递归约拒绝：{detail}", redundant_edges=redundant)

    @staticmethod
    def _bfs(adj: dict[int, list[int]], start: int) -> set[int]:
        visited: set[int] = set()
        queue = [start]
        while queue:
            cur = queue.pop(0)
            if cur in visited:
                continue
            visited.add(cur)
            for nxt in adj.get(cur, []):
                if nxt not in visited:
                    queue.append(nxt)
        return visited
