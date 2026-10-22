"""Flask web application for the preprocessing pipeline."""

from __future__ import annotations

import base64
import json
import hashlib
import os
import logging
import queue
import re
import shutil
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any, Dict

from flask import Flask, Response, render_template, request

from ..catalog import SUPPORTED_CATALOG_SUFFIXES, build_outline, load_markdown
from ..catalog_llm import refine_outline, refine_points
from ..chunk_repository import get_active_chunks
from ..config import load_domain_config
from ..pipeline2 import PipelineProgress
from ..upload_service import UploadOptions, upload_document_bytes
from . import task_store

logger = logging.getLogger(__name__)

app = Flask(__name__, template_folder=str(Path(__file__).parent / "templates"))

# ── In-memory task store ──
_tasks: Dict[str, Dict[str, Any]] = {}
_queues: Dict[str, queue.Queue] = {}

_STEP_LABELS = {
    "intake": "1. 文件接入",
    "create_document": "2. 文档登记",
    "archive": "3. 原始归档",
    "normalizer": "4. Markdown 规范化",
    "image_pipeline": "5. 图片处理",
    "structure_parser": "6. 结构解析",
    "chunk_compiler": "7. 切片编译",
    "chunk_db_sync": "8. 切片增量同步",
    "category_classify": "9. 知识点分类",
    "ragflow_packager": "10. RAGFlow 打包",
    "preflight": "11. 质量检查",
    "audit": "12. 审计记录",
    "ragflow_upload": "13. RAGFlow 同步",
}


def _make_progress_callback(task_id: str):
    """Create a callback that pushes progress events to the task queue."""
    q = _queues[task_id]

    def callback(progress: PipelineProgress):
        if task_store.is_cancel_requested(task_id):
            raise RuntimeError("TASK_CANCELLED")
        event = {
            "step_name": progress.step_name,
            "step_num": progress.step_num,
            "status": progress.status,
            "message": progress.message,
            "label": _STEP_LABELS.get(progress.step_name, progress.step_name),
        }
        q.put(event)
        task_store.progress(task_id, progress.step_name, progress.step_num, progress.status, progress.message)

    return callback


@app.route("/")
def index():
    """Serve the main page."""
    return render_template("index.html")


def _run_upload(task_id: str, filename: str, content: bytes, opts: UploadOptions):
    """Run the upload pipeline in a background thread."""
    try:
        _tasks[task_id]["status"] = "running"
        result = upload_document_bytes(filename, content, opts,
                                       progress_callback=_make_progress_callback(task_id))
        _tasks[task_id]["result"] = result.to_dict()
        _tasks[task_id]["status"] = "done"
        task_store.finish(task_id, result.to_dict())
        _queues[task_id].put(None)  # sentinel: done
    except Exception as e:
        cancelled = str(e) == "TASK_CANCELLED"
        _tasks[task_id]["status"] = "cancelled" if cancelled else "error"
        _tasks[task_id]["result"] = {"status": "cancelled" if cancelled else "failed", "errors": [str(e)]}
        if cancelled: task_store.finish(task_id, _tasks[task_id]["result"])
        else: task_store.fail(task_id, e)
        _queues[task_id].put(None)


