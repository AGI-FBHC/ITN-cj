"""Image uploader to ITN image server.

Uploads images to the ITN image server using the existing upload API.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Optional

import httpx

from .models import UploadResult

logger = logging.getLogger(__name__)

# Configuration from environment
IMAGE_UPLOAD_URL = os.environ.get("IMAGE_UPLOAD_URL")
IMAGE_UPLOAD_TOKEN = os.environ.get("IMAGE_UPLOAD_TOKEN")
# 未配置外部图片服务时的本地归档目录（由 nginx /archives/ 对外提供访问）
LOCAL_ARCHIVE_ROOT = Path(os.environ.get("LOCAL_ARCHIVE_ROOT", "/opt/itn-stack/archives"))


def upload_image(
    local_path: Path,
    directory: str,
    filename: Optional[str] = None,
    upload_url: Optional[str] = None,
    token: Optional[str] = None,
) -> UploadResult:
    """Upload a local image file to the ITN image server.

    Args:
        local_path: Path to the local image file
        directory: Target directory on the server (e.g., "ITN/hello_agents/chapter4")
        filename: Desired filename on the server (e.g., "4-1.png").
                  If None, uses local_path.name.
        upload_url: Upload API URL (default: from env)
        token: Authentication token (default: from env)

    Returns:
        UploadResult with server response data

    Raises:
        httpx.HTTPError: If the upload fails
        ValueError: If the response is invalid
    """
    if upload_url is None:
        upload_url = IMAGE_UPLOAD_URL

    if token is None:
        token = IMAGE_UPLOAD_TOKEN

    if not local_path.exists():
        raise FileNotFoundError(f"Image file not found: {local_path}")

    server_name = filename or local_path.name

    # 未配置外部图片服务时退化为本地归档，避免因外部依赖缺失导致整条入库链路失败。
    if not upload_url:
        return _store_locally(local_path, directory, server_name)

    logger.info(f"Uploading image: {local_path} -> {directory}/{server_name}")

    # Prepare the file for upload
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

        # Make the upload request
        with httpx.Client(timeout=60.0, proxy=None) as client:
            response = client.post(
                upload_url,
                files=files,
                data=data,
                headers=headers,
            )

    # Handle response
    if response.status_code == 409:
        # File already exists — treat as success, build URL from existing key
        existing_key = f"{directory}/{server_name}"
        logger.info(f"File already exists on server: {existing_key}")
        return UploadResult(
            storage_key=existing_key,
            url=build_public_url(existing_key),
            sha256="",
            mime_type="",
            file_size=local_path.stat().st_size,
        )

    response.raise_for_status()

    # Parse response
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

    # Build storage_key from path
    storage_key = data.get("path", "")

    return UploadResult(
        storage_key=storage_key,
        url=data.get("url", ""),
        sha256="",  # Server doesn't return hash in current API
        mime_type="",  # Server doesn't return mime in current API
        file_size=data.get("size", 0),
    )


def _store_locally(local_path: Path, directory: str, server_name: str) -> UploadResult:
    """本地归档：按 storage_key 目录结构复制图片，供 nginx /archives/ 访问。"""
    storage_key = f"{directory.strip('/')}/{server_name}"
    target = LOCAL_ARCHIVE_ROOT / storage_key
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.resolve() != local_path.resolve():
        shutil.copy2(local_path, target)
    logger.info(f"IMAGE_UPLOAD_URL 未配置，已保存到本地归档: {target}")
    return UploadResult(
        storage_key=storage_key,
        url=build_public_url(storage_key),
        sha256="",
        mime_type="",
        file_size=local_path.stat().st_size,
    )


def build_public_url(storage_key: str, base_url: Optional[str] = None) -> str:
    """Build the public URL for a stored image.

    Args:
        storage_key: Server storage path (e.g., "ITN/hello_agents/chapter4/4-1.png")
        base_url: Base URL for public access (default: from env)

    Returns:
        Full public URL
    """
    if base_url is None:
        base_url = os.environ.get("IMAGE_BASE_URL")

    if not base_url:
        base_url = "/archives"

    return f"{base_url.rstrip('/')}/{storage_key.lstrip('/')}"
