"""File and content hash utilities."""

import hashlib


def file_hash(path: str, algorithm: str = "sha256") -> str:
    """Compute hash of a file."""
    h = hashlib.new(algorithm)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return f"{algorithm}:{h.hexdigest()}"


def content_hash(content: str, algorithm: str = "sha256") -> str:
    """Compute hash of a string."""
    h = hashlib.new(algorithm)
    h.update(content.encode("utf-8"))
    return f"{algorithm}:{h.hexdigest()}"
