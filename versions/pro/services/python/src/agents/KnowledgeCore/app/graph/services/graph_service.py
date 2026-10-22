"""知识图谱查询与校验服务."""
from __future__ import annotations
from typing import Optional

import uuid
from collections import defaultdict

from sqlalchemy import bindparam, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.graph.models.orm import GraphEdgeORM, GraphNodeORM

# ── T1.2：graph_consistency 距离→分数映射（模块级常量，便于后续按评估结果调整） ──
# 沿 knowledge_category_prerequisite（先修边，节点=knowledge_category.id）BFS：
# 同点(distance=0) / 一跳 / 二跳 依次递减；超过二跳或不可达统一按"无路径"处理。
GRAPH_CONSISTENCY_DISTANCE_SCORES: dict[int, float] = {0: 1.0, 1: 0.8, 2: 0.6}
GRAPH_CONSISTENCY_NO_PATH_SCORE = 0.3        # 无路径（含超过二跳）
GRAPH_CONSISTENCY_DEFAULT_SCORE = 0.8        # 图为空 / 查询失败 / 目标未知：兼容旧写死常量

# ── T4.2：学习前沿——mastery 达到该阈值视为"已掌握"（与 QuestionBank
# MasteryService.MASTERED_THRESHOLD / 前端展示口径保持一致） ──────────────────
FRONTIER_MASTERY_THRESHOLD = 0.7


