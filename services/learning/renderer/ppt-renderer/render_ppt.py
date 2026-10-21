"""Lumin PPT renderer: fixed Cangjie pipeline -> python-pptx compatibility renderer.

This file intentionally contains no LLM or network calls. It receives a verified
outline and a normalized request, then uses the legacy web renderer's layout
engine to produce a real .pptx file.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

from legacy_agent import PptAgent
from pptx_preview import preview_from_pptx


def make_request(raw: dict) -> SimpleNamespace:
    return SimpleNamespace(
        requirement=str(raw.get("requirement") or raw.get("title") or "交互课件"),
        title=str(raw.get("title") or ""),
        audience=str(raw.get("audience") or "students"),
        purpose=str(raw.get("purpose") or "courseware"),
        style=str(raw.get("style") or "education"),
        background_style=str(raw.get("backgroundStyle") or raw.get("background_style") or "clean-minimal"),
        language=str(raw.get("language") or "zh-CN"),
        slide_count=int(raw.get("slideCount") or raw.get("slide_count") or 0),
        aspect_ratio=str(raw.get("aspectRatio") or raw.get("aspect_ratio") or "16:9"),
        detail_level=str(raw.get("detailLevel") or raw.get("detail_level") or "detailed"),
        include_speaker_notes=bool(raw.get("includeSpeakerNotes", raw.get("include_speaker_notes", True))),
        model_provider=str(raw.get("modelProvider") or raw.get("model_provider") or "mimo"),
        generation_mode=str(raw.get("generationMode") or raw.get("generation_mode") or "template"),
        custom_style=raw.get("customStyle") or raw.get("custom_style"),
        learning_goal_id=raw.get("learningGoalId") or raw.get("learning_goal_id"),
        generation_context=raw.get("generationContext") or raw.get("generation_context") or {},
    )



def main() -> int:
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "error": "usage: render_ppt.py input.json output.pptx"}, ensure_ascii=False))
        return 2
    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    packet = json.loads(input_path.read_text(encoding="utf-8"))
    request = make_request(packet.get("request") or {})
    outline = packet.get("outline") or {}
    if not isinstance(outline, dict) or not isinstance(outline.get("slides"), list) or not outline["slides"]:
        print(json.dumps({"ok": False, "error": "outline is empty"}, ensure_ascii=False))
        return 1
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Keep the original template/section flow. Preview the actual output canvas,
    # rather than independently laying out the outline a second time.
    normalized = PptAgent.normalize_outline_for_layout(outline)
    agent = PptAgent(None, None, output_path.parent)
    agent.render(request, normalized, output_path)
    preview_path = Path(str(output_path) + ".preview.html")
    preview_path.write_text(
        preview_from_pptx(output_path, str(outline.get("title") or request.title)),
        encoding="utf-8",
        newline="\n",
    )
    design_path = Path(str(output_path) + ".json")
    design_path.write_text(json.dumps({"request": packet.get("request") or {}, "outline": normalized}, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    result = {
        "ok": True,
        "path": str(output_path),
        "previewPath": str(preview_path),
        "designPath": str(design_path),
        "slides": len(normalized.get("slides") or []),
        "title": str(outline.get("title") or request.title or request.requirement),
        "kinds": [str(s.get("kind") or "content") for s in (normalized.get("slides") or []) if isinstance(s, dict)],
        "notes": sum(1 for s in (normalized.get("slides") or []) if request.include_speaker_notes and isinstance(s, dict) and str(s.get("speakerNotes") or "").strip()),
        "backgroundStyle": request.background_style,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
