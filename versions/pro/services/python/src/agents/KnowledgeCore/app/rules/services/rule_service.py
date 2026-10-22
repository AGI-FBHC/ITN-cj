"""规则执行引擎."""
from __future__ import annotations
from typing import Optional

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.rules.models.orm import RuleBundleORM, RuleExecutionLogORM


class RuleService:
    """规则 DSL 执行、受控谓词调用."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def build_fact_snapshot(
        self,
        task: dict,
        learner: Optional[dict],
        domain_id: str,
        snapshot_id: str,
    ) -> dict:
        """构建事实快照."""
        import uuid as uuid_mod
        fact_id = f"fact_{uuid_mod.uuid4().hex[:8]}"

        fact_snapshot = {
            "fact_id": fact_id,
            "domain_runtime_snapshot_id": snapshot_id,
            "query": task.get("query", ""),
            "task_type": task.get("task_type", "question"),
            "user_context": {
                "learner": learner or {},
                **(task.get("user_context") or {}),
            },
            "relevant_sections": [],
            "relevant_skills": [],
            "prerequisite_chain": [],
            "related_entities": [],
            "constraints": task.get("constraints", {}),
        }

        return fact_snapshot

    async def execute_rules(
        self,
        fact_snapshot: dict,
        rules: list[dict],
        domain_id: str,
        persist: bool = True,
    ) -> dict:
        """执行规则.

        persist=False 时不写 rule_execution_logs（纯内存模式，供不建表环境使用）。
        """
        execution_id = f"exec_{uuid.uuid4().hex[:8]}"
        hit_rules = []
        blocked_by = []
        restricted_by = []
        messages = []
        passed = True

        for rule in rules:
            rule_id = rule.get("rule_id", "")
            level = rule.get("level", "soft")
            predicate = rule.get("predicate", "")
            action = rule.get("action", "")
            message = rule.get("message", "")
            params = rule.get("params", {})

            # Evaluate predicate (simplified)
            is_hit = self._evaluate_predicate(predicate, params, fact_snapshot)

            if is_hit:
                hit_rules.append(rule)

                if action == "block":
                    blocked_by.append(rule)
                    passed = False
                    messages.append(f"BLOCKED by {rule_id}: {message}")
                elif action == "restrict":
                    restricted_by.append(rule)
                    messages.append(f"RESTRICTED by {rule_id}: {message}")
                else:
                    messages.append(f"Rule {rule_id} hit: {message}")

        result = {
            "execution_id": execution_id,
            "domain_id": domain_id,
            "fact_snapshot_id": fact_snapshot.get("fact_id", ""),
            "passed": passed,
            "hit_rules": hit_rules,
            "blocked_by": blocked_by,
            "restricted_by": restricted_by,
            "messages": messages,
        }

        # Persist execution log
        if persist:
            log = RuleExecutionLogORM(
                execution_id=execution_id,
                domain_id=domain_id,
                bundle_id="",
                fact_snapshot_id=fact_snapshot.get("fact_id", ""),
                hit_rules=hit_rules,
                blocked_by=blocked_by,
                restricted_by=restricted_by,
                messages=messages,
                passed=passed,
            )
            self.db.add(log)
            await self.db.commit()

        return result

    async def pre_retrieval_rules(
        self,
        fact_snapshot: dict,
        rules: list[dict],
    ) -> dict:
        """执行检索前规则.

        返回检索策略调整：
        - expanded_queries: 扩展查询列表
        - required_sections: 必需章节
        - excluded_documents: 排除文档
        - max_results: 最大结果数
        """
        retrieval_hints = {
            "expanded_queries": [],
            "required_sections": [],
            "excluded_documents": [],
            "max_results": 10,
        }

        for rule in rules:
            level = rule.get("level", "soft")
            predicate = rule.get("predicate", "")
            params = rule.get("params", {})

            if self._evaluate_predicate(predicate, params, fact_snapshot):
                action = rule.get("action", "")
                if action == "expand_query":
                    retrieval_hints["expanded_queries"].extend(
                        params.get("queries", [])
                    )
                elif action == "require_section":
                    retrieval_hints["required_sections"].extend(
                        params.get("sections", [])
                    )
                elif action == "exclude_document":
                    retrieval_hints["excluded_documents"].extend(
                        params.get("document_ids", [])
                    )
                elif action == "limit_results":
                    retrieval_hints["max_results"] = params.get("max", 10)

        return retrieval_hints

    async def post_retrieval_rules(
        self,
        fact_snapshot: dict,
        evidence_pack: dict,
        rules: list[dict],
    ) -> dict:
        """执行检索后规则.

        返回过滤和调整后的证据包。
        """
        filter_results = {
            "filtered_items": [],
            "re_ranked": False,
            "additional_filters": [],
        }

        evidence_items = evidence_pack.get("evidence_items", [])

        for rule in rules:
            predicate = rule.get("predicate", "")
            params = rule.get("params", {})
            action = rule.get("action", "")

            if self._evaluate_predicate(predicate, params, {**fact_snapshot, "evidence_pack": evidence_pack}):
                if action == "filter_evidence":
                    # Apply filters
                    min_similarity = params.get("min_similarity", 0.0)
                    required_roles = params.get("required_roles", [])

                    filtered = []
                    for item in evidence_items:
                        if item.get("similarity_score", 0) >= min_similarity:
                            if not required_roles or item.get("evidence_role") in required_roles:
                                filtered.append(item)

                    evidence_items = filtered
                    filter_results["filtered_items"] = filtered

                elif action == "re_rank":
                    # Re-rank by custom criteria
                    sort_key = params.get("sort_by", "similarity_score")
                    reverse = params.get("reverse", True)
                    evidence_items.sort(key=lambda x: x.get(sort_key, 0), reverse=reverse)
                    filter_results["re_ranked"] = True

        filter_results["filtered_items"] = evidence_items
        return filter_results

    def _evaluate_predicate(self, predicate: str, params: dict, context: dict) -> bool:
        """评估谓词.

        简化实现：基于谓词名称进行基本判断。
        实际实现应使用受控谓词库。
        """
        # Simple predicate evaluation
        if predicate == "always":
            return True
        elif predicate == "never":
            return False
        elif predicate == "high_risk_task":
            task_type = context.get("task_type", "")
            return task_type in ["troubleshooting", "exercise"]
        elif predicate == "has_constraints":
            constraints = context.get("constraints", {})
            return bool(constraints)
        elif predicate == "query_contains":
            query = context.get("query", "").lower()
            keywords = params.get("keywords", [])
            return any(kw.lower() in query for kw in keywords)
        elif predicate == "evidence_count_below":
            evidence_pack = context.get("evidence_pack", {})
            count = len(evidence_pack.get("evidence_items", []))
            threshold = params.get("threshold", 1)
            return count < threshold
        elif predicate == "similarity_below":
            evidence_pack = context.get("evidence_pack", {})
            items = evidence_pack.get("evidence_items", [])
            if not items:
                return True
            avg_sim = sum(e.get("similarity_score", 0) for e in items) / len(items)
            threshold = params.get("threshold", 0.3)
            return avg_sim < threshold

        # Default: predicate not recognized, don't trigger
        return False

    async def get_active_bundle(self, domain_id: str) -> Optional[RuleBundleORM]:
        """获取活跃规则包."""
        # First check rule_bundles table
        result = await self.db.execute(
            select(RuleBundleORM).where(
                RuleBundleORM.domain_id == domain_id,
                RuleBundleORM.status == "active",
            )
        )
        bundle = result.scalar_one_or_none()
        if bundle:
            return bundle

        # If not found, check domain_rule_bundles table
        from app.domain.models.orm import DomainRuleBundleORM
        result = await self.db.execute(
            select(DomainRuleBundleORM).where(
                DomainRuleBundleORM.domain_id == domain_id,
                DomainRuleBundleORM.status == "active",
            )
        )
        domain_bundle = result.scalar_one_or_none()
        if domain_bundle:
            # Convert to RuleBundleORM format
            return RuleBundleORM(
                bundle_id=f"drb_{domain_bundle.id}",
                domain_id=domain_bundle.domain_id,
                domain_version_id=domain_bundle.domain_version_id,
                version=domain_bundle.bundle_version,
                rules_json=domain_bundle.rules_json,
                predicate_dependencies=domain_bundle.predicate_dependencies,
                test_suite_ref=domain_bundle.test_suite_ref,
                status=domain_bundle.status,
            )
        return None

    async def get_bundle_by_id(self, bundle_id: str) -> Optional[RuleBundleORM]:
        """根据 ID 获取规则包."""
        result = await self.db.execute(
            select(RuleBundleORM).where(RuleBundleORM.bundle_id == bundle_id)
        )
        return result.scalar_one_or_none()

    async def list_bundles(self, domain_id: str) -> list[RuleBundleORM]:
        """列出规则包."""
        result = await self.db.execute(
            select(RuleBundleORM).where(RuleBundleORM.domain_id == domain_id)
        )
        return list(result.scalars().all())
