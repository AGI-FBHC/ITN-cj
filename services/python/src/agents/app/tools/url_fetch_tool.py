"""
URL Fetch Tool - 抓取网页并围绕 focus 用 LLM 提炼核心信息。
"""
import json
import re

import httpx
from bs4 import BeautifulSoup

from app.config import get_settings
from app.llm import LLMClient
from app.tools.base import BaseTool, register_tool

_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/120.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

_NOISE_TAGS = ["script", "style", "nav", "footer", "header", "aside", "noscript", "iframe", "form"]
_NOISE_LINE = re.compile(
    r"^(?:登录|注册|首页|搜索|关闭|发布|关注|举报|订阅|管理|控制台|建议反馈|"
    r"skip to content|sign(?:ed)? in|sign(?:ed)? out|reload|dismiss alert|"
    r"copy path|blame|history|preview|raw|download raw file|fork\s*\d*|star\s*\d*|"
    r"discord|whatsapp|wecom|上一篇|下一篇|相关推荐|热门文章|评论)\s*$",
    re.IGNORECASE,
)


@register_tool
class UrlFetchTool(BaseTool):
    """网页抓取与提炼：抓取指定 URL 并围绕用户关注点提炼信息。"""

    @property
    def id(self) -> str:
        return "url_fetch"

    @property
    def name(self) -> str:
        return "网页抓取与提炼"

    @property
    def description(self) -> str:
        return (
            "【网页抓取与提炼】当用户提供 URL、希望了解网页内容时使用。\n"
            "使用场景：\n"
            "- 用户给出一个链接，希望总结、翻译或回答有关内容的提问\n"
            "- 用户希望调研某个网页的具体方面（定价 / 技术 / 融资等）\n\n"
            "参数：\n"
            "- url: 必填，目标网页地址（必须以 http:// 或 https:// 开头）\n"
            "- focus: 可选，描述你想从页面里提炼的方向，例如「定价」「技术架构」"
            "「融资历程」。留空则提炼主要内容。"
        )

    @property
    def parameters_schema(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "目标网页 URL（必须以 http:// 或 https:// 开头）",
                },
                "focus": {
                    "type": "string",
                    "description": "提炼方向 / 关注点，例如「定价」「融资历程」",
                    "default": "主要内容",
                },
            },
            "required": ["url"],
        }

    async def execute(self, params: dict) -> dict:
        settings = get_settings()
        url = (params.get("url") or "").strip()
        focus = (params.get("focus") or "主要内容").strip() or "主要内容"
        max_length = settings.url_fetch_max_length

        if not url:
            return {"success": False, "error": "url parameter is required"}
        if not url.startswith(("http://", "https://")):
            return {"success": False, "error": "URL 必须以 http:// 或 https:// 开头"}

        try:
            async with httpx.AsyncClient(timeout=settings.url_fetch_timeout_seconds,
                                         follow_redirects=True, headers=_HEADERS) as client:
                response = await client.get(url)
                response.raise_for_status()
        except httpx.TimeoutException:
            return {"success": False, "error": f"请求超时：{url}"}
        except httpx.HTTPStatusError as exc:
            return {"success": False, "error": f"HTTP {exc.response.status_code}: {url}"}
        except httpx.HTTPError as exc:
            return {"success": False, "error": f"抓取失败：{exc}"}

        soup = BeautifulSoup(response.text, "html.parser")
        for tag in soup(_NOISE_TAGS):
            tag.decompose()
        title = soup.title.string.strip() if soup.title and soup.title.string else url
        raw_text = self._extract_article_text(soup)
        raw_text = raw_text[:max_length]
        if not raw_text:
            return {"success": False, "error": "未能从页面提取到正文内容", "url": url, "title": title}

        summary = await self._extract_with_llm(title, url, focus, raw_text)
        return {
            "success": True,
            "url": url,
            "title": title,
            "focus": focus,
            "content": raw_text,
            "summary": summary,
            "source": "url_fetch",
        }

    @staticmethod
    def _extract_article_text(soup: BeautifulSoup) -> str:
        """Extract knowledge-bearing article text and discard page chrome/recommendations."""
        selectors = (
            "article", "main", "[role='main']", ".markdown-body", ".article-content",
            ".post-content", ".entry-content", "#article_content", "#content_views",
        )
        candidates = [node for selector in selectors for node in soup.select(selector)]
        root = max(candidates, key=lambda node: len(node.get_text(" ", strip=True)), default=soup.body or soup)
        noise_selector = (
            "nav,footer,header,aside,form,.sidebar,.recommend,.recommendation,.related,.comments,"
            ".comment,.author-info,.user-info,.toolbar,.breadcrumb,.pagination,.advertisement,.ad"
        )
        for node in root.select(noise_selector):
            node.decompose()
        lines: list[str] = []
        seen: set[str] = set()
        for raw in root.get_text("\n").splitlines():
            line = re.sub(r"\s+", " ", raw).strip()
            if not line or _NOISE_LINE.match(line) or line in seen:
                continue
            if len(line) <= 24 and re.search(r"(?:浏览|阅读|点赞|收藏|评论|发表于|发布于|原创|作者|公众号|QQ群|Image\s*\d+)", line, re.I):
                continue
            seen.add(line)
            lines.append(line)
        return "\n".join(lines)

    @staticmethod
    async def _extract_with_llm(title: str, url: str, focus: str, raw_text: str) -> str:
        prompt = (
            "请从以下网页正文中提炼信息，严格输出 JSON：\n"
            "{\n"
            '  "summary": "100 字以内概括",\n'
            '  "key_points": ["要点1", "要点2", "要点3"],\n'
            '  "numbers": ["标签: 数值"],\n'
            '  "conclusion": "一句话结论或直接回答用户问题"\n'
            "}\n"
            "要求：\n"
            "1. summary 控制在 100 字以内\n"
            "2. key_points 只保留与用户关注点直接相关的 2-5 个要点\n"
            "3. numbers 列出页面中的关键数据（如价格、百分比、排名等），格式「标签: 数值」\n"
            "4. 保持原文事实绝不编造；无法提取时对应字段填 null\n"
            "5. conclusion 直接回答用户问题（如用户问价格就给价格，问涨跌就给涨跌）\n"
            "6. 总输出控制在 800 字以内\n\n"
            f"网页标题：{title}\n"
            f"用户关注点：{focus}\n\n"
            f"正文：\n{raw_text[:8000]}"
        )
        llm = LLMClient(get_settings())
        data = await llm.complete_json(
            "你是网页内容提炼助手。严格输出 JSON 格式，字段只填有效内容。",
            prompt,
            fallback={},
            reasoning_effort="low",
            provider="mimo",  # 与生成链路统一走 mimo，避免混入默认(kimi)提供方
        )
        summary = (data.get("summary") or "").strip()
        key_points = data.get("key_points") or []
        numbers = data.get("numbers") or []
        conclusion = (data.get("conclusion") or "").strip()

        parts = [part for part in (summary,) if part]
        if key_points:
            parts.append("【要点】")
            parts.extend(f"· {point}" for point in key_points if point)
        if numbers:
            parts.append("【数据】")
            parts.extend(f"· {number}" for number in numbers if number)
        if conclusion and conclusion != summary:
            parts.append(f"【结论】{conclusion}")
        if parts:
            return "\n".join(parts)
        return raw_text[:3000]
