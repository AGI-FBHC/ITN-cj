"""Step 5: Figure Asset Processing — extract, save, and catalog images."""

from __future__ import annotations

import json
import re
from pathlib import Path

from ..config import DomainConfig, FigurePolicy
from ..models import AssetStatus, DocumentSource, FigureAsset, FigureImportance
from ..utils.markdown import ImageRef

# Pattern to extract figure info from enhanced <img> tags
_IMG_WITH_FIGURE_ID = re.compile(
    r'<img\s+([^>]*?)data-figure-id="(\d+)"\s+([^>]*?)/?>',
    re.IGNORECASE,
)
_IMG_SRC = re.compile(r'src="([^"]*)"', re.IGNORECASE)
_IMG_ALT = re.compile(r'alt="([^"]*)"', re.IGNORECASE)
_IMG_VLM_DESC = re.compile(r'data-vlm-description="([^"]*)"', re.IGNORECASE)


def process_figures(
    image_refs: list[ImageRef],
    doc: DocumentSource,
    config: DomainConfig,
    source_path: Path,
    output_dir: Path,
    enhanced_text: str | None = None,
) -> list[FigureAsset]:
    """Process image references into FigureAsset records.

    If enhanced_text is provided (from images sub-pipeline),
    extract figure info from data-figure-id attributes.
    Otherwise, fall back to download/copy logic.
    """
    if enhanced_text:
        return _extract_figures_from_enhanced(enhanced_text, doc, config)

    # Fallback: download/copy logic (legacy)
    return _process_figures_legacy(image_refs, doc, config, source_path, output_dir)


def _extract_figures_from_enhanced(
    enhanced_text: str,
    doc: DocumentSource,
    config: DomainConfig,
) -> list[FigureAsset]:
    """Extract FigureAsset records from enhanced markdown with data-figure-id attributes."""
    assets: list[FigureAsset] = []

    for match in _IMG_WITH_FIGURE_ID.finditer(enhanced_text):
        attrs = match.group(1) + " " + match.group(3)
        figure_id_db = match.group(2)

        # Extract src
        src_m = _IMG_SRC.search(attrs)
        src = src_m.group(1) if src_m else ""

        # Extract alt
        alt_m = _IMG_ALT.search(attrs)
        alt = alt_m.group(1) if alt_m else ""

        # Extract VLM description
        vlm_m = _IMG_VLM_DESC.search(attrs)
        vlm_desc = vlm_m.group(1) if vlm_m else ""

        figure_id = f"fig_{len(assets) + 1:04d}"

        asset = FigureAsset(
            figure_id=figure_id,
            document_id=doc.document_id,
            domain_id=config.domain_id,
            domain_version_id=config.domain_version_id,
            alt_text=alt or None,
            original_src=src,
            source_start_offset=match.start(),
            source_end_offset=match.end(),
            asset_status=AssetStatus.AVAILABLE,
            importance=FigureImportance.CONTENT,
            vlm_summary=vlm_desc or None,
            metadata={"db_figure_id": figure_id_db},
        )
        assets.append(asset)

    return assets


def _process_figures_legacy(
    image_refs: list[ImageRef],
    doc: DocumentSource,
    config: DomainConfig,
    source_path: Path,
    output_dir: Path,
) -> list[FigureAsset]:
    """Legacy figure processing: download/copy images to local assets."""
    from ..utils.image import (
        copy_local_image,
        download_remote_image,
        guess_extension,
        is_remote_url,
        resolve_local_path,
    )

    assets: list[FigureAsset] = []
    figures_dir = (
        output_dir
        / config.domain_id
        / config.domain_version_id
        / doc.document_id
        / "assets"
        / "figures"
    )
    figures_dir.mkdir(parents=True, exist_ok=True)

    doc_dir = source_path.parent

    for idx, img in enumerate(image_refs):
        fig_id = f"fig_{idx + 1:04d}"
        ext = guess_extension(img.src)
        dest = figures_dir / f"{fig_id}{ext}"

        asset_hash = ""
        status = AssetStatus.AVAILABLE

        if is_remote_url(img.src):
            if config.figure_policy.download_remote_images:
                asset_hash, success = download_remote_image(img.src, dest)
                if not success:
                    status = AssetStatus.DOWNLOAD_FAILED
            else:
                status = AssetStatus.DOWNLOAD_FAILED
        else:
            local = resolve_local_path(img.src, doc_dir)
            if local:
                asset_hash = copy_local_image(local, dest)
            else:
                status = AssetStatus.LOCAL_MISSING

        section_path = _infer_section_path(img)

        asset = FigureAsset(
            figure_id=fig_id,
            document_id=doc.document_id,
            domain_id=config.domain_id,
            domain_version_id=config.domain_version_id,
            caption=img.caption,
            alt_text=img.alt or None,
            original_src=img.src,
            asset_uri=str(dest) if status == AssetStatus.AVAILABLE else None,
            asset_hash=asset_hash or None,
            source_start_offset=img.start_offset,
            source_end_offset=img.end_offset,
            section_path=section_path,
            asset_status=status,
            importance=FigureImportance.CONTENT,
        )
        assets.append(asset)

    return assets


def save_figure_manifest(assets: list[FigureAsset], output_dir: Path, doc: DocumentSource) -> Path:
    """Save figure_manifest.json."""
    fig_dir = (
        output_dir
        / doc.domain_id
        / doc.domain_version_id
        / doc.document_id
        / "figures"
    )
    fig_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = fig_dir / "figure_manifest.json"
    data = [a.model_dump(mode="json") for a in assets]
    manifest_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest_path


def _infer_section_path(img: ImageRef) -> list[str]:
    """Infer section path from image caption or alt text."""
    if img.caption:
        m = re.match(r"图\s*(\d+)\.(\d+)", img.caption)
        if m:
            return [f"第{m.group(1)}章"]
    return []
