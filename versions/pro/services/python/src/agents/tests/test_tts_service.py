import asyncio
from types import SimpleNamespace

from app.services.tts import get_tts_service, pcm_to_wav


def test_pcm_to_wav_sets_sizes_and_format():
    pcm = b"\x01\x02" * 100
    wav = pcm_to_wav(pcm)

    assert wav[:4] == b"RIFF"
    assert wav[8:12] == b"WAVE"
    assert int.from_bytes(wav[4:8], "little") == len(wav) - 8
    assert int.from_bytes(wav[24:28], "little") == 24_000
    assert int.from_bytes(wav[40:44], "little") == len(pcm)
    assert wav[44:] == pcm


def test_tts_service_reuses_existing_mimo_base_when_override_is_empty():
    settings = SimpleNamespace(
        mimo_api_key="test-key",
        mimo_api_base="https://token-plan.example/v1",
        mimo_tts_api_base=None,
    )
    service = get_tts_service(settings)
    try:
        assert str(service._client.base_url) == "https://token-plan.example/v1/"
    finally:
        asyncio.run(service.close())


def test_tts_service_prefers_dedicated_base():
    settings = SimpleNamespace(
        mimo_api_key="test-key",
        mimo_api_base="https://token-plan.example/v1",
        mimo_tts_api_base="https://tts.example/v1",
    )
    service = get_tts_service(settings)
    try:
        assert str(service._client.base_url) == "https://tts.example/v1/"
    finally:
        asyncio.run(service.close())
