"""Test infrastructure for predeal pipeline tests.

Provides:
- FakeDB: in-memory MySQL (documents / chunks / figures / chunk_categories)
- Fake external services: image download/upload/VLM, file server, RAGFlow, LLM
- Fixtures: isolated domain config + source markdown + output dir

All external dependencies (MySQL, image server, file server, RAGFlow, LLM)
are replaced by fakes so tests are deterministic and never touch production.
"""

from __future__ import annotations

import hashlib
import os
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

# ── 测试隔离：单测绝不触网（2026-08-19，同 KnowledgeCore/tests/conftest.py）──
# ``predeal`` 包 __init__ 会加载 src/agents/.env（部署配置），其中配置了真实
# 的硅基流动 embedding 端点/密钥（EMBEDDING_API_URL/EMBEDDING_API_KEY）。
# 环境变量优先级高于 .env 文件，在导入 predeal 包之前置空，保证
# embedding_client.EmbeddingClient 在单测中恒为 unconfigured（自动回落占位
# 实现），需要验证真实 embedding 逻辑的测试自行 mock httpx / 构造带显式
# api_url/api_key 的 EmbeddingClient 实例。
os.environ["EMBEDDING_API_URL"] = ""
os.environ["EMBEDDING_API_KEY"] = ""

from predeal import load_dotenv  # noqa: E402  (loads .env, harmless in tests)
from predeal.images.models import (  # noqa: E402
    ImageMetadata,
    ImageRecord,
    ProcessingStatus,
    UploadResult,
)


# ── Production-MySQL guard (T5.2) ───────────────────────────────────────────
#
# The predeal pytest suite never touches a real MySQL server: every DB call
# is monkeypatched onto `FakeDB` below (see `fake_env`). `load_dotenv()`
# above may still load `src/agents/.env`, whose `MYSQL_*` point at the
# production database (113.249.110.108 / itn-platform) used by the running
# service — but that config is not read here.
#
# As a safety net for any future test/fixture that opts into a real
# connection via dedicated `TEST_MYSQL_*` env vars, refuse to run the suite
# at all when those vars look like they target the production database.
_PROD_HOSTS = {"113.249.110.108"}
_PROD_DATABASES = {"itn-platform"}
_SAFE_HOSTS = {"", "localhost", "127.0.0.1"}


def _looks_like_production(host: str, database: str) -> bool:
    if host in _PROD_HOSTS or database in _PROD_DATABASES:
        return True
    if host and host not in _SAFE_HOSTS:
        return True
    return False


def _guard_against_production_mysql() -> None:
    host = os.environ.get("TEST_MYSQL_HOST", "")
    if not host:
        return
    database = os.environ.get("TEST_MYSQL_DATABASE", "")
    if _looks_like_production(host, database):
        pytest.exit(
            "检测到 TEST_MYSQL_HOST/TEST_MYSQL_DATABASE 指向疑似生产库"
            f"（host={host!r}, database={database!r}）。predeal 测试套件禁止连接"
            "生产 MySQL，请改配隔离的测试库。",
            returncode=1,
        )


_guard_against_production_mysql()


# ── Fake DB ────────────────────────────────────────────────────────────────


