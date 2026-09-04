/**
 * 讲义 Markdown 渲染定制（react-markdown v10 + remark-gfm）
 * - 正文 [KB-xxx] 标记 → TraceBadge（可点开 KB 抽屉）
 * - H2 章节自动挂 id（scroll-spy / 目录定位用）
 * - blockquote 按内容分流为：标准引用块（虚线框+印章）/ 安全警示（砖红）/ 重点 callout（墨绿）
 */
import { Children, cloneElement, isValidElement, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { withTraceBadges } from '@/components/TraceBadge';
import { cn } from '@/lib/utils';

/** 递归把 children 字符串里的 [KB-xxx] 替换为 TraceBadge（仅深入宿主元素）
 *  讲义正文属于「零幻觉溯源」的核心展示位，全部启用 rich 信息卡 */
function traceify(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === 'string') return withTraceBadges(child, true);
    if (isValidElement(child) && typeof child.type === 'string') {
      const kids = (child.props as { children?: ReactNode }).children;
      if (kids) {
        return cloneElement(child as ReactElement<{ children?: ReactNode }>, undefined, traceify(kids));
      }
    }
    return child;
  });
}

/** 段落是否含 [KB-xxx] 溯源标记（渲染前的原始文本判断） */
const hasKbRef = (children: ReactNode) => /\[KB-\d{3}\]/.test(flattenText(children));

/** 提取纯文本（用于生成 heading id / 判断 callout 类型） */
export function flattenText(node: ReactNode): string {
  return Children.toArray(node)
    .map((c) => {
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      if (isValidElement(c)) {
        return flattenText((c.props as { children?: ReactNode }).children);
      }
      return '';
    })
    .join('');
}

export const headingId = (text: string) =>
  'sec-' +
  text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w一-龥.-]/g, '')
    .slice(0, 48);

/** 知识库原文/讲义里常见 http://113.249.110.108:28901/... 图床地址，走后端 HTTPS 代理避免 Mixed Content。 */
export const secureImageSrc = (src: string | undefined) => {
  if (!src) return src;
  try {
    const url = new URL(src, window.location.origin);
    if (url.protocol === 'http:' && url.hostname === '113.249.110.108' && url.port === '28901') {
      return `/api/v1/rag/assets/remote?url=${encodeURIComponent(src)}`;
    }
    if (url.protocol === 'http:') {
      url.protocol = 'https:';
      return url.toString();
    }
  } catch {
    return src;
  }
  return src;
};

type MDProps = { node?: unknown; children?: ReactNode; className?: string };

/** 剥离 react-markdown 注入的非 DOM 属性（node） */
const domOnly = (props: MDProps): Omit<MDProps, 'node'> => {
  const { node, ...rest } = props;
  void node;
  return rest;
};

