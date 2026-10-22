import json
from uuid import uuid4

import jwt
import pytest

from app.config import get_settings


def bearer_headers(user_id=None, secret=None):
    token = jwt.encode({"sub": str(user_id or uuid4()), "email": "tester@example.com"},
                       secret or get_settings().jwt_secret, algorithm="HS256")
    return {"Authorization": f"Bearer {token}"}


class FakeChatStore:
    def __init__(self):
        self.sessions = {}
        self.messages = {}

    def available(self):
        return True

    def create_session(self, user_id):
        from uuid import uuid4 as new_id
        session_id = str(new_id())
        self.sessions[session_id] = {"id": session_id, "user_id": str(user_id), "title": "\u65b0\u5bf9\u8bdd", "archived": False}
        self.messages[session_id] = []
        return {"id": session_id, "title": "\u65b0\u5bf9\u8bdd"}

    def list_sessions(self, user_id, archived=False):
        return [s for s in self.sessions.values()
                if s["user_id"] == str(user_id) and s["archived"] is archived]

    def get_session(self, session_id, user_id):
        session = self.sessions.get(str(session_id))
        if session is None or session["user_id"] != str(user_id):
            return None
        return session

    def delete_session(self, session_id, user_id):
        session = self.sessions.get(str(session_id))
        if session is None or session["user_id"] != str(user_id):
            return False
        del self.sessions[str(session_id)]
        self.messages.pop(str(session_id), None)
        return True

    def set_archived(self, session_id, user_id, archived):
        session = self.get_session(session_id, user_id)
        if session is None:
            return None
        session["archived"] = archived
        return session

    def list_messages(self, session_id):
        return list(self.messages.get(str(session_id), []))

    def append_message(self, session_id, role, content, reasoning=None, attachment_ids=None, user_id=None):
        message = {"id": str(uuid4()), "role": role, "content": content, "reasoning": reasoning,
                   "tools": None, "seq": len(self.messages[str(session_id)]) + 1}
        self.messages[str(session_id)].append(message)
        return message

    def update_message(self, message_id, content, reasoning=None, tools=None):
        for messages in self.messages.values():
            for message in messages:
                if message["id"] == str(message_id):
                    message["content"] = content
                    message["reasoning"] = reasoning
                    if tools is not None:
                        message["tools"] = tools
                    return message
        return None

    def auto_title(self, session_id, content):
        session = self.sessions[str(session_id)]
        if session["title"] == "\u65b0\u5bf9\u8bdd":
            session["title"] = content.strip()[:64]


@pytest.fixture
def fake_store(monkeypatch):
    store = FakeChatStore()
    monkeypatch.setattr("app.routers.public.chat_store", lambda: store)
    return store


def test_create_and_list_sessions(client, fake_store):
    user_id = uuid4()
    created = client.post("/v1/chat/sessions", headers=bearer_headers(user_id))
    assert created.status_code == 200
    session_id = created.json()["id"]

    listed = client.get("/v1/chat/sessions", headers=bearer_headers(user_id))
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["sessions"]] == [session_id]

    other = client.get("/v1/chat/sessions", headers=bearer_headers(uuid4()))
    assert other.json()["sessions"] == []


def test_session_messages_require_ownership(client, fake_store):
    owner = uuid4()
    session_id = client.post("/v1/chat/sessions", headers=bearer_headers(owner)).json()["id"]

    allowed = client.get(f"/v1/chat/sessions/{session_id}/messages", headers=bearer_headers(owner))
    assert allowed.status_code == 200
    assert allowed.json()["messages"] == []

    denied = client.get(f"/v1/chat/sessions/{session_id}/messages", headers=bearer_headers(uuid4()))
    assert denied.status_code == 404


def test_delete_session(client, fake_store):
    owner = uuid4()
    session_id = client.post("/v1/chat/sessions", headers=bearer_headers(owner)).json()["id"]
    removed = client.delete(f"/v1/chat/sessions/{session_id}", headers=bearer_headers(owner))
    assert removed.status_code == 204
    assert client.get("/v1/chat/sessions", headers=bearer_headers(owner)).json()["sessions"] == []


def test_archive_and_restore_session(client, fake_store):
    owner = uuid4()
    session_id = client.post("/v1/chat/sessions", headers=bearer_headers(owner)).json()["id"]

    archived = client.put(
        f"/v1/chat/sessions/{session_id}/archive",
        json={"archived": True}, headers=bearer_headers(owner),
    )
    assert archived.status_code == 200
    assert archived.json()["archived"] is True
    assert client.get("/v1/chat/sessions", headers=bearer_headers(owner)).json()["sessions"] == []
    archive_list = client.get("/v1/chat/sessions?archived=true", headers=bearer_headers(owner))
    assert [item["id"] for item in archive_list.json()["sessions"]] == [session_id]

    restored = client.put(
        f"/v1/chat/sessions/{session_id}/archive",
        json={"archived": False}, headers=bearer_headers(owner),
    )
    assert restored.status_code == 200
    assert restored.json()["archived"] is False


def test_sync_chat_persists_messages(client, fake_store):
    user_id = uuid4()
    session_id = client.post("/v1/chat/sessions", headers=bearer_headers(user_id)).json()["id"]
    payload = {"messages": [{"role": "user", "content": "\u4f60\u597d"}], "sessionId": session_id}
    response = client.post("/v1/chat", json=payload, headers=bearer_headers(user_id))
    assert response.status_code == 200

    stored = fake_store.list_messages(session_id)
    assert [m["role"] for m in stored] == ["user", "assistant"]
    assert stored[0]["content"] == "\u4f60\u597d"
    assert stored[1]["content"].startswith("[mock]")
    assert fake_store.get_session(session_id, user_id)["title"] == "\u4f60\u597d"


def test_stream_chat_persists_reply_with_reasoning(client, fake_store):
    user_id = uuid4()
    session_id = client.post("/v1/chat/sessions", headers=bearer_headers(user_id)).json()["id"]
    payload = {"messages": [{"role": "user", "content": "hello"}],
               "sessionId": session_id, "includeReasoning": True}
    response = client.post("/v1/chat/stream", json=payload, headers=bearer_headers(user_id))
    assert response.status_code == 200

    stored = fake_store.list_messages(session_id)
    assert [m["role"] for m in stored] == ["user", "assistant"]
    assert stored[1]["reasoning"]
    assert stored[1]["content"].startswith("[mock]")


def test_chat_with_unknown_session_returns_404(client, fake_store):
    payload = {"messages": [{"role": "user", "content": "hi"}], "sessionId": str(uuid4())}
    response = client.post("/v1/chat", json=payload, headers=bearer_headers(uuid4()))
    assert response.status_code == 404


def test_session_endpoints_require_token(client, fake_store):
    assert client.get("/v1/chat/sessions").status_code == 401