class FakeDB:
    """In-memory stand-in for the predeal MySQL tables."""

    def __init__(self) -> None:
        self.documents: dict[int, dict] = {}
        self.chunks: dict[int, dict] = {}
        self.figures: dict[int, ImageRecord] = {}
        self.chunk_categories: list[dict] = []
        self.chunk_enrichment: dict[int, dict] = {}  # T3.1: chunk_id -> enrichment row
        self._next_doc = 1
        self._next_chunk = 1
        self._next_fig = 1

    # ── knowledge_document ──

    def get_or_create_document(self, **kw) -> dict:
        key = kw["document_key"]
        fhash = kw["file_hash"]
        for row in self.documents.values():
            if row.get("document_key") == key:
                unchanged = row.get("content_sha256") == fhash
                row["content_sha256"] = fhash
                if not unchanged and row["status"] not in ("processing", "failed"):
                    row["status"] = "processing"
                return {
                    "db_id": row["id"], "created_new": False,
                    "content_unchanged": unchanged,
                    "status": row["status"] if unchanged else "processing",
                    "row": row,
                }
        # legacy hash code lookup
        legacy = f"{kw['domain_id']}_{fhash[:8]}"
        for row in self.documents.values():
            if row.get("document_code") == legacy:
                unchanged = row.get("content_sha256") == fhash
                row["document_key"] = key
                row["document_code"] = key
                row["content_sha256"] = fhash
                return {
                    "db_id": row["id"], "created_new": False,
                    "content_unchanged": unchanged,
                    "status": row["status"] if unchanged else "processing",
                    "row": row,
                }
        row = {
            "id": self._next_doc, "document_key": key, "document_code": key,
            "content_sha256": fhash, "status": "processing",
            "title": kw.get("title", ""), "storage_key": None,
            "normalized_storage_key": None, "ragflow_document_id": None,
            "ragflow_doc_id": None, "last_ragflow_sha256": None,
            "last_error": None, "original_file_name": kw.get("original_file_name", ""),
        }
        self._next_doc += 1
        self.documents[row["id"]] = row
        return {
            "db_id": row["id"], "created_new": True,
            "content_unchanged": False, "status": "processing", "row": row,
        }

    def get_document_fields(self, document_id: int):
        return self.documents.get(document_id)

    def update_document_fields(self, document_id: int, **kw) -> None:
        if document_id in self.documents:
            self.documents[document_id].update(kw)

    def mark_document_failed(self, document_id: int, error: str) -> None:
        self.update_document_fields(document_id, status="failed", last_error=str(error)[:2000])

    # ── knowledge_chunk ──

    def active_chunk_rows(self, document_id: int) -> list[dict]:
        rows = [r for r in self.chunks.values()
                if r["document_id"] == document_id and r["status"] == "active"]
        return sorted(rows, key=lambda r: r["chunk_index"])

    def sync_chunks(self, document_db_id: int, chunks: list):
        """Mirror of chunk_repository.sync_chunks semantics (diff-based)."""
        from predeal.chunk_repository import ChunkSyncReport
        from predeal.utils.hash import content_hash

        report = ChunkSyncReport()
        all_rows = [r for r in self.chunks.values()
                    if r["document_id"] == document_db_id]
        old_by_hash: dict = {}
        old_by_index: dict = {}
        old_active: dict[int, dict] = {}
        for row in all_rows:
            if row.get("content_hash"):
                old_by_hash.setdefault(row["content_hash"], row)
            if row["status"] == "active":
                old_by_index.setdefault(row["chunk_index"], row)
                old_active[row["id"]] = row
        used: set[int] = set()

        for chunk in chunks:
            h = content_hash(chunk.content)
            title_path = " > ".join(chunk.section_path) if chunk.section_path else ""
            old = old_by_hash.get(h)
            if old is not None and old["id"] not in used:
                used.add(old["id"])
                if old["status"] != "active":
                    old["status"] = "active"  # reactivate
                old.update(chunk_code=chunk.chunk_id, chunk_index=chunk.chunk_order,
                           title_path=title_path, section_title=chunk.heading or "",
                           content_hash=h)
                report.unchanged.append({"chunk_id": chunk.chunk_id, "db_id": old["id"]})
                report._all_db_ids[chunk.chunk_id] = old["id"]
                continue
            old = old_by_index.get(chunk.chunk_order)
            if old is not None and old["id"] not in used:
                used.add(old["id"])
                old.update(
                    chunk_code=chunk.chunk_id, chunk_index=chunk.chunk_order,
                    title_path=title_path, section_title=chunk.heading or "",
                    content=chunk.content, content_hash=h,
                    token_count=chunk.approx_token_count, status="active",
                    char_start=chunk.source_start_offset, char_end=chunk.source_end_offset,
                )
                self.chunk_categories = [c for c in self.chunk_categories
                                         if c["chunk_id"] != old["id"]]
                report.updated.append({"chunk_id": chunk.chunk_id, "db_id": old["id"]})
                report._all_db_ids[chunk.chunk_id] = old["id"]
                continue
            row = {
                "id": self._next_chunk, "document_id": document_db_id,
                "chunk_code": chunk.chunk_id, "chunk_index": chunk.chunk_order,
                "title_path": title_path, "section_title": chunk.heading or "",
                "content": chunk.content, "content_hash": h,
                "token_count": chunk.approx_token_count, "ragflow_chunk_id": None,
                "status": "active", "char_start": chunk.source_start_offset,
                "char_end": chunk.source_end_offset, "canonical_chunk_id": None,
            }
            self._next_chunk += 1
            self.chunks[row["id"]] = row
            report.inserted.append({"chunk_id": chunk.chunk_id, "db_id": row["id"]})
            report._all_db_ids[chunk.chunk_id] = row["id"]

        superseded = [r["id"] for r in old_active.values() if r["id"] not in used]
        for sid in superseded:
            self.chunks[sid]["status"] = "superseded"
            self.chunk_categories = [c for c in self.chunk_categories if c["chunk_id"] != sid]
        report.superseded_ids = superseded
        return report

    def count_active_chunks(self, document_db_id: int) -> int:
        return len(self.active_chunk_rows(document_db_id))

    def get_active_chunks(self, document_db_id: int) -> list[dict]:
        return self.active_chunk_rows(document_db_id)

    def update_chunk_ragflow_id(self, chunk_db_id: int, ragflow_chunk_id: str) -> None:
        if chunk_db_id in self.chunks:
            self.chunks[chunk_db_id]["ragflow_chunk_id"] = ragflow_chunk_id

    def get_ragflow_chunk_ids(self, document_db_id: int, chunk_db_ids=None) -> dict:
        rows = [r for r in self.chunks.values() if r["document_id"] == document_db_id]
        if chunk_db_ids:
            rows = [r for r in rows if r["id"] in chunk_db_ids]
        return {r["id"]: r["ragflow_chunk_id"] for r in rows}

    def missing_ragflow_ids(self, document_db_id: int) -> list[int]:
        return [r["id"] for r in self.chunks.values()
                if r["document_id"] == document_db_id
                and r.get("ragflow_chunk_id") is None]

    def get_chunks_without_category(self, document_db_id: int) -> list[dict]:
        cat_chunk_ids = {c["chunk_id"] for c in self.chunk_categories}
        rows = []
        for r in self.active_chunk_rows(document_db_id):
            if r["id"] not in cat_chunk_ids:
                rows.append({
                    "db_id": r["id"], "chunk_id": r["chunk_code"],
                    "content": r["content"], "title_path": r["title_path"],
                    "section_title": r["section_title"],
                })
        return rows

    def count_chunks_without_category(self, document_db_id: int) -> int:
        return len(self.get_chunks_without_category(document_db_id))

    # ── knowledge_chunk_enrichment (T3.1 / T3.5 / T3.9) ──

    def get_chunks_needing_enrichment(self, document_db_id: int) -> list[dict]:
        """Mirror of chunk_enricher.get_chunks_needing_enrichment: stale/missing
        enrichment (content_hash mismatch) OR missing category classification."""
        cat_chunk_ids = {c["chunk_id"] for c in self.chunk_categories}
        rows = []
        for r in self.active_chunk_rows(document_db_id):
            enr = self.chunk_enrichment.get(r["id"])
            stale = enr is None or enr.get("content_hash") != r.get("content_hash")
            uncategorized = r["id"] not in cat_chunk_ids
            if stale or uncategorized:
                rows.append({
                    "db_id": r["id"], "chunk_id": r["chunk_code"],
                    "content": r["content"], "content_hash": r.get("content_hash"),
                    "title_path": r["title_path"], "section_title": r["section_title"],
                })
        return rows

    def count_chunks_needing_enrichment(self, document_db_id: int) -> int:
        return len(self.get_chunks_needing_enrichment(document_db_id))

    def save_enrichment(self, chunk_db_id: int, content_hash_value, data: dict) -> None:
        self.chunk_enrichment[chunk_db_id] = {"content_hash": content_hash_value, **data}

    def get_enrichment_for_chunks(self, chunk_db_ids) -> dict:
        out = {}
        for cid in chunk_db_ids:
            enr = self.chunk_enrichment.get(cid)
            if enr:
                out[cid] = {
                    "context_prefix": enr.get("context_prefix") or "",
                    "questions": enr.get("questions") or [],
                    "asset_summary": enr.get("asset_summary") or "",
                }
        return out

    def get_confidence_by_chunk_code(self, document_db_id: int) -> dict:
        by_id = {r["id"]: r["chunk_code"] for r in self.active_chunk_rows(document_db_id)}
        out = {}
        for c in self.chunk_categories:
            if c["chunk_id"] in by_id:
                out[by_id[c["chunk_id"]]] = c.get("confidence", 0.0)
        return out

    def dedup_document_chunks(self, document_db_id: int) -> int:
        """Mirror of chunk_enricher.dedup_document_chunks using the same pure
        compute_canonical_map helper (imported lazily to avoid import cycles)."""
        from predeal.steps.chunk_enricher import compute_canonical_map

        rows = []
        for r in self.active_chunk_rows(document_db_id):
            if r.get("canonical_chunk_id") is not None:
                continue
            enr = self.chunk_enrichment.get(r["id"])
            if enr and enr.get("near_duplicate_hint"):
                rows.append({
                    "db_id": r["id"], "chunk_index": r["chunk_index"],
                    "content": r["content"], "near_duplicate_hint": True,
                })
        if not rows:
            return 0
        canonical_map = compute_canonical_map(rows)
        for later_id, canonical_id in canonical_map.items():
            self.chunks[later_id]["canonical_chunk_id"] = canonical_id
        return len(canonical_map)

    # ── knowledge_figures ──

    def upsert_pending(self, document_id, occurrence_no, figure_label,
                       caption, alt_text, source_url) -> ImageRecord:
        for rec in self.figures.values():
            if rec.document_id == document_id and rec.occurrence_no == occurrence_no:
                if rec.source_url == source_url:
                    return rec
                # URL changed -> reset statuses (replaced image)
                rec.source_url = source_url
                rec.figure_label = figure_label
                rec.caption = caption
                rec.alt_text = alt_text
                rec.download_status = ProcessingStatus.PENDING
                rec.upload_status = ProcessingStatus.PENDING
                rec.vlm_status = ProcessingStatus.PENDING
                rec.storage_key = None
                rec.sha256 = None
                rec.vlm_description = None
                rec.vlm_model = None
                rec.download_error = rec.upload_error = rec.vlm_error = None
                return rec
        rec = ImageRecord(
            id=self._next_fig, document_id=document_id, occurrence_no=occurrence_no,
            figure_label=figure_label, caption=caption, alt_text=alt_text,
            source_url=source_url,
        )
        self._next_fig += 1
        self.figures[rec.id] = rec
        return rec

    def get_record(self, record_id: int):
        return self.figures.get(record_id)

    def can_reuse(self, record: ImageRecord) -> bool:
        return (
            record.upload_status == ProcessingStatus.SUCCESS
            and record.vlm_status == ProcessingStatus.SUCCESS
            and record.storage_key is not None
            and record.vlm_description is not None
            and record.vlm_description != ""
        )

    def reset_stale_processing(self, record_id: int) -> None:
        rec = self.figures.get(record_id)
        if not rec:
            return
        for field in ("download_status", "upload_status", "vlm_status"):
            if getattr(rec, field) == ProcessingStatus.PROCESSING:
                setattr(rec, field, ProcessingStatus.PENDING)

    def _mark(self, record_id, field, value):
        if record_id in self.figures:
            setattr(self.figures[record_id], field, value)

    def mark_download_processing(self, rid): self._mark(rid, "download_status", ProcessingStatus.PROCESSING)
    def mark_download_success(self, rid, metadata: ImageMetadata):
        rec = self.figures[rid]
        rec.download_status = ProcessingStatus.SUCCESS
        rec.sha256 = metadata.sha256
        rec.mime_type = metadata.mime_type
        rec.file_extension = metadata.file_extension
        rec.file_size = metadata.file_size
        rec.width = metadata.width
        rec.height = metadata.height
        rec.download_error = None
    def mark_download_failed(self, rid, error): self._mark(rid, "download_status", ProcessingStatus.FAILED)
    def mark_upload_processing(self, rid): self._mark(rid, "upload_status", ProcessingStatus.PROCESSING)
    def mark_upload_success(self, rid, storage_key):
        rec = self.figures[rid]
        rec.upload_status = ProcessingStatus.SUCCESS
        rec.storage_key = storage_key
        rec.upload_error = None
    def mark_upload_failed(self, rid, error): self._mark(rid, "upload_status", ProcessingStatus.FAILED)
    def mark_vlm_processing(self, rid): self._mark(rid, "vlm_status", ProcessingStatus.PROCESSING)
    def mark_vlm_success(self, rid, model, description):
        rec = self.figures[rid]
        rec.vlm_status = ProcessingStatus.SUCCESS
        rec.vlm_model = model
        rec.vlm_description = description
        rec.vlm_error = None
    def mark_vlm_failed(self, rid, error): self._mark(rid, "vlm_status", ProcessingStatus.FAILED)
    def mark_current_step_failed(self, rid, error):
        rec = self.figures[rid]
        if rec.download_status == ProcessingStatus.PROCESSING:
            self.mark_download_failed(rid, error)
        elif rec.upload_status == ProcessingStatus.PROCESSING:
            self.mark_upload_failed(rid, error)
        elif rec.vlm_status == ProcessingStatus.PROCESSING:
            self.mark_vlm_failed(rid, error)


