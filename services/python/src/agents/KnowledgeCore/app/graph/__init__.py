"""先修关系图模块（新实现，对应 AGENT/dag-design.md）.

节点 = knowledge_category.id（目录树即图节点，不复制节点）
边表 = knowledge_category_prerequisite（生产库已建表）

旧实现（graph_nodes/graph_edges，21 表蓝图）已确认无引用并删除（T5.3 唯一事实源收敛，2026-08-17）。
"""