@app.route("/api/v1/uploads", methods=["POST"])
def api_upload():
    """Upload a document into the knowledge base (new pipeline).

    Multipart form:
      file                    required, .md/.markdown/.docx/.pptx
      domain                  required, domain id (e.g. hello_agents)
      title / document_type / source_type / source_name / publisher /
      publish_year / version / reliability_score / language / storage_prefix
      enable_ragflow (default 1) / dataset_name / enable_vlm (default 1)

    Returns task_id; poll GET /api/task/<task_id> or stream
    GET /api/progress/<task_id> (SSE).
    """
    file = request.files.get("file")
    if not file or not file.filename:
        return {"error": "No file uploaded"}, 400
    suffix = Path(file.filename).suffix.lower()
    if suffix not in (".md", ".markdown", ".docx", ".pptx"):
        return {"error": f"Unsupported file type '{suffix}'; only .md/.markdown/.docx/.pptx"}, 400

    domain = (request.form.get("domain") or "").strip()
    if not domain:
        return {"error": "Field 'domain' is required"}, 400

    def _bool(name: str, default: bool) -> bool:
        v = request.form.get(name)
        if v is None or v == "":
            return default
        return v.strip().lower() not in ("0", "false", "no", "off")

    try:
        publish_year = int(request.form.get("publish_year", 0) or 0) or None
        reliability = float(request.form.get("reliability_score", 0) or 0) or None
    except ValueError:
        return {"error": "publish_year / reliability_score must be numeric"}, 400

    # 管理员「文档入库」按知识领域命名 RAGFlow 数据集：{领域名称}_v1
    domain_code = (request.form.get("domain_code") or "").strip()
    domain_name = (request.form.get("domain_name") or "").strip()
    dataset_name = (request.form.get("dataset_name") or "").strip() or None
    if not dataset_name and (domain_name or domain_code):
        dataset_name = f"{domain_name or domain_code}_v1"

    opts = UploadOptions(
        domain_id=domain,
        title=(request.form.get("title") or "").strip() or None,
        document_type=(request.form.get("document_type") or "").strip() or None,
        source_type=(request.form.get("source_type") or "upload").strip(),
        source_name=(request.form.get("source_name") or "").strip() or None,
        publisher=(request.form.get("publisher") or "").strip() or None,
        publish_year=publish_year,
        version=(request.form.get("version") or "").strip() or None,
        reliability_score=reliability,
        language=(request.form.get("language") or "zh-CN").strip(),
        storage_prefix=(request.form.get("storage_prefix") or "").strip() or None,
        enable_ragflow=_bool("enable_ragflow", True),
        dataset_name=dataset_name,
        enable_vlm=_bool("enable_vlm", True),
    )

    organization_id, user_id = _platform_context()
    content = file.read()
    content_sha256 = hashlib.sha256(content).hexdigest()
    task_id = uuid.uuid4().hex[:8]
    _queues[task_id] = queue.Queue()
    _tasks[task_id] = {
        "id": task_id,
        "file_name": file.filename,
        "domain": domain,
        "status": "queued",
        "result": None,
        "params": {
            "domain": domain,
            "title": opts.title,
            "document_type": opts.document_type,
            "source_type": opts.source_type,
            "enable_ragflow": opts.enable_ragflow,
            "enable_vlm": opts.enable_vlm,
            "source_name": opts.source_name,
            "publisher": opts.publisher,
            "publish_year": opts.publish_year,
            "version": opts.version,
            "reliability_score": opts.reliability_score,
            "language": opts.language,
            "storage_prefix": opts.storage_prefix,
            "dataset_name": opts.dataset_name,
        },
    }
    persisted_id, reused = task_store.create_task(_tasks[task_id], organization_id, user_id, content_sha256)
    if reused:
        _tasks.pop(task_id, None); _queues.pop(task_id, None)
        existing = task_store.get_task(persisted_id, organization_id)
        if existing and existing["status"] in {"failed", "partial", "cancelled"}:
            # Re-uploading the same file after a failure should re-run the pipeline.
            _input_path(persisted_id).write_bytes(content)
            task_store.requeue(persisted_id)
            _queues[persisted_id] = queue.Queue()
            _tasks[persisted_id] = existing
            thread = threading.Thread(
                target=_run_upload,
                args=(persisted_id, file.filename, content, opts),
                daemon=True,
            )
            thread.start()
            return {"task_id": persisted_id, "status": "queued", "reused": True, "retried": True}
        return {"task_id": persisted_id, "status": "reused", "reused": True}
    _input_path(task_id).write_bytes(content)
    thread = threading.Thread(
        target=_run_upload,
        args=(task_id, file.filename, content, opts),
        daemon=True,
    )
    thread.start()

    return {"task_id": task_id, "status": "queued"}


