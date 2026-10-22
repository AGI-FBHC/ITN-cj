"""Chat attachment storage: disk persistence + MySQL metadata + LLM content building."""
import base64
import mimetypes
from datetime import datetime
from pathlib import Path
from uuid import UUID, uuid4

from app.config import Settings
from app.storage.platform_db import platform_connect

IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
TEXT_MIME_TYPES = {
    "text/plain", "text/markdown", "text/csv", "application/json",
    "text/xml", "application/xml", "text/yaml", "application/x-yaml",
    "text/html", "text/css", "application/javascript", "text/javascript",
    "application/sql", "text/x-python", "application/x-python-code",
}
TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".csv", ".json", ".xml", ".yaml", ".yml",
    ".py", ".java", ".js", ".ts", ".tsx", ".jsx", ".html", ".htm", ".css",
    ".sql", ".sh", ".c", ".h", ".cpp", ".cc", ".go", ".rs", ".vue", ".log",
    ".ini", ".conf", ".properties", ".gradle", ".kt",
}
DOCUMENT_MIME_TYPES = {"application/pdf"}

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_FILE_BYTES = 10 * 1024 * 1024
TEXT_EXCERPT_MAX_CHARS = 6000
MAX_IMAGES_PER_MESSAGE = 4


class AttachmentError(ValueError):
    pass


class AttachmentStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.root = Path(settings.agent_database_path).parent / "uploads"

    @staticmethod
    def _now() -> datetime:
        return datetime.utcnow()

    @staticmethod
    def _row_to_meta(row: dict) -> dict:
        return {
            "id": str(UUID(bytes=row["id"])),
            "name": row["filename"],
            "mimeType": row["mime_type"],
            "size": row["size_bytes"],
            "created_at": row["created_at"].isoformat(),
        }

    @staticmethod
    def normalize_mime(filename: str, mime_type: str | None) -> str:
        if mime_type and mime_type != "application/octet-stream":
            return mime_type.lower()
        guessed, _ = mimetypes.guess_type(filename)
        return (guessed or "application/octet-stream").lower()

    def validate(self, filename: str, mime_type: str, size: int) -> None:
        suffix = Path(filename).suffix.lower()
        allowed = mime_type in IMAGE_MIME_TYPES or mime_type in TEXT_MIME_TYPES \
            or mime_type in DOCUMENT_MIME_TYPES or suffix in TEXT_EXTENSIONS
        if not allowed:
            raise AttachmentError(f"Unsupported attachment type: {mime_type or suffix or filename}")
        limit = MAX_IMAGE_BYTES if mime_type in IMAGE_MIME_TYPES else MAX_FILE_BYTES
        if size > limit:
            raise AttachmentError(f"Attachment is too large (limit {limit // 1024 // 1024} MB)")
        if size <= 0:
            raise AttachmentError("Attachment is empty")

    def save(self, user_id: UUID, filename: str, mime_type: str | None, data: bytes) -> dict:
        safe_name = Path(filename or "attachment").name[:200] or "attachment"
        normalized = self.normalize_mime(safe_name, mime_type)
        self.validate(safe_name, normalized, len(data))
        attachment_id = uuid4()
        suffix = Path(safe_name).suffix.lower()[:16]
        directory = self.root / str(user_id)
        directory.mkdir(parents=True, exist_ok=True)
        storage = directory / f"{attachment_id.hex}{suffix}"
        storage.write_bytes(data)
        now = self._now()
        relative = str(storage.relative_to(self.root))
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO chat_attachments"
                    "(id, user_id, session_id, message_id, filename, mime_type, size_bytes, storage_path, created_at) "
                    "VALUES(%s, %s, NULL, NULL, %s, %s, %s, %s, %s)",
                    (attachment_id.bytes, user_id.bytes, safe_name, normalized,
                     len(data), relative, now),
                )
            connection.commit()
        return {"id": str(attachment_id), "name": safe_name, "mimeType": normalized,
                "size": len(data), "created_at": now.isoformat()}

    def get_owned(self, attachment_id: UUID, user_id: UUID) -> dict | None:
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT id, user_id, filename, mime_type, size_bytes, storage_path, created_at "
                    "FROM chat_attachments WHERE id = %s AND user_id = %s",
                    (attachment_id.bytes, user_id.bytes),
                )
                row = cursor.fetchone()
        return row

    def get_many_owned(self, attachment_ids: list[UUID], user_id: UUID) -> list[dict]:
        if not attachment_ids:
            return []
        placeholders = ", ".join(["%s"] * len(attachment_ids))
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"SELECT id, user_id, filename, mime_type, size_bytes, storage_path, created_at "
                    f"FROM chat_attachments WHERE id IN ({placeholders}) AND user_id = %s",
                    (*[item.bytes for item in attachment_ids], user_id.bytes),
                )
                rows = cursor.fetchall()
        order = {item.bytes: index for index, item in enumerate(attachment_ids)}
        return sorted(rows, key=lambda row: order.get(row["id"], 0))

    def path_for(self, row: dict) -> Path:
        return self.root / row["storage_path"]

    def link_to_message(self, attachment_ids: list[UUID], user_id: UUID,
                        session_id: UUID, message_id: UUID) -> None:
        if not attachment_ids:
            return
        placeholders = ", ".join(["%s"] * len(attachment_ids))
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"UPDATE chat_attachments SET session_id = %s, message_id = %s "
                    f"WHERE id IN ({placeholders}) AND user_id = %s",
                    (session_id.bytes, message_id.bytes,
                     *[item.bytes for item in attachment_ids], user_id.bytes),
                )
            connection.commit()

    def list_for_messages(self, message_ids: list[UUID]) -> dict[str, list[dict]]:
        if not message_ids:
            return {}
        placeholders = ", ".join(["%s"] * len(message_ids))
        with platform_connect(self.settings) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    f"SELECT id, message_id, filename, mime_type, size_bytes, created_at "
                    f"FROM chat_attachments WHERE message_id IN ({placeholders}) "
                    f"ORDER BY created_at",
                    tuple(item.bytes for item in message_ids),
                )
                rows = cursor.fetchall()
        grouped: dict[str, list[dict]] = {}
        for row in rows:
            key = str(UUID(bytes=row["message_id"]))
            grouped.setdefault(key, []).append({
                "id": str(UUID(bytes=row["id"])),
                "name": row["filename"],
                "mimeType": row["mime_type"],
                "size": row["size_bytes"],
            })
        return grouped

    @staticmethod
    def is_image(row: dict) -> bool:
        return row["mime_type"] in IMAGE_MIME_TYPES

    @staticmethod
    def is_text(row: dict) -> bool:
        suffix = Path(row["filename"]).suffix.lower()
        return row["mime_type"] in TEXT_MIME_TYPES or suffix in TEXT_EXTENSIONS

    def build_image_part(self, row: dict) -> dict | None:
        path = self.path_for(row)
        if not path.exists():
            return None
        encoded = base64.b64encode(path.read_bytes()).decode()
        return {"type": "image_url",
                "image_url": {"url": f"data:{row['mime_type']};base64,{encoded}"}}

    def build_text_excerpt(self, row: dict) -> str:
        path = self.path_for(row)
        if not path.exists():
            return f"[附件 {row['filename']}: 文件已丢失]"
        try:
            text = path.read_bytes().decode("utf-8", errors="replace")
        except OSError:
            return f"[附件 {row['filename']}: 读取失败]"
        if len(text) > TEXT_EXCERPT_MAX_CHARS:
            text = text[:TEXT_EXCERPT_MAX_CHARS] + "\n...[内容过长已截断]"
        return text

    def augment_content(self, content: str, rows: list[dict]) -> str | list[dict]:
        """Merge attachment content into a chat message content field."""
        text_blocks: list[str] = []
        image_parts: list[dict] = []
        image_count = 0
        for row in rows:
            if self.is_image(row):
                if image_count >= MAX_IMAGES_PER_MESSAGE:
                    text_blocks.append(f"[图片附件 {row['filename']}: 超出单条消息图片数量限制，未发送给模型]")
                    continue
                part = self.build_image_part(row)
                if part is not None:
                    image_parts.append(part)
                    image_count += 1
                else:
                    text_blocks.append(f"[图片附件 {row['filename']}: 文件已丢失]")
            elif self.is_text(row):
                excerpt = self.build_text_excerpt(row)
                text_blocks.append(f"[附件 {row['filename']} 内容开始]\n{excerpt}\n[附件 {row['filename']} 内容结束]")
            else:
                text_blocks.append(f"[附件 {row['filename']}（{row['mime_type']}）: 该格式暂不支持解析，请粘贴关键文本内容]")
        base_text = content or ""
        if text_blocks:
            prefix = "\n\n".join(text_blocks)
            base_text = f"{prefix}\n\n{base_text}" if base_text else prefix
        if image_parts:
            parts: list[dict] = [{"type": "text", "text": base_text or "请分析这张图片"}]
            parts.extend(image_parts)
            return parts
        return base_text
