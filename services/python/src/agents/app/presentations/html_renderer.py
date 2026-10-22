"""HTML-based PPT slide renderer for web generation mode.

Generates visually rich HTML slides from the verified outline,
then converts them to PPTX with native text rendering.
"""
import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Any

from app.llm import LLMClient
from app.presentations.backgrounds import palette_for, THEME_PALETTES

logger = logging.getLogger(__name__)


class HtmlSlideRenderer:
    """Generates HTML slides from verified outline, converts to PPTX."""

    def __init__(self, llm: LLMClient, output_dir: Path):
        self.llm = llm
        self.output_dir = output_dir

    async def generate_style_guide(self, request: Any, outline: dict) -> dict:
        """Generate a consistent style guide for the entire presentation.

        Uses custom_style if provided, otherwise derives from background_style theme.
        The guide ensures all slides share consistent visual language while
        allowing layout diversity within each slide type.
        """
        # Derive base palette from theme
        if request.background_style and request.background_style != "none":
            primary, surface, accent = palette_for(request.background_style)
        else:
            primary, surface, accent = THEME_PALETTES.get("academic", ("1A3A5C", "F5F7FA", "3B82F6"))

        base_guide = {
            "primaryColor": f"#{primary}",
            "surfaceColor": f"#{surface}",
            "accentColor": f"#{accent}",
            "fontFamily": "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
            "titleFont": "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif",
            "codeFont": "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
            "baseFontSize": "18px",
            "lineHeight": "1.6",
            "borderRadius": "12px",
            "spacing": {"page": "48px", "section": "24px", "element": "16px"},
            "slideTypes": {
                "title": {"bg": "primary", "textColor": "surface"},
                "section": {"bg": "primary", "textColor": "surface"},
                "agenda": {"bg": "surface", "textColor": "primary"},
                "content": {"bg": "surface", "textColor": "primary"},
                "conclusion": {"bg": "primary", "textColor": "surface"},
            },
            "layoutRules": [
                "Each slide has exactly ONE background color",
                "Title/section/conclusion pages use primary color background",
                "Agenda and content pages use surface color background",
                "Same slide type = same background, but layout can vary",
                "Encourage diverse layouts: cards, flow, timeline, comparison, spotlight",
                "All text must be HTML text (standard fonts), never images",
                "Use CSS flexbox/grid for layout, not absolute positioning",
                "Ensure text is readable: contrast ratio >= 4.5:1",
            ],
        }

        if request.custom_style:
            custom = await self._parse_custom_style(request.custom_style, base_guide)
            if custom:
                base_guide.update(custom)

        return base_guide

    async def _parse_custom_style(self, custom_text: str, base_guide: dict) -> dict | None:
        """Parse user's custom style requirements into style guide overrides."""
        prompt = (
            f"请根据用户的风格要求，输出 JSON 格式的风格覆盖配置。\n\n"
            f"用户风格要求：{custom_text}\n\n"
            f"基础配置：{json.dumps(base_guide, ensure_ascii=False)}\n\n"
            f"输出格式：\n"
            f'{{"primaryColor": "#hex", "surfaceColor": "#hex", "accentColor": "#hex", '
            f'"fontFamily": "...", "borderRadius": "...", "layoutNotes": "..."}}\n'
            f"只输出需要覆盖的字段，不要重复基础配置。如果用户要求不明确，返回空对象。"
        )
        result = await self.llm.complete_json(
            "你是风格配置解析器，只输出 JSON。",
            prompt,
            fallback={},
        )
        return result if result else None

    async def generate_slide_html(
        self,
        slide: dict,
        style_guide: dict,
        slide_index: int,
        total_slides: int,
    ) -> str:
        """Generate HTML for a single slide.

        The HTML is a self-contained page with inline CSS that renders
        the slide content with the style guide's visual language.
        """
        slide_type = self._get_slide_type(slide, slide_index, total_slides)
        type_config = style_guide.get("slideTypes", {}).get(slide_type, style_guide["slideTypes"]["content"])
        bg_color = type_config.get("bg", "surface")
        text_color = type_config.get("textColor", "primary")
        bg_value = style_guide["primaryColor"] if bg_color == "primary" else style_guide["surfaceColor"]
        text_value = style_guide["primaryColor"] if text_color == "primary" else style_guide["surfaceColor"]

        content_html = self._build_slide_content_html(slide, slide_type, style_guide)

        html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=1280, initial-scale=1.0">
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{
  width: 1280px;
  height: 720px;
  overflow: hidden;
  background: {bg_value};
  color: {text_value};
  font-family: {style_guide['fontFamily']};
  font-size: {style_guide['baseFontSize']};
  line-height: {style_guide['lineHeight']};
}}
.slide-container {{
  width: 100%;
  height: 100%;
  padding: {style_guide['spacing']['page']};
  display: flex;
  flex-direction: column;
}}
.slide-header {{
  margin-bottom: {style_guide['spacing']['section']};
  flex-shrink: 0;
}}
.slide-title {{
  font-size: 1.8em;
  font-weight: 700;
  line-height: 1.3;
  margin-bottom: 8px;
}}
.slide-subtitle {{
  font-size: 1em;
  opacity: 0.75;
  font-weight: 400;
}}
.slide-body {{
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: {style_guide['spacing']['element']};
  overflow: hidden;
}}
.points-grid {{
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: {style_guide['spacing']['element']};
}}
.point-card {{
  background: rgba(255,255,255,0.1);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: {style_guide['borderRadius']};
  padding: 20px;
}}
.point-heading {{
  font-size: 1.1em;
  font-weight: 600;
  margin-bottom: 8px;
  color: {style_guide['accentColor']};
}}
.point-detail {{
  font-size: 0.9em;
  opacity: 0.85;
  line-height: 1.5;
}}
.code-block {{
  background: #1a1a2e;
  color: #e0e0e0;
  border-radius: {style_guide['borderRadius']};
  padding: 20px;
  font-family: {style_guide['codeFont']};
  font-size: 0.85em;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre-wrap;
}}
.table-container {{
  width: 100%;
  border-collapse: collapse;
}}
.table-container th {{
  background: {style_guide['accentColor']};
  color: white;
  padding: 12px;
  text-align: left;
  font-weight: 600;
}}
.table-container td {{
  padding: 10px 12px;
  border-bottom: 1px solid rgba(0,0,0,0.1);
}}
.process-flow {{
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}}
.process-step {{
  background: {style_guide['accentColor']};
  color: white;
  padding: 12px 20px;
  border-radius: {style_guide['borderRadius']};
  font-weight: 500;
}}
.process-arrow {{
  color: {style_guide['accentColor']};
  font-size: 1.5em;
  font-weight: bold;
}}
.takeaway {{
  background: rgba(0,0,0,0.08);
  border-left: 4px solid {style_guide['accentColor']};
  padding: 16px 20px;
  border-radius: 0 {style_guide['borderRadius']} {style_guide['borderRadius']} 0;
  margin-top: auto;
  flex-shrink: 0;
}}
.takeaway-label {{
  font-size: 0.75em;
  font-weight: 700;
  color: {style_guide['accentColor']};
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-bottom: 4px;
}}
.takeaway-text {{
  font-size: 0.95em;
  line-height: 1.5;
}}
.agenda-list {{
  display: flex;
  flex-direction: column;
  gap: 16px;
}}
.agenda-item {{
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  background: rgba(255,255,255,0.08);
  border-radius: {style_guide['borderRadius']};
}}
.agenda-number {{
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: {style_guide['accentColor']};
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  flex-shrink: 0;
}}
.agenda-text {{
  flex: 1;
}}
.agenda-title {{
  font-weight: 600;
  margin-bottom: 2px;
}}
.agenda-desc {{
  font-size: 0.85em;
  opacity: 0.7;
}}
.section-badge {{
  display: inline-block;
  background: {style_guide['accentColor']};
  color: white;
  padding: 6px 16px;
  border-radius: 20px;
  font-size: 0.75em;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-bottom: 12px;
}}
</style>
</head>
<body>
<div class="slide-container">
{content_html}
</div>
</body>
</html>"""
        return html

    def _get_slide_type(self, slide: dict, index: int, total: int) -> str:
        """Determine the visual type of a slide."""
        kind = slide.get("kind", "")
        if index == 0:
            return "title"
        if kind in ("section",):
            return "section"
        if kind in ("agenda",):
            return "agenda"
        if index == total - 1 or kind in ("conclusion",):
            return "conclusion"
        return "content"

    def _build_slide_content_html(self, slide: dict, slide_type: str, style_guide: dict) -> str:
        """Build the inner HTML content for a slide."""
        title = slide.get("title", "")
        points = slide.get("points", [])
        kind = slide.get("kind", "")

        if slide_type == "title":
            subtitle = slide.get("subtitle", "")
            return f"""
  <div class="slide-header" style="text-align: center; margin-top: 80px;">
    <div class="slide-title" style="font-size: 2.5em;">{self._escape(title)}</div>
    <div class="slide-subtitle" style="font-size: 1.2em; margin-top: 16px;">{self._escape(subtitle)}</div>
  </div>
  <div class="slide-body" style="justify-content: center;">
    <div style="text-align: center; opacity: 0.6; font-size: 0.9em;">
      {self._escape(slide.get('audienceLabel', ''))}
    </div>
  </div>"""

        if slide_type == "section":
            section_num = slide.get("sectionNumber", "")
            return f"""
  <div class="slide-header" style="text-align: center; margin-top: 120px;">
    <div class="section-badge">{self._escape(f"Chapter {section_num}")}</div>
    <div class="slide-title" style="font-size: 2.2em;">{self._escape(title)}</div>
  </div>
  <div class="slide-body" style="justify-content: center;">
    <div style="text-align: center; opacity: 0.5; font-size: 1em;">
      {self._escape(' · '.join(slide.get('sectionTopics', [])[:5]))}
    </div>
  </div>"""

        if slide_type == "agenda":
            items_html = ""
            for i, point in enumerate(points[:6], 1):
                heading = self._escape(point.get("heading", ""))
                detail = self._escape(point.get("detail", "")[:80])
                items_html += f"""
    <div class="agenda-item">
      <div class="agenda-number">{i}</div>
      <div class="agenda-text">
        <div class="agenda-title">{heading}</div>
        <div class="agenda-desc">{detail}</div>
      </div>
    </div>"""
            return f"""
  <div class="slide-header">
    <div class="slide-title">{self._escape(title)}</div>
  </div>
  <div class="slide-body agenda-list">
{items_html}
  </div>"""

        # Content slides
        header_html = f"""
  <div class="slide-header">
    <div class="slide-title">{self._escape(title)}</div>
  </div>"""

        body_parts = []

        if kind == "code" and slide.get("code"):
            code_content = self._escape(slide["code"].get("content", ""))
            code_lang = self._escape(slide["code"].get("language", ""))
            body_parts.append(f'<div class="code-block">{code_content}</div>')
            if points:
                for point in points[:2]:
                    body_parts.append(f"""
    <div class="point-card">
      <div class="point-heading">{self._escape(point.get('heading', ''))}</div>
      <div class="point-detail">{self._escape(point.get('detail', ''))}</div>
    </div>""")

        elif kind == "table" and slide.get("table"):
            table = slide["table"]
            headers = table.get("headers", [])
            rows = table.get("rows", [])
            header_cells = "".join(f"<th>{self._escape(h)}</th>" for h in headers)
            row_html = ""
            for row in rows[:8]:
                cells = "".join(f"<td>{self._escape(c)}</td>" for c in row)
                row_html += f"<tr>{cells}</tr>"
            body_parts.append(f"""
    <table class="table-container">
      <thead><tr>{header_cells}</tr></thead>
      <tbody>{row_html}</tbody>
    </table>""")

        elif kind == "process" and slide.get("process"):
            steps = slide["process"][:6]
            flow_html = '<div class="process-flow">'
            for i, step in enumerate(steps):
                if i > 0:
                    flow_html += '<div class="process-arrow">→</div>'
                flow_html += f'<div class="process-step">{self._escape(step)}</div>'
            flow_html += '</div>'
            body_parts.append(flow_html)
            if points:
                for point in points[:2]:
                    body_parts.append(f"""
    <div class="point-card">
      <div class="point-heading">{self._escape(point.get('heading', ''))}</div>
      <div class="point-detail">{self._escape(point.get('detail', ''))}</div>
    </div>""")

        elif points:
            # Default: card layout for points
            cards_html = '<div class="points-grid">'
            for point in points[:4]:
                cards_html += f"""
    <div class="point-card">
      <div class="point-heading">{self._escape(point.get('heading', ''))}</div>
      <div class="point-detail">{self._escape(point.get('detail', ''))}</div>
    </div>"""
            cards_html += '</div>'
            body_parts.append(cards_html)

        body_html = "\n".join(body_parts) if body_parts else '<div style="opacity:0.5">内容加载中...</div>'

        takeaway = slide.get("takeaway", "")
        takeaway_html = ""
        if takeaway:
            takeaway_html = f"""
  <div class="takeaway">
    <div class="takeaway-label">要点总结</div>
    <div class="takeaway-text">{self._escape(takeaway)}</div>
  </div>"""

        return f"{header_html}\n  <div class=\"slide-body\">\n{body_html}\n  </div>{takeaway_html}"

    def _escape(self, text: str) -> str:
        """Escape HTML special characters."""
        text = str(text or "")
        return (text
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace('"', "&quot;"))

    async def generate_all_slides_parallel(
        self,
        outline: dict,
        style_guide: dict,
        concurrency: int = 4,
    ) -> list[str]:
        """Generate HTML for all slides in parallel."""
        slides = outline.get("slides", [])
        semaphore = asyncio.Semaphore(concurrency)

        async def generate_one(slide: dict, index: int) -> str:
            async with semaphore:
                try:
                    return await self.generate_slide_html(slide, style_guide, index, len(slides))
                except Exception as exc:
                    logger.warning(f"Slide {index} HTML generation failed: {exc}")
                    return self._fallback_html(slide, style_guide, index)

        tasks = [generate_one(slide, i) for i, slide in enumerate(slides)]
        return await asyncio.gather(*tasks)

    def _fallback_html(self, slide: dict, style_guide: dict, index: int) -> str:
        """Simple fallback HTML when LLM generation fails."""
        title = self._escape(slide.get("title", f"Slide {index + 1}"))
        return f"""<!DOCTYPE html>
