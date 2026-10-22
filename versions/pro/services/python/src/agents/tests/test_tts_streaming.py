import asyncio
import base64
from types import SimpleNamespace

import pytest

from app.services.tts import TtsService


class FakeCompletions:
    def __init__(self):
        self.kwargs = {}

    async def create(self, **kwargs):
        self.kwargs = kwargs
        assert kwargs["audio"]["format"] == "pcm16"
        assert kwargs["audio"]["voice"] in {"苏打", "茉莉"}

        async def chunks():
            for data in (b"\x01\x00", b"\x02\x00"):
                audio = {"data": base64.b64encode(data).decode("ascii")}
                yield SimpleNamespace(choices=[SimpleNamespace(
                    delta=SimpleNamespace(audio=audio),
                )])

        return chunks()


class FakeClient:
    def __init__(self):
        self.chat = SimpleNamespace(completions=FakeCompletions())


def test_tts_stream_pcm_yields_upstream_chunks_without_buffering():
    service = TtsService(None, None)
    service._client = FakeClient()

    async def collect():
        return [chunk async for chunk in service.stream_pcm("测试")]

    assert asyncio.run(collect()) == [b"\x01\x00", b"\x02\x00"]


def test_tts_synthesize_still_collects_stream_for_wav_generation():
    service = TtsService(None, None)
    service._client = FakeClient()

    assert asyncio.run(service.synthesize("测试")) == b"\x01\x00\x02\x00"


def test_tts_stream_pcm_accepts_supported_voice():
    service = TtsService(None, None)
    service._client = FakeClient()

    async def collect():
        return [chunk async for chunk in service.stream_pcm("测试", "茉莉")]

    assert asyncio.run(collect()) == [b"\x01\x00", b"\x02\x00"]


def test_tts_stream_pcm_rejects_unknown_voice():
    service = TtsService(None, None)
    service._client = FakeClient()

    async def collect():
        return [chunk async for chunk in service.stream_pcm("测试", "unknown")]

    with pytest.raises(ValueError, match="Unsupported MiMo voice"):
        asyncio.run(collect())


def test_tts_slow_mode_requests_clear_punctuation_pauses():
    client = FakeClient()
    service = TtsService(None, None)
    service._client = client

    async def collect():
        return [chunk async for chunk in service.stream_pcm("第一句，第二句。", "苏打", "very_slow")]

    assert asyncio.run(collect()) == [b"\x01\x00", b"\x02\x00"]
    instruction = client.chat.completions.kwargs["messages"][0]["content"]
    assert "自然的正常语速与停顿" in instruction
    assert "保持该音色原本的声线、音高" in instruction
    assert "不要额外提高音调" in instruction
    assert "不要根据外部播放倍率改变音色、音高" in instruction