function MarkdownCodeBlock({ children, roomy = false }: { children?: ReactNode; roomy?: boolean }) {
  const [copied, setCopied] = useState(false);
  const child = Children.toArray(children)[0];
  const childClass = isValidElement(child)
    ? String((child.props as { className?: string }).className ?? '')
    : '';
  const language = childClass.match(/language-([\w-]+)/)?.[1]?.toUpperCase() || 'CODE';
  const source = flattenText(children).replace(/\n$/, '');
  const lines = source.split('\n');
  const copy = async () => {
    await navigator.clipboard.writeText(source);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <figure className={cn('my-5 overflow-hidden rounded-[14px] border border-[#2E463D] bg-[#14211C] shadow-[0_12px_30px_rgba(17,34,27,0.16)]', roomy && 'my-6 rounded-[16px]')}>
      <figcaption className="flex h-10 items-center justify-between border-b border-white/10 bg-[#1A2B24] px-3.5">
        <div className="flex items-center gap-2.5">
          <span className="h-4 w-[3px] rounded-full bg-[#73A98E]" />
          <span className="font-mono text-[9.5px] font-semibold tracking-[0.16em] text-[#B9D2C5]">{language}</span>
        </div>
        <button type="button" onClick={() => void copy()} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-white/10 px-2 text-[10px] text-[#AFC6BB] transition-colors hover:border-[#73A98E]/60 hover:bg-white/[0.06] hover:text-white" aria-label="复制代码">
          {copied ? <Check size={12} /> : <Copy size={12} />}{copied ? '已复制' : '复制'}
        </button>
      </figcaption>
      <div className={cn('max-h-[440px] overflow-auto py-3.5', roomy && 'max-h-[48vh] py-4')}>
        <code className={cn('block min-w-max font-mono text-[12.5px] leading-[22px] text-[#E2ECE7]', roomy && 'text-[13.5px] leading-6')}>
          {lines.map((line, index) => <span key={index} className="grid grid-cols-[42px_minmax(0,1fr)] pr-5 hover:bg-white/[0.035]"><span aria-hidden className="select-none border-r border-white/[0.07] pr-3 text-right text-[#60776C]">{index + 1}</span><span className="whitespace-pre pl-4">{line || ' '}</span></span>)}
        </code>
      </div>
    </figure>
  );
}

export const lectureMdComponents = {
  h1: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return <h1 className="mb-5 mt-8 font-serif text-[26px] font-semibold leading-[35px] tracking-[-0.01em] text-ink first:mt-0" {...rest}>{traceify(children)}</h1>;
  },
  h2: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    const id = headingId(flattenText(children));
    return (
      <h2
        id={id}
        data-spy={id}
        className="group mt-9 scroll-mt-24 border-b border-hairline pb-2 font-serif text-[21px] font-semibold leading-[30px] text-ink first:mt-0"
        {...rest}
      >
        <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-brand/25 transition-colors duration-300 group-hover:bg-brand" />
        {traceify(children)}
      </h2>
    );
  },
  h3: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return <h3 className="mb-2 mt-7 font-serif text-[18px] font-semibold leading-[27px] text-ink" {...rest}>{traceify(children)}</h3>;
  },
  h4: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return <h4 className="mb-1.5 mt-5 text-[15px] font-semibold leading-6 text-ink" {...rest}>{traceify(children)}</h4>;
  },
  p: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    /* 本段含 KB 引用 → 左侧加 2px 竖线，视觉提示「本段有溯源」 */
    const traced = hasKbRef(children);
    return (
      <p
        className={cn(
          'my-3.5 text-[15px] leading-[26px] text-ink-2',
          traced && 'border-l-2 border-brand/25 pl-3',
        )}
        {...rest}
      >
        {traceify(children)}
      </p>
    );
  },
  li: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return (
      <li className="my-1.5 text-[15px] leading-[26px] text-ink-2 marker:text-brand" {...rest}>
        {traceify(children)}
      </li>
    );
  },
  ol: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return (
      <ol className="my-3 list-decimal space-y-1 pl-6" {...rest}>
        {children}
      </ol>
    );
  },
  ul: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return (
      <ul className="my-3 list-disc space-y-1 pl-6" {...rest}>
        {children}
      </ul>
    );
  },
  strong: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return (
      <strong className="font-semibold text-ink" {...rest}>
        {traceify(children)}
      </strong>
    );
  },
  blockquote: (props: MDProps) => {
    const { children } = props;
    const text = flattenText(children);
    const isWarning = /警示|安全|禁止|不得|急停/.test(text);
    const isStandard = /GB|JB\/T|JJF|标准|试验应|规定/.test(text) && !isWarning;
    if (isWarning) {
      return (
        <div className="my-4 rounded-r-[10px] border-l-4 border-brand-danger bg-brand-danger/5 px-4 py-3">
          <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-brand-danger">
            CAUTION · 安全警示
          </div>
          <div className="text-[14px] leading-[24px] text-ink-2 [&_p]:my-0">{children}</div>
        </div>
      );
    }
    if (isStandard) {
      return (
        <div className="relative my-4 rounded-[10px] border border-dashed border-brand/45 bg-brand-tint/40 px-4 py-3 pr-14">
          <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-brand">
            STANDARD · 标准条款引用
          </div>
          <div className="text-[14px] leading-[24px] text-ink-2 [&_p]:my-0">{children}</div>
          <img
            src="/seal-standard.svg"
            alt=""
            aria-hidden
            className="absolute right-3 top-1/2 h-10 w-10 -translate-y-1/2 opacity-60"
          />
        </div>
      );
    }
    return (
      <div className="my-4 rounded-r-[10px] border-l-4 border-brand bg-brand-tint/50 px-4 py-3">
        <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-brand">
          KEY POINT · 重点
        </div>
        <div className="text-[14px] leading-[24px] text-ink-2 [&_p]:my-0">{children}</div>
      </div>
    );
  },
  pre: (props: MDProps) => {
    const { children } = domOnly(props);
    return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>;
  },
  code: (props: MDProps) => {
    const { children, className, ...rest } = domOnly(props);
    const isBlock = Boolean(className);
    if (isBlock) {
      return (
        <code className={cn('font-mono', className)} {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded-[5px] bg-brand-tint/75 px-1.5 py-0.5 font-mono text-[12.5px] font-medium text-brand"
        {...rest}
      >
        {children}
      </code>
    );
  },
  table: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return (
      <div className="my-4 overflow-x-auto rounded-[10px] border border-hairline">
        <table className="w-full border-collapse text-[13.5px]" {...rest}>
          {children}
        </table>
      </div>
    );
  },
  thead: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return (
      <thead className="bg-brand-tint/60" {...rest}>
        {children}
      </thead>
    );
  },
  th: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return (
      <th
        className="border-b border-hairline px-3 py-2.5 text-left font-semibold text-brand"
        {...rest}
      >
        {traceify(children)}
      </th>
    );
  },
  td: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return (
      <td className="border-b border-hairline/60 px-3 py-2.5 align-top text-ink-2" {...rest}>
        {traceify(children)}
      </td>
    );
  },
  img: (props: MDProps & { src?: string; alt?: string }) => {
    const { node, src, ...rest } = props;
    void node;
    return <img src={secureImageSrc(src)} className="my-5 max-h-[440px] w-full rounded-[12px] border border-hairline bg-paper-deep object-contain" loading="lazy" {...rest} />;
  },
  hr: (props: MDProps) => <hr className="my-6 border-hairline" {...domOnly(props)} />,
  a: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return (
      <a
        className="font-medium text-brand underline decoration-brand/40 underline-offset-2"
        {...rest}
      >
        {children}
      </a>
    );
  },
};

