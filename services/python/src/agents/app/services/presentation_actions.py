"""随堂问答动作协议与上下文窗口工具。

动作由 LLM 直接决策：模型在回答最开头输出 [[ACTION:xxx]] 标记，
后端解析为 control 事件驱动播放器（翻页/暂停/继续），正文必须剥离全部标记。
旧版 [[SLIDE:n]] 标记继续兼容解析为 goto。

上下文采用"系统提示词常驻 + 对话历史滑动窗口"：
- 系统提示词（含完整演讲稿与页码）永不参与滑动；
- 对话历史按条数与字符预算双上限截断，超窗直接丢弃，不做压缩。
"""
from __future__ import annotations

import re

# 动作标记：[[ACTION:goto:5]] [[ACTION:next]] [[ACTION:previous]] [[ACTION:play]] [[ACTION:pause]]
_ACTION_PATTERN = re.compile(r"\[\[ACTION:([a-zA-Z]+)(?::(\d+))?\]\]")
# 兼容旧标记：[[SLIDE:5]]
_SLIDE_PATTERN = re.compile(r"\[\[SLIDE:(\d+)\]\]")
# 兜底：剥离任何残留 [[...]] 形态标记
_ANY_BRACKET_PATTERN = re.compile(r"\[\[[^\]]*\]\]")

ALLOWED_ACTIONS = {"goto", "next", "previous", "play", "pause"}

# 追加进系统提示词的动作协议段（保持与 _presentation_chat_context 一致）
ACTION_PROTOCOL = (
    "\n动作协议：你可以通过动作标记控制讲播器。"
    "需要切换到另一页讲解时，在回答最开头输出[[ACTION:goto:页码]]，页码使用目录中的1起始页码；"
    "用户要求翻页时输出[[ACTION:next]]或[[ACTION:previous]]；"
    "用户要求暂停或继续播放时输出[[ACTION:pause]]或[[ACTION:play]]。"
    "动作标记必须放在回答最前面，多个标记依次排列；"
    "回答正文中禁止出现任何[[...]]标记。"
)

# 滑动窗口参数：MiMo v2.6 为 512K 上下文，系统提示词常驻，这里只约束对话历史。
WINDOW_MAX_ITEMS = 40  # 最多保留多少条历史消息（user/assistant 各算一条）
WINDOW_MAX_CHARS = 32_000  # 历史文本总字符预算


def _parse_single_marker(marker: str) -> dict | None:
    """解析单个 [[...]] 标记为 control 动作；不是合法动作返回 None。"""
    action_match = _ACTION_PATTERN.fullmatch(marker)
    if action_match:
        name = action_match.group(1).lower()
        if name not in ALLOWED_ACTIONS:
            return None
        action: dict = {"action": name}
        if name == "goto" and action_match.group(2):
            action["page"] = int(action_match.group(2))
        return action
    slide_match = _SLIDE_PATTERN.fullmatch(marker)
    if slide_match:
        return {"action": "goto", "page": int(slide_match.group(1))}
    return None


def parse_actions(text: str) -> tuple[list[dict], str]:
    """从完整模型输出中提取动作并剥离标记，返回 (actions, clean_text)。

    用于非流式（或流结束后兜底）解析；流式场景请用 ControlMarkerStripper。
    """
    actions: list[dict] = []

    def handle_action(match: re.Match) -> str:
        marker = match.group(0)
        action = _parse_single_marker(marker)
        if action is not None:
            actions.append(action)
        return ""

    cleaned = _ACTION_PATTERN.sub(handle_action, text)
    cleaned = _SLIDE_PATTERN.sub(handle_action, cleaned)
    cleaned = _ANY_BRACKET_PATTERN.sub("", cleaned)
    return actions, cleaned.strip()


class ControlMarkerStripper:
    """流式回答的在线标记剥离器。

    feed(delta) 返回可安全下发的正文增量；完整动作标记一旦闭合，
    立即通过 emit_action 回调发出 control，保证前端"先执行动作、后播放回答"。
    未闭合的 [[ 会被缓冲等待，正文中的残留 [[...]] 在 flush 时兜底剥离。
    """

    def __init__(self, emit_action) -> None:
        self._buffer = ""
        self._emit_action = emit_action

    def feed(self, delta: str) -> str:
        if not delta:
            return ""
        out = ""
        self._buffer += delta
        while True:
            start = self._buffer.find("[[")
            if start < 0:
                # 无标记起点：末尾最多保留 2 个字符防止 [[ 被切分
                keep = min(2, len(self._buffer))
                if self._buffer[-keep:] in ("[", "[[") or (keep == 1 and self._buffer[-1] == "["):
                    out += self._buffer[:-keep]
                    self._buffer = self._buffer[-keep:]
                else:
                    out += self._buffer
                    self._buffer = ""
                break
            out += self._buffer[:start]
            rest = self._buffer[start:]
            end = rest.find("]]")
            if end < 0:
                # 标记未闭合：整段保留，等待后续 delta
                self._buffer = rest
                break
            marker = rest[: end + 2]
            self._buffer = rest[end + 2 :]
            action = _parse_single_marker(marker)
            if action is not None:
                self._emit_action(action)
        return out

    def flush(self) -> str:
        tail = self._buffer
        self._buffer = ""
        return _ANY_BRACKET_PATTERN.sub("", tail)


def slide_window_messages(
    messages: list[dict],
    max_items: int = WINDOW_MAX_ITEMS,
    max_chars: int = WINDOW_MAX_CHARS,
) -> list[dict]:
    """对持久化对话历史做滑动窗口截断（保持配对顺序，超窗丢弃，不压缩）。

    messages 按 seq 升序；返回最近若干条，且总字符不超过 max_chars。
    """
    if not messages:
        return []
    window: list[dict] = []
    total = 0
    for item in reversed(messages):
        content = str(item.get("content") or "")
        size = len(content)
        if window and total + size > max_chars:
            break
        if len(window) >= max_items:
            break
        window.append(item)
        total += size
    return list(reversed(window))
