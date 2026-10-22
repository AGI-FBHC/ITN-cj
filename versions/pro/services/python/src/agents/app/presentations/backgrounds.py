"""Presentation background catalog and deterministic role selection."""

from __future__ import annotations

import hashlib
import random
from pathlib import Path


BACKGROUND_STYLES = {
    "none": "纯色排版",
    "colorful-ink": "彩色水墨晕染",
    "sunset-mountains": "橙红渐变山脉",
    "abstract-gradient": "抽象渐变",
    "clean-minimal": "极致简约",
    "cartoon-doodle": "卡通涂鸦",
    "blue-white-minimal": "蓝白极简",
    "blue-conference": "蓝调会议风",
    "morandi-blue-gray": "莫兰迪蓝灰",
    "business-gray": "商务灰",
    "watercolor": "水彩画",
}

THEME_PALETTES = {
    "none": ("27272A", "FAFAF8", "8B8B80"),
    "colorful-ink": ("43223D", "FFF6FA", "D35F8D"),
    "sunset-mountains": ("592D35", "FFF3E8", "E8794E"),
    "abstract-gradient": ("30215A", "F7F2FF", "A974D6"),
    "clean-minimal": ("26332D", "F8F6F0", "8BA89A"),
    "cartoon-doodle": ("283B52", "FFF9DD", "E3A522"),
    "blue-white-minimal": ("173A5E", "F2F8FC", "4C91C7"),
    "blue-conference": ("102B50", "EDF4FA", "3F8ECD"),
    "morandi-blue-gray": ("344753", "F1F0EC", "8199A8"),
    "business-gray": ("30363C", "F3F4F4", "A3A8AC"),
    "watercolor": ("31546B", "F4F8F6", "D88B73"),
}

# These image families are consistently light but textured; near-black cover
# typography keeps subtitles readable where an average-luminance check is too
# optimistic. Other families continue to use local image analysis/model advice.
COVER_TEXT_OVERRIDES = {
    "watercolor": ("16232B", "243844"),
}


def palette_for(background_style: str) -> tuple[str, str, str]:
    """Return the foreground palette bound to a background family."""
    return THEME_PALETTES.get(background_style, THEME_PALETTES["none"])

ASSET_ROOT = Path(__file__).resolve().parents[2] / "assets" / "presentation_backgrounds"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def _asset_role(path: Path) -> str:
    text = "/".join(part.lower() for part in path.parts)
    if "正文" in text or "content" in text:
        return "content"
    if "目录" in text or "agenda" in text:
        return "agenda"
    if "标题" in text or "title" in text:
        return "title"
    return "universal"


def select_backgrounds(style: str, seed_text: str) -> dict[str, Path | None]:
    """Select a stable, varied cover/section/agenda/content background set."""
    if style == "none" or style not in BACKGROUND_STYLES:
        return {role: None for role in ("cover", "section", "agenda", "content")}
    style_dir = ASSET_ROOT / style
    assets = sorted(
        path for path in style_dir.rglob("*")
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )
    if not assets:
        return {role: None for role in ("cover", "section", "agenda", "content")}

    grouped = {role: [] for role in ("title", "agenda", "content", "universal")}
    for path in assets:
        grouped[_asset_role(path)].append(path)
    seed = int(hashlib.sha256(f"{style}:{seed_text}".encode("utf-8")).hexdigest()[:16], 16)
    rng = random.Random(seed)
    used: set[Path] = set()

    def choose(*roles: str) -> Path:
        candidates: list[Path] = []
        for role in roles:
            role_candidates = grouped[role]
            role_fresh = [path for path in role_candidates if path not in used]
            if role_fresh:
                candidates = role_fresh
                break
            if role_candidates and not candidates:
                candidates = role_candidates
        selected = rng.choice(candidates or assets)
        used.add(selected)
        return selected

    return {
        "cover": choose("title", "universal", "agenda", "content"),
        "section": choose("title", "universal", "agenda", "content"),
        "agenda": choose("agenda", "title", "universal", "content"),
        "content": choose("content", "universal", "agenda", "title"),
    }
