/**
 * 来源标签工具：把后端来源快照里的"文件名"（doc_000054.md 这类）替换成可读标题。
 *
 * 背景：检索来源快照同时带有 document（文件名）、sectionTitle（常为空）与 content（原文，
 * 首行通常是 "# 第一章 智能体范式革命" 这样的文档/章节标题）。直接把文件名展示给学习者
 * 没有意义，所以统一按"可读标题 → 原文首个标题 → 去扩展名的文件名"的顺序兜底。
 */

export const looksLikeFileName = (value: string): boolean =>
  /\.(md|markdown|txt|pdf|docx?|pptx?|xlsx?)$/i.test(value) || /^doc_\w+$/i.test(value);

/** 取文本中第一个 Markdown 标题（# ~ ######），没有则返回空串。 */
export const headingFromText = (value: unknown): string => {
  const match = String(value ?? '').match(/^[ \t]*#{1,6}[ \t]*(.+?)[ \t]*$/m);
  return match ? match[1].replace(/[#*`]/g, '').trim() : '';
};

type SourceLike = {
  sectionTitle?: unknown;
  titlePath?: unknown;
  title?: unknown;
  standardNumber?: unknown;
  document?: unknown;
  content?: unknown;
  excerpt?: unknown;
};

/** 生成可读来源标题；ident 仅用于最终兜底文案。 */
export function readableSourceTitle(source: SourceLike | undefined, ident?: number | string): string {
  const s = source ?? {};
  const readable = [s.sectionTitle, s.titlePath, s.title, s.standardNumber]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && !looksLikeFileName(value));
  if (readable.length) return readable[0];
  const heading = headingFromText(s.content) || headingFromText(s.excerpt);
  if (heading) return heading;
  const fallback = String(s.document ?? s.title ?? '').trim().replace(/\.[a-z0-9]+$/i, '');
  if (fallback) return fallback;
  return ident === undefined ? '未知来源' : `来源 ${ident}`;
}
