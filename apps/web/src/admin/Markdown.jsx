import * as React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';

marked.setOptions({ gfm: true, breaks: true });

// 先把公式抽出来占位，Markdown 渲染完再换成 KaTeX 的 HTML。
// 这样模型输出里的 $...$ / $$...$$ / \(...\) / \[...\] 都能正确排版。
const MATH_PATTERN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^\s$][^$\n]*?)\$|\\\(([\s\S]+?)\\\)/g;

function renderMath(tex, displayMode) {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode,
      throwOnError: false,
      strict: false,
      output: 'html',
    });
  } catch {
    return `<code>${tex.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</code>`;
  }
}

export default function Markdown({ text }) {
  const html = React.useMemo(() => {
    if (!text) return '';
    const math = [];
    const stripped = text.replace(MATH_PATTERN, (match, block1, block2, inline1, inline2) => {
      const isBlock = block1 !== undefined || block2 !== undefined;
      const tex = block1 ?? block2 ?? inline1 ?? inline2 ?? '';
      const rendered = renderMath(tex, isBlock);
      const token = `ZXMATHPLACEHOLDER${math.length}END`;
      // 块级公式单独占一行，避免被 Markdown 包进 <p> 里
      math.push({ token, rendered });
      return isBlock ? `\n\n${token}\n\n` : token;
    });

    const raw = marked.parse(stripped, { async: false });
    const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true, mathMl: true } });
    return math.reduce((acc, item) => acc.split(item.token).join(item.rendered), clean);
  }, [text]);

  if (!html) return null;
  // eslint-disable-next-line react/no-danger
  return <div className="zx-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