# ── Fake external services ─────────────────────────────────────────────────


class FakeServices:
    """Call-recording fakes for download/upload/VLM/file-server/LLM."""

    def __init__(self, tmp_path: Path, db=None) -> None:
        self.tmp = tmp_path
        self.db = db
        self.download_calls: list[str] = []
        self.upload_calls: list[str] = []
        self.vlm_calls: list[str] = []
        self.file_upload_calls: list[str] = []
        self.classify_calls: list[str] = []
        self.enrich_calls: list[str] = []

    # image download
    def download_image(self, url: str) -> Path:
        self.download_calls.append(url)
        fname = f"dl_{abs(hash(url)) % 1000000}.png"
        path = self.tmp / "dl" / fname
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(hashlib.sha256(url.encode()).digest() * 8)
        return path

    def inspect_image(self, local_path: Path) -> ImageMetadata:
        data = local_path.read_bytes()
        return ImageMetadata(
            sha256="sha256:" + hashlib.sha256(data).hexdigest(),
            mime_type="image/png", file_extension=".png",
            file_size=len(data), width=10, height=10,
        )

    def upload_image(self, local_path: Path, directory: str, filename=None) -> UploadResult:
        name = filename or local_path.name
        key = f"{directory}/{name}"
        self.upload_calls.append(key)
        return UploadResult(storage_key=key, url=f"http://img/{key}",
                            sha256="", mime_type="image/png", file_size=0)

    def describe_image(self, local_path: Path, api_key=None) -> str:
        self.vlm_calls.append(str(local_path))
        return f"VLM 描述 {abs(hash(str(local_path))) % 100000}"

    def build_public_url(self, storage_key: str) -> str:
        return f"http://img/{storage_key.lstrip('/')}"

    # file server
    def upload_file(self, local_path: Path, directory: str, filename=None):
        name = filename or local_path.name
        key = f"{directory}/{name}"
        self.file_upload_calls.append(key)
        return type("R", (), {"storage_key": key, "url": f"http://file/{key}"})()

    # LLM classifier
    def get_domain_db_id(self, domain_code: str):
        return 1

    def classify_missing_for_document(self, document_db_id, domain_id, **kw):
        work = self.db.get_chunks_without_category(document_db_id)
        for w in work:
            self.classify_calls.append(w["chunk_id"])
            self.save_chunk_categories(w["db_id"], [1], 0.9)
        return [{"chunk_id": w["chunk_id"]} for w in work]

    def save_chunk_categories(self, chunk_db_id, category_ids, confidence, source="llm"):
        self.db.chunk_categories.append({
            "chunk_id": chunk_db_id, "category_id": category_ids[0],
            "confidence": confidence,
        })

    # ── T3.1 chunk_enricher (one LLM call: classification + defines/uses/
    # context_prefix/questions/near_duplicate_hint/asset_summary) ──

    def enrich_missing_for_document(self, document_db_id, domain_id, **kw):
        work = self.db.get_chunks_needing_enrichment(document_db_id)
        results = []
        for w in work:
            self.classify_calls.append(w["chunk_id"])  # shared LLM-call counter
            self.enrich_calls.append(w["chunk_id"])
            data = {
                "category_ids": [1],
                "confidence": 0.9,
                "defines": [],
                "uses": [],
                "context_prefix": f"上下文：{w['chunk_id']}",
                "questions": [f"{w['chunk_id']} 能回答什么问题？"],
                "near_duplicate_hint": False,
                "asset_summary": "",
            }
            self.save_chunk_categories(w["db_id"], data["category_ids"], data["confidence"])
            self.db.save_enrichment(w["db_id"], w.get("content_hash"), data)
            results.append({"chunk_id": w["chunk_id"]})
        return results

    def count_chunks_needing_enrichment(self, document_db_id, **kw):
        return self.db.count_chunks_needing_enrichment(document_db_id)

    def dedup_document_chunks(self, document_db_id, **kw):
        return self.db.dedup_document_chunks(document_db_id)

    def get_enrichment_for_chunks(self, chunk_db_ids, **kw):
        return self.db.get_enrichment_for_chunks(chunk_db_ids)

    def get_confidence_by_chunk_code(self, document_db_id, **kw):
        return self.db.get_confidence_by_chunk_code(document_db_id)


