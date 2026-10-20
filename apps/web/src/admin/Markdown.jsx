import * as React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';

marked.setOptions({ gfm: true, breaks: true });

// 公式：先抽成占位符，Markdown 渲染并净化后再换成 KaTeX 的 HTML。
const MATH_PATTERN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^\s$][^$\n]*?)\$|\\\(([\s\S]+?)\\\)/g;
const CODE_PATTERN = /`([^`\n]+)`/g;

function escapeHtml(value) {
  return value.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function renderMath(tex, displayMode) {
  try {
    return katex.renderToString(tex.trim(), {
      displayMode,
      throwOnError: false,
      strict: false,
      output: 'html',
    });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

/**
 * 中文标点会让 CommonMark 的强调判定失败：
 * `**语言模型（LM）**是…` 里的结尾 `**` 前面是全角括号、后面是文字，
 * 不满足右闭合条件，星号就会原样输出。
 * 这里先把成对的 ** / * / __ 直接换成标签，再交给 marked；围栏代码块整段跳过。
 */
function normalizeEmphasis(text) {
  const lines = text.split('\n');
  let inFence = false;
  const out = lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line
      .replace(/\*\*([^\s*](?:[^*]*?[^\s*])?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^\s*](?:[^*]*?[^\s*])?)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/__([^\s_](?:[^_]*?[^\s_])?)__/g, '<strong>$1</strong>');
  });
  return out.join('\n');
}

export default function Markdown({ text }) {
  const html = React.useMemo(() => {
    if (!text) return '';

    const placeholders = [];

    // 1) 行内代码先摘出来，避免其中的 ** 被当成加粗
    let working = text.replace(CODE_PATTERN, (match, code) => {
      const token = `ZXCODE${placeholders.length}END`;
      placeholders.push({ token, html: `<code>${escapeHtml(code)}</code>` });
      return token;
    });

    // 2) 公式
    working = working.replace(MATH_PATTERN, (match, block1, block2, inline1, inline2) => {
      const isBlock = block1 !== undefined || block2 !== undefined;
      const tex = block1 ?? block2 ?? inline1 ?? inline2 ?? '';
      const token = `ZXMATH${placeholders.length}END`;
      placeholders.push({ token, html: renderMath(tex, isBlock) });
      return isBlock ? `\n\n${token}\n\n` : token;
    });

    // 3) 强调符归一化，再交给 marked
    working = normalizeEmphasis(working);

    const raw = marked.parse(working, { async: false });
    let clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true, mathMl: true } });

    // 4) 把占位符换回本地生成的 HTML（不走净化，因为内容是本地转换/转义的）
    for (const item of placeholders) {
      clean = clean.split(item.token).join(item.html);
    }
    return clean;
  }, [text]);

  if (!html) return null;
  // eslint-disable-next-line react/no-danger
  return <div className="zx-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
