"""Qwen Audio TTS for on-demand PPT narration."""
from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import urlparse

import httpx

from app.services.speech_utils import spread_llm_for_speech

logger = logging.getLogger(__name__)

QWEN_TTS_VOICES = ("longanlingxi", "longanxiaoxin")


class QwenTtsService:
    def __init__(self, api_key: str | None, api_base: str, model: str):
        self.api_key = api_key
        self.model = model
        parsed = urlparse(api_base)
        self.endpoint = f"{parsed.scheme}://{parsed.netloc}/api/v1/services/audio/tts/SpeechSynthesizer"
        self.client = httpx.AsyncClient(trust_env=False, timeout=120)

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    async def close(self) -> None:
        await self.client.aclose()

    async def synthesize(self, text: str, voice: str) -> bytes:
        if not self.api_key:
            raise RuntimeError("Qwen TTS is not configured")
        if voice not in QWEN_TTS_VOICES:
            raise ValueError(f"Unsupported Qwen TTS voice: {voice}")
        text = spread_llm_for_speech(text)
        response = await self.client.post(
            self.endpoint,
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            json={
                "model": self.model,
                "input": {
                    "text": text.strip(),
                    "voice": voice,
                    "format": "wav",
                    "sample_rate": 24000,
                    "instruction": "以自然、清晰、沉稳的知识讲解方式演讲，段落衔接流畅，不要夸张表演。",
                },
            },
        )
        response.raise_for_status()
        payload = response.json()
        output = payload.get("output") or {}
        audio_output = output.get("audio") or {}
        audio_url = str(
            (audio_output.get("url") if isinstance(audio_output, dict) else audio_output)
            or output.get("url")
            or ""
        )
        if not audio_url:
            raise RuntimeError(f"Qwen TTS returned no audio URL (request_id={payload.get('request_id', '')})")
        audio = await self.client.get(audio_url)
        audio.raise_for_status()
        return audio.content

    async def synthesize_to_file(self, text: str, dest: Path, voice: str) -> Path:
        audio = await self.synthesize(text, voice)
        if not audio:
            raise RuntimeError("Qwen TTS returned empty audio")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(audio)
        return dest


def get_qwen_tts_service(settings) -> QwenTtsService:
    return QwenTtsService(
        getattr(settings, "qwen_tts_api_key", None),
        getattr(settings, "qwen_tts_api_base", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        getattr(settings, "qwen_tts_model", "qwen-audio-3.0-tts-flash"),
    )
