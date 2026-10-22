from bs4 import BeautifulSoup

from app.tools.url_fetch_tool import UrlFetchTool


def test_article_extractor_discards_navigation_author_and_recommendations():
    soup = BeautifulSoup("""
      <html><body>
        <nav>首页 登录 注册</nav>
        <main>
          <article>
            <div class="author-info">原创 MarkX 关注作者 2.7K 人浏览</div>
            <h1>传统 Agent 与 LLM Agent 的差异</h1>
            <p>传统 Agent 依赖预设规则处理确定性任务。</p>
            <p>LLM Agent 能结合上下文动态规划并调用工具。</p>
            <div class="recommend">相关推荐：如何用 Python 制作贪吃蛇</div>
          </article>
        </main>
        <footer>Discord WhatsApp WeCom</footer>
      </body></html>
    """, "html.parser")
    text = UrlFetchTool._extract_article_text(soup)
    assert "传统 Agent 依赖预设规则" in text
    assert "LLM Agent 能结合上下文" in text
    assert "关注作者" not in text
    assert "贪吃蛇" not in text
    assert "Discord" not in text