# ── Fake RAGFlow ───────────────────────────────────────────────────────────


class FakeRAGFlow:
    """In-memory RAGFlow with the same API surface the pipeline uses.

    Mirrors real RAGFlow behavior:
    - uploading with an existing name auto-renames to ``name(1).md``
    - parsing splits on the ITN chunk delimiter
    """

    def __init__(self) -> None:
        self.datasets: dict[str, dict] = {}
        self.upload_calls = 0
        self.update_calls = 0
        self.delete_calls = 0
        self.parse_calls = 0
        self._ds_seq = 0
        self._doc_seq = 0

    def find_dataset_by_name(self, name: str):
        for ds in self.datasets.values():
            if ds["name"] == name:
                return {"id": ds["id"], "name": name}
        return None

    def create_dataset(self, name, **kw):
        self._ds_seq += 1
        ds = {
            "id": f"ds{self._ds_seq}", "name": name, "docs": {},
            "parser_config": kw.get("parser_config") or {"delimiter": "\n"},
        }
        self.datasets[ds["id"]] = ds
        return ds

    def get_dataset(self, dataset_id):
        ds = self.datasets.get(dataset_id)
        return dict(ds) if ds else {}

    def update_dataset(self, dataset_id, name=None, description=None, parser_config=None):
        ds = self.datasets[dataset_id]
        if name is not None:
            ds["name"] = name
        if parser_config is not None:
            ds["parser_config"] = parser_config
        return dict(ds)

    def list_datasets(self):
        return [{"id": d["id"], "name": d["name"]} for d in self.datasets.values()]

    def list_documents(self, dataset_id, page=1, page_size=30):
        return [dict(d) for d in self.datasets[dataset_id]["docs"].values()]

    def upload_document(self, dataset_id, file_path, name=None, parser_config=None):
        """Mimic real RAGFlow: per-document parser_config overrides are IGNORED;
        the document inherits the dataset-level parser_config."""
        self.upload_calls += 1
        ds = self.datasets[dataset_id]
        base = name or file_path.name
        # mimic RAGFlow: duplicate names get a (N) suffix
        existing = {d["name"] for d in ds["docs"].values()}
        fname, n = base, 1
        stem, ext = (base.rsplit(".", 1) + [""])[:2]
        while fname in existing:
            fname = f"{stem}({n}).{ext}" if ext else f"{stem}({n})"
            n += 1
        self._doc_seq += 1
        doc = {
            "id": f"rfdoc{self._doc_seq}", "name": fname,
            "content": file_path.read_text(encoding="utf-8"),
            "parsed": False, "chunks": [],
            "parser_config": dict(ds.get("parser_config") or {"delimiter": "\n"}),
        }
        ds["docs"][doc["id"]] = doc
        return {"id": doc["id"]}

    def parse_documents(self, dataset_id, document_ids):
        self.parse_calls += 1
        ds = self.datasets[dataset_id]
        for did in document_ids:
            doc = ds["docs"].get(did)
            if not doc:
                continue
            parts = [p.strip("\n") for p in doc["content"].split("<<<ITN_CHUNK_BOUNDARY>>>")]
            doc["chunks"] = [
                {"id": f"{did}c{i}", "content": p, "create_time": i}
                for i, p in enumerate(parts) if p
            ]
            doc["parsed"] = True

    def delete_documents(self, dataset_id, document_ids):
        self.delete_calls += 1
        ds = self.datasets[dataset_id]
        for did in document_ids:
            ds["docs"].pop(did, None)

    def list_chunks(self, dataset_id, document_id, page=1, page_size=100):
        doc = self.datasets[dataset_id]["docs"].get(document_id)
        if not doc:
            return []
        chunks = [dict(c) for c in doc["chunks"]]
        return chunks[(page - 1) * page_size : page * page_size]

    def update_chunk(self, dataset_id, document_id, chunk_id, content=None, available=None):
        self.update_calls += 1
        doc = self.datasets[dataset_id]["docs"][document_id]
        for c in doc["chunks"]:
            if c["id"] == chunk_id:
                if content is not None:
                    c["content"] = content
                if available is not None:
                    c["available"] = available

    def add_chunk(self, dataset_id, document_id, content, **kw):
        doc = self.datasets[dataset_id]["docs"][document_id]
        cid = f"{document_id}c{len(doc['chunks']) + 1}"
        doc["chunks"].append({"id": cid, "content": content, "create_time": len(doc["chunks"])})
        return {"id": cid}


