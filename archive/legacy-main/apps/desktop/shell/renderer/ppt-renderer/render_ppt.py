"""Lumin PPT renderer: fixed Cangjie pipeline -> python-pptx compatibility renderer.

This file intentionally contains no LLM or network calls. It receives a verified
outline and a normalized request, then uses the legacy web renderer's layout
engine to produce a real .pptx file.
"""
from __future__ import annotations

import html
import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

from backgrounds import palette_for
from legacy_agent import PptAgent


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


def preview_html(outline: dict, request: SimpleNamespace | None = None) -> str:
    """Render a slide-shaped HTML preview for the candidate, not a text report."""
    slides = outline.get("slides") or []
    title = html.escape(str(outline.get("title") or "交互课件"))
    primary, surface, accent = palette_for(getattr(request, "background_style", "none") if request else "none")

    def point_html(point, index):
        if isinstance(point, dict):
            heading = html.escape(str(point.get("heading") or ""))
            detail = html.escape(str(point.get("detail") or ""))
            return ('<div class="point"><span class="num">' + str(index).zfill(2) + '</span>'
                    '<div><b>' + heading + '</b><p>' + detail + '</p></div></div>')
        return '<div class="point"><span class="num">' + str(index).zfill(2) + '</span><p>' + html.escape(str(point or "")) + '</p></div>'

    body = []
    for i, slide in enumerate(slides, 1):
        if not isinstance(slide, dict):
            continue
        kind = str(slide.get("kind") or "content").lower()
        is_edge = i == 1 or kind in ("section", "conclusion")
        bg, ink = (primary, "#ffffff") if is_edge else (surface, primary)
        if kind == "section":
            body.append(
                '<section class="slide edge section" style="background:' + bg + ';color:' + ink + '">'
                '<div class="kicker">CHAPTER ' + str(slide.get("sectionNumber") or 1).zfill(2) + '</div>'
                '<h2>' + html.escape(str(slide.get("title") or "本章")) + '</h2>'
                '<p class="section-topics">本章包括：' + html.escape("、".join(str(x) for x in (slide.get("sectionTopics") or [])[:4])) + '</p>'
                '<div class="page-no">' + str(i).zfill(2) + ' / ' + str(len(slides)).zfill(2) + '</div></section>'
            )
            continue
        if i == 1:
            body.append('<section class="slide edge cover" style="background:' + bg + ';color:' + ink + '">'
                        '<div class="kicker">' + html.escape(str((request.title if request else '') or title)) + '</div>'
                        '<h2>' + html.escape(str(slide.get("title") or title)) + '</h2>'
                        '<p class="subtitle">' + html.escape(str(outline.get("subtitle") or "核心概念、关键方法与实践应用")) + '</p>'
                        '<div class="page-no">' + str(i).zfill(2) + ' / ' + str(len(slides)).zfill(2) + '</div></section>')
            continue
        points = slide.get("points") or []
        point_markup = '<div class="points">' + ''.join(point_html(point, n + 1) for n, point in enumerate(points[:5])) + '</div>'
        extra = ''
        if slide.get("code") and isinstance(slide.get("code"), dict):
            code = html.escape(str(slide["code"].get("content") or ""))
            extra = '<pre class="code">' + code + '</pre>'
        elif slide.get("table") and isinstance(slide.get("table"), dict):
            table = slide["table"]
            headers = table.get("headers") or []
            rows = table.get("rows") or []
            extra = '<table><thead><tr>' + ''.join('<th>' + html.escape(str(x)) + '</th>' for x in headers) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join('<td>' + html.escape(str(x)) + '</td>' for x in row) + '</tr>' for row in rows[:5]) + '</tbody></table>'
        elif slide.get("process"):
            extra = '<div class="process">' + ''.join('<div><b>' + html.escape(str(p.get("label") or "")) + '</b><span>' + html.escape(str(p.get("detail") or "")) + '</span></div>' for p in slide["process"][:5] if isinstance(p, dict)) + '</div>'
        notes = html.escape(str(slide.get("speakerNotes") or ""))
        body.append('<section class="slide ' + kind + '" style="background:' + bg + ';color:' + ink + '">'
                    '<div class="kicker">' + str(i).zfill(2) + ' / ' + str(len(slides)).zfill(2) + ' · ' + html.escape(kind) + '</div>'
                    '<h2>' + html.escape(str(slide.get("title") or f"第 {i} 页")) + '</h2>' + point_markup + extra +
                    ('<aside><b>讲者备注</b><p>' + notes + '</p></aside>' if notes else '') +
                    '<div class="page-no">' + str(i).zfill(2) + ' / ' + str(len(slides)).zfill(2) + '</div></section>')
    css = (
        '<style>body{margin:0;background:#e9e9e5;font-family:"Microsoft YaHei",sans-serif;padding:18px}'
        '.slide{position:relative;aspect-ratio:16/9;max-width:1120px;margin:0 auto 22px;padding:5.4% 6%;box-sizing:border-box;overflow:hidden;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.13)}'
        '.kicker{font-size:clamp(10px,1.15vw,13px);letter-spacing:.12em;text-transform:uppercase;opacity:.62;font-weight:700}'
        'h2{font-size:clamp(22px,3.1vw,40px);line-height:1.25;margin:4% 0 4%;max-width:88%}'
        '.edge h2{font-size:clamp(25px,3.7vw,48px);margin-top:9%}.subtitle,.section-topics{font-size:clamp(12px,1.55vw,18px);line-height:1.6;opacity:.9;max-width:70%}'
        '.points{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 18px;margin-top:2%}.point{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.74);color:#26332d;box-shadow:0 2px 8px rgba(0,0,0,.035)}'
        '.point .num{flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:' + accent + ';color:' + primary + ';font-size:11px;font-weight:700}.point b{font-size:clamp(11px,1.15vw,15px);display:block;margin-bottom:3px}.point p{font-size:clamp(10px,1vw,13px);line-height:1.55;margin:0;opacity:.88}'
        '.code{margin:2% 0 0;padding:12px 14px;border-radius:9px;background:#17221d;color:#dce9df;font-size:clamp(9px,.85vw,12px);line-height:1.45;max-height:31%;overflow:hidden}'
        'table{width:100%;border-collapse:collapse;margin-top:2%;background:rgba(255,255,255,.78);color:#26332d;font-size:clamp(10px,1vw,13px)}th,td{border:1px solid #d4ddd7;padding:8px;text-align:left}th{background:' + primary + ';color:white}'
        '.process{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:3%}.process div{padding:10px;border-radius:8px;background:rgba(255,255,255,.76);color:#26332d}.process b{display:block;font-size:13px;margin-bottom:4px}.process span{font-size:11px;line-height:1.45}'
        'aside{position:absolute;left:6%;right:6%;bottom:5.3%;padding:8px 12px;border-left:3px solid ' + accent + ';background:rgba(255,255,255,.72);color:#33433b;font-size:clamp(9px,.9vw,12px);line-height:1.5;max-height:16%;overflow:hidden}aside b{font-size:10px;letter-spacing:.08em}aside p{margin:2px 0 0}'
        '.page-no{position:absolute;right:6%;bottom:5.5%;font-size:clamp(10px,1vw,13px);opacity:.65}.edge .page-no{color:inherit}'
        '@media(max-width:700px){body{padding:8px}.slide{padding:7% 6%;border-radius:5px}.points{grid-template-columns:1fr;gap:6px}.point{padding:7px}.point p{display:none}.process{grid-template-columns:repeat(2,1fr)}}'
        '</style>'
    )
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>' + title + '</title>' + css + ''.join(body) + '</html>')


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
    # 旧网页版会在章节之间补 section 页；用同一份归一化提纲生成预览，
    # 避免候选页数和 PowerPoint 实际页数对不上。
    normalized = PptAgent.normalize_outline_for_layout(outline)
    agent = PptAgent(None, None, output_path.parent)
    agent.render(request, normalized, output_path)
    preview_path = Path(str(output_path) + ".preview.html")
    preview_path.write_text(preview_html(normalized, request), encoding="utf-8", newline="\n")
    design_path = Path(str(output_path) + ".json")
    design_path.write_text(json.dumps({"request": packet.get("request") or {}, "outline": normalized}, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    result = {
        "ok": True,
        "path": str(output_path),
        "previewPath": str(preview_path),
        "designPath": str(design_path),
        "slides": len(outline.get("slides") or []),
        "title": str(outline.get("title") or request.title or request.requirement),
        "kinds": [str(s.get("kind") or "content") for s in (outline.get("slides") or []) if isinstance(s, dict)],
        "notes": sum(1 for s in (outline.get("slides") or []) if isinstance(s, dict) and str(s.get("speakerNotes") or "").strip()),
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
