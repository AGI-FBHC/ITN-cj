"""Field Registry（§10 字段对齐）.

规则与事实可能使用不同字段名（height / work_height / 作业高度 / 高度）。
所有 Rule Extractor 和 Fact Extractor Prompt 都要求优先从注册表选择字段，
不存在时才创建新字段。
"""
from __future__ import annotations


class FieldRegistry:
    def __init__(self, aliases: dict[str, list[str]] | None = None):
        # canonical -> [alias, ...]
        self.aliases: dict[str, list[str]] = {}
        # 反向索引: alias -> canonical
        self._reverse: dict[str, str] = {}
        for canonical, alias_list in (aliases or DEFAULT_FIELD_ALIASES).items():
            self.add(canonical, alias_list)

    def add(self, canonical: str, alias_list: list[str]) -> None:
        self.aliases.setdefault(canonical, [])
        for alias in alias_list + [canonical]:
            key = alias.strip()
            if key and key not in self._reverse:
                self._reverse[key] = canonical

    def normalize(self, name: str) -> str:
        """把任意字段名归一化为 canonical 名；未注册则原样返回（小写去空格）."""
        if not name:
            return name
        key = name.strip()
        if key in self._reverse:
            return self._reverse[key]
        # 大小写/空白不敏感兜底
        lowered = key.lower()
        for alias, canonical in self._reverse.items():
            if alias.lower() == lowered:
                return canonical
        return key

    def aliases_of(self, canonical: str) -> list[str]:
        """返回 canonical 及其全部别名（含 canonical 自身），用于 facts 反查."""
        result = [canonical]
        for alias, canon in self._reverse.items():
            if canon == canonical and alias not in result:
                result.append(alias)
        return result

    def describe(self) -> str:
        """生成注入 LLM Prompt 的字段注册表描述."""
        lines = []
        for canonical, alias_list in self.aliases.items():
            lines.append(f"- {canonical}（可接受别名: {', '.join(alias_list)}）")
        return "\n".join(lines)


DEFAULT_FIELD_ALIASES: dict[str, list[str]] = {
    "height": ["work_height", "作业高度", "高度", "坠落高度"],
    "work_type": ["task_type", "作业类型", "任务类型", "work_category"],
    "equipment_type": ["设备类型", "equipment"],
    "equipment_status": ["设备状态", "power_status", "电源状态"],
    "power_cut": ["已断电", "断电", "power_off", "是否断电"],
    "task_type": ["任务类型", "task", "作业任务"],
    "scene": ["场景", "scenario", "work_scenario", "作业场景"],
    "target_audience": ["受众", "audience", "目标人群", "training_audience"],
    "content_type": ["内容类型", "content_form", "产出形式"],
    "language": ["语言", "lang"],
    "paradigm": ["agent_paradigm", "范式", "智能体范式", "框架范式"],
    "use_reflection": ["启用反思", "reflection_enabled", "是否反思"],
    "max_iterations": ["最大迭代次数", "迭代上限", "iteration_limit"],
}

field_registry = FieldRegistry()
