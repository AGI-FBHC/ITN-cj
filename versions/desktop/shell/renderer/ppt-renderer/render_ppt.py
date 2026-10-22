from __future__ import annotations

import base64
import html
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

from backgrounds import palette_for, select_backgrounds
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


def _css_color(value: str) -> str:
    text = str(value or "").strip()
    return text if text.startswith("#") else "#" + text.lstrip("#")


def _data_url(path: Path | None) -> str:
    if path is None or not path.is_file():
        return ""
    suffix = path.suffix.lower()
    mime = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(suffix, "application/octet-stream")
    payload = base64.b64encode(path.read_bytes()).decode("ascii")
    return "data:" + mime + ";base64," + payload


def _powerpoint_preview_images(pptx_path: Path) -> list[str]:
    """Return exact slide JPEGs as data URLs when desktop PowerPoint is present."""
    if sys.platform != "win32":
        return []
    powerpoints = [
        Path(r"C:\Program Files\Microsoft Office\root\Office16\POWERPNT.EXE"),
        Path(r"C:\Program Files (x86)\Microsoft Office\root\Office16\POWERPNT.EXE"),
    ]
    if not any(path.is_file() for path in powerpoints):
        return []
    with tempfile.TemporaryDirectory(prefix="lumin-ppt-preview-") as temp_dir:
        out_dir = Path(temp_dir)
        quoted_file = str(pptx_path.resolve()).replace("'", "''")
        quoted_dir = str(out_dir.resolve()).replace("'", "''")
        script = r"""
$ErrorActionPreference = 'Stop'
$ppt = $null
$deck = $null
try {
  $ppt = New-Object -ComObject PowerPoint.Application
  $deck = $ppt.Presentations.Open('__FILE__', $true, $false, $false)
  for ($i = 1; $i -le $deck.Slides.Count; $i++) {
    $target = Join-Path '__DIR__' ('slide-{0:D3}.jpg' -f $i)
    $deck.Slides.Item($i).Export($target, 'JPG', 1600, 900)
  }
}
finally {
  if ($null -ne $deck) { try { $deck.Close() } catch {} }
  if ($null -ne $ppt) { try { $ppt.Quit() } catch {} }
}
""".replace("__FILE__", quoted_file).replace("__DIR__", quoted_dir)
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        try:
            result = subprocess.run(
                ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                capture_output=True,
                text=True,
                timeout=45,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if result.returncode != 0:
                return []
            return [_data_url(path) for path in sorted(out_dir.glob("slide-*.jpg")) if path.is_file()]
        except Exception:
            return []


def _exact_preview_html(outline: dict, images: list[str]) -> str:
    slides = outline.get("slides") or []
    title = html.escape(str(outline.get("title") or "PPT 演示"))
    sections: list[str] = []
    for index, image in enumerate(images):
        label = ""
        if index < len(slides) and isinstance(slides[index], dict):
            label = str(slides[index].get("title") or "")
        sections.append(
            '<section class="slide ppt-rendered" data-title="' + html.escape(label, quote=True) + '">'
            '<img src="' + image + '" alt="' + html.escape(label or f"第 {index + 1} 页", quote=True) + '">'
            '</section>'
        )
    return (
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + title + '</title>'
        '<style>body{margin:0;background:#deded9;font-family:"Microsoft YaHei",sans-serif;padding:18px}'
        '.slide{position:relative;width:100%;max-width:1200px;aspect-ratio:16/9;margin:0 auto 22px;overflow:hidden;border-radius:8px;background:#fff;box-shadow:0 18px 44px rgba(0,0,0,.16)}'
        '.slide img{display:block;width:100%;height:100%;object-fit:contain;background:#fff}'
        '@media(max-width:700px){body{padding:8px}.slide{margin-bottom:10px;border-radius:5px}}</style></head><body>'
        + ''.join(sections) + '</body></html>'
    )


def preview_html(outline: dict, request: SimpleNamespace | None = None, seed_text: str = "preview") -> str:
    """Fallback slide-shaped preview using the same full-bleed backgrounds."""
    slides = outline.get("slides") or []
    title = html.escape(str(outline.get("title") or "交互课件"))
    primary, surface, accent = palette_for(getattr(request, "background_style", "none") if request else "none")
    primary, surface, accent = _css_color(primary), _css_color(surface), _css_color(accent)
    backgrounds = select_backgrounds(getattr(request, "background_style", "none") if request else "none", seed_text)
    background_urls = {role: _data_url(path) for role, path in backgrounds.items()}

    def point_html(point, index):
        if isinstance(point, dict):
            heading = html.escape(str(point.get("heading") or ""))
            detail = html.escape(str(point.get("detail") or ""))
            return ('<div class="point"><span class="num">' + str(index).zfill(2) + '</span>'
                    '<div><b>' + heading + '</b><p>' + detail + '</p></div></div>')
        return '<div class="point"><span class="num">' + str(index).zfill(2) + '</span><p>' + html.escape(str(point or "")) + '</p></div>'

    def slide_style(role: str, edge: bool) -> str:
        base = primary if edge else surface
        url = background_urls.get(role, "")
        if not url:
            return 'background:' + base + ';color:' + ('#ffffff' if edge else primary)
        veil = 'rgba(15,27,22,.38)' if edge else 'rgba(255,255,255,.28)'
        return ("background-image:linear-gradient(" + veil + "," + veil + "),url('" + url + "');"
                "background-size:cover;background-position:center;color:" + ('#ffffff' if edge else primary))

    body = []
    for i, slide in enumerate(slides, 1):
        if not isinstance(slide, dict):
            continue
        kind = str(slide.get("kind") or "content").lower()
        is_section = kind == "section"
        is_edge = i == 1 or kind in ("section", "conclusion")
        role = "cover" if i == 1 else "section" if is_section or i == len(slides) else "agenda" if kind == "agenda" else "content"
        style = slide_style(role, is_edge)
        if is_section:
            body.append(
                '<section class="slide edge section" style="' + style + '">'
                '<div class="kicker">CHAPTER ' + str(slide.get("sectionNumber") or 1).zfill(2) + '</div>'
                '<h2>' + html.escape(str(slide.get("title") or "本章")) + '</h2>'
                '<p class="section-topics">本章包括：' + html.escape("、".join(str(x) for x in (slide.get("sectionTopics") or [])[:4])) + '</p>'
                '<div class="page-no">' + str(i).zfill(2) + ' / ' + str(len(slides)).zfill(2) + '</div></section>'
            )
            continue
        if i == 1:
            body.append('<section class="slide edge cover" style="' + style + '">'
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
        body.append('<section class="slide ' + kind + '" style="' + style + '">'
                    '<div class="kicker">' + str(i).zfill(2) + ' / ' + str(len(slides)).zfill(2) + ' · ' + html.escape(kind) + '</div>'
                    '<h2>' + html.escape(str(slide.get("title") or f"第 {i} 页")) + '</h2>' + point_markup + extra +
                    '<div class="page-no">' + str(i).zfill(2) + ' / ' + str(len(slides)).zfill(2) + '</div></section>')
    css = (
        '<style>body{margin:0;background:#deded9;font-family:"Microsoft YaHei",sans-serif;padding:18px}'
        '.slide{position:relative;aspect-ratio:16/9;max-width:1200px;margin:0 auto 22px;padding:5.4% 6%;box-sizing:border-box;overflow:hidden;border-radius:8px;box-shadow:0 18px 44px rgba(0,0,0,.16)}'
        '.kicker{font-size:clamp(10px,1.15vw,13px);letter-spacing:.12em;text-transform:uppercase;opacity:.72;font-weight:700}'
        'h2{font-size:clamp(22px,3.1vw,40px);line-height:1.25;margin:4% 0 4%;max-width:88%;text-shadow:0 1px 3px rgba(0,0,0,.18)}'
        '.edge h2{font-size:clamp(25px,3.7vw,48px);margin-top:9%}.subtitle,.section-topics{font-size:clamp(12px,1.55vw,18px);line-height:1.6;opacity:.92;max-width:70%}'
        '.points{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 18px;margin-top:2%}.point{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:10px;background:rgba(255,255,255,.82);color:#26332d;box-shadow:0 3px 12px rgba(0,0,0,.06)}'
        '.point .num{flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:' + accent + ';color:' + primary + ';font-size:11px;font-weight:700}.point b{font-size:clamp(11px,1.15vw,15px);display:block;margin-bottom:3px}.point p{font-size:clamp(10px,1vw,13px);line-height:1.55;margin:0;opacity:.88}'
        '.code{margin:2% 0 0;padding:12px 14px;border-radius:9px;background:rgba(18,28,23,.92);color:#dce9df;font-size:clamp(9px,.85vw,12px);line-height:1.45;max-height:31%;overflow:hidden}'
        'table{width:100%;border-collapse:collapse;margin-top:2%;background:rgba(255,255,255,.86);color:#26332d;font-size:clamp(10px,1vw,13px)}th,td{border:1px solid #d4ddd7;padding:8px;text-align:left}th{background:' + primary + ';color:white}'
        '.process{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:3%}.process div{padding:10px;border-radius:8px;background:rgba(255,255,255,.84);color:#26332d}.process b{display:block;font-size:13px;margin-bottom:4px}.process span{font-size:11px;line-height:1.45}'
        '.page-no{position:absolute;right:6%;bottom:5.5%;font-size:clamp(10px,1vw,13px);opacity:.72}.edge .page-no{color:inherit}'
        '@media(max-width:700px){body{padding:8px}.slide{padding:7% 6%;border-radius:5px;margin-bottom:10px}.points{grid-template-columns:1fr;gap:6px}.point{padding:7px}.point p{display:none}.process{grid-template-columns:repeat(2,1fr)}}'
        '</style>'
    )
    return ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + title + '</title>' + css + '</head><body>' + ''.join(body) + '</body></html>')


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
    normalized = PptAgent.normalize_outline_for_layout(outline)
    agent = PptAgent(None, None, output_path.parent)
    agent.render(request, normalized, output_path)
    preview_path = Path(str(output_path) + ".preview.html")
    exact_images = _powerpoint_preview_images(output_path)
    preview_path.write_text(
        _exact_preview_html(normalized, exact_images) if exact_images else preview_html(normalized, request, output_path.stem),
        encoding="utf-8",
        newline="\n",
    )
    design_path = Path(str(output_path) + ".json")
    design_path.write_text(json.dumps({"request": packet.get("request") or {}, "outline": normalized}, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    normalized_slides = [s for s in (normalized.get("slides") or []) if isinstance(s, dict)]
    requested_slides = len(outline.get("slides") or [])
    rendered_slides = len(normalized_slides)
    result = {
        "ok": True,
        "path": str(output_path),
        "previewPath": str(preview_path),
        "designPath": str(design_path),
        "requestedSlides": requested_slides,
        "renderedSlides": rendered_slides,
        "slides": rendered_slides,
        "title": str(normalized.get("title") or outline.get("title") or request.title or request.requirement),
        "kinds": [str(s.get("kind") or "content") for s in normalized_slides],
        "notes": sum(1 for s in normalized_slides if str(s.get("speakerNotes") or "").strip()),
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
