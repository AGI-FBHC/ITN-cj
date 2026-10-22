"""受控谓词注册与执行"""


class PredicateRegistry:
    """受控谓词的注册、测试和版本化管理"""

    def __init__(self) -> None:
        self._predicates: dict[str, callable] = {}

    def register(self, name: str, func: callable) -> None:
        self._predicates[name] = func

    def get(self, name: str) -> Optional[callable]:
        return self._predicates.get(name)

    def list_all(self) -> list[str]:
        return list(self._predicates.keys())

    async def execute(self, name: str, **kwargs) -> dict:
        func = self._predicates.get(name)
        if func is None:
            return {"error": f"Predicate {name} not found"}
        result = func(**kwargs)
        return {"predicate": name, "result": result}


predicate_registry = PredicateRegistry()