@app.route("/api/v1/catalog/outline", methods=["POST"])
def catalog_outline():
    """从文档抽取知识目录建议（章 / 知识点），不写库。

    JSON body:
      fileName    required, .md/.markdown/.docx/.pptx
      dataBase64  required, 文件内容 base64

    返回 {title, chapters:[{name, description, points:[{name, description}]}]}，
    由调用方（平台管理员端）确认后再落库 knowledge_category。
    """
    payload = request.get_json(silent=True) or {}
    file_name = str(payload.get("fileName") or "").strip()
    data_b64 = str(payload.get("dataBase64") or "").strip()
    if not file_name or not data_b64:
        return {"error": "fileName / dataBase64 均不能为空"}, 400

    suffix = Path(file_name).suffix.lower()
    if suffix not in SUPPORTED_CATALOG_SUFFIXES:
        return {"error": f"暂不支持 '{suffix or '未知'}' 格式；支持 .md/.markdown/.docx/.pptx"}, 400

    try:
        content = base64.b64decode(data_b64, validate=True)
    except Exception:
        return {"error": "dataBase64 不是有效的 base64"}, 400
    if not content:
        return {"error": "文件内容为空"}, 400
    if len(content) > 24 * 1024 * 1024:
        return {"error": "文件超过 24MB，无法解析"}, 400

    tmp_dir = Path(tempfile.mkdtemp(prefix="predeal_catalog_"))
    try:
        src = tmp_dir / f"source{suffix}"
        src.write_bytes(content)
        markdown = load_markdown(src)
    except Exception as e:
        return {"error": f"文档解析失败：{e}"}, 422
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

    if not markdown.strip():
        return {"error": "未从文档中抽取到文本，请确认不是扫描件/图片"}, 422

    fallback_title = Path(file_name).stem
    scope = str(payload.get("scope") or "").strip().lower()
    outline = build_outline(markdown, fallback_title)
    # 规则骨架先兜底，再用大模型归并；失败不影响解析
    if scope == "points":
        refined = refine_points(markdown, outline.get("title") or fallback_title)
    else:
        refined = refine_outline(markdown, outline.get("title") or fallback_title)
    if refined:
        outline = refined
    outline["fileName"] = file_name
    return outline


_UUID_TITLE_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f-]{27,}[_-]?", re.IGNORECASE)
_HEX_TITLE_RE = re.compile(r"^[0-9a-f]{24,}[_-]?", re.IGNORECASE)


def _document_title(file_name: str, content: bytes, suffix: str) -> str:
    """取 Markdown 一级标题作为文档名；没有标题时清掉上传附件的 UUID 前缀。"""
    if suffix in {".md", ".markdown"}:
        text = content.decode("utf-8-sig", errors="ignore")
        match = re.search(r"^#\s+(.+?)\s*$", text, re.MULTILINE)
        if match:
            return match.group(1).strip()[:120]
    stem = Path(file_name).stem
    cleaned = _UUID_TITLE_RE.sub("", stem)
    cleaned = _HEX_TITLE_RE.sub("", cleaned)
    cleaned = re.sub(r"[_-]?attachment$", "", cleaned, flags=re.IGNORECASE).strip()
    return (cleaned or stem or "上传文档")[:120]


