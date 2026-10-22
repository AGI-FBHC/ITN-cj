"""File uploader to ITN asset server.

Uploads document files (raw, normalized, ragflow) to the ITN asset server.
Similar to images/uploader.py but for general files on port 28802.
"""

from __future__ import annotations

import logging
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Configuration from environment
FILE_UPLOAD_URL = os.environ.get("FILE_UPLOAD_URL")
FILE_UPLOAD_TOKEN = os.environ.get("FILE_UPLOAD_TOKEN")
FILE_BASE_URL = os.environ.get("FILE_BASE_URL")
# 未配置外部文件服务时的本地归档目录（由 nginx /archives/ 对外提供访问）
LOCAL_ARCHIVE_ROOT = Path(os.environ.get("LOCAL_ARCHIVE_ROOT", "/opt/itn-stack/archives"))


@dataclass
class FileUploadResult:
    """Result from file upload API."""
    storage_key: str
    url: str


def upload_file(
    local_path: Path,
    directory: str,
    filename: Optional[str] = None,
    upload_url: Optional[str] = None,
    token: Optional[str] = None,
) -> FileUploadResult:
    """Upload a local file to the ITN asset server.

    Args:
        local_path: Path to the local file
        directory: Target directory on the server (e.g., "ITN/hello_agents/chapter4")
        filename: Desired filename on the server. If None, uses local_path.name.
        upload_url: Upload API URL (default: from env)
        token: Authentication token (default: from env)

    Returns:
        FileUploadResult with storage_key and url

    Raises:
        httpx.HTTPError: If the upload fails
        ValueError: If the response is invalid
    """
    if upload_url is None:
        upload_url = FILE_UPLOAD_URL

    if token is None:
        token = FILE_UPLOAD_TOKEN

    if not local_path.exists():
        raise FileNotFoundError(f"File not found: {local_path}")

    server_name = filename or local_path.name

    # 未配置外部文件服务时退化为本地归档，避免因外部依赖缺失导致整条入库链路失败。
    if not upload_url:
        return _store_locally(local_path, directory, server_name)

    logger.info(f"Uploading file: {local_path} -> {directory}/{server_name}")

    with local_path.open("rb") as f:
        files = {
            "file": (server_name, f, "application/octet-stream"),
        }
        data = {
            "directory": directory,
        }
        headers = {
            "Authorization": f"Bearer {token}",
        }

        with httpx.Client(timeout=60.0, proxy=None) as client:
            response = client.post(
                upload_url,
                files=files,
                data=data,
                headers=headers,
            )

    # Handle 409 conflict (file already exists)
    if response.status_code == 409:
        existing_key = f"{directory}/{server_name}"
        logger.info(f"File already exists on server: {existing_key}")
        return FileUploadResult(
            storage_key=existing_key,
            url=build_file_url(existing_key),
        )

    response.raise_for_status()

    result = response.json()

    if result.get("code") != 0:
        raise ValueError(
            f"Upload failed: {result.get('message', 'Unknown error')}"
        )

    data = result.get("data", {})

    if not data.get("success"):
        raise ValueError(
            f"Upload failed: {data.get('error', 'Unknown error')}"
        )

    storage_key = data.get("path", "")

    return FileUploadResult(
        storage_key=storage_key,
        url=data.get("url", build_file_url(storage_key)),
    )


def _store_locally(local_path: Path, directory: str, server_name: str) -> FileUploadResult:
    """本地归档：按 storage_key 目录结构复制文件，供 nginx /archives/ 访问。"""
    storage_key = f"{directory.strip('/')}/{server_name}"
    target = LOCAL_ARCHIVE_ROOT / storage_key
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.resolve() != local_path.resolve():
        shutil.copy2(local_path, target)
    logger.info(f"FILE_UPLOAD_URL 未配置，已保存到本地归档: {target}")
    return FileUploadResult(storage_key=storage_key, url=build_file_url(storage_key))


def build_file_url(storage_key: str, base_url: Optional[str] = None) -> str:
    """Build the public URL for a stored file.

    Args:
        storage_key: Server storage path
        base_url: Base URL for public access (default: from env)

    Returns:
        Full public URL
    """
    if base_url is None:
        base_url = FILE_BASE_URL

    if not base_url:
        base_url = "/archives"

    return f"{base_url.rstrip('/')}/{storage_key.lstrip('/')}"
