import asyncio
import base64

import httpx

from app.services.assistant_audio import AssistantAudioService, get_assistant_audio_service


def test_audio_understanding_builds_single_mimo_request():
    captured = {}

    def handler(request: httpx.Request):
        captured.update(__import__("json").loads(request.content))
        return httpx.Response(200, json={
            "choices": [{"message": {"content": (
                '{"transcript":"你好","action":"none","arguments":{},'
                '"reply":"你好呀","requiresConfirmation":false}'
            )}}],
        })

    service = AssistantAudioService("test-key", "https://example.test/v1")
    asyncio.run(service._client.aclose())
    service._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = asyncio.run(service.understand(
            b"RIFFaudio", "audio/wav", {"page": "dashboard"}, {"none": {}},
        ))
    finally:
        asyncio.run(service._client.aclose())

    assert captured["model"] == "mimo-v2.5"
    content = captured["messages"][1]["content"]
    assert len(content) == 2
    assert content[0]["type"] == "input_audio"
    encoded = content[0]["input_audio"]["data"].split(",", 1)[1]
    assert base64.b64decode(encoded) == b"RIFFaudio"
    assert result["reply"] == "你好呀"


def test_audio_understanding_accepts_json_in_reasoning_content():
    def handler(_: httpx.Request):
        return httpx.Response(200, json={
            "choices": [{"message": {
                "content": "",
                "reasoning_content": '{"transcript":"打开知识库","action":"navigation.open"}',
            }}],
        })

    service = AssistantAudioService("test-key", "https://example.test/v1")
    asyncio.run(service._client.aclose())
    service._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = asyncio.run(service.understand(b"RIFFaudio", "audio/wav", {}, {}))
    finally:
        asyncio.run(service._client.aclose())

    assert result["transcript"] == "打开知识库"


def test_audio_understanding_prefers_token_plan_base_from_settings():
    settings = type("Settings", (), {
        "mimo_api_key": "key",
        "mimo_multimodal_api_base": None,
        "mimo_api_base": "https://token-plan.example/v1",
    })()
    service = get_assistant_audio_service(settings)
    try:
        assert service._api_base == "https://token-plan.example/v1"
    finally:
        asyncio.run(service._client.aclose())


def test_audio_understanding_streams_json_deltas():
    import json
    chunks = [
        '{"reply":"你好',
        '呀。","transcript":"你好","action":"none","arguments":{},"requiresConfirmation":false}',
    ]
    body = "".join(
        f"data: {json.dumps({'choices': [{'delta': {'content': chunk}}]}, ensure_ascii=False)}\n\n"
        for chunk in chunks
    ) + "data: [DONE]\n\n"

    def handler(_: httpx.Request):
        return httpx.Response(200, content=body.encode())

    service = AssistantAudioService("test-key", "https://example.test/v1")
    asyncio.run(service._client.aclose())
    service._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    async def collect():
        return [part async for part in service.stream_understand(
            b"RIFFaudio", "audio/wav", {}, {"none": {}},
        )]

    try:
        parts = asyncio.run(collect())
    finally:
        asyncio.run(service._client.aclose())

    assert "".join(parts).startswith('{"reply":"你好呀。')


def test_presentation_audio_stream_uses_direct_mimo_with_slide_context():
    import json
    captured = {}
    body = (
        f"data: {json.dumps({'choices': [{'delta': {'content': '{\"transcript\":\"这一页讲什么？\",\"reply\":\"这一页讲矩阵秩。\"}'}}]}, ensure_ascii=False)}\n\n"
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request):
        captured.update(json.loads(request.content))
        return httpx.Response(200, content=body.encode())

    service = AssistantAudioService("test-key", "https://example.test/v1")
    asyncio.run(service._client.aclose())
    service._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    async def collect():
        return [part async for part in service.stream_presentation_understand(
            b"RIFFaudio", "audio/wav", "当前页：矩阵的秩；第8页",
        )]

    try:
        parts = asyncio.run(collect())
    finally:
        asyncio.run(service._client.aclose())

    assert captured["model"] == "mimo-v2.5"
    instruction = captured["messages"][1]["content"][1]["text"]
    assert "当前页：矩阵的秩；第8页" in instruction
    assert '"action":"none"' in instruction
    assert '"resume":false' in instruction
    assert "理解用户意图" in instruction
    assert "不要使用Markdown" in instruction
    assert "不超过120个汉字" in instruction
    assert "先生成transcript和控制字段" in instruction
    assert instruction.index('"action"') < instruction.index('"reply"')
    assert "".join(parts).startswith('{"transcript":"这一页讲什么？"')
