import * as React from 'react';
import Markdown from './admin/Markdown.jsx';
import { citationMarkdown, coursewareReferences } from './courseware-references.js';
import './courseware-references.css';

export function CoursewareMarkdown({ text, references, prefix, audience = 'learner' }) {
  const content = React.useMemo(() => citationMarkdown(text, references, prefix), [text, references, prefix]);
  const followReference = (event) => {
    const link = event.target.closest('a');
    const href = link?.getAttribute('href') || '';
    if (!href.startsWith(`#${prefix}-reference-`)) return;
    // The learner app uses the URL hash for navigation; references scroll locally.
    event.preventDefault();
    const target = document.getElementById(href.slice(1));
    target?.scrollIntoView({ block: 'start' });
    target?.focus({ preventScroll: true });
  };
  return <div className="zx-courseware-prose" onClick={followReference}><Markdown text={content} audience={audience} /></div>;
}

export default function CoursewareReferences({ references, prefix = 'courseware' }) {
  const sources = coursewareReferences(references);
  return <section className="zx-courseware-references" aria-label="参考资料">
    <h2>参考资料</h2>
    <p className="zx-courseware-reference-note">编号对应本章实际使用的资料。[1] 为上传章节原文，不表示外部参考文献。</p>
    {sources.length ? <ol>
      {sources.map((source) => <li key={source.number} id={`${prefix}-reference-${source.number}`} tabIndex={-1}>
        <div><strong>[{source.number}] {source.title}</strong><span>{source.label || (source.kind === 'chapter-original' ? '上传章节原文' : '章节资料')}</span></div>
        {source.sourcePath ? <p className="zx-courseware-reference-path">原始文件：{source.sourcePath}</p> : null}
        {source.excerpt ? <details>
          <summary>展开原文摘录</summary>
          <pre>{source.excerpt}</pre>
          {source.excerptTruncated ? <p className="zx-courseware-reference-note">此处展示提供给生成流程的章节原文前段，原文较长，摘录已截断。</p> : null}
        </details> : null}
        {source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">打开来源资料</a> : null}
      </li>)}
    </ol> : <p role="note">暂未取得可核验的原文来源，正文中无法对应的引用编号已隐藏。</p>}
  </section>;
}
