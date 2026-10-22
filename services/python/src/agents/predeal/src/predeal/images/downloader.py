"""Remote image downloader.

Downloads remote images to local temporary files for processing.
Uses httpx for streaming downloads with proper timeout handling.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Default temporary directory for image downloads
DEFAULT_TEMP_DIR = Path(os.environ.get("IMAGE_TEMP_DIR", "/tmp/itn-images"))

# Allowed content types
ALLOWED_CONTENT_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
}

# Content-type to file extension mapping
CONTENT_TYPE_TO_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

# Maximum file size (50MB)
MAX_FILE_SIZE = 50 * 1024 * 1024


def download_image(
    source_url: str,
    temp_dir: Optional[Path] = None,
    timeout: Optional[httpx.Timeout] = None,
) -> Path:
    """Download a remote image to a local temporary file.

    Args:
        source_url: URL of the remote image
        temp_dir: Directory for temporary files (default: /tmp/itn-images)
        timeout: HTTP timeout configuration

    Returns:
        Path to the downloaded temporary file

    Raises:
        httpx.HTTPError: If the download fails
        ValueError: If the content type is not an image or file is too large
    """
    if temp_dir is None:
        temp_dir = DEFAULT_TEMP_DIR

    if timeout is None:
        timeout = httpx.Timeout(
            connect=10.0,
            read=30.0,
            write=30.0,
            pool=10.0,
        )

    # Create temp directory
    temp_dir.mkdir(parents=True, exist_ok=True)

    # Generate a temporary file path (initially .tmp, renamed after content-type detection)
    temp_file = tempfile.NamedTemporaryFile(
        dir=temp_dir,
        suffix=".tmp",
        delete=False,
    )
    temp_path = Path(temp_file.name)
    temp_file.close()
    final_path: Optional[Path] = None

    try:
        logger.info(f"Downloading image: {source_url}")

        with httpx.stream(
            "GET",
            source_url,
            follow_redirects=True,
            timeout=timeout,
            proxy=None,
        ) as response:
            response.raise_for_status()

            # Validate content type
            content_type = response.headers.get("content-type", "")
            if not content_type.startswith("image/"):
                raise ValueError(
                    f"Remote content is not an image: {content_type}"
                )

            # Determine proper extension from content-type
            ext = CONTENT_TYPE_TO_EXT.get(content_type, ".tmp")

            # Check content length if available
            content_length = response.headers.get("content-length")
            if content_length and int(content_length) > MAX_FILE_SIZE:
                raise ValueError(
                    f"Image file too large: {int(content_length)} bytes "
                    f"(max: {MAX_FILE_SIZE})"
                )

            # Write to temp file
            total_size = 0
            with temp_path.open("wb") as f:
                for chunk in response.iter_bytes(chunk_size=8192):
                    total_size += len(chunk)
                    if total_size > MAX_FILE_SIZE:
                        raise ValueError(
                            f"Image file too large: {total_size} bytes "
                            f"(max: {MAX_FILE_SIZE})"
                        )
                    f.write(chunk)

        # Rename temp file to have the correct extension
        if ext != ".tmp":
            final_path = temp_path.with_suffix(ext)
            temp_path.rename(final_path)
        else:
            final_path = temp_path

        logger.info(
            f"Downloaded image: {source_url} -> {final_path} "
            f"({total_size} bytes)"
        )
        return final_path

    except Exception:
        # Clean up temp file on error
        if final_path and final_path.exists():
            final_path.unlink(missing_ok=True)
        else:
            temp_path.unlink(missing_ok=True)
        raise


def cleanup_temp_file(file_path: Path) -> None:
    """Remove a temporary file.

    Args:
        file_path: Path to the temporary file to remove
    """
    try:
        if file_path and file_path.exists():
            file_path.unlink()
            logger.debug(f"Cleaned up temp file: {file_path}")
    except Exception as e:
        logger.warning(f"Failed to clean up temp file {file_path}: {e}")
