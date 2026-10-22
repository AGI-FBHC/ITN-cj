"""Image download and processing utilities."""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path
from urllib.parse import urlparse


def is_remote_url(src: str) -> bool:
    """Check if an image source is a remote URL."""
    return src.startswith(("http://", "https://"))


def resolve_local_path(src: str, document_dir: Path) -> Path | None:
    """Resolve a relative image path against the document directory."""
    if is_remote_url(src):
        return None
    path = Path(src)
    if not path.is_absolute():
        path = document_dir / path
    return path if path.exists() else None


def copy_local_image(src: Path, dest: Path) -> str:
    """Copy a local image to the assets directory and return its hash."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    return _hash_file(dest)


def download_remote_image(url: str, dest: Path, timeout: int = 30) -> tuple[str, bool]:
    """Download a remote image. Returns (hash, success)."""
    import urllib.request

    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        urllib.request.urlretrieve(url, str(dest))
        return _hash_file(dest), True
    except Exception:
        return "", False


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return f"sha256:{h.hexdigest()}"


def guess_extension(src: str) -> str:
    """Guess file extension from URL or path."""
    parsed = urlparse(src)
    path = parsed.path
    if "." in Path(path).name:
        return "." + Path(path).name.rsplit(".", 1)[-1].lower()
    return ".png"
