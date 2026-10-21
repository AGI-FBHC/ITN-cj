// Source numbers are local to a chapter; a title alone is not verifiable evidence.
export function coursewareReferences(value) {
  const input = Array.isArray(value) ? value : value?.references ?? value?.sources ?? [];
  const seen = new Set();
  return (Array.isArray(input) ? input : []).flatMap((source) => {
    if (!source || typeof source !== 'object') return [];
    const number = Number(source.number);
    const excerpt = typeof source.excerpt === 'string' ? source.excerpt : '';
    const url = safeReferenceUrl(source.url);
    if (!Number.isSafeInteger(number) || number < 1 || seen.has(number) || (!excerpt.trim() && !url)) return [];
    seen.add(number);
    return [{ ...source, number, excerpt, url, title: String(source.title || '章节资料') }];
  });
}

export function safeReferenceUrl(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : '';
}

export function chapterReference(doc, bundleId = '') {
  if (!doc?.id || typeof doc.content !== 'string' || !doc.content.trim()) return [];
  const bytes = new TextEncoder().encode(doc.content);
  let end = Math.min(bytes.length, 16000);
  while (end < bytes.length && (bytes[end] & 192) === 128) end -= 1;
  return [{ number: 1, kind: 'chapter-original', docId: doc.id, bundleId,
    title: doc.title || '上传章节', sourcePath: doc.sourcePath || '',
    label: '上传章节原文', excerpt: new TextDecoder().decode(bytes.subarray(0, end)),
    excerptTruncated: bytes.length > 16000 }];
}

export function lessonReferences(lesson, type = 'lecture') {
  for (const value of [lesson?.resources?.[type], lesson?.content, lesson]) {
    const references = coursewareReferences(value);
    if (references.length) return references;
  }
  return [];
}

function balancedEnd(text, start, open, close) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === open) depth += 1;
    if (text[i] === close) { depth -= 1; if (!depth) return i + 1; }
  }
  return start;
}

// Only visit prose markers. Everything inside code, links, or index expressions
// is copied verbatim, including bracketed numeric Markdown link labels.
function mapInlineCitations(text, visit, definitions) {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
    if (text[i] === '`') {
      const run = /^`+/.exec(text.slice(i))[0];
      let end = text.indexOf(run, i + run.length);
      while (end >= 0 && (text[end - 1] === '`' || text[end + run.length] === '`')) end = text.indexOf(run, end + run.length);
      const stop = end < 0 ? text.length : end + run.length;
      out += text.slice(i, stop); i = stop; continue;
    }
    if (text[i] === '[') {
      const end = balancedEnd(text, i, '[', ']');
      if (end > i) {
        const label = text.slice(i + 1, end - 1);
        let next = end;
        while (text[next] === ' ' || text[next] === '\t') next += 1;
        if (text[next] === '(' || text[next] === '[') {
          const close = text[next] === '(' ? ')' : ']';
          const stop = balancedEnd(text, next, text[next], close);
          const nextLabel = text.slice(next + 1, stop - 1);
          const adjacentCitations = text[next] === '[' && /^[1-9]\d*$/.test(label) && /^[1-9]\d*$/.test(nextLabel) && !definitions.has(nextLabel);
          if (stop > next && !adjacentCitations) { out += text.slice(i, stop); i = stop; continue; }
        }
        const before = text.slice(0, i).trimEnd().slice(-1);
        const afterCitation = /\[[1-9]\d*\]\s*$/.test(text.slice(0, i));
        const indexed = !afterCitation && (/[\w$\])]/.test(text[i - 1] || '') || /[=([{,:]/.test(before));
        if (/^[1-9]\d*$/.test(label) && text[next] !== ':' && !indexed && !definitions.has(label)) {
          out += visit(Number(label)); i = end; continue;
        }
        // A bracketed label can contain nested numeric text; never rewrite it.
        out += text.slice(i, end); i = end; continue;
      }
    }
    out += text[i]; i += 1;
  }
  return out;
}

function mapProse(markdown, transform) {
  const definitions = new Set([...markdown.matchAll(/^ {0,3}\[([^\]\n]+)\]:/gm)].map((match) => match[1]));
  const lines = markdown.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) || [];
  let fence = null;
  let paragraph = '';
  let output = '';
  const flush = () => { if (paragraph) output += transform(paragraph, definitions); paragraph = ''; };
  for (const line of lines) {
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      output += line;
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = null;
    } else if (opening) {
      flush(); fence = opening[1]; output += line;
    } else if (/^(?: {4}|\t)/.test(line) || !line.trim() || /^ {0,3}\[[^\]]+\]:/.test(line)) {
      flush(); output += line;
    } else if (/^ {0,3}(?:#{1,6}\s|[-+*]\s|\d+[.)]\s|>\s|\|)/.test(line)) {
      flush(); output += transform(line, definitions);
    } else paragraph += line;
  }
  flush();
  return output;
}

export function normalizeCoursewareCitations(markdown, references = []) {
  const valid = new Set(coursewareReferences(references).map((source) => source.number));
  return mapProse(String(markdown || ''), (paragraph, definitions) => {
    const used = new Set();
    const cleaned = mapInlineCitations(paragraph, (number) => {
      if (valid.has(number)) used.add(number);
      return '';
    }, definitions);
    if (!used.size) return cleaned;
    const trailing = /\s*$/.exec(paragraph)[0];
    return cleaned.trimEnd() + ' ' + [...used].map((number) => `[${number}]`).join(' ') + trailing;
  });
}

export function citationMarkdown(markdown, references = [], prefix = 'courseware') {
  const normalized = normalizeCoursewareCitations(markdown, references);
  return mapProse(normalized, (text, definitions) => mapInlineCitations(text,
    (number) => `[${number}](#${prefix}-reference-${number})`, definitions));
}
