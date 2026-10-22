import json
import time

import jwt
from uuid import uuid4

from app.config import get_settings
from app.llm import _normalize_cumulative_delta, _parse_tags
from app.security import create_signature


def signed_headers(method: str, path: str, body: bytes, user_id=None, nonce=None, timestamp=None):
    user_id = str(user_id or uuid4())
    nonce = nonce or uuid4().hex
    timestamp = str(timestamp or int(time.time()))
    signature = create_signature(get_settings().agent_internal_secret, method, path,
                                 timestamp, nonce, user_id, body)
    return {
        "X-ITN-Timestamp": timestamp,
        "X-ITN-Nonce": nonce,
        "X-ITN-User-Id": user_id,
        "X-ITN-Signature": signature,
        "Content-Type": "application/json",
    }


def test_health_is_public(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


def test_internal_endpoint_rejects_unsigned_request(client):
    assert client.get("/internal/v1/agents").status_code == 401


def test_signature_replay_is_rejected(client):
    path = "/internal/v1/agents"
    headers = signed_headers("GET", path, b"", nonce=uuid4().hex)
    assert client.get(path, headers=headers).status_code == 200
    assert client.get(path, headers=headers).status_code == 401


def test_expired_signature_is_rejected(client):
    path = "/internal/v1/agents"
    headers = signed_headers("GET", path, b"", timestamp=int(time.time()) - 600)
    assert client.get(path, headers=headers).status_code == 401


def test_agent_run_and_owner_isolation(client):
    user_id = uuid4()
    payload = {"learning_goal_id": str(uuid4()), "content": "掌握 Spring Boot",
               "profile": {"learningPreference": "PRACTICAL"}, "input": {}}
    body = json.dumps(payload, separators=(",", ":")).encode()
    path = "/internal/v1/agent-runs"
    response = client.post(path, content=body, headers=signed_headers("POST", path, body, user_id=user_id))
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "COMPLETED"
    assert data["result"]["lecture"]

    run_path = f"/internal/v1/agent-runs/{data['run_id']}"
    owner_response = client.get(run_path, headers=signed_headers("GET", run_path, b"", user_id=user_id))
    assert owner_response.status_code == 200
    other_response = client.get(run_path, headers=signed_headers("GET", run_path, b"", user_id=uuid4()))
    assert other_response.status_code == 404


def test_validation_rejects_empty_content(client):
    payload = {"learning_goal_id": str(uuid4()), "content": ""}
    body = json.dumps(payload, separators=(",", ":")).encode()
    path = "/internal/v1/agent-runs"
    response = client.post(path, content=body, headers=signed_headers("POST", path, body))
    assert response.status_code == 422


def signed_chat_headers(path: str, body: bytes, user_id=None):
    return signed_headers("POST", path, body, user_id=user_id)


def test_chat_returns_mock_reply(client):
    payload = {"messages": [{"role": "user", "content": "\u4f60\u597d"}]}
    body = json.dumps(payload, separators=(",", ":")).encode()
    path = "/internal/v1/chat"
    response = client.post(path, content=body, headers=signed_chat_headers(path, body))
    assert response.status_code == 200
    assert response.json()["reply"].startswith("[mock]")


def test_chat_rejects_empty_messages(client):
    payload = {"messages": []}
    body = json.dumps(payload, separators=(",", ":")).encode()
    path = "/internal/v1/chat"
    response = client.post(path, content=body, headers=signed_chat_headers(path, body))
    assert response.status_code == 422


def test_chat_requires_signature(client):
    payload = {"messages": [{"role": "user", "content": "hi"}]}
    response = client.post("/internal/v1/chat", json=payload)
    assert response.status_code == 401


def test_chat_stream_emits_delta_and_completed(client):
    payload = {"messages": [{"role": "user", "content": "hello"}]}
    body = json.dumps(payload, separators=(",", ":")).encode()
    path = "/internal/v1/chat/stream"
    response = client.post(path, content=body, headers=signed_chat_headers(path, body))
    assert response.status_code == 200
    events = [json.loads(line.removeprefix("data: "))
              for line in response.text.strip().split("\n\n") if line.startswith("data: ")]
    types = [event["type"] for event in events]
    assert "chat_delta" in types
    assert types[-1] == "chat_completed"
    reply = "".join(event.get("content", "") for event in events if event["type"] == "chat_delta")
    assert reply.startswith("[mock]")

def test_chat_stream_can_include_reasoning(client):
    payload = {"messages": [{"role": "user", "content": "hello"}], "include_reasoning": True}
    body = json.dumps(payload, separators=(",", ":")).encode()
    path = "/internal/v1/chat/stream"
    response = client.post(path, content=body, headers=signed_chat_headers(path, body))
    assert response.status_code == 200
    events = [json.loads(line.removeprefix("data: "))
              for line in response.text.strip().split("\n\n") if line.startswith("data: ")]
    types = [event["type"] for event in events]
    assert "chat_reasoning_delta" in types
    assert "chat_delta" in types
    assert types[-1] == "chat_completed"


def test_chat_stream_omits_reasoning_by_default(client):
    payload = {"messages": [{"role": "user", "content": "hello"}]}
    body = json.dumps(payload, separators=(",", ":")).encode()
    path = "/internal/v1/chat/stream"
    response = client.post(path, content=body, headers=signed_chat_headers(path, body))
    assert response.status_code == 200
    assert "chat_reasoning_delta" not in response.text


def test_parse_tags_buffers_partial_tool_call_opening_tag():
    assert _parse_tags("准备检索<tool_") == [
        {"type": "content", "text": "准备检索"},
        {"type": "_buf", "text": "<tool_"},
    ]


def test_parse_tags_reassembles_chunked_text_tool_call():
    first = _parse_tags("说明文字<tool_")
    second = _parse_tags(
        first[-1]["text"]
        + "call><function=web_search>"
        + "<parameter=query>江南大学</parameter>"
        + "</function></tool_call>"
    )

    assert first[0] == {"type": "content", "text": "说明文字"}
    assert second == [{
        "type": "text_tool_call",
        "name": "web_search",
        "params": {"query": "江南大学"},
    }]


def test_normalize_cumulative_reasoning_frames():
    accumulated, delta = _normalize_cumulative_delta("", "先分析")
    assert (accumulated, delta) == ("先分析", "先分析")

    accumulated, delta = _normalize_cumulative_delta(accumulated, "先分析，再检索")
    assert (accumulated, delta) == ("先分析，再检索", "，再检索")

    accumulated, delta = _normalize_cumulative_delta(accumulated, "，再检索")
    assert (accumulated, delta) == ("先分析，再检索", "")


def test_normalize_incremental_reasoning_frames():
    accumulated, delta = _normalize_cumulative_delta("先分析", "，再检索")
    assert (accumulated, delta) == ("先分析，再检索", "，再检索")


def bearer_headers(user_id=None, secret=None):
    token = jwt.encode({"sub": str(user_id or uuid4()), "email": "tester@example.com"},
                       secret or get_settings().jwt_secret, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


def test_public_chat_requires_bearer_token(client):
    response = client.post("/v1/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert response.status_code == 401


def test_public_chat_rejects_bad_signature(client):
    response = client.post("/v1/chat", json={"messages": [{"role": "user", "content": "hi"}]},
                           headers=bearer_headers(secret="totally-wrong-secret"))
    assert response.status_code == 401


def test_public_chat_with_valid_token(client):
    response = client.post("/v1/chat", json={"messages": [{"role": "user", "content": "\u4f60\u597d"}]},
                           headers=bearer_headers())
    assert response.status_code == 200
    assert response.json()["reply"].startswith("[mock]")


def test_public_chat_stream_with_valid_token(client):
    payload = {"messages": [{"role": "user", "content": "hello"}], "include_reasoning": True}
    response = client.post("/v1/chat/stream", json=payload, headers=bearer_headers())
    assert response.status_code == 200
    assert "chat_reasoning_delta" in response.text
    assert "chat_delta" in response.text
    assert "chat_completed" in response.text


def test_public_agents_list_with_valid_token(client):
    response = client.get("/v1/agents", headers=bearer_headers())
    assert response.status_code == 200
    assert len(response.json()["agents"]) == 6