class GraphService:
    """图谱查询、先修链、影响分析、一致性校验."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def create_node(
        self,
        domain_id: str,
        domain_version_id: str,
        node_type: str,
        name: str,
        description: Optional[str] = None,
        properties: Optional[dict] = None,
    ) -> GraphNodeORM:
        """创建图谱节点."""
        node = GraphNodeORM(
            node_id=f"node_{uuid.uuid4().hex[:8]}",
            domain_id=domain_id,
            domain_version_id=domain_version_id,
            node_type=node_type,
            name=name,
            description=description,
            properties=properties,
        )
        self.db.add(node)
        await self.db.commit()
        await self.db.refresh(node)
        return node

    async def create_edge(
        self,
        domain_id: str,
        domain_version_id: str,
        source_id: str,
        target_id: str,
        edge_type: str,
        weight: float = 1.0,
        properties: Optional[dict] = None,
    ) -> GraphEdgeORM:
        """创建图谱边."""
        # Verify nodes exist
        source = await self.get_node(source_id)
        target = await self.get_node(target_id)
        if not source or not target:
            raise ValueError("Source or target node not found")

        edge = GraphEdgeORM(
            edge_id=f"edge_{uuid.uuid4().hex[:8]}",
            domain_id=domain_id,
            domain_version_id=domain_version_id,
            source_id=source_id,
            target_id=target_id,
            edge_type=edge_type,
            weight=weight,
            properties=properties,
        )
        self.db.add(edge)
        await self.db.commit()
        await self.db.refresh(edge)
        return edge

    async def get_node(self, node_id: str) -> Optional[GraphNodeORM]:
        """获取节点."""
        result = await self.db.execute(
            select(GraphNodeORM).where(GraphNodeORM.node_id == node_id)
        )
        return result.scalar_one_or_none()

    async def list_nodes(
        self,
        domain_id: str,
        domain_version_id: Optional[str] = None,
        node_type: Optional[str] = None,
    ) -> list[GraphNodeORM]:
        """列出节点."""
        query = select(GraphNodeORM).where(GraphNodeORM.domain_id == domain_id)
        if domain_version_id:
            query = query.where(GraphNodeORM.domain_version_id == domain_version_id)
        if node_type:
            query = query.where(GraphNodeORM.node_type == node_type)

        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def list_edges(
        self,
        domain_id: str,
        domain_version_id: Optional[str] = None,
        edge_type: Optional[str] = None,
    ) -> list[GraphEdgeORM]:
        """列出边."""
        query = select(GraphEdgeORM).where(GraphEdgeORM.domain_id == domain_id)
        if domain_version_id:
            query = query.where(GraphEdgeORM.domain_version_id == domain_version_id)
        if edge_type:
            query = query.where(GraphEdgeORM.edge_type == edge_type)

        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def query_prerequisites(
        self,
        target_skill_id: str,
        domain_id: str,
        domain_version_id: str,
    ) -> dict:
        """查询先修链."""
        # Get all prerequisite edges for the domain
        edges = await self.list_edges(domain_id, domain_version_id, "prerequisite")

        # Build adjacency list
        graph: dict[str, list[str]] = defaultdict(list)
        for edge in edges:
            graph[edge.target_id].append(edge.source_id)

        # BFS to find all prerequisites
        visited = set()
        queue = [target_skill_id]
        prerequisite_chain = []

        while queue:
            current = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)

            prerequisites = graph.get(current, [])
            for prereq in prerequisites:
                if prereq not in visited:
                    queue.append(prereq)
                    prerequisite_chain.append({
                        "skill_id": current,
                        "prerequisite_id": prereq,
                    })

        # Check which prerequisites are satisfied (simplified)
        completed_prerequisites = []  # Would need learner state
        missing_prerequisites = [p["prerequisite_id"] for p in prerequisite_chain]

        return {
            "target_skill_id": target_skill_id,
            "is_satisfied": len(missing_prerequisites) == 0,
            "missing_prerequisites": missing_prerequisites,
            "completed_prerequisites": completed_prerequisites,
            "prerequisite_chain": prerequisite_chain,
        }

    async def analyze_impact(self, entity_id: str, domain_id: str) -> dict:
        """影响分析."""
        # Get all edges
        edges = await self.list_edges(domain_id)

        # Build adjacency list (reverse)
        reverse_graph: dict[str, list[str]] = defaultdict(list)
        for edge in edges:
            reverse_graph[edge.source_id].append(edge.target_id)

        # BFS to find affected entities
        visited = set()
        queue = [entity_id]
        affected_entities = []

        while queue:
            current = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)

            if current != entity_id:
                node = await self.get_node(current)
                if node:
                    affected_entities.append({
                        "node_id": node.node_id,
                        "node_type": node.node_type,
                        "name": node.name,
                    })

            for neighbor in reverse_graph.get(current, []):
                if neighbor not in visited:
                    queue.append(neighbor)

        return {
            "entity_id": entity_id,
            "affected_entities": affected_entities,
            "impact_paths": [],  # Simplified
        }

    async def expand_retrieval(
        self,
        target_skill_id: str,
        task_type: str,
        domain_id: str,
    ) -> dict:
        """扩展检索."""
        # Get related nodes
        edges = await self.list_edges(domain_id)

        # Find related entities
        related = []
        for edge in edges:
            if edge.source_id == target_skill_id:
                related.append(edge.target_id)
            elif edge.target_id == target_skill_id:
                related.append(edge.source_id)

        # Get node details
        expanded_nodes = []
        for node_id in related:
            node = await self.get_node(node_id)
            if node:
                expanded_nodes.append({
                    "node_id": node.node_id,
                    "node_type": node.node_type,
                    "name": node.name,
                })

        return {
            "target_skill_id": target_skill_id,
            "expanded_nodes": expanded_nodes,
            "suggested_queries": [node["name"] for node in expanded_nodes[:5]],
        }

    async def locate_constraints(
        self,
        task_id: str,
        risk_level: str,
        domain_id: str,
    ) -> dict:
        """定位约束."""
        # Get rule-type nodes
        rule_nodes = await self.list_nodes(domain_id, node_type="rule")

        # Filter by risk level (simplified)
        constraints = []
        for node in rule_nodes:
            props = node.properties or {}
            if props.get("risk_level") == risk_level or risk_level == "all":
                constraints.append({
                    "node_id": node.node_id,
                    "name": node.name,
                    "properties": props,
                })

        return {
            "task_id": task_id,
            "risk_level": risk_level,
            "constraints": constraints,
        }

    async def validate_consistency(self, domain_id: str, domain_version_id: str) -> dict:
        """一致性校验."""
        errors = []
        warnings = []

        # Get all nodes and edges
        nodes = await self.list_nodes(domain_id, domain_version_id)
        edges = await self.list_edges(domain_id, domain_version_id)

        node_ids = {node.node_id for node in nodes}

        # Check edge references
        for edge in edges:
            if edge.source_id not in node_ids:
                errors.append(f"Edge {edge.edge_id} references non-existent source node {edge.source_id}")
            if edge.target_id not in node_ids:
                errors.append(f"Edge {edge.edge_id} references non-existent target node {edge.target_id}")

        # Check for orphan nodes
        connected_nodes = set()
        for edge in edges:
            connected_nodes.add(edge.source_id)
            connected_nodes.add(edge.target_id)

        orphans = node_ids - connected_nodes
        if orphans:
            warnings.append(f"Found {len(orphans)} orphan nodes")

        # Check for cycles in prerequisite graph
        prereq_edges = [e for e in edges if e.edge_type == "prerequisite"]
        if self._has_cycle(prereq_edges):
            errors.append("Cycle detected in prerequisite graph")

        return {
            "domain_id": domain_id,
            "domain_version_id": domain_version_id,
            "is_consistent": len(errors) == 0,
            "errors": errors,
            "warnings": warnings,
            "node_count": len(nodes),
            "edge_count": len(edges),
        }

    # ── T1.2：graph_consistency 真值化 ───────────────────────────────────

    async def _prerequisite_adjacency(self) -> Optional[dict[int, set[int]]]:
        """读取 knowledge_category_prerequisite 的 active 边，构建无向邻接表.

        表不存在 / 查询失败 / 表为空 → 返回 None（调用方据此走兼容默认值）。
        """
        try:
            rows = (
                await self.db.execute(
                    text(
                        "SELECT category_id, prereq_category_id "
                        "FROM knowledge_category_prerequisite WHERE status = 'active'"
                    )
                )
            ).mappings().all()
        except Exception:  # noqa: BLE001 — 表未迁移/生产库不可达时优雅降级，不影响 HF 评分主链路
            return None
        if not rows:
            return None
        adjacency: dict[int, set[int]] = defaultdict(set)
        for r in rows:
            a, b = int(r["category_id"]), int(r["prereq_category_id"])
            adjacency[a].add(b)
            adjacency[b].add(a)
        return adjacency

    @staticmethod
    def _bfs_distance(
        adjacency: dict[int, set[int]], start: int, target: int, max_depth: int = 2
    ) -> Optional[int]:
        """无向 BFS，最多探测 max_depth 跳；找不到返回 None（视为无路径）."""
        if start == target:
            return 0
        visited = {start}
        frontier = [start]
        depth = 0
        while frontier and depth < max_depth:
            depth += 1
            next_frontier: list[int] = []
            for node in frontier:
                for neighbor in adjacency.get(node, ()):
                    if neighbor == target:
                        return depth
                    if neighbor not in visited:
                        visited.add(neighbor)
                        next_frontier.append(neighbor)
            frontier = next_frontier
        return None

    @staticmethod
    def _distance_to_score(distance: Optional[int]) -> float:
        if distance is None:
            return GRAPH_CONSISTENCY_NO_PATH_SCORE
        return GRAPH_CONSISTENCY_DISTANCE_SCORES.get(distance, GRAPH_CONSISTENCY_NO_PATH_SCORE)

    async def consistency_detail(
        self, evidence_category_ids: list[int], target_category_id: Optional[int]
    ) -> list[dict]:
        """各证据类别到目标类别的 BFS 距离明细（供 audit_trail 展示）.

        证据为空 / 目标未知 / 图为空 / 查询失败 → 返回空列表（区别于"已算出但无路径"）。
        """
        if not evidence_category_ids or target_category_id is None:
            return []
        adjacency = await self._prerequisite_adjacency()
        if adjacency is None:
            return []
        details = []
        for cid in evidence_category_ids:
            distance = self._bfs_distance(adjacency, cid, target_category_id)
            details.append(
                {
                    "evidence_category_id": cid,
                    "target_category_id": target_category_id,
                    "distance": distance,
                    "score": self._distance_to_score(distance),
                }
            )
        return details

    async def consistency_score(
        self, evidence_category_ids: list[int], target_category_id: Optional[int]
    ) -> float:
        """沿 prerequisite 边 BFS：同点1.0 / 一跳0.8 / 二跳0.6 / 无路径0.3；取各证据均值.

        图为空 / 查询失败 / 无有效目标或证据 → 兼容默认值 0.8（与现状写死常量一致）。
        """
        detail = await self.consistency_detail(evidence_category_ids, target_category_id)
        if not detail:
            return GRAPH_CONSISTENCY_DEFAULT_SCORE
        return sum(d["score"] for d in detail) / len(detail)

    # ── T4.5：GraphRAG 一跳 ────────────────────────────────────────────────

    async def direct_prerequisites(self, category_id: int) -> list[dict]:
        """目标知识点的直接（1 跳）先修节点列表（active prerequisite/cross_domain 边）.

        按 confidence 降序（更可信的先修优先被采纳为证据来源）。
        表未迁移 / 查询失败 → 优雅降级返回空列表，不影响决策主链路。
        """
        try:
            rows = (
                await self.db.execute(
                    text(
                        "SELECT p.prereq_category_id AS category_id, p.confidence, c.name "
                        "FROM knowledge_category_prerequisite p "
                        "JOIN knowledge_category c ON c.id = p.prereq_category_id "
                        "WHERE p.category_id = :cid AND p.status = 'active' "
                        "AND p.edge_type IN ('prerequisite', 'cross_domain_prerequisite') "
                        "ORDER BY p.confidence DESC"
                    ),
                    {"cid": category_id},
                )
            ).mappings().all()
        except Exception:  # noqa: BLE001 — 表未迁移/查询失败不应中断决策主链路
            return []
        return [
            {"category_id": int(r["category_id"]), "name": r["name"], "confidence": float(r["confidence"])}
            for r in rows
        ]

    # ── T4.2：学习前沿 ────────────────────────────────────────────────────

    async def learning_frontier(self, domain_id: int, user_id: str) -> list[dict]:
        """"先修全掌握而自身未掌握"的节点列表（数据飞轮：mastery + 先修图联动）.

        读 `user_knowledge_state`（QuestionBank AttemptService 提交后落库的掌握度，
        同一 itn-platform 库，KnowledgeCore 只读消费）+ `knowledge_category_prerequisite`
        的 active 先修边：目标节点的全部先修均已掌握（mastery >= 0.7）且自身未掌握
        （含从未有过作答记录）→ 判定为"学习前沿"，即用户当下最该学的下一批知识点。

        任一查询失败（表不存在 / 库不可达）→ 优雅降级返回空列表，不抛异常
        （与 T1.2 consistency_score 的降级约定一致）。
        """
        try:
            mastery_rows = (
                await self.db.execute(
                    text("SELECT category_id, mastery FROM user_knowledge_state WHERE user_id = :uid"),
                    {"uid": user_id},
                )
            ).mappings().all()
        except Exception:  # noqa: BLE001 — 表未迁移/生产库不可达时优雅降级
            return []
        mastered: set[int] = {
            int(r["category_id"]) for r in mastery_rows if float(r["mastery"]) >= FRONTIER_MASTERY_THRESHOLD
        }

        try:
            edge_rows = (
                await self.db.execute(
                    text(
                        "SELECT category_id, prereq_category_id FROM knowledge_category_prerequisite "
                        "WHERE status = 'active' "
                        "AND edge_type IN ('prerequisite', 'cross_domain_prerequisite') "
                        "AND domain_id = :did"
                    ),
                    {"did": domain_id},
                )
            ).mappings().all()
        except Exception:  # noqa: BLE001
            return []

        prereqs_of: dict[int, set[int]] = defaultdict(set)
        for r in edge_rows:
            prereqs_of[int(r["category_id"])].add(int(r["prereq_category_id"]))

        frontier_ids = sorted(
            cid
            for cid, prereqs in prereqs_of.items()
            if cid not in mastered and prereqs and prereqs.issubset(mastered)
        )
        if not frontier_ids:
            return []

        by_id: dict[int, dict] = {}
        try:
            rows = (
                await self.db.execute(
                    text(
                        "SELECT id, name, level, node_type FROM knowledge_category WHERE id IN :ids"
                    ).bindparams(bindparam("ids", expanding=True, type_=None)),
                    {"ids": frontier_ids},
                )
            ).mappings().all()
            by_id = {int(r["id"]): dict(r) for r in rows}
        except Exception:  # noqa: BLE001 — 节点详情查询失败不影响 id 列表可用
            pass

        return [
            {
                "category_id": cid,
                "name": by_id.get(cid, {}).get("name"),
                "level": by_id.get(cid, {}).get("level"),
                "node_type": by_id.get(cid, {}).get("node_type"),
                "mastered_prerequisites": sorted(prereqs_of[cid]),
            }
            for cid in frontier_ids
        ]

    def _has_cycle(self, edges: list[GraphEdgeORM]) -> bool:
        """检测是否有环."""
        # Build adjacency list
        graph: dict[str, list[str]] = defaultdict(list)
        for edge in edges:
            graph[edge.source_id].append(edge.target_id)

        # DFS cycle detection
        WHITE, GRAY, BLACK = 0, 1, 2
        color: dict[str, int] = defaultdict(int)

        def dfs(node: str) -> bool:
            if color[node] == GRAY:
                return True
            if color[node] == BLACK:
                return False

            color[node] = GRAY
            for neighbor in graph[node]:
                if dfs(neighbor):
                    return True
            color[node] = BLACK
            return False

        all_nodes = set(graph.keys())
        for edge in edges:
            all_nodes.add(edge.target_id)

        for node in all_nodes:
            if color[node] == WHITE:
                if dfs(node):
                    return True

        return False