@app.route("/api/v1/catalog/ingest", methods=["POST"])
def catalog_ingest():
    """管理员「新建资源」：把文档规范化为 Markdown 并切片入库，同步返回切片清单。

    JSON body:
      fileName    required, .md/.markdown/.docx/.pptx
      dataBase64  required, 文件内容 base64

    不做 LLM 分类（切片由平台按标题路径绑定到刚建好的知识目录节点），
    因此返回的 titlePath 是调用方建立 knowledge_chunk_category 的依据。
    """
    payload = request.get_json(silent=True) or {}
    file_name = str(payload.get("fileName") or "").strip()
    data_b64 = str(payload.get("dataBase64") or "").strip()
    if not file_name or not data_b64:
        return {"error": "fileName / dataBase64 均不能为空"}, 400

    suffix = Path(file_name).suffix.lower()
    if suffix not in SUPPORTED_CATALOG_SUFFIXES:
        return {"error": f"暂不支持 '{suffix or '未知'}' 格式；支持 .md/.markdown/.docx/.pptx"}, 400

    try:
        content = base64.b64decode(data_b64, validate=True)
    except Exception:
        return {"error": "dataBase64 不是有效的 base64"}, 400
    if not content:
        return {"error": "文件内容为空"}, 400
    if len(content) > 24 * 1024 * 1024:
        return {"error": "文件超过 24MB，无法入库"}, 400

    doc_title = _document_title(file_name, content, suffix)
    # 管理员新建资源也同步到 RAGFlow：按领域复用/创建数据集 {领域名称}_v1，
    # 知识质量页的「RAG 兜底」才能检索到这些资料；未传领域信息时保持旧行为。
    domain_code = str(payload.get("domainCode") or "").strip()
    domain_name = str(payload.get("domainName") or "").strip()
    dataset_name = f"{domain_name or domain_code}_v1" if (domain_name or domain_code) else None
    opts = UploadOptions(
        domain_id="custom_ingest",
        title=doc_title,
        enable_ragflow=bool(dataset_name),
        dataset_name=dataset_name,
        enable_vlm=False,
        enable_image_pipeline=False,
        enable_classify=False,
        force=bool(payload.get("force")),
    )
    try:
        result = upload_document_bytes(file_name, content, opts)
    except Exception as e:
        logger.exception("catalog ingest failed")
        return {"error": f"文档入库失败：{e}"}, 500

    # RAGFlow 同步失败不应阻断入库：切片已落库，RAGFlow 恢复后重传即可。
    ragflow_failed = bool(
        result.ragflow_result and result.ragflow_result.get("status") == "failed"
    )
    if not result.db_document_id or (result.status == "failed" and not ragflow_failed):
        detail = "；".join(result.errors) if result.errors else "未知错误"
        return {"error": f"文档入库失败：{detail}"}, 422

    chunks = get_active_chunks(result.db_document_id)
    return {
        "documentId": result.db_document_id,
        "documentKey": result.document_key,
        "title": doc_title,
        "ragflowWarning": (result.ragflow_result or {}).get("error") if ragflow_failed else None,
        "status": result.status,
        "chunkCount": len(chunks),
        "chunks": [
            {
                "id": row["id"],
                "index": row["chunk_index"],
                "sectionTitle": row.get("section_title") or "",
                "titlePath": row.get("title_path") or "",
            }
            for row in chunks
        ],
    }


@app.route("/api/domains")
def list_domains():
    """List available domain configs."""
    domains_dir = Path(__file__).parent.parent.parent.parent / "domains"
    if not domains_dir.exists():
        return {"domains": []}
    domains = []
    for f in sorted(domains_dir.glob("*.yaml")):
        try:
            cfg = load_domain_config(f.stem, domains_dir)
            domains.append({
                "id": cfg.domain_id,
                # 知识领域编码：决定 RAGFlow 数据集名 {code}_v1
                "code": cfg.domain_code or cfg.domain_id,
                "profile": cfg.pipeline_profile,
                "language": cfg.language,
            })
        except Exception:
            pass
    return {"domains": domains}


@app.route("/api/run", methods=["POST"])
def run_pipeline():
    """[REMOVED] v1 pipeline retired (T5.3 唯一事实源收敛).

    This endpoint used to drive ``predeal.pipeline`` (v1), now archived
    read-only under ``predeal/legacy/pipeline.py``. Use
    ``POST /api/v1/uploads`` instead (backed by ``predeal.pipeline2`` /
    ``predeal.upload_service``).
    """
    return {
        "error": (
            "/api/run has been retired — the v1 pipeline it depended on was "
            "archived under predeal/legacy/pipeline.py. Use POST /api/v1/uploads instead."
        )
    }, 410


