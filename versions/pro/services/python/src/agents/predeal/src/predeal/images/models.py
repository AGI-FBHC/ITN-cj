"""Data models for image processing."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional


class ProcessingStatus(str, Enum):
    """Status for download, upload, and VLM processing."""
    PENDING = "pending"
    PROCESSING = "processing"
    SUCCESS = "success"
    FAILED = "failed"


@dataclass
class ImageRef:
    """Reference to an image found in a document.

    Attributes:
        source_url: Original image URL
        alt_text: Alt text from img tag or markdown
        caption: Figure caption text
        figure_label: Figure label (e.g., "图 4.1")
        occurrence_no: Order of appearance in document (1-based)
        is_html: Whether the image was in HTML format
        start_offset: Start position in source text
        end_offset: End position in source text
        width: Width attribute if present
        original_tag: Original HTML/markdown tag for replacement
    """
    source_url: str
    alt_text: str = ""
    caption: Optional[str] = None
    figure_label: Optional[str] = None
    occurrence_no: int = 0
    is_html: bool = True
    start_offset: int = 0
    end_offset: int = 0
    width: Optional[str] = None
    original_tag: str = ""


@dataclass
class ImageMetadata:
    """Metadata extracted from an image file.

    Attributes:
        sha256: SHA-256 hash of the file
        mime_type: MIME type (e.g., image/png)
        file_extension: File extension (e.g., .png)
        file_size: File size in bytes
        width: Image width in pixels
        height: Image height in pixels
    """
    sha256: str
    mime_type: str
    file_extension: str
    file_size: int
    width: int
    height: int


@dataclass
class UploadResult:
    """Result from image upload API.

    Attributes:
        storage_key: Server storage path (e.g., ITN/hello_agents/chapter4/4-1-a1b2c3d4.png)
        url: Public access URL
        sha256: File hash from server
        mime_type: MIME type
        file_size: File size in bytes
    """
    storage_key: str
    url: str
    sha256: str
    mime_type: str
    file_size: int


@dataclass
class ImageRecord:
    """Database record for a figure in knowledge_figures table.

    Attributes:
        id: Database record ID
        document_id: Document ID in business database
        occurrence_no: Order of appearance in document
        figure_label: Figure label (e.g., "图 4.1")
        caption: Figure caption text
        alt_text: Alt text
        source_url: Original image URL
        storage_key: Server storage path
        mime_type: MIME type
        file_extension: File extension
        file_size: File size in bytes
        width: Image width
        height: Image height
        sha256: File hash
        download_status: Download processing status
        upload_status: Upload processing status
        vlm_status: VLM processing status
        vlm_description: VLM generated description
        vlm_model: VLM model used
        download_error: Download error message
        upload_error: Upload error message
        vlm_error: VLM error message
        downloaded_at: Download completion time
        uploaded_at: Upload completion time
        described_at: VLM completion time
        created_at: Record creation time
        updated_at: Last update time
    """
    id: Optional[int] = None
    document_id: int = 0
    occurrence_no: int = 0
    figure_label: Optional[str] = None
    caption: Optional[str] = None
    alt_text: Optional[str] = None
    source_url: str = ""
    storage_key: Optional[str] = None
    mime_type: Optional[str] = None
    file_extension: Optional[str] = None
    file_size: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    sha256: Optional[str] = None
    download_status: ProcessingStatus = ProcessingStatus.PENDING
    upload_status: ProcessingStatus = ProcessingStatus.PENDING
    vlm_status: ProcessingStatus = ProcessingStatus.PENDING
    vlm_description: Optional[str] = None
    vlm_model: Optional[str] = None
    download_error: Optional[str] = None
    upload_error: Optional[str] = None
    vlm_error: Optional[str] = None
    downloaded_at: Optional[datetime] = None
    uploaded_at: Optional[datetime] = None
    described_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


@dataclass
class ReplacementInfo:
    """Information for replacing an image tag in the document.

    Attributes:
        image: Original image reference
        public_url: New public URL for the image
        figure_id: Database record ID
        vlm_description: VLM generated description
    """
    image: ImageRef
    public_url: str
    figure_id: int
    vlm_description: str