# ── Shared fixture wiring ──────────────────────────────────────────────────


@pytest.fixture()
def fake_env(tmp_path, monkeypatch):
    """Wire all fakes into the pipeline modules. Returns a bundle object."""
    fake_db = FakeDB()
    fakes = FakeServices(tmp_path, db=fake_db)
    ragflow = FakeRAGFlow()

    # document repository
    for name in ("get_or_create_document", "get_document_fields",
                 "update_document_fields", "mark_document_failed"):
        monkeypatch.setattr(f"predeal.document_repository.{name}",
                            getattr(fake_db, name))
    # chunk repository
    for name in ("sync_chunks", "count_active_chunks", "get_active_chunks",
                 "update_chunk_ragflow_id", "get_ragflow_chunk_ids",
                 "missing_ragflow_ids"):
        monkeypatch.setattr(f"predeal.chunk_repository.{name}",
                            getattr(fake_db, name))
    # images repository
    for name in ("upsert_pending", "get_record", "can_reuse",
                 "reset_stale_processing", "mark_download_processing",
                 "mark_download_success", "mark_download_failed",
                 "mark_upload_processing", "mark_upload_success", "mark_upload_failed",
                 "mark_vlm_processing", "mark_vlm_success", "mark_vlm_failed",
                 "mark_current_step_failed"):
        monkeypatch.setattr(f"predeal.images.repository.{name}",
                            getattr(fake_db, name))
    # figure binder
    def load_figures_for_document(document_db_id):
        rows = [r for r in fake_db.figures.values()
                if r.document_id == document_db_id]
        rows.sort(key=lambda r: r.occurrence_no)
        return [{"id": r.id, "occurrence_no": r.occurrence_no, "caption": r.caption,
                 "alt_text": r.alt_text, "vlm_description": r.vlm_description,
                 "source_url": r.source_url, "bound_chunk_ids": None,
                 "bound_context_hash": None} for r in rows]

    monkeypatch.setattr("predeal.figure_chunk_binder.load_figures_for_document",
                        load_figures_for_document)
    monkeypatch.setattr("predeal.pipeline2.binder.load_figures_for_document",
                        load_figures_for_document)

    # classifier
    monkeypatch.setattr("predeal.category_classifier.get_domain_db_id",
                        fakes.get_domain_db_id)
    monkeypatch.setattr("predeal.category_classifier.classify_missing_for_document",
                        fakes.classify_missing_for_document)
    monkeypatch.setattr("predeal.category_classifier.count_chunks_without_category",
                        fake_db.count_chunks_without_category)
    monkeypatch.setattr("predeal.pipeline2.classifier.get_domain_db_id",
                        fakes.get_domain_db_id)
    monkeypatch.setattr("predeal.pipeline2.classifier.classify_missing_for_document",
                        fakes.classify_missing_for_document)
    monkeypatch.setattr("predeal.pipeline2.classifier.count_chunks_without_category",
                        fake_db.count_chunks_without_category)

    # chunk_enricher (T3.1) — same module object regardless of import path
    # (predeal.pipeline2.enricher / predeal.steps.ragflow_packager2.chunk_enricher
    # both reference predeal.steps.chunk_enricher), so patching once is enough.
    monkeypatch.setattr("predeal.steps.chunk_enricher.enrich_missing_for_document",
                        fakes.enrich_missing_for_document)
    monkeypatch.setattr("predeal.steps.chunk_enricher.count_chunks_needing_enrichment",
                        fakes.count_chunks_needing_enrichment)
    monkeypatch.setattr("predeal.steps.chunk_enricher.dedup_document_chunks",
                        fakes.dedup_document_chunks)
    monkeypatch.setattr("predeal.steps.chunk_enricher.get_enrichment_for_chunks",
                        fakes.get_enrichment_for_chunks)
    monkeypatch.setattr("predeal.steps.chunk_enricher.get_confidence_by_chunk_code",
                        fakes.get_confidence_by_chunk_code)

    # figure binder — deterministic fake (keep every image in its current chunk)
    def fake_review_slice(ctxs, chunk_dicts, unit_listing, *a, **kw):
        from predeal.figure_chunk_binder import ReviewResult
        return ReviewResult(
            figure_targets={
                ctx.figure_db_id: [ctx.current_chunk_idx]
                for ctx in ctxs if ctx.current_chunk_idx is not None
            },
            split_after=[],
            reasoning="fake-deterministic",
        )

    monkeypatch.setattr("predeal.figure_chunk_binder.review_slice", fake_review_slice)
    monkeypatch.setattr("predeal.figure_chunk_binder.bind_figure",
                        lambda ctx, chunk_dicts, *a, **kw: None)
    monkeypatch.setattr("predeal.figure_chunk_binder.save_figure_binding",
                        lambda fid, idx, h: None)

    # image pipeline external calls
    monkeypatch.setattr("predeal.images.pipeline.download_image", fakes.download_image)
    monkeypatch.setattr("predeal.images.pipeline.inspect_image", fakes.inspect_image)
    monkeypatch.setattr("predeal.images.pipeline.upload_image", fakes.upload_image)
    monkeypatch.setattr("predeal.images.pipeline.describe_image", fakes.describe_image)
    monkeypatch.setattr("predeal.images.pipeline.build_public_url", fakes.build_public_url)

    # file server
    monkeypatch.setattr("predeal.pipeline2.upload_file", fakes.upload_file)

    # RAGFlow client (factory so `RAGFlowClient(config)` works)
    monkeypatch.setattr("predeal.steps.ragflow_packager2.RAGFlowClient",
                        lambda cfg: ragflow)
    monkeypatch.setattr("predeal.ragflow_client.RAGFlowClient",
                        lambda cfg: ragflow)

    # chunk_repository helper used by ragflow packager
    monkeypatch.setattr("predeal.steps.ragflow_packager2.chunk_repo.get_active_chunks",
                        fake_db.get_active_chunks)
    monkeypatch.setattr("predeal.steps.ragflow_packager2.chunk_repo.update_chunk_ragflow_id",
                        fake_db.update_chunk_ragflow_id)
    monkeypatch.setattr("predeal.steps.ragflow_packager2.chunk_repo.get_ragflow_chunk_ids",
                        fake_db.get_ragflow_chunk_ids)
    monkeypatch.setattr("predeal.steps.ragflow_packager2.doc_repo.get_document_fields",
                        fake_db.get_document_fields)
    monkeypatch.setattr("predeal.steps.ragflow_packager2.doc_repo.update_document_fields",
                        fake_db.update_document_fields)

    class Bundle:
        pass

    b = Bundle()
    b.db = fake_db
    b.services = fakes
    b.ragflow = ragflow
    b.tmp = tmp_path
    return b


