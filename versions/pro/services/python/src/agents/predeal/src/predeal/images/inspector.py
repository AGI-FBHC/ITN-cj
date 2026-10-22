"""Image file inspector.

Validates image files and extracts metadata including:
- MIME type
- File dimensions (width, height)
- File size
- SHA-256 hash
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path
from typing import Optional

from .models import ImageMetadata

logger = logging.getLogger(__name__)

# Allowed MIME types
ALLOWED_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

# Extension to MIME type mapping
EXTENSION_TO_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

# MIME type to canonical extension
MIME_TO_EXTENSION = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def inspect_image(file_path: Path) -> ImageMetadata:
    """Inspect an image file and extract metadata.

    Args:
        file_path: Path to the image file

    Returns:
        ImageMetadata with extracted information

    Raises:
        FileNotFoundError: If the file does not exist
        ValueError: If the file is not a valid image
    """
    if not file_path.exists():
        raise FileNotFoundError(f"Image file not found: {file_path}")

    # Check file is not empty
    file_size = file_path.stat().st_size
    if file_size == 0:
        raise ValueError(f"Image file is empty: {file_path}")

    # Calculate SHA-256 hash
    sha256 = _calculate_sha256(file_path)

    # Determine MIME type from extension
    extension = file_path.suffix.lower()
    mime_type = EXTENSION_TO_MIME.get(extension)

    if mime_type is None:
        raise ValueError(
            f"Unsupported image format: {extension}. "
            f"Allowed: {', '.join(ALLOWED_MIME_TYPES.keys())}"
        )

    # Get image dimensions using Pillow
    width, height = _get_image_dimensions(file_path)

    return ImageMetadata(
        sha256=sha256,
        mime_type=mime_type,
        file_extension=extension,
        file_size=file_size,
        width=width,
        height=height,
    )


def _calculate_sha256(file_path: Path) -> str:
    """Calculate SHA-256 hash of a file.

    Args:
        file_path: Path to the file

    Returns:
        Hex-encoded SHA-256 hash
    """
    sha256_hash = hashlib.sha256()
    with file_path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256_hash.update(chunk)
    return sha256_hash.hexdigest()


def _get_image_dimensions(file_path: Path) -> tuple[int, int]:
    """Get image dimensions using Pillow.

    Args:
        file_path: Path to the image file

    Returns:
        Tuple of (width, height)

    Raises:
        ValueError: If the image cannot be opened
    """
    try:
        from PIL import Image

        with Image.open(file_path) as img:
            return img.size
    except ImportError:
        logger.warning(
            "Pillow not installed, cannot get image dimensions. "
            "Install with: pip install Pillow"
        )
        return 0, 0
    except Exception as e:
        raise ValueError(f"Cannot open image file: {e}") from e


def get_mime_type(file_path: Path) -> Optional[str]:
    """Get MIME type from file extension.

    Args:
        file_path: Path to the file

    Returns:
        MIME type string or None if unsupported
    """
    extension = file_path.suffix.lower()
    return EXTENSION_TO_MIME.get(extension)


def get_canonical_extension(mime_type: str) -> str:
    """Get canonical file extension for a MIME type.

    Args:
        mime_type: MIME type string

    Returns:
        File extension with leading dot

    Raises:
        ValueError: If the MIME type is not supported
    """
    ext = MIME_TO_EXTENSION.get(mime_type)
    if ext is None:
        raise ValueError(
            f"Unsupported MIME type: {mime_type}. "
            f"Allowed: {', '.join(MIME_TO_EXTENSION.keys())}"
        )
    return ext
