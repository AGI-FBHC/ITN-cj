"""Image processing module for document figure management.

This module handles:
1. Image path replacement (remote -> ITN image server)
2. VLM image description (GLM-4.6V-Flash)
3. Image metadata management (knowledge_figures table)
"""

# Lazy imports to avoid requiring all dependencies at import time
def __getattr__(name):
    if name == "process_markdown_images":
        from .pipeline import process_markdown_images
        return process_markdown_images
    elif name == "ImageRecord":
        from .models import ImageRecord
        return ImageRecord
    elif name == "ImageMetadata":
        from .models import ImageMetadata
        return ImageMetadata
    elif name == "UploadResult":
        from .models import UploadResult
        return UploadResult
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = [
    "process_markdown_images",
    "ImageRecord",
    "ImageMetadata",
    "UploadResult",
]