# ── Domain + document fixtures ─────────────────────────────────────────────


SAMPLE_MD = """# 第六章 测试框架

## 6.1 概述

智能体框架是构建复杂智能体的基础设施。本节介绍框架开发实践的基本概念，
包括框架的选型、核心机制与生态体系。框架开发实践需要综合运用多种技术，
从手动实现到框架开发是一个自然的演进过程。本节内容为后续章节打下基础，
帮助读者建立对智能体框架的整体认知。这里补充一段内容让本小节足够长，
确保能够形成独立的切片并验证增量更新的行为。继续补充描述文字若干。

## 6.2 核心机制

<div align="center">
  <img src="http://img.example/6-1.png" alt="图 6.1 框架结构" width="80%" />
</div>

框架的核心机制包括自动规划、工具调用与多智能体协作。AutoGen 提供了
对话驱动的编排机制，LangGraph 则强调状态图与条件分支。两种范式各有
适用场景，需要根据任务类型选择。框架还提供了内存管理、缓存与可观测性
能力，帮助开发者构建可靠的智能体应用。此处继续展开说明机制细节，
包括会话管理、任务队列与错误恢复等工程实践内容。

## 6.3 实践对比

<div align="center">
  <img src="http://img.example/6-2.png" alt="图 6.2 对比示意" width="80%" />
</div>

实际项目中选择框架需要考虑团队熟悉度、生态成熟度与部署成本。本章
通过一个完整的案例演示框架开发实践的全流程，从需求分析到最终交付。
案例覆盖了提示词设计、工具注册与异常处理等关键环节。通过对比不同
框架的差异，读者可以形成自己的选型方法论。这里继续补充实践对比的
详细说明文字，保证切片内容充足且具有代表性。

## 6.4 小结

本章总结了框架开发实践中的关键经验，包括设计原则、常见陷阱与最佳
实践。核心结论是：框架只是工具，重要的是理解任务本质并选择合适
的抽象层次。后续章节将继续深入探讨更多高级主题。
"""