/** 幻灯片使用更大的字号和更强的内容分块，不直接套用长文排版。 */
export const slideMdComponents = {
  ...lectureMdComponents,
  h1: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return <h1 className="mb-5 font-serif text-[26px] font-semibold leading-[34px] text-ink md:text-[32px] md:leading-[40px]" {...rest}>{traceify(children)}</h1>;
  },
  h2: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return <h2 className="mb-4 mt-7 border-l-4 border-brand pl-4 font-serif text-[21px] font-semibold leading-[30px] text-ink first:mt-0 md:text-[25px]" {...rest}>{traceify(children)}</h2>;
  },
  h3: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return <h3 className="mb-3 mt-6 text-[17px] font-semibold leading-7 text-ink md:text-[19px]" {...rest}>{traceify(children)}</h3>;
  },
  p: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return <p className="my-4 text-[15px] leading-7 text-ink-2 md:text-[16.5px] md:leading-8" {...rest}>{traceify(children)}</p>;
  },
  ul: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return <ul className="my-5 grid gap-2.5" {...rest}>{children}</ul>;
  },
  ol: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return <ol className="my-5 grid list-none gap-2.5 [counter-reset:slide-step]" {...rest}>{children}</ol>;
  },
  li: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return <li className="relative rounded-[13px] border border-hairline bg-paper/75 px-4 py-3 text-[14px] leading-6 text-ink-2 shadow-xs before:mr-2 before:text-brand before:content-['•'] md:text-[15.5px]" {...rest}>{traceify(children)}</li>;
  },
  pre: (props: MDProps) => {
    const { children } = domOnly(props);
    return <MarkdownCodeBlock roomy>{children}</MarkdownCodeBlock>;
  },
  table: (props: MDProps) => {
    const { children, ...rest } = domOnly(props);
    return <div className="my-5 overflow-auto rounded-[14px] border border-hairline bg-paper"><table className="w-full min-w-[520px] border-collapse text-[13.5px] md:text-[15px]" {...rest}>{children}</table></div>;
  },
};

/** 从 markdown 提取章节（H2）目录 */
export function extractToc(markdown: string): { id: string; label: string }[] {
  return markdown
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => {
      const label = l.replace(/^##\s+/, '').trim();
      return { id: headingId(label), label };
    });
}

/** 计算每个 KB 引用首次出现的章节 id（脚注回链定位） */
export function kbFirstSection(markdown: string, kbId: string): string | null {
  const lines = markdown.split('\n');
  let current: string | null = null;
  for (const line of lines) {
    if (line.startsWith('## ')) current = headingId(line.replace(/^##\s+/, '').trim());
    if (line.includes(`[${kbId}]`)) return current;
  }
  return null;
}
