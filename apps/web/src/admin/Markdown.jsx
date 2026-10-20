import * as React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { adminApi } from './admin-api.js';

marked.setOptions({ gfm: true, breaks: true });

// 公式：先抽成占位符，Markdown 渲染并净化后再换成 KaTeX 的 HTML。
const MATH_PATTERN = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\$([^\s$][^$\n]*?)\$|\\\(([\s\S]+?)\\\)/g;
const CODE_PATTERN = /`([^`\n]+)`/g;
const ASSET_PATH = /^\/api\/admin\/kb\/bundles\/[^/]+\/assets\/[^/]+$/;

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
      trust: false,
    });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

// 围栏内的公式与强调符属于代码，先完整保留，避免被后续的正则改写。
function protectFencedCode(text, placeholders) {
  const lines = text.split('\n');
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index]);
    if (!opening) {
      result.push(lines[index]);
      continue;
    }
    const fence = opening[1];
    const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
    const block = [lines[index]];
    while (index + 1 < lines.length) {
      index += 1;
      block.push(lines[index]);
      if (closing.test(lines[index])) break;
    }
    const token = `ZXFENCE${placeholders.length}END`;
    placeholders.push({
      token,
      block: true,
      html: DOMPurify.sanitize(marked.parse(block.join('\n'), { async: false })),
    });
    result.push('', token, '');
  }
  return result.join('\n');
}

function prepareImages(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const image of template.content.querySelectorAll('img')) {
    const source = image.getAttribute('src') || '';
    // 只允许代码生成的属性进入鉴权读取流程。
    image.removeAttribute('data-zx-asset');
    image.removeAttribute('data-zx-image-error');
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
    image.setAttribute('loading', 'lazy');
    image.setAttribute('decoding', 'async');
    try {
      const url = new URL(source, window.location.href);
      if (source && url.origin === window.location.origin && ASSET_PATH.test(url.pathname)) {
        image.removeAttribute('src');
        image.setAttribute('data-zx-asset', `${url.pathname}${url.search}`);
      } else if (/^https?:\/\//i.test(source) || /^\/\//.test(source)) {
        // 网络图由浏览器直接读取，不把管理员令牌传给外部站点。
        image.setAttribute('referrerpolicy', 'no-referrer');
      } else {
        image.removeAttribute('src');
        image.setAttribute('data-zx-image-error', '原文引用的图片未包含在资料包中');
      }
    } catch {
      image.removeAttribute('src');
      image.setAttribute('data-zx-image-error', '原文中的图片地址不可用');
    }
  }
  return template.innerHTML;
}

function showImageError(image, reason) {
  const placeholder = document.createElement('span');
  placeholder.className = 'zx-md-image-error';
  placeholder.setAttribute('role', 'img');
  const alt = image.getAttribute('alt') || '';
  placeholder.setAttribute('aria-label', `图片不可用${alt ? `：${alt}` : ''}`);
  if (image.title) placeholder.title = image.title;
  const label = document.createElement('strong');
  label.textContent = alt ? `图片不可用：${alt}` : '图片不可用';
  const detail = document.createElement('small');
  detail.textContent = reason || '图片链接失效或暂时无法访问';
  placeholder.append(label, detail);
  image.replaceWith(placeholder);
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
  const root = React.useRef(null);
  const html = React.useMemo(() => {
    if (!text) return '';

    const placeholders = [];

    // 1) 行内代码先摘出来，避免其中的 ** 被当成加粗
    let working = protectFencedCode(text.replace(/^\uFEFF/, ''), placeholders).replace(CODE_PATTERN, (match, code) => {
      const token = `ZXCODE${placeholders.length}END`;
      placeholders.push({ token, html: `<code>${escapeHtml(code)}</code>` });
      return token;
    });

    // 2) 公式
    working = working.replace(MATH_PATTERN, (match, block1, block2, inline1, inline2) => {
      const isBlock = block1 !== undefined || block2 !== undefined;
      const tex = block1 ?? block2 ?? inline1 ?? inline2 ?? '';
      const token = `ZXMATH${placeholders.length}END`;
      placeholders.push({ token, block: isBlock, html: renderMath(tex, isBlock) });
      return isBlock ? `\n\n${token}\n\n` : token;
    });

    // 3) 强调符归一化，再交给 marked
    working = normalizeEmphasis(working);

    const raw = marked.parse(working, { async: false });
    let clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true, mathMl: true } });

    // 4) 把占位符换回本地生成的 HTML（不走净化，因为内容是本地转换/转义的）
    for (const item of placeholders) {
      if (item.block) clean = clean.split(`<p>${item.token}</p>`).join(item.html);
      clean = clean.split(item.token).join(item.html);
    }
    // 本地图先移除 src，避免浏览器发出没有鉴权的自动请求。
    return prepareImages(clean);
  }, [text]);
  const markup = React.useMemo(() => ({ __html: html }), [html]);

  React.useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    let active = true;
    const controller = new AbortController();
    const objectUrls = new Set();
    const requests = new Map();
    const listeners = [];
    const pending = new Map();
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        pending.get(entry.target)?.();
        pending.delete(entry.target);
      }
    }, { rootMargin: '500px' });
    for (const image of element.querySelectorAll('img')) {
      const error = image.getAttribute('data-zx-image-error');
      if (error) {
        showImageError(image, error);
        continue;
      }
      const onError = () => { if (active) showImageError(image); };
      image.addEventListener('error', onError, { once: true });
      listeners.push(() => image.removeEventListener('error', onError));
      const path = image.getAttribute('data-zx-asset');
      if (path) {
        const load = () => {
          if (!active) return;
          if (!requests.has(path)) {
            requests.set(path, adminApi.kbBundleAsset(path, { signal: controller.signal }).then((blob) => {
              if (!active) return '';
              const url = URL.createObjectURL(blob);
              objectUrls.add(url);
              return url;
            }));
          }
          requests.get(path).then((url) => {
            if (active && url) image.src = url;
          }).catch((failure) => {
            if (active) showImageError(image, failure.name === 'AbortError' ? '图片读取超时，请刷新重试' : failure.message);
          });
        };
        if (observer) {
          pending.set(image, load);
          observer.observe(image);
        } else {
          load();
        }
      } else if (image.complete && image.naturalWidth === 0) {
        showImageError(image);
      }
    }
    return () => {
      active = false;
      observer?.disconnect();
      controller.abort();
      listeners.forEach((remove) => remove());
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [html]);

  if (!html) return null;
  // eslint-disable-next-line react/no-danger
  return <div ref={root} className="zx-md" dangerouslySetInnerHTML={markup} />;
}
