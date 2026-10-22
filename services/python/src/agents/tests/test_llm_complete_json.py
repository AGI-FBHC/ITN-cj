import asyncio
from types import SimpleNamespace

from app.llm import LLMClient


def test_mimo_complete_json_uses_exactly_one_stream_request():
    llm = LLMClient.__new__(LLMClient)
    llm.settings = SimpleNamespace(
        llm_timeout_seconds=60,
        llm_reasoning_effort="none",
    )
    direct_calls = {"count": 0}
    stream_calls = {"count": 0}

    class Completions:
        async def create(self, **_kwargs):
            direct_calls["count"] += 1
            raise AssertionError("MiMo complete_json must not make a second direct request")

    client = SimpleNamespace(chat=SimpleNamespace(completions=Completions()))
    llm._client_for = lambda _provider="": client
    llm._re_kwargs = lambda _provider="": {}

    async def stream_chat(messages, **kwargs):
        stream_calls["count"] += 1
        assert messages[1]["content"] == "生成 JSON"
        assert kwargs["provider"] == "mimo"
        assert kwargs["thinking"] is False
        yield {"type": "content", "text": '{"ok":'}
        yield {"type": "content", "text": "true}"}

    llm.stream_chat = stream_chat
    result = asyncio.run(llm.complete_json(
        "系统", "生成 JSON", {"ok": False}, provider="mimo",
        max_retries=1, max_tokens=1000, thinking=False,
    ))

    assert result == {"ok": True}
    assert stream_calls["count"] == 1
    assert direct_calls["count"] == 0
