"""MiMo-V2.5-TTS speech synthesis via OpenAI-compatible API."""
from __future__ import annotations

import asyncio
import base64
import logging
import struct
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
from openai import AsyncOpenAI

from app.services.speech_utils import spread_llm_for_speech

logger = logging.getLogger(__name__)

_MIMO_TTS_MODEL = "mimo-v2.5-tts"
_MIMO_DEFAULT_VOICE = "苏打"
MIMO_PRESET_VOICES = ("冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean")
TTS_SPEEDS = ("very_slow", "slow", "normal", "fast", "very_fast")
_SAMPLE_RATE = 24_000
_PCM_HEADER_BYTES = 44


def _wav_header(sample_rate: int = _SAMPLE_RATE, num_channels: int = 1, bits_per_sample: int = 16) -> bytes:
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 0, b"WAVE",
        b"fmt ", 16, 1, num_channels, sample_rate, byte_rate, block_align, bits_per_sample,
        b"data", 0,
    )


def pcm_to_wav(pcm_data: bytes, sample_rate: int = _SAMPLE_RATE) -> bytes:
    header = _wav_header(sample_rate)
    data_size = len(pcm_data)
    riff_size = data_size + 36
    header = bytearray(header)
    struct.pack_into("<I", header, 4, riff_size)
    struct.pack_into("<I", header, 40, data_size)
    return bytes(header) + pcm_data


class TtsService:
    """Synthesize speech from text using MiMo TTS."""

    def __init__(self, api_key: str | None, api_base: str | None, voice: str = _MIMO_DEFAULT_VOICE):
        if not api_key:
            logger.warning("MIMO_API_KEY not set, TTS will be unavailable")
            self._client: AsyncOpenAI | None = None
            self._http_client: httpx.AsyncClient | None = None
        else:
            base = api_base or "https://api.xiaomimimo.com/v1"
            self._http_client = httpx.AsyncClient(trust_env=False, timeout=120, limits=httpx.Limits(keepalive_expiry=300))
            self._client = AsyncOpenAI(
                api_key=api_key,
                base_url=base,
                timeout=120,
                http_client=self._http_client,
            )
        self._voice = voice

    @property
    def available(self) -> bool:
        return self._client is not None

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()

    async def synthesize(self, text: str, voice: str | None = None, speed: str = "normal") -> bytes:
        """Synthesize *text* and return PCM16 bytes (mono, 24 kHz)."""
        collected = bytearray()
        async for chunk in self.stream_pcm(text, voice, speed):
            collected.extend(chunk)
        return bytes(collected)

    async def stream_pcm(
        self, text: str, voice: str | None = None, speed: str = "normal",
    ) -> AsyncIterator[bytes]:
        """Yield PCM16LE chunks as MiMo produces them."""
        if not self._client:
            raise RuntimeError("TTS client is not configured")
        text = spread_llm_for_speech(text)
        if not text or not text.strip():
            return
        selected_voice = voice or self._voice
        if selected_voice not in MIMO_PRESET_VOICES:
            raise ValueError(f"Unsupported MiMo voice: {selected_voice}")
        try:
            stream = await self._client.chat.completions.create(
                model=_MIMO_TTS_MODEL,
                messages=[
                    {
                        "role": "user",
                        "content": (
                            "请忠实使用所选预设音色朗读，保持该音色原本的声线、音高、"
                            "音色质感和情绪稳定，不要额外提高音调，不要刻意幼儿化、"
                            "少年化或夸张表演。使用自然的正常语速与停顿，吐字清晰。"
                            "外部播放器会单独处理速度与句间停顿，因此不要根据外部播放"
                            "倍率改变音色、音高、韵律或情绪。"
                        ),
                    },
                    {"role": "assistant", "content": text},
                ],
                audio={"format": "pcm16", "voice": selected_voice},
                stream=True,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                audio = getattr(delta, "audio", None)
                if audio is None:
                    continue
                if isinstance(audio, dict) and "data" in audio:
                    decoded = base64.b64decode(audio["data"])
                    if decoded:
                        yield decoded
                elif hasattr(audio, "data") and audio.data:
                    decoded = base64.b64decode(audio.data)
                    if decoded:
                        yield decoded
        except Exception as exc:
            logger.error("TTS synthesis failed: %s", exc, exc_info=True)
            raise

    async def synthesize_to_file(
        self, text: str, dest: Path, voice: str | None = None, speed: str = "normal",
    ) -> Path:
        """Synthesize *text*, wrap as WAV, write to *dest* and return the path."""
        pcm = await self.synthesize(text, voice, speed)
        if not pcm:
            raise RuntimeError("TTS returned empty audio")
        wav = pcm_to_wav(pcm)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(wav)
        return dest

    async def synthesize_slides(
        self, speaker_notes: list[str], dest_dir: Path, voice: str | None = None,
        speed: str = "normal",
    ) -> list[Path]:
        """Synthesize each slide's speaker notes and save as numbered WAV files."""
        dest_dir.mkdir(parents=True, exist_ok=True)
        semaphore = asyncio.Semaphore(3)
        results: list[Path] = []

        async def synthesize_one(idx: int, note: str) -> None:
            text = (note or "").strip()
            if not text:
                logger.info("Slide %d has no speaker notes, skipping TTS", idx)
                return
            wav_path = dest_dir / f"slide_{idx:03d}.wav"
            async with semaphore:
                try:
                    await self.synthesize_to_file(text, wav_path, voice, speed)
                    results.append(wav_path)
                    logger.info("TTS slide %d → %s (%d bytes)", idx, wav_path, wav_path.stat().st_size)
                except Exception as exc:
                    logger.warning("TTS failed for slide %d: %s", idx, exc)

        await asyncio.gather(
            *(synthesize_one(idx, note) for idx, note in enumerate(speaker_notes)),
        )
        results.sort()
        return results


def get_tts_service(settings) -> TtsService:
    return TtsService(
        # 语音暂不接入：只认独立的 TTS key，不回落到文本模型 key
        api_key=getattr(settings, "mimo_tts_api_key", None),
        api_base=getattr(settings, "mimo_tts_api_base", None),
    )
