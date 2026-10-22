"""Database repository for knowledge_figures table.

Manages image records in MySQL including:
- Creating and updating records
- Tracking processing status
- Idempotent operations based on document_id + occurrence_no
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Optional

import pymysql
from pymysql.cursors import DictCursor

from .models import ImageMetadata, ImageRecord, ProcessingStatus

logger = logging.getLogger(__name__)

# MySQL connection configuration
MYSQL_CONFIG = {
    "host": os.environ.get("MYSQL_HOST"),
    "port": int(os.environ.get("MYSQL_PORT", 3306)),
    "user": os.environ.get("MYSQL_USER"),
    "password": os.environ.get("MYSQL_PASSWORD"),
    "database": os.environ.get("MYSQL_DATABASE"),
    "charset": "utf8mb4",
    "cursorclass": DictCursor,
}


def get_connection() -> pymysql.Connection:
    """Get a MySQL database connection.

    Returns:
        pymysql Connection object
    """
    return pymysql.connect(**MYSQL_CONFIG)


def upsert_pending(
    document_id: int,
    occurrence_no: int,
    figure_label: Optional[str],
    caption: Optional[str],
    alt_text: Optional[str],
    source_url: str,
) -> ImageRecord:
    """Create or update a pending image record.

    Uses document_id + occurrence_no as the unique key.
    If a record exists with the same source_url, returns it.
    If source_url changed, updates the record.

    Args:
        document_id: Document ID
        occurrence_no: Image occurrence order (1-based)
        figure_label: Figure label (e.g., "图 4.1")
        caption: Figure caption
        alt_text: Alt text
        source_url: Original image URL

    Returns:
        ImageRecord (existing or newly created)
    """
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            # Try to find existing record
            sql = """
                SELECT * FROM knowledge_figures
                WHERE document_id = %s AND occurrence_no = %s
            """
            cursor.execute(sql, (document_id, occurrence_no))
            row = cursor.fetchone()

            now = datetime.now()

            if row:
                # Record exists
                if row["source_url"] == source_url:
                    # Same URL, return existing record
                    return _row_to_record(row)
                else:
                    # URL changed, update and reset status
                    sql = """
                        UPDATE knowledge_figures
                        SET source_url = %s,
                            figure_label = %s,
                            caption = %s,
                            alt_text = %s,
                            download_status = %s,
                            upload_status = %s,
                            vlm_status = %s,
                            storage_key = NULL,
                            vlm_description = NULL,
                            download_error = NULL,
                            upload_error = NULL,
                            vlm_error = NULL,
                            updated_at = %s
                        WHERE document_id = %s AND occurrence_no = %s
                    """
                    cursor.execute(sql, (
                        source_url,
                        figure_label,
                        caption,
                        alt_text,
                        ProcessingStatus.PENDING.value,
                        ProcessingStatus.PENDING.value,
                        ProcessingStatus.PENDING.value,
                        now,
                        document_id,
                        occurrence_no,
                    ))
                    conn.commit()

                    # Fetch updated record
                    cursor.execute(
                        "SELECT * FROM knowledge_figures WHERE document_id = %s AND occurrence_no = %s",
                        (document_id, occurrence_no),
                    )
                    return _row_to_record(cursor.fetchone())
            else:
                # Create new record
                sql = """
                    INSERT INTO knowledge_figures (
                        document_id, occurrence_no, figure_label,
                        caption, alt_text, source_url, image_type,
                        download_status, upload_status, vlm_status,
                        created_at, updated_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """
                cursor.execute(sql, (
                    document_id,
                    occurrence_no,
                    figure_label,
                    caption,
                    alt_text,
                    source_url,
                    "unknown",
                    ProcessingStatus.PENDING.value,
                    ProcessingStatus.PENDING.value,
                    ProcessingStatus.PENDING.value,
                    now,
                    now,
                ))
                conn.commit()

                # Get the inserted record
                record_id = cursor.lastrowid
                cursor.execute(
                    "SELECT * FROM knowledge_figures WHERE id = %s",
                    (record_id,),
                )
                return _row_to_record(cursor.fetchone())
    finally:
        conn.close()


def can_reuse(record: ImageRecord) -> bool:
    """Check if an image record can be reused without reprocessing.

    A record can be reused if:
    - upload_status is success
    - vlm_status is success
    - storage_key is not empty
    - vlm_description is not empty

    Args:
        record: ImageRecord to check

    Returns:
        True if the record can be reused
    """
    return (
        record.upload_status == ProcessingStatus.SUCCESS
        and record.vlm_status == ProcessingStatus.SUCCESS
        and record.storage_key is not None
        and record.storage_key != ""
        and record.vlm_description is not None
        and record.vlm_description != ""
    )


def get_record(record_id: int) -> ImageRecord:
    """Fetch a single image record by id."""
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT * FROM knowledge_figures WHERE id = %s",
                (record_id,),
            )
            row = cursor.fetchone()
            return _row_to_record(row) if row else None
    finally:
        conn.close()


def reset_stale_processing(record_id: int) -> None:
    """Reset stale 'processing' statuses left behind by a crashed run.

    If the process died between "mark X processing" and "mark X success",
    the row is stuck in 'processing' forever. On the next run we reset such
    fields back to 'pending' so the per-step logic retries them.
    """
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            for field in ("download_status", "upload_status", "vlm_status"):
                cursor.execute(
                    f"UPDATE knowledge_figures SET {field} = %s, updated_at = %s "
                    f"WHERE id = %s AND {field} = %s",
                    (ProcessingStatus.PENDING.value, datetime.now(), record_id,
                     ProcessingStatus.PROCESSING.value),
                )
            conn.commit()
    finally:
        conn.close()


def mark_download_processing(record_id: int) -> None:
    """Mark a record as being downloaded.

    Args:
        record_id: Record ID
    """
    _update_status(record_id, "download_status", ProcessingStatus.PROCESSING)


def mark_download_success(record_id: int, metadata: ImageMetadata) -> None:
    """Mark a record as successfully downloaded.

    Args:
        record_id: Record ID
        metadata: Image metadata from inspection
    """
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            sql = """
                UPDATE knowledge_figures
                SET download_status = %s,
                    sha256 = %s,
                    mime_type = %s,
                    file_extension = %s,
                    file_size = %s,
                    width = %s,
                    height = %s,
                    downloaded_at = %s,
                    download_error = NULL,
                    updated_at = %s
                WHERE id = %s
            """
            now = datetime.now()
            cursor.execute(sql, (
                ProcessingStatus.SUCCESS.value,
                metadata.sha256,
                metadata.mime_type,
                metadata.file_extension,
                metadata.file_size,
                metadata.width,
                metadata.height,
                now,
                now,
                record_id,
            ))
            conn.commit()
    finally:
        conn.close()


def mark_download_failed(record_id: int, error: str) -> None:
    """Mark a record as download failed.

    Args:
        record_id: Record ID
        error: Error message
    """
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            sql = """
                UPDATE knowledge_figures
                SET download_status = %s,
                    download_error = %s,
                    updated_at = %s
                WHERE id = %s
            """
            cursor.execute(sql, (
                ProcessingStatus.FAILED.value,
                error,
                datetime.now(),
                record_id,
            ))
            conn.commit()
    finally:
        conn.close()


def mark_upload_processing(record_id: int) -> None:
    """Mark a record as being uploaded.

    Args:
        record_id: Record ID
    """
    _update_status(record_id, "upload_status", ProcessingStatus.PROCESSING)


def mark_upload_success(record_id: int, storage_key: str) -> None:
    """Mark a record as successfully uploaded.

    Args:
        record_id: Record ID
        storage_key: Server storage path
    """
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            sql = """
                UPDATE knowledge_figures
                SET upload_status = %s,
                    storage_key = %s,
                    uploaded_at = %s,
                    upload_error = NULL,
                    updated_at = %s
                WHERE id = %s
            """
            now = datetime.now()
            cursor.execute(sql, (
                ProcessingStatus.SUCCESS.value,
                storage_key,
                now,
                now,
                record_id,
            ))
            conn.commit()
    finally:
        conn.close()


def mark_upload_failed(record_id: int, error: str) -> None:
    """Mark a record as upload failed.

    Args:
        record_id: Record ID
        error: Error message
    """
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            sql = """
                UPDATE knowledge_figures
                SET upload_status = %s,
                    upload_error = %s,
                    updated_at = %s
                WHERE id = %s
            """
            cursor.execute(sql, (
                ProcessingStatus.FAILED.value,
                error,
                datetime.now(),
                record_id,
            ))
            conn.commit()
    finally:
        conn.close()


def mark_vlm_processing(record_id: int) -> None:
    """Mark a record as being processed by VLM.

    Args:
        record_id: Record ID
    """
    _update_status(record_id, "vlm_status", ProcessingStatus.PROCESSING)


def mark_vlm_success(
    record_id: int,
    model: str,
    description: str,
) -> None:
    """Mark a record as successfully described by VLM.

    Args:
        record_id: Record ID
        model: VLM model name
        description: Generated description
    """
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            sql = """
                UPDATE knowledge_figures
                SET vlm_status = %s,
                    vlm_model = %s,
                    vlm_description = %s,
                    described_at = %s,
                    vlm_error = NULL,
                    updated_at = %s
                WHERE id = %s
            """
            now = datetime.now()
            cursor.execute(sql, (
                ProcessingStatus.SUCCESS.value,
                model,
                description,
                now,
                now,
                record_id,
            ))
            conn.commit()
    finally:
        conn.close()


def mark_vlm_failed(record_id: int, error: str) -> None:
    """Mark a record as VLM processing failed.

    Args:
        record_id: Record ID
        error: Error message
    """
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            sql = """
                UPDATE knowledge_figures
                SET vlm_status = %s,
                    vlm_error = %s,
                    updated_at = %s
                WHERE id = %s
            """
            cursor.execute(sql, (
                ProcessingStatus.FAILED.value,
                error,
                datetime.now(),
                record_id,
            ))
            conn.commit()
    finally:
        conn.close()


def mark_current_step_failed(record_id: int, error: str) -> None:
    """Mark the current processing step as failed.

    Determines which step is currently processing and marks it as failed.

    Args:
        record_id: Record ID
        error: Error message
    """
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            # Get current status
            sql = """
                SELECT download_status, upload_status, vlm_status
                FROM knowledge_figures
                WHERE id = %s
            """
            cursor.execute(sql, (record_id,))
            row = cursor.fetchone()

            if not row:
                return

            # Determine which step is processing
            if row["download_status"] == ProcessingStatus.PROCESSING.value:
                mark_download_failed(record_id, error)
            elif row["upload_status"] == ProcessingStatus.PROCESSING.value:
                mark_upload_failed(record_id, error)
            elif row["vlm_status"] == ProcessingStatus.PROCESSING.value:
                mark_vlm_failed(record_id, error)
    finally:
        conn.close()


def _update_status(
    record_id: int,
    status_field: str,
    status: ProcessingStatus,
) -> None:
    """Update a status field for a record.

    Args:
        record_id: Record ID
        status_field: Name of the status field
        status: New status value
    """
    conn = get_connection()
    try:
        with conn.cursor() as cursor:
            sql = f"""
                UPDATE knowledge_figures
                SET {status_field} = %s,
                    updated_at = %s
                WHERE id = %s
            """
            cursor.execute(sql, (
                status.value,
                datetime.now(),
                record_id,
            ))
            conn.commit()
    finally:
        conn.close()


def _row_to_record(row: dict) -> ImageRecord:
    """Convert a database row to an ImageRecord.

    Args:
        row: Database row as dictionary

    Returns:
        ImageRecord object
    """
    return ImageRecord(
        id=row.get("id"),
        document_id=row.get("document_id", 0),
        occurrence_no=row.get("occurrence_no", 0),
        figure_label=row.get("figure_label"),
        caption=row.get("caption"),
        alt_text=row.get("alt_text"),
        source_url=row.get("source_url", ""),
        storage_key=row.get("storage_key"),
        mime_type=row.get("mime_type"),
        file_extension=row.get("file_extension"),
        file_size=row.get("file_size"),
        width=row.get("width"),
        height=row.get("height"),
        sha256=row.get("sha256"),
        download_status=ProcessingStatus(row.get("download_status", "pending")),
        upload_status=ProcessingStatus(row.get("upload_status", "pending")),
        vlm_status=ProcessingStatus(row.get("vlm_status", "pending")),
        vlm_description=row.get("vlm_description"),
        vlm_model=row.get("vlm_model"),
        download_error=row.get("download_error"),
        upload_error=row.get("upload_error"),
        vlm_error=row.get("vlm_error"),
        downloaded_at=row.get("downloaded_at"),
        uploaded_at=row.get("uploaded_at"),
        described_at=row.get("described_at"),
        created_at=row.get("created_at"),
        updated_at=row.get("updated_at"),
    )
