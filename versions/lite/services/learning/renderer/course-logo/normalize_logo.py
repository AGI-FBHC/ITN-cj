"""Decode uploads in memory and emit only a compressed square WebP as base64."""

import base64
import io
import sys
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_UPLOAD = 8 * 1024 * 1024
MAX_PIXELS = 25_000_000
MAX_OUTPUT = 128 * 1024
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def normalize_logo(upload: bytes) -> bytes:
    if not upload or len(upload) > MAX_UPLOAD:
        raise ValueError("size")
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(upload)) as source:
            if source.format not in {"PNG", "JPEG", "WEBP", "GIF"}:
                raise ValueError("format")
            if source.width * source.height > MAX_PIXELS:
                raise ValueError("pixels")
            source.seek(0)
            image = ImageOps.exif_transpose(source).convert("RGBA")
    edge = min(image.size)
    left = (image.width - edge) // 2
    top = (image.height - edge) // 2
    image = image.crop((left, top, left + edge, top + edge))
    image.thumbnail((512, 512), Image.Resampling.LANCZOS)
    for quality in (82, 72, 60, 45):
        output = io.BytesIO()
        image.save(output, format="WEBP", quality=quality, method=4)
        if output.tell() <= MAX_OUTPUT:
            return output.getvalue()
    image.thumbnail((256, 256), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, format="WEBP", quality=60, method=4)
    if output.tell() > MAX_OUTPUT:
        raise ValueError("output")
    return output.getvalue()


def main() -> int:
    # Framed stdin avoids any original upload or metadata reaching the filesystem.
    line = sys.stdin.buffer.readline(((MAX_UPLOAD + 2) // 3) * 4 + 2)
    try:
        upload = base64.b64decode(line.strip(), validate=True)
        result = normalize_logo(upload)
    except (Image.DecompressionBombWarning, Image.DecompressionBombError):
        return 3
    except (ValueError, UnidentifiedImageError, OSError, EOFError):
        return 2
    sys.stdout.write(base64.b64encode(result).decode("ascii"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
