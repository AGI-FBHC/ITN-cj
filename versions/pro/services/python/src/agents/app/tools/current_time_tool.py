"""Current Time Tool - 获取当前日期与时间，用于判断信息时效性。"""

from datetime import datetime, timezone, timedelta

from app.tools.base import BaseTool, register_tool


@register_tool
class CurrentTimeTool(BaseTool):
    """获取当前服务器时间（北京时间 UTC+8），用于判断问题是否需要搜索最新信息。"""

    @property
    def id(self) -> str:
        return "get_current_time"

    @property
    def name(self) -> str:
        return "获取当前时间"

    @property
    def description(self) -> str:
        return (
            "【当前时间】获取当前的日期和时间（北京时间 UTC+8）。\n"
            "使用场景：\n"
            "- 用户问「最新」「最近」「今年」「2025」「当前」「现在」等有时间含义的问题时\n"
            "- 需要搜索互联前，先获取当前时间，以判断是否需要搜索\n"
            "- 用户询问时效性信息（新闻、技术更新、模型版本、API 变更等）\n\n"
            "不需要参数，直接调用即可返回当前日期时间。"
        )

    @property
    def parameters_schema(self) -> dict | None:
        return None

    async def execute(self, params: dict) -> dict:
        now = datetime.now(timezone(timedelta(hours=8)))
        return {
            "success": True,
            "datetime": now.strftime("%Y-%m-%d %H:%M:%S"),
            "date": now.strftime("%Y-%m-%d"),
            "time": now.strftime("%H:%M:%S"),
            "timezone": "Asia/Shanghai (UTC+8)",
            "weekday": ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][now.weekday()],
        }