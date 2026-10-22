"""Image processing pipeline.

Orchestrates the complete image processing workflow:
1. Parse images from Markdown
2. Create/update database records
3. Download remote images
4. Validate and inspect images
5. Upload to ITN image server
6. Generate VLM descriptions
7. Update database records
8. Replace image URLs in document
9. Write normalized document
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import List, Optional
from urllib.parse import urlparse

from . import repository
from .downloader import cleanup_temp_file, download_image
from .inspector import inspect_image
from .models import ImageRef, ImageMetadata, ImageRecord, ProcessingStatus, ReplacementInfo
from .parser import parse_images
from .rewriter import apply_replacements, build_replacement
from .uploader import build_public_url, upload_image
from .vlm import describe_image

logger = logging.getLogger(__name__)


def process_markdown_images(
    document_id: int,
    source_path: Path,
    storage_prefix: str,
    enable_vlm: bool = True,
    vlm_api_key: str = "",
) -> Path:
    """Process all images in a Markdown document.

    This is the main entry point for the image processing pipeline.

    Args:
        document_id: Document ID in the business database
        source_path: Path to the source Markdown file
        storage_prefix: Target directory on the image server
            (e.g., "ITN/hello_agents/chapter4")

    Returns:
        Path to the normalized output file

    Raises:
        FileNotFoundError: If the source file does not exist
        ValueError: If required configuration is missing
    """
    if not source_path.exists():
        raise FileNotFoundError(f"Source file not found: {source_path}")

    logger.info(f"Processing images in: {source_path}")
    logger.info(f"Document ID: {document_id}")
    logger.info(f"Storage prefix: {storage_prefix}")

    # Read source document
    source_text = source_path.read_text(encoding="utf-8")

    # Parse all images
    images = parse_images(source_text)
    logger.info(f"Found {len(images)} images in document")

    if not images:
        logger.info("No images to process, copying source to normalized")
        return _write_normalized(source_path, source_text)

    # Process each image
    replacements: List[ReplacementInfo] = []

    for image in images:
        try:
            replacement = _process_single_image(
                document_id=document_id,
                image=image,
                storage_prefix=storage_prefix,
                enable_vlm=enable_vlm,
                vlm_api_key=vlm_api_key,
            )
            if replacement:
                replacements.append(replacement)
        except Exception as e:
            logger.error(
                f"Failed to process image {image.occurrence_no}: {e}"
            )
            raise

    # Apply all replacements to generate normalized text
    normalized_text = apply_replacements(source_text, replacements)

    # Write normalized document
    output_path = _write_normalized(source_path, normalized_text)

    logger.info(f"Processing complete. Output: {output_path}")
    return output_path


def _derive_filename(image: ImageRef) -> str:
    """Derive a meaningful server-side filename from an image reference.

    Strategy:
    1. Extract basename from the source URL path
    2. Sanitize to alphanumeric + dots + hyphens + underscores
    3. Ensure it has a proper image extension

    Examples:
        https://example.com/docs/images/4-figures/4-1.png -> 4-1.png
        https://example.com/img?id=123 -> figure-001.png

    Args:
        image: Image reference from parser

    Returns:
        Safe filename string (e.g., "4-1.png")
    """
    parsed = urlparse(image.source_url)
    basename = Path(parsed.path).stem  # e.g., "4-1"

    # Sanitize: keep only safe characters
    basename = re.sub(r'[^\w\-]', '_', basename)

    # Fallback if empty
    if not basename:
        basename = f"figure-{image.occurrence_no:03d}"

    # Determine extension from source URL or default to .png
    ext = Path(parsed.path).suffix.lower()
    if ext not in ('.png', '.jpg', '.jpeg', '.webp', '.gif'):
        ext = '.png'

    return f"{basename}{ext}"


def _process_single_image(
    document_id: int,
    image: ImageRef,
    storage_prefix: str,
    enable_vlm: bool = True,
    vlm_api_key: str = "",
) -> Optional[ReplacementInfo]:
    """Process a single image through the complete pipeline.

    Idempotent, step-level resume:
    - download_status == success  -> reuse stored metadata, no re-download
    - upload_status  == success   -> reuse storage_key, no re-upload
    - vlm_status     == success   -> reuse description, no re-VLM call
    - stale 'processing' statuses (crashed run) are reset to pending and retried
    - a changed source_url resets all statuses (handled by upsert_pending)

    Returns:
        ReplacementInfo if successful, None if skipped

    Raises:
        Exception: If any step fails
    """
    logger.info(
        f"Processing image {image.occurrence_no}: {image.source_url}"
    )

    # Derive a meaningful filename from the source URL
    server_filename = _derive_filename(image)

    # Step 1: Create or get database record
    record = repository.upsert_pending(
        document_id=document_id,
        occurrence_no=image.occurrence_no,
        figure_label=image.figure_label,
        caption=image.caption,
        alt_text=image.alt_text,
        source_url=image.source_url,
    )

    # Step 2: recover stale 'processing' statuses from a crashed run
    repository.reset_stale_processing(record.id)
    record = repository.get_record(record.id)

    # Step 3: check if we can reuse everything
    if repository.can_reuse(record):
        logger.info(
            f"Reusing existing record for image {image.occurrence_no}"
        )
        public_url = build_public_url(record.storage_key)
        return build_replacement(
            image=image,
            public_url=public_url,
            figure_id=record.id,
            vlm_description=record.vlm_description,
        )

    # Step 4: process only the missing steps
    local_path = None
    metadata = None

    try:
        # ── Download (skip if already success) ──
        if record.download_status == ProcessingStatus.SUCCESS:
            logger.info(f"Download already done, reusing metadata for image {image.occurrence_no}")
        else:
            repository.mark_download_processing(record.id)
            local_path = download_image(image.source_url)
            metadata = inspect_image(local_path)
            repository.mark_download_success(record.id, metadata)

        # ── Upload (skip if already success) ──
        if (record.upload_status == ProcessingStatus.SUCCESS
                and record.storage_key):
            logger.info(f"Upload already done, reusing storage_key for image {image.occurrence_no}")
            storage_key = record.storage_key
        else:
            if local_path is None:
                # download was reused, but we still need the file to upload:
                # re-download to a temp file (content hash will match stored sha256)
                local_path = download_image(image.source_url)
            repository.mark_upload_processing(record.id)
            upload_result = upload_image(
                local_path=local_path,
                directory=storage_prefix,
                filename=server_filename,
            )
            repository.mark_upload_success(record.id, upload_result.storage_key)
            storage_key = upload_result.storage_key

        # ── VLM description (skip if already success) ──
        description = ""
        if enable_vlm:
            if (record.vlm_status == ProcessingStatus.SUCCESS
                    and record.vlm_description):
                logger.info(f"VLM already done, reusing description for image {image.occurrence_no}")
                description = record.vlm_description
            else:
                if local_path is None:
                    local_path = download_image(image.source_url)
                repository.mark_vlm_processing(record.id)
                try:
                    description = describe_image(local_path, api_key=vlm_api_key or None)
                except Exception as e:
                    # VLM 未配置或调用失败时不应中断整条入库链路，仅跳过图片描述。
                    logger.warning(f"VLM description skipped for image {image.occurrence_no}: {e}")
                    description = ""
                if description:
                    repository.mark_vlm_success(
                        record.id,
                        model="glm-4.6v-flash",
                        description=description,
                    )
        else:
            logger.info(f"VLM disabled, skipping description for image {image.occurrence_no}")

        # Build replacement
        public_url = build_public_url(storage_key)
        return build_replacement(
            image=image,
            public_url=public_url,
            figure_id=record.id,
            vlm_description=description,
        )

    except Exception as e:
        # Mark current step as failed
        repository.mark_current_step_failed(record.id, str(e))
        raise

    finally:
        # Clean up temporary file
        if local_path:
            cleanup_temp_file(local_path)


def _write_normalized(source_path: Path, content: str) -> Path:
    """Write the normalized document to the output directory.

    Uses atomic write (write to temp file, then rename).

    Args:
        source_path: Original source file path
        content: Normalized content to write

    Returns:
        Path to the output file
    """
    # If source is already inside a normalized dir, write back in place to
    # avoid nested normalized/normalized/ directories (image pipeline feeds
    # the normalized.md file back into itself).
    if source_path.parent.name == "normalized":
        output_path = source_path
    else:
        output_dir = source_path.parent / "normalized"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / source_path.name

    # Atomic write
    temp_path = output_path.with_suffix(output_path.suffix + ".tmp")

    try:
        temp_path.write_text(content, encoding="utf-8")
        temp_path.replace(output_path)
        logger.info(f"Written normalized document: {output_path}")
    except Exception:
        # Clean up temp file on error
        temp_path.unlink(missing_ok=True)
        raise

    return output_path