@pytest.fixture()
def domain(tmp_path):
    """Create an isolated domain config + source document, return paths."""
    domains_dir = tmp_path / "domains"
    docs_dir = tmp_path / "docs"
    domains_dir.mkdir(parents=True)
    docs_dir.mkdir(parents=True)
    (docs_dir / "chapter6").mkdir()

    yaml = f"""domain_id: itn_test
domain_code: agent
domain_version_id: v1
pipeline_profile: markdown_tutorial
language: zh-CN

discovery:
  root: {docs_dir}
  include:
    - "chapter6/*.md"
  exclude: []

chunk_policy:
  target_min_chars: 100
  target_max_chars: 500
  hard_max_chars: 800
  preserve_code_block: true
  preserve_table: true
  preserve_figure: true

figure_policy:
  download_remote_images: true
  enable_ocr: false
  enable_vlm_summary: true
  keep_decorative_images: false
  enable_image_pipeline: true
  storage_prefix: ITN/itn_test

metadata_defaults:
  authority_level: official
  document_type: course_markdown
  source_type: web
  source_name: "ITN Test"
  publisher: Datawhale
  publish_year: 2025
  version: v1.0
  reliability_score: 0.90
  applicability_scope:
    course: HelloAgents
"""
    (domains_dir / "itn_test.yaml").write_text(yaml, encoding="utf-8")
    src = docs_dir / "chapter6" / "第六章 测试框架.md"
    src.write_text(SAMPLE_MD, encoding="utf-8")
    return {"domains_dir": domains_dir, "docs_dir": docs_dir, "src": src}


def run_pipeline(domain, tmp_path, fake_env, output="out", ragflow_cfg=True, **opts_kw):
    """Run process_document against the sample doc with all fakes wired."""
    from predeal.config import load_domain_config
    from predeal.pipeline2 import PipelineOptions, process_document
    from predeal.ragflow_client import RAGFlowConfig

    config = load_domain_config("itn_test", domain["domains_dir"])
    out = tmp_path / output
    opts = PipelineOptions(
        ragflow_config=RAGFlowConfig(base_url="http://rf", api_key="k") if ragflow_cfg else None,
        **opts_kw,
    )
    return process_document(domain["src"], config, out, opts), out