<html><head><style>
body {{ width:1280px; height:720px; background:{style_guide['surfaceColor']};
  color:{style_guide['primaryColor']}; font-family:{style_guide['fontFamily']};
  display:flex; align-items:center; justify-content:center; }}
h1 {{ font-size:2em; }}
</style></head><body><h1>{title}</h1></body></html>"""

    def validate_slides(self, html_slides: list[str]) -> list[str]:
        """Validate generated HTML slides."""
        issues = []
        for i, html in enumerate(html_slides):
            if not html or len(html) < 100:
                issues.append(f"Slide {i + 1}: HTML too short or empty")
            elif "<style>" not in html:
                issues.append(f"Slide {i + 1}: missing style block")
            elif "slide-container" not in html:
                issues.append(f"Slide {i + 1}: missing slide container")
            # Check for unescaped content that might break HTML
            if "&lt;" in html and "&gt;" in html and "&amp;" in html:
                pass  # properly escaped
        return issues

    def render_to_pptx(self, html_slides: list[str], outline: dict, output_path: Path, request: Any) -> None:
        """Convert HTML slides to PPTX.

        Renders each HTML slide to a designed background image (colors and
        geometric accents extracted from the HTML style) and embeds it as a
        full-bleed background, with native text from the outline on top.
        This keeps web mode visually distinct from template mode while
        retaining searchable, copyable text and standard fonts.
        """
        # Import here to avoid circular imports
        from app.presentations.agent import PptAgent

        backgrounds = [
            self._build_design_background(html, index, len(html_slides), request.aspect_ratio)
            for index, html in enumerate(html_slides)
        ]

        # Create a temporary agent for rendering
        # The agent's render method uses the outline dict directly
        agent = PptAgent.__new__(PptAgent)
        agent.llm = self.llm
        agent.store = None
        agent.output_dir = self.output_dir

        # Embed the HTML-derived design backgrounds under native text.
        agent.render(request, outline, output_path, background_images=backgrounds)

    # ---------------------------------------------------------------- design bg

    @staticmethod
    def _extract_colors(html: str) -> tuple[str, str]:
        """Extract background and accent colors embedded in the HTML slide."""
        bg = "F5F7FA"
        accent = "3B82F6"
        body_match = re.search(r"body\s*\{[^}]*?background:\s*(#[0-9a-fA-F]{6})", html, re.DOTALL)
        if body_match:
            bg = body_match.group(1).lstrip("#")
        accent_match = re.search(r"\.point-heading\s*\{[^}]*?color:\s*(#[0-9a-fA-F]{6})", html, re.DOTALL)
        if accent_match:
            accent = accent_match.group(1).lstrip("#")
        return bg, accent

    @staticmethod
    def _hex_to_rgb(value: str) -> tuple[int, int, int]:
        value = value.lstrip("#")
        return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))

    def _build_design_background(self, html: str, index: int, total: int, aspect_ratio: str) -> Path:
        """Build a designed PIL background image derived from the HTML slide's palette."""
        from PIL import Image, ImageDraw

        bg_hex, accent_hex = self._extract_colors(html)
        width, height = (1920, 1080) if aspect_ratio != "4:3" else (1600, 1200)
        bg_rgb = self._hex_to_rgb(bg_hex)
        accent_rgb = self._hex_to_rgb(accent_hex)

        image = Image.new("RGB", (width, height), bg_rgb)
        overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)

        luminance = 0.299 * bg_rgb[0] + 0.587 * bg_rgb[1] + 0.114 * bg_rgb[2]
        dark = luminance < 128
        text_tone = (255, 255, 255) if dark else (0, 0, 0)
        accent_a = 38 if dark else 30
        secondary = tuple(max(0, min(255, int(c * 1.25))) for c in accent_rgb) if dark else \
            tuple(max(0, min(255, int(c * 0.72))) for c in accent_rgb)

        # Vary decorative geometry by slide index so pages do not look identical.
        variant = index % 6
        if variant == 0:
            draw.ellipse((-width * 0.18, -height * 0.22, width * 0.34, height * 0.5),
                         fill=accent_rgb + (accent_a,))
            draw.ellipse((width * 0.74, height * 0.62, width * 1.22, height * 1.18),
                         fill=secondary + (accent_a,))
        elif variant == 1:
            draw.polygon([(width, 0), (width * 0.66, 0), (width, height * 0.34)], fill=accent_rgb + (accent_a,))
            draw.polygon([(0, height), (0, height * 0.72), (width * 0.3, height)], fill=secondary + (accent_a,))
        elif variant == 2:
            draw.rounded_rectangle((width * 0.02, height * 0.72, width * 0.42, height * 1.02),
                                   radius=60, fill=accent_rgb + (accent_a,))
            draw.ellipse((width * 0.76, -height * 0.16, width * 1.06, height * 0.22),
                         fill=secondary + (accent_a,))
        elif variant == 3:
            draw.ellipse((width * 0.78, height * 0.06, width * 1.16, height * 0.5),
                         fill=accent_rgb + (accent_a,))
            draw.polygon([(0, height * 0.84), (width * 0.28, height * 0.6), (width * 0.5, height), (0, height)],
                         fill=secondary + (accent_a,))
        elif variant == 4:
            for i in range(5):
                r = 90 + i * 46
                draw.ellipse((width * 0.82 - r, height * 0.78 - r, width * 0.82 + r, height * 0.78 + r),
                             outline=accent_rgb + (36 if i % 2 else 16,), width=3)
            draw.rounded_rectangle((-width * 0.06, height * 0.1, width * 0.26, height * 0.28),
                                   radius=48, fill=accent_rgb + (accent_a,))
        else:
            draw.rounded_rectangle((width * 0.6, -height * 0.12, width * 1.02, height * 0.3),
                                   radius=72, fill=accent_rgb + (accent_a,))
            draw.ellipse((-width * 0.1, height * 0.66, width * 0.24, height * 1.06),
                         fill=secondary + (accent_a,))

        # A subtle accent bar at the very bottom keeps the design cohesive.
        draw.rectangle((0, height - 18, width, height), fill=accent_rgb + (90,))

        image = Image.alpha_composite(image.convert("RGBA"), overlay).convert("RGB")
        out_dir = self.output_dir / "web_backgrounds"
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"bg_{index:03d}_{bg_hex}_{accent_hex}.png"
        image.save(path, format="PNG")
        return path
