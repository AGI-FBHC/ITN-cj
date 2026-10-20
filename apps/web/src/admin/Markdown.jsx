import * as React from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

/** 渲染 Markdown；先转 HTML 再净化，避免模型输出里的脚本被带进页面。 */
export default function Markdown({ text }) {
  const html = React.useMemo(() => {
    if (!text) return '';
    const raw = marked.parse(text, { async: false });
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [text]);

  if (!html) return null;
  // eslint-disable-next-line react/no-danger
  return <div className="zx-md" dangerouslySetInnerHTML={{ __html: html }} />;
}
