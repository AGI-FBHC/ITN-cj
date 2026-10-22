"""MiMo-V2.5-ASR speech recognition service."""
from __future__ import annotations

import base64

import httpx


class AsrService:
    def __init__(self, api_key: str | None, api_base: str | None):
        self._api_key = api_key
        self._api_base = (api_base or "https://api.xiaomimimo.com/v1").rstrip("/")

    @property
    def available(self) -> bool:
        return bool(self._api_key)

    async def transcribe(self, audio: bytes, mime_type: str, language: str = "zh") -> str:
        if not self._api_key:
            raise RuntimeError("ASR client is not configured")
        formats = {"audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3"}
        audio_format = formats.get(mime_type.lower())
        if audio_format is None:
            raise ValueError("ASR only accepts WAV or MP3 audio")
        encoded = base64.b64encode(audio).decode("ascii")
        payload = {
            "model": "mimo-v2.5-asr",
            "messages": [{
                "role": "user",
                "content": [{
                    "type": "input_audio",
                    "input_audio": {
                        "data": f"data:{mime_type};base64,{encoded}",
                        "format": audio_format,
                    },
                }],
            }],
            "asr_options": {"language": language if language in {"zh", "en", "auto"} else "auto"},
        }
        async with httpx.AsyncClient(trust_env=False, timeout=120) as client:
            response = await client.post(
                f"{self._api_base}/chat/completions",
                headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
                json=payload,
            )
            response.raise_for_status()
        data = response.json()
        choices = data.get("choices") or []
        transcript = str(choices[0].get("message", {}).get("content") or "").strip() if choices else ""
        if not transcript:
            raise RuntimeError("ASR returned empty transcript")
        return transcript


def get_asr_service(settings) -> AsrService:
    return AsrService(
        # 语音暂不接入：只认独立的 ASR/TTS key，不回落到文本模型 key
        api_key=(
            getattr(settings, "mimo_asr_api_key", None)
            or getattr(settings, "mimo_tts_api_key", None)
        ),
        api_base=(
            getattr(settings, "mimo_asr_api_base", None)
            or getattr(settings, "mimo_tts_api_base", None)
        ),
    )
