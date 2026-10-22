import asyncio
from types import SimpleNamespace

import httpx

from app.services.asr import AsrService, get_asr_service


def test_asr_service_builds_mimo_request(monkeypatch):
    captured = {}

    async def post(_self, url, **kwargs):
        captured.update(url=url, **kwargs)
        return httpx.Response(
            200,
            request=httpx.Request("POST", url),
            json={"choices": [{"message": {"content": "打开知识库"}}]},
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    service = AsrService("key", "https://api.example/v1")

    result = asyncio.run(service.transcribe(b"RIFFdata", "audio/wav", "zh"))

    assert result == "打开知识库"
    assert captured["json"]["model"] == "mimo-v2.5-asr"
    assert captured["json"]["asr_options"] == {"language": "zh"}
    assert captured["json"]["messages"][0]["content"][0]["input_audio"]["format"] == "wav"


def test_asr_service_rejects_unsupported_audio():
    service = AsrService("key", "https://api.example/v1")

    try:
        asyncio.run(service.transcribe(b"audio", "audio/webm"))
    except ValueError as exc:
        assert "WAV or MP3" in str(exc)
    else:
        raise AssertionError("unsupported audio was accepted")


def test_asr_service_prefers_dedicated_base():
    settings = SimpleNamespace(
        mimo_api_key="key",
        mimo_api_base="https://text.example/v1",
        mimo_tts_api_base="https://tts.example/v1",
        mimo_asr_api_base="https://asr.example/v1",
    )

    assert get_asr_service(settings)._api_base == "https://asr.example/v1"
