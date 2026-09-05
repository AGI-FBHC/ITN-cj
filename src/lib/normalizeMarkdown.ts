/**
 * 渲染前修正模型常见的“编号/列表未换行”问题。
 * 只把明显是列表项的位置拆成独立行，不影响正常段落或小数。
 */
export function normalizeMarkdownLists(text: string): string {
  if (!text) return text;
  let value = text.replace(/\r\n?/g, '\n');
  value = value.replace(
    /([^\n])(\s*)([一二三四五六七八九十]+、|(?<![\d.])（\d+）|(?<![\d.])\d+[）)]|(?<![\d.])\d+\.(?=\s|[^\d]))/g,
    '$1\n\n$2$3',
  );
  value = value.replace(/([^\n])(\s*)([-•*]\s+)/g, '$1\n\n$2$3');
  value = value.replace(/^[ \t]*[-•*][ \t]*$/gm, '');
  value = value.replace(/\n{3,}/g, '\n\n');
  return value;
}

/** 把任意文本列表规整成安全的 Markdown 列表，过滤空项并避免重复圆点。 */
export function markdownList(items: unknown[]): string {
  return items
    .map((item) => (item === null || item === undefined ? '' : String(item)).trim())
    .filter(Boolean)
    .map((item) => item.replace(/^[-•*]\s+/, '').trim())
    .filter(Boolean)
    .map((item) => `- ${item}`)
    .join('\n');
}
