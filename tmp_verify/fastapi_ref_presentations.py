"""
Authoritative FastAPI reference for the 11-route presentations batch.

Mounts the REAL PresentationProgressRequest model and a REAL `dict` body route
onto a throwaway FastAPI app, then records (status, detail) for a battery of
bodies / paths / query strings. Output JSON is the contract the Spire build is
diffed against — expectations come from measurement, not from memory.

Run:  PYTHONIOENCODING=utf-8 python -u tmp_verify/fastapi_ref_presentations.py
Out:  tmp_verify/fastapi_ref_presentations.json
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Optional, Union
from uuid import UUID

from typing import Optional  # noqa: E402

from fastapi import FastAPI, HTTPException, Query  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import AliasChoices, BaseModel, ConfigDict, Field  # noqa: E402

# The legacy models.py needs Python >= 3.11 (StrEnum); this interpreter is 3.9,
# so the model is transcribed verbatim from
# D:\cangjie\ITN-Beta\src\agents\app\domain\models.py:146-154 with
# `X | None` written as `Optional[X]` — identical pydantic schema/validation.
class PresentationProgressRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    page_index: Optional[int] = Field(
        default=None, ge=0,
        validation_alias=AliasChoices("page_index", "pageIndex"))
    page_count: Optional[int] = Field(
        default=None, ge=1,
        validation_alias=AliasChoices("page_count", "pageCount"))
    learned: Optional[bool] = None
    mastery: Optional[float] = Field(default=None, ge=0, le=1)


app = FastAPI()


# --- mirrors public.py:1943 update_presentation_progress --------------------
@app.post("/v1/presentations/{task_id}/progress")
async def update_progress(task_id: UUID,
                          request: PresentationProgressRequest):
    return {"ok": True}


# --- mirrors public.py:1521 batch_delete_presentations ----------------------
@app.post("/v1/presentations/batch-delete")
async def batch_delete(payload: dict):
    raw_ids = payload.get("taskIds") or payload.get("task_ids") or []
    if not isinstance(raw_ids, list) or not raw_ids:
        raise HTTPException(status_code=422, detail="taskIds must be a non-empty array")
    if len(raw_ids) > 100:
        raise HTTPException(status_code=422, detail="taskIds cannot contain more than 100 items")
    try:
        task_ids = [UUID(str(item)) for item in raw_ids]
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="taskIds contains invalid UUIDs")
    return {"deleted": [str(t) for t in task_ids], "count": len(task_ids)}


# --- mirrors public.py:1469 get_presentation (path uuid only) ---------------
@app.get("/v1/presentations/{task_id}")
async def get_one(task_id: UUID):
    return {"ok": True}


# --- mirrors public.py:249862 list learning-resource-tasks (query only) -----
@app.get("/v1/learning-resource-tasks")
async def list_rt(limit: int = Query(30, ge=1, le=1000), summary: bool = False):
    return {"ok": True}


@app.get("/v1/learning-resource-tasks/{task_id}")
async def get_rt(task_id: UUID):
    return {"ok": True}


GHOST = "11111111-2222-4333-8444-555555555555"

BODIES: Dict[str, list] = {
    "progress": [
        ("empty", ""),
        ("ws", "  "),
        ("malformed", "{not json"),
        ("malformed2", "[1,2"),
        ("malformed3", "nul"),
        ("malformed4", '{"a": }'),
        ("malformed5", '{"page_index": 1'),
        ("malformed_extra", "01"),
        ("singlequote", "'x'"),
        ("null", "null"),
        ("int", "123"),
        ("str", '"str"'),
        ("bool", "true"),
        ("array", "[1,2]"),
        ("emptyobj", "{}"),
        ("pi_neg", '{"pageIndex": -1}'),
        ("pi_str", '{"pageIndex": "abc"}'),
        ("pi_float", '{"pageIndex": 1.5}'),
        ("pi_floatint", '{"pageIndex": 2.0}'),
        ("pi_bool", '{"pageIndex": true}'),
        ("pi_strnum", '{"pageIndex": "4"}'),
        ("pi_explicit_null", '{"pageIndex": null}'),
        ("pi_extra", '{"pageIndex": 1, "extra": {"x": 1}}'),
        ("snake_neg", '{"page_index": -1}'),
        ("pc_zero", '{"pageCount": 0}'),
        ("pc_str", '{"pageCount": "two"}'),
        ("learned_yes", '{"learned": "yes"}'),
        ("learned_maybe", '{"learned": "maybe"}'),
        ("learned_int0", '{"learned": 0}'),
        ("mastery_neg", '{"mastery": -0.1}'),
        ("mastery_over", '{"mastery": 1.5}'),
        ("mastery_2", '{"mastery": 2}'),
        ("mastery_str", '{"mastery": "high"}'),
        ("ok", '{"pageIndex": 3, "pageCount": 9, "learned": true, "mastery": 0.5}'),
        ("both_aliases", '{"pageIndex": 3, "page_index": 7}'),
    ],
    "batch": [
        ("empty", ""),
        ("ws", "  "),
        ("malformed", "{not json"),
        ("null", "null"),
        ("int", "123"),
        ("str", '"str"'),
        ("bool", "true"),
        ("array", "[]"),
        ("array2", "[1,2,3]"),
        ("emptyobj", "{}"),
        ("ids_empty", '{"taskIds": []}'),
        ("ids_null", '{"taskIds": null}'),
        ("ids_str", '{"taskIds": "x"}'),
        ("ids_bad", '{"taskIds": ["nope"]}'),
        ("ids_ok", '{"taskIds": ["%s"]}' % GHOST),
        ("snake_ok", '{"task_ids": ["%s"]}' % GHOST),
        ("ids_101", json.dumps({"taskIds": [GHOST] * 101})),
    ],
}

UUIDS = [
    "not-a-uuid",
    "00000000-0000-0000-0000-0000000000z",
    "0000000000000000000000000000000",
    "000000000000000000000000000000000",
    "00000000-0000-0000-0000",
    "00000000-000-0000-0000-000000000000",
    "URN:UUID:00000000-0000-0000-0000-000000000000",
    "urn:uuid:00000000-0000-0000-0000-000000000000",
    "urn:uuid:{00000000-0000-0000-0000-000000000000}",
    "{urn:uuid:00000000-0000-0000-0000-000000000000}",
    "{00000000-0000-0000-0000-000000000000}",
    "{00000000-0000-0000-0000-000000000000",
    "00000000000000000000000000000000",
    "-00000000-0000-0000-0000-000000000000",
    "00000000-0000-0000-0000-000000000000-",
    "00000000-0000-0000-0000-00000000000",
    "00000000-0000-0000-0000-0000000000000",
    "00000000-0000-0000-0000-000000000000-extra",
    "urn:uuid:00000000000000000000000000000000",
    "urn:uuid:zzzzzzzz-0000-0000-0000-000000000000",
    "{00000000-0000-0000-0000-00000000000}",
    GHOST,
    "batch-delete",
    # --- crafted inputs pinning the crate's length dispatch and error text ---
    # (probed against the real service; see http_util.uuidParseError)
    "{00000000-0000-0000-0000-00000000000}",     # braced 37, g4 -> found 13
    "{00000000-0000-0000-0000-0000000000000}",   # braced 39, g4 -> found 15
    "{00000000000000000000000000000000}",        # braced 34 -> group count 1
    "{0000000000000000000000000000000}",         # braced 33 -> group count 1
    "{0000000-0000-0000-0000-000000000000}",     # braced, g0 -> found 7
    "{00000000-000-0000-0000-000000000000}",     # braced, g1 -> found 3
    "{00000000-0000-0000-0000-00000000000z}",    # braced 38, char pos
    "{00000000-0000-0000-0000-0000000000zz}",    # braced, second char pos
    "urn:uuid:00000000000000000000000000000000", # 41 -> group count 1
    "urn:uuid:0000000000000000000000000000000",  # 40 -> group count 1
    "urn:uuid:000000000000000000000000000000000", # 42 -> group count 1
    "urn:uuid:000000000000000000000000000000000000000000000000",  # 57
    "urn:uuid:00000000-0000-0000-0000-00000000000",   # 44, g4 -> 20
    "urn:uuid:00000000-0000-0000-0000-0000000000000", # 46, g4 -> 22
    "urn:uuid:0000000-0000-0000-0000-000000000000",   # urn g0 -> 7
    "urn:uuid:00000000-000-0000-0000-000000000000",   # urn g1 -> 3
    "urn:uuid:00000000-0000-0000-0000-0000000000z",   # urn 45 char pos
    "000000000000000000000000000000000000",    # 36 hex, no hyphen -> invalid length
    "0000000-0000-0000-0000-000000000000",     # plain g0 -> 7
    "00000000-000-0000-0000-000000000000",     # plain g1 -> 3
    "0000000000000000000000000000000000000000",      # 40 hex -> invalid length
    "000000000000000000000000000000000000000000000000", # 48 hex -> invalid length
    "-00000000-0000-0000-0000-000000000000",
    "00000000-0000-0000-0000-000000000000-",
    "00000000--0000-0000-0000-000000000000",
    "00000000-0000-0000-0000-000000000000-extra",
    "00000000-0000-0000-0000-0000000000z",     # plain 36 char pos
    "00000000-0000-0000-0000-00000000000z",     # plain 37 char pos
]


JSON_BATTERY = [
    # --- structural ---
    "", " ", "  \t\n  ", "{", "}", "[", "]", "{,}", "{:}", "{\"a\":}", "{\"a\":,}",
    "{\"a\" 1}", "{\"a\":1,}", "{\"a\":1,,\"b\":2}", "[,]", "[1,]", "[1,,2]",
    "[1 2]", "{\"a\":1 \"b\":2}", "{a:1}", "{'a':1}", "{not json", "[1,2",
    "nul", "nu", "nulll", "true", "truex", "fals", "falsey", "tru", "None",
    "01", "1.", "1e", "1e+", "+1", ".5", "-", "-.5", "0x10", "1.2.3", "1 2",
    "00", "1_", "1.0e", "0b10", "'x'", "\"abc", "\"abc\\", "\"ab\\q\"",
    "\"ab\\u12\"", "\"ab\\uXXXX\"", "\"a\nb\"", "\"a\tb\"", "[1,2", "{} {}",
    "\"x\" \"y\"", "NaN", "Infinity", "-Infinity", "undefined", "''",
    # --- objects ---
    "{\"a\": 1", "{\"a\": 1,", "{\"a\" 1}", "{\"a\": 1 } x",
    "{\"a\": tru}", "{\"a\": [1,2}", "{\"a\": {\"b\": 1}",
    # --- unicode positions (pos is in code points, not bytes) ---
    "[中文,", "{\"中\": }", "\"中文\\q\"", "😀{", "\"ok😀\"",
    "é{", "€ [1,", "[😀😀,]", "{\"k😀\": tru}",
    '"中文" x', '["中文", ]', '{"中文": 1, }', '[1, 中文]',
    # --- EOF after whitespace (which message / position wins) ---
    '{ ', '[ ', '{\n', '[1,', '{"a": ', '{"a"', '[1 ', '[1', '{"" ',
    '"\\u1"', '"\\u"', '"\\"', '"abc\\u12g"', "[1,2,]",
    # --- literal-prefix boundaries ---
    'nulx', 'null ', 'true ', 'truex ', '[true]', '{"a":null}', '[NaN]',
    # --- valid JSON (must stay ok) ---
    "null", "true", "false", "0", "-0", "1.5", "1e3", "-2.5E-4", "\"s\"",
    "{}", "[]", "{\"a\":1}", "{\"a\":[1,2,{\"b\":null}]}",
    " [ 1 , 2 ] ", "\"\\u00e9\"", "\"\\\\\"", "\"\\/\"",
    "[1, 2.0, -3, 4e5, \"six\", true, false, null]",
    "\"\\b\\f\\n\\r\\t\"",
    "{\n  \"a\": 1,\n  \"b\": [\n    2\n  ]\n}",
    "\"中文字符串\"",
]


def rec(c: TestClient, label: str, fn) -> dict:
    r = fn()
    body: Any
    try:
        body = r.json()
    except Exception:
        body = r.text
    return {"label": label, "status": r.status_code, "body": body}


def main() -> None:
    c = TestClient(app)
    out: Dict[str, Any] = {"note": "measured FastAPI 0.115.6 / pydantic 2.10.4"}

    out["progress"] = [
        rec(c, f"body:{n}", lambda b=b: c.post(
            f"/v1/presentations/{GHOST}/progress", content=b.encode("utf-8"),
            headers={"Content-Type": "application/json"}))
        for n, b in BODIES["progress"]
    ]

    out["batch"] = [
        rec(c, f"body:{n}", lambda b=b: c.post(
            "/v1/presentations/batch-delete", content=b.encode("utf-8"),
            headers={"Content-Type": "application/json"}))
        for n, b in BODIES["batch"]
    ]

    out["batch_noct"] = [
        rec(c, f"nc:{n}", lambda b=b: c.post(
            "/v1/presentations/batch-delete", content=b.encode("utf-8")))
        for n, b in [("malformed", "{not json"), ("null", "null"),
                     ("empty", ""), ("ok", '{"taskIds": []}')]
    ]

    out["uuid_path"] = [
        rec(c, f"uuid:{u}", lambda u=u: c.get(f"/v1/presentations/{u}"))
        for u in UUIDS
    ]

    out["uuid_rt"] = [
        rec(c, f"rt-uuid:{u}", lambda u=u: c.get(f"/v1/learning-resource-tasks/{u}"))
        for u in ["not-a-uuid", "urn:uuid:00000000-0000-0000-0000-000000000000", GHOST]
    ]

    out["query_rt"] = [
        rec(c, "rt limit abc", lambda: c.get("/v1/learning-resource-tasks?limit=abc")),
        rec(c, "rt limit 0", lambda: c.get("/v1/learning-resource-tasks?limit=0")),
        rec(c, "rt limit 1001", lambda: c.get("/v1/learning-resource-tasks?limit=1001")),
        rec(c, "rt summary bogus", lambda: c.get("/v1/learning-resource-tasks?summary=bogus")),
        rec(c, "rt summary 1", lambda: c.get("/v1/learning-resource-tasks?summary=1")),
    ]

    out["method_collision"] = [
        rec(c, "GET batch-delete", lambda: c.get("/v1/presentations/batch-delete")),
        rec(c, "DELETE batch-delete", lambda: c.delete("/v1/presentations/batch-delete")),
    ]

    # --- CPython json.loads oracle: exact (msg, pos) for every malformed body.
    # FastAPI's routing.py catches json.JSONDecodeError and puts e.msg in
    # ctx.error and e.pos in loc[1], so this IS the contract.
    import json as _j

    out["json_errors"] = []
    for s in JSON_BATTERY:
        try:
            _j.loads(s)
            out["json_errors"].append({"in": s, "ok": True})
        except _j.JSONDecodeError as e:
            out["json_errors"].append({"in": s, "ok": False,
                                       "msg": e.msg, "pos": e.pos})

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "fastapi_ref_presentations.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    n = sum(len(v) for k, v in out.items() if isinstance(v, list))
    print(f"wrote {path} ({n} cases)")


if __name__ == "__main__":
    main()