@app.route("/api/progress/<task_id>")
def progress_stream(task_id: str):
    """SSE endpoint for real-time progress."""
    organization_id, _ = _platform_context()
    if task_store.get_task(task_id, organization_id) is None:
        return {"error": "Task not found"}, 404
    if task_id not in _queues:
        events = task_store.list_events(task_id, organization_id) or []
        def replay():
            for event in events:
                details = event.get("details") or {}
                payload = {
                    "type": "progress",
                    "step_name": event.get("stage"),
                    "step_num": details.get("step_num"),
                    "status": details.get("status"),
                    "message": event.get("message"),
                    "level": event.get("level"),
                    "sequence_no": event.get("sequence_no"),
                }
                yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'result': task_store.get_task(task_id, organization_id)}, ensure_ascii=False)}\n\n"
        return Response(replay(), mimetype="text/event-stream")

    q = _queues[task_id]

    def generate():
        while True:
            try:
                event = q.get(timeout=30)
            except queue.Empty:
                # Send keepalive
                yield ":\n\n"
                continue
            if event is None:
                # Task done — send final result
                task = _tasks.get(task_id, {})
                result = task.get("result", {})
                yield f"data: {json.dumps({'type': 'done', 'result': result})}\n\n"
                break
            yield f"data: {json.dumps({'type': 'progress', **event})}\n\n"

    return Response(generate(), mimetype="text/event-stream")


@app.route("/api/task/<task_id>")
def get_task(task_id: str):
    """Get task status and result."""
    organization_id, _ = _platform_context()
    task = task_store.get_task(task_id, organization_id)
    return task if task is not None else ({"error": "Task not found"}, 404)


@app.route("/api/v1/uploads", methods=["GET"])
def list_uploads():
    organization_id, _ = _platform_context()
    return task_store.list_tasks(organization_id, int(request.args.get("page", 0)), int(request.args.get("size", 20)))


@app.route("/api/v1/uploads/<task_id>", methods=["GET"])
def upload_detail(task_id: str):
    return get_task(task_id)


@app.route("/api/v1/uploads/<task_id>/events", methods=["GET"])
def upload_events(task_id: str):
    organization_id, _ = _platform_context()
    events = task_store.list_events(task_id, organization_id)
    return {"items": events} if events is not None else ({"error": "Task not found"}, 404)


@app.route("/api/v1/uploads/<task_id>/cancel", methods=["POST"])
def cancel_upload(task_id: str):
    organization_id, _ = _platform_context()
    return ({"task_id": task_id, "cancel_requested": True}
            if task_store.cancel(task_id, organization_id) else ({"error": "Task cannot be cancelled"}, 409))


@app.route("/api/v1/uploads/<task_id>/retry", methods=["POST"])
def retry_upload(task_id: str):
    organization_id, _ = _platform_context()
    task = task_store.get_task(task_id, organization_id)
    path = _input_path(task_id)
    if task is None: return {"error": "Task not found"}, 404
    if task["status"] not in {"failed", "partial", "cancelled"}: return {"error": "Task is not retryable"}, 409
    if not path.exists(): return {"error": "Persisted upload source is unavailable"}, 409
    params = task.get("params") or {}
    opts = UploadOptions(domain_id=task["domain"], **{k: v for k, v in params.items() if k != "domain" and k in UploadOptions.__dataclass_fields__})
    _queues[task_id] = queue.Queue(); _tasks[task_id] = task
    thread = threading.Thread(target=_run_upload, args=(task_id, task["file_name"], path.read_bytes(), opts), daemon=True)
    thread.start()
    return {"task_id": task_id, "status": "queued"}


def _platform_context() -> tuple[str, str]:
    organization_id = request.headers.get("X-ITN-Organization-Id", "").strip()
    user_id = request.headers.get("X-ITN-User-Id", "").strip()
    try:
        uuid.UUID(organization_id); uuid.UUID(user_id)
    except ValueError:
        from flask import abort
        abort(401, description="Platform organization context required")
    return organization_id, user_id


def _input_path(task_id: str) -> Path:
    root = Path(os.environ.get("PREDEAL_TASK_INPUT_DIR", "/workspace/src/agents/predeal/output/task-inputs"))
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{task_id}.md"


def main():
    """Run the web server."""
    import argparse

    parser = argparse.ArgumentParser(description="Predeal Pipeline Web UI")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind")
    parser.add_argument("--port", type=int, default=8080, help="Port to bind")
    parser.add_argument("--debug", action="store_true", help="Debug mode")
    args = parser.parse_args()

    logging.basicConfig(level=logging.DEBUG if args.debug else logging.INFO)
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
