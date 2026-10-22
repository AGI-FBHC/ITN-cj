"""Qwen Audio Realtime WebSocket bridge for PPT voice conversations."""
from __future__ import annotations

import audioop
import base64
import io
import json
import wave
from collections.abc import AsyncIterator
from urllib.parse import urlencode, urlparse, urlunparse

import websockets


def wav_to_pcm16k(audio: bytes) -> bytes:
    with wave.open(io.BytesIO(audio), "rb") as wav:
        channels = wav.getnchannels()
        width = wav.getsampwidth()
        rate = wav.getframerate()
        pcm = wav.readframes(wav.getnframes())
    if width != 2:
        pcm = audioop.lin2lin(pcm, width, 2)
    if channels > 1:
        pcm = audioop.tomono(pcm, 2, 0.5, 0.5)
    if rate != 16000:
        pcm, _ = audioop.ratecv(pcm, 2, 1, rate, 16000, None)
    return pcm


class QwenRealtimeAudioService:
    def __init__(self, api_key: str | None, api_base: str, model: str):
        self.api_key = api_key
        self.model = model
        parsed = urlparse(api_base)
        self.ws_url = urlunparse(("wss", parsed.netloc, "/api-ws/v1/realtime", "", urlencode({"model": model}), ""))

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    async def stream(self, wav_audio: bytes, instructions: str, voice: str = "longanlufeng") -> AsyncIterator[dict]:
        if not self.api_key:
            raise RuntimeError("Qwen Audio Realtime is not configured")
        pcm = wav_to_pcm16k(wav_audio)
        headers = {"Authorization": f"Bearer {self.api_key}", "OpenAI-Beta": "realtime=v1"}
        async with websockets.connect(self.ws_url, additional_headers=headers, open_timeout=20) as ws:
            await ws.send(json.dumps({
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                    "input_audio_format": "pcm",
                    "output_audio_format": "pcm",
                    "instructions": instructions,
                    "voice": voice,
                    "turn_detection": None,
                    "input_audio_transcription": {"model": "qwen-audio-3.0-realtime-plus"},
                },
            }, ensure_ascii=False))
            for offset in range(0, len(pcm), 3200):
                await ws.send(json.dumps({
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(pcm[offset:offset + 3200]).decode("ascii"),
                }))
            await ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
            await ws.send(json.dumps({"type": "response.create"}))
            async for raw in ws:
                event = json.loads(raw)
                event_type = event.get("type")
                if event_type == "response.audio_transcript.delta":
                    yield {"type": "text", "delta": str(event.get("delta") or "")}
                elif event_type == "response.audio.delta":
                    yield {"type": "audio", "delta": str(event.get("delta") or "")}
                elif event_type == "conversation.item.input_audio_transcription.completed":
                    yield {"type": "transcript", "text": str(event.get("transcript") or "")}
                elif event_type == "error":
                    detail = event.get("error") or event
                    raise RuntimeError(str(detail))
                elif event_type == "response.done":
                    break


def get_qwen_realtime_audio_service(settings) -> QwenRealtimeAudioService:
    return QwenRealtimeAudioService(
        getattr(settings, "qwen_audio_api_key", None),
        getattr(settings, "qwen_audio_api_base", ""),
        getattr(settings, "qwen_audio_model", "qwen-audio-3.0-realtime-plus"),
    )
