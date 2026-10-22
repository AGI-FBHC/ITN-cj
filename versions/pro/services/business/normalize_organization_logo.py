#!/usr/bin/env python3
"""Linux adapter for organization logo normalization.

Mirrors normalize-organization-logo.ps1: base64 image on stdin,
normalized PNG base64 on stdout. Exit codes: 2 empty/oversize,
3 too many pixels, 4 invalid image or adapter failure.
"""
import base64
import io
import sys

from PIL import Image


def fail(code: int) -> None:
    sys.exit(code)


def main() -> None:
    try:
        line = sys.stdin.readline()
        if not line:
            fail(2)
        line = line.strip()
        if not line or len(line) > 2796204:
            fail(2)
        raw = base64.b64decode(line, validate=True)
        if not raw or len(raw) > 2097152:
            fail(2)

        Image.MAX_IMAGE_PIXELS = 20_000_000
        with Image.open(io.BytesIO(raw)) as image:
            width, height = image.size
            if width < 1 or height < 1:
                fail(4)
            if width * height > 16_000_000:
                fail(3)
            image.load()
            scale = min(1.0, 1024.0 / max(width, height))
            target_width = max(1, int(width * scale + 0.5))
            target_height = max(1, int(height * scale + 0.5))
            normalized = image.convert("RGBA").resize(
                (target_width, target_height), Image.Resampling.LANCZOS
            )
            output = io.BytesIO()
            normalized.save(output, format="PNG")

        sys.stdout.write(base64.b64encode(output.getvalue()).decode("ascii"))
    except SystemExit:
        raise
    except Exception:
        fail(4)


if __name__ == "__main__":
    main()
