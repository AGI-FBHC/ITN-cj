"""Direct MiMo token-plan audio/vision understanding for the global assistant."""
from __future__ import annotations

import base64
import json
import re
from collections.abc import AsyncIterator
from typing import Any

import httpx


class AssistantAudioService:
    def __init__(
        self, api_key: str | None, api_base: str | None, model: str = "mimo-v2.6-pro",
        vision_api_key: str | None = None, vision_api_base: str | None = None,
        vision_model: str | None = None,
    ):
        self._api_key = api_key
        self._api_base = (api_base or "https://api.xiaomimimo.com/v1").rstrip("/")
        self._client = httpx.AsyncClient(trust_env=False, timeout=60, limits=httpx.Limits(keepalive_expiry=300))
        self._model = model
        self._vision_api_key = vision_api_key or api_key
        self._vision_api_base = (vision_api_base or api_base or "https://api.xiaomimimo.com/v1").rstrip("/")
        self._vision_model = vision_model or model

    @property
    def available(self) -> bool:
        # DeepSeek 现已提供视觉模型（deepseek-flash），不再按 base 一刀切排除
        return bool(self._api_key)

    @property
    def audio_available(self) -> bool:
        """语音能力仍需 MiMo：DeepSeek 通道不支持音频输入。"""
        return bool(self._api_key) and "deepseek" not in self._api_base.lower()

    async def understand(
        self,
        audio: bytes,
        mime_type: str,
        context: dict[str, Any],
        action_guide: dict[str, Any],
    ) -> dict[str, Any]:
        payload = self._build_payload(audio, mime_type, context, action_guide)
        response = await self._client.post(
            f"{self._api_base}/chat/completions",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        choices = data.get("choices") or []
        message = choices[0].get("message", {}) if choices else {}
        raw = str(message.get("content") or message.get("reasoning_content") or "").strip()
        fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", raw, flags=re.DOTALL | re.IGNORECASE)
        if fenced:
            raw = fenced.group(1)
        start, end = raw.find("{"), raw.rfind("}")
        if start >= 0 and end > start:
            raw = raw[start:end + 1]
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise RuntimeError("MiMo audio response is not a JSON object")
        return parsed

    async def stream_understand(
        self,
        audio: bytes,
        mime_type: str,
        context: dict[str, Any],
        action_guide: dict[str, Any],
    ) -> AsyncIterator[str]:
        """Yield the model's JSON text as it is generated."""
        payload = self._build_payload(audio, mime_type, context, action_guide)
        payload["stream"] = True
        async with self._client.stream(
            "POST",
            f"{self._api_base}/chat/completions",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        ) as response:
            response.raise_for_status()
            accumulated = ""
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                event = json.loads(data)
                choices = event.get("choices") or []
                delta = choices[0].get("delta", {}) if choices else {}
                incoming = str(delta.get("content") or delta.get("reasoning_content") or "")
                if not incoming:
                    continue
                if accumulated and incoming.startswith(accumulated):
                    emitted = incoming[len(accumulated):]
                    accumulated = incoming
                else:
                    emitted = incoming
                    accumulated += incoming
                if emitted:
                    yield emitted

    async def stream_presentation_understand(
        self,
        audio: bytes,
        mime_type: str,
        presentation_context: str,
    ) -> AsyncIterator[str]:
        """Stream one grounded slideshow reply and its voice command metadata."""
        instruction = (
            f"{presentation_context}\n"
            "直接听懂用户语音并回答。若用户要求控制演示，action 只能是 "
            "none、play、pause、next、previous、restart、goto；goto 时 page 使用1起始页码。"
            "普通提问 action 使用 none。需要根据问题主动跳转到相关页时，也可使用 goto。"
            "另用 resume 表示执行动作后是否应立即继续播放讲解。"
            "\n核心原则：理解用户意图，不要死板匹配关键词。"
            "用户在演示播放中说的任何催促、要求继续、不满停顿的话，"
            "都应理解为希望继续播放，action=play、resume=true。"
            "例如但不限于：讲啊、继续、怎么停了、别停、接着来、说下去、你怎么不动了、快讲、go on等等。"
            "只有用户明确要求跳转、暂停、翻页时才对应相应action。"
            "用户提问时action=none，正常回答即可。"
            "默认回答2到4句、尽量不超过120个汉字；只写适合朗读的纯文本，"
            "不要使用Markdown、星号、标题或列表符号。"
            "transcript只能填写从当前音频中实际听到的用户语音；如果没有听清人声，transcript和reply都返回空字符串。"
            "绝对不要把系统提示、PPT上下文、本段指令或对话历史中的文字复制进transcript。"
            "对话历史仅供理解上下文，绝不能作为transcript的来源。"
            "\n只返回紧凑JSON，严格按照以下字段顺序：先生成transcript和控制字段，"
            "让页面可以先执行动作，再生成reply："
            '{"transcript":"用户语音原文","action":"none","page":null,"resume":false,'
            '"reply":"适合直接朗读的简短中文回答"}'
        )
        payload = self._build_audio_payload(
            audio,
            mime_type,
            (
                "你是ITN在线演示助手。回答必须依据提供的PPT上下文，"
                "自然、直接、适合口头交流，不要声称看不到幻灯片。"
            ),
            instruction,
        )
        payload["stream"] = True
        async for emitted in self._stream_payload(payload):
            yield emitted

    async def stream_presentation_reply(
        self,
        audio: bytes,
        mime_type: str,
        presentation_context: str,
    ) -> AsyncIterator[str]:
        """Answer presentation audio directly, without serializing transcript/control JSON first."""
        payload = self._build_audio_payload(
            audio,
            mime_type,
            (
                "你是ITN在线演示助手。回答必须依据提供的PPT上下文，"
                "自然、直接、适合口头交流，不要声称看不到幻灯片。"
            ),
            (
                f"{presentation_context}\n"
                "直接回答当前音频中的问题。默认回答2到4句、尽量不超过120个汉字；"
                "只输出适合朗读的回答正文，不要复述问题，不要输出转写、JSON、Markdown、"
                "标题、列表或思考过程。"
                "如需切换页面或控制播放，必须按动作协议在回答最开头输出[[ACTION:...]]标记，"
                "回答正文中不得包含任何[[...]]标记。"
            ),
        )
        payload.pop("response_format", None)
        payload["max_completion_tokens"] = 300
        payload["stream"] = True
        payload["thinking"] = {"type": "disabled"}
        async with self._client.stream(
            "POST",
            f"{self._api_base}/chat/completions",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        ) as response:
            response.raise_for_status()
            accumulated = ""
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                event = json.loads(data)
                choices = event.get("choices") or []
                delta = choices[0].get("delta", {}) if choices else {}
                # reasoning_content is deliberately ignored: only user-facing text is streamed.
                incoming = str(delta.get("content") or "")
                if not incoming:
                    continue
                if accumulated and incoming.startswith(accumulated):
                    emitted = incoming[len(accumulated):]
                    accumulated = incoming
                else:
                    emitted = incoming
                    accumulated += incoming
                if emitted:
                    yield emitted

    async def _stream_payload(
        self, payload: dict[str, Any], *, api_base: str | None = None, api_key: str | None = None,
    ) -> AsyncIterator[str]:
        """Yield normalized text deltas from a MiMo streaming response."""
        endpoint_base = (api_base or self._api_base).rstrip("/")
        bearer_key = api_key or self._api_key
        async with self._client.stream(
            "POST",
            f"{endpoint_base}/chat/completions",
            headers={
                "Authorization": f"Bearer {bearer_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        ) as response:
            response.raise_for_status()
            accumulated = ""
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                event = json.loads(data)
                choices = event.get("choices") or []
                delta = choices[0].get("delta", {}) if choices else {}
                incoming = str(delta.get("content") or delta.get("reasoning_content") or "")
                if not incoming:
                    continue
                if accumulated and incoming.startswith(accumulated):
                    emitted = incoming[len(accumulated):]
                    accumulated = incoming
                else:
                    emitted = incoming
                    accumulated += incoming
                if emitted:
                    yield emitted

    def _build_payload(
        self,
        audio: bytes,
        mime_type: str,
        context: dict[str, Any],
        action_guide: dict[str, Any],
    ) -> dict[str, Any]:
        instruction = (
            "听懂这段用户语音，并判断它是普通对话还是网页操作命令。"
            "普通对话直接自然简短回答，action使用none，绝对不要说功能不支持；"
            "明确的操作命令只能选择白名单动作。"
            f"\n当前页面上下文：{json.dumps(context, ensure_ascii=False)[:1500]}"
            f"\n动作白名单：{json.dumps(action_guide, ensure_ascii=False)}"
            "\n只返回紧凑JSON，严格按照以下字段顺序，并优先生成reply："
            '{"reply":"直接给用户的简短中文回复","transcript":"语音原文",'
            '"action":"动作名","arguments":{},"requiresConfirmation":false}'
        )
        return self._build_audio_payload(
            audio,
            mime_type,
            (
                "你是亲切、反应迅速的伴学助手，同时负责安全的网页动作路由。"
                "不要编造动作，不要输出代码。"
            ),
            instruction,
        )

    def _build_audio_payload(
        self, audio: bytes, mime_type: str, system_prompt: str, instruction: str,
    ) -> dict[str, Any]:
        if not self._api_key:
            raise RuntimeError("MiMo audio understanding is not configured")
        if mime_type.lower() not in {
            "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3",
            "audio/flac", "audio/mp4", "audio/ogg",
        }:
            raise ValueError("Audio must be WAV, MP3, FLAC, M4A or OGG")
        encoded = base64.b64encode(audio).decode("ascii")
        return {
            "model": self._model,
            "messages": [
                {
                    "role": "system",
                    "content": system_prompt,
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_audio",
                            "input_audio": {"data": f"data:{mime_type};base64,{encoded}"},
                        },
                        {"type": "text", "text": instruction},
                    ],
                },
            ],
            "response_format": {"type": "json_object"},
            "max_completion_tokens": 700,
        }


    def _build_image_payload(
        self, image: bytes, mime_type: str, presentation_context: str, question: str,
    ) -> dict[str, Any]:
        if not self._vision_api_key:
            raise RuntimeError("MiMo image understanding is not configured")
        if mime_type.lower() not in {
            "image/png", "image/jpeg", "image/webp", "image/gif",
        }:
            raise ValueError("Image must be PNG, JPEG, WEBP or GIF")
        encoded = base64.b64encode(image).decode("ascii")
        instruction = (
            f"{presentation_context}\n"
            f"用户问题：{question or '请结合这张图片和当前页内容说明。'}\n"
            "直接回答，默认2到4句、尽量不超过120个汉字；只输出适合朗读的回答正文，"
            "不要复述问题，不要输出转写、JSON、Markdown、标题、列表或思考过程。"
            "如需切换页面或控制播放，必须按动作协议在回答最开头输出[[ACTION:...]]标记，"
            "回答正文中不得包含任何[[...]]标记。"
        )
        return {
            "model": self._vision_model,
            "messages": [
                {"role": "system", "content": (
                    "你是ITN在线演示助手。回答必须依据提供的PPT上下文和用户图片，"
                    "自然、直接、适合口头交流，不要声称看不到图片或幻灯片。"
                )},
                {"role": "user", "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,{encoded}", "detail": "low"},
                    },
                    {"type": "text", "text": instruction},
                ]},
            ],
            "stream": True,
            "max_completion_tokens": 300,
            "thinking": {"type": "disabled"},
        }

    async def describe_image(self, image: bytes, mime_type: str, topic_hint: str = "") -> str:
        """Describe a photo once (mimo-v2.6-pro image_url), returning short plain text.

        图片只在发送提问这一次以真实图片进模型；描述文本随后注入主问答上下文，
        历史与后续轮次只保留 [图片] 占位，不反复传输图片数据。
        与课件相关的图片描述细致一些，无关内容简短带过，控制字数以保障主对话响应时长。
        """
        if not self._vision_api_key:
            raise RuntimeError("MiMo image understanding is not configured")
        if mime_type.lower() not in {
            "image/png", "image/jpeg", "image/webp", "image/gif",
        }:
            raise ValueError("Image must be PNG, JPEG, WEBP or GIF")
        encoded = base64.b64encode(image).decode("ascii")
        instruction = (
            "请判断这张图片是否与下面的课件内容相关，再决定描述的详细程度。"
            f"\n课件内容：{topic_hint or '（未提供，视为通用课堂场景）'}\n"
            "如果图片与课件相关（课件截图、板书、题目、公式、设备界面、报错等）："
            "细致描述，必须包含①主题/场景②主体与关键对象③整体结构与布局④图中所有文本（逐条摘录）⑤关键细节。"
            "如果图片与课件无关（日常照片、表情包、无关截图等）：用一两句话简短说明图片内容即可，不要展开。"
            "总字数控制在160个汉字以内，只输出描述正文，不要评价、不要推测、不要输出Markdown标题或列表符号。"
        )
        payload = {
            "model": self._vision_model,
            "messages": [
                {"role": "system", "content": "你是ITN演示助手的图像识别模块，负责把图片准确转写为文字描述。"},
                {"role": "user", "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,{encoded}", "detail": "low"},
                    },
                    {"type": "text", "text": instruction},
                ]},
            ],
            "stream": False,
            "max_completion_tokens": 300,
            "thinking": {"type": "disabled"},
        }
        response = await self._client.post(
            f"{self._vision_api_base}/chat/completions",
            headers={
                "Authorization": f"Bearer {self._vision_api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        try:
            return str(data["choices"][0]["message"]["content"] or "").strip()[:2000]
        except (KeyError, IndexError, TypeError):
            return ""

    async def stream_image_reply(

        self, image: bytes, mime_type: str, presentation_context: str, question: str,
    ) -> AsyncIterator[str]:
        """Answer a presentation image question via mimo-v2.6-pro multimodal (image+text -> text)."""
        payload = self._build_image_payload(image, mime_type, presentation_context, question)
        async for emitted in self._stream_payload(
            payload, api_base=self._vision_api_base, api_key=self._vision_api_key,
        ):
            yield emitted


def get_assistant_audio_service(settings) -> AssistantAudioService:
    return AssistantAudioService(
        api_key=getattr(settings, "mimo_api_key", None),
        api_base=(
            getattr(settings, "mimo_api_base", None)
            or getattr(settings, "mimo_multimodal_api_base", None)
            or "https://api.xiaomimimo.com/v1"
        ),
        vision_api_key=getattr(settings, "mimo_api_key", None),
        vision_api_base=(
            getattr(settings, "mimo_vision_api_base", None)
            or getattr(settings, "mimo_multimodal_api_base", None)
            or getattr(settings, "mimo_api_base", None)
            or getattr(settings, "mimo_text_api_base", None)
            or "https://api.xiaomimimo.com/v1"
        ),
        vision_model=(
            getattr(settings, "mimo_vision_model", None)
            or getattr(settings, "mimo_model", None)
            or getattr(settings, "mimo_text_model", None)
        ),
    )
