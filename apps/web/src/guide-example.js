// Old guides store both code and Markdown worksheets in the `code` field.
// Respect an explicit code language; otherwise only promote clear document syntax.
export function guideExampleMarkdown(value, language = '') {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!text.trim()) return '';
  const lang = String(language || '').trim().toLowerCase();
  if (lang === 'md' || lang === 'markdown') return text;
  const fenced = /^\s*(`{3,}|~{3,})([\w+-]*)[^\n]*\n[\s\S]*\n\1\s*$/.test(text);
  if (!lang && fenced) return text;
  const table = /^ {0,3}\|?\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*(?:\|[^\n]*)?\|?\s*$/m.test(text);
  const diagram = /^ {0,3}(?:`{3,}|~{3,})mermaid\s*$/m.test(text);
  const worksheet = /^#{1,6}\s+.+/m.test(text) && /^\s*-\s+\[[ xX]\]\s+/m.test(text);
  if (!lang && (table || diagram || worksheet)) return text;
  const length = Math.max(3, ...(text.match(/`+/g) || []).map((part) => part.length + 1));
  const fence = '`'.repeat(length);
  return `${fence}${/^[a-z0-9_+-]+$/i.test(lang) ? lang : ''}\n${text}\n${fence}`;
}
