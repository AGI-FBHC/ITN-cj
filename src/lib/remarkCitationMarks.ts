type MdNode = { type?: string; value?: string; children?: MdNode[]; data?: { hName?: string; hProperties?: Record<string, unknown> } };

const citationMarkPattern = /(?:\^\[(?:来源|源|KB-)?\s*([0-9][0-9\s,，、;；]*)\]|\[(?:citation\s*:\s*([0-9][0-9\s,，、;；]*)|\^([0-9][0-9\s,，、;；]*))\])/gi;

/** 将历史内容中的 [^2] / [citation:2] / ^[2] / ^[来源7] / ^[来源1, 10] 引用标记统一渲染为上标。 */
export default function remarkCitationMarks() {
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        const value = child.value ?? '';
        if (child.type !== 'text' || !citationMarkPattern.test(value)) { visit(child); return [child]; }
        citationMarkPattern.lastIndex = 0;
        const parts: MdNode[] = [];
        let cursor = 0;
        for (const match of value.matchAll(citationMarkPattern)) {
          const index = match.index ?? 0;
          if (index > cursor) parts.push({ type: 'text', value: value.slice(cursor, index) });
          const raw = match[1] ?? match[2] ?? match[3] ?? '';
          const citationNumber = raw.split(/[^\d]+/).filter(Boolean).join(', ');
          parts.push({ type: 'text', value: citationNumber, data: { hName: 'sup', hProperties: { className: ['citation-mark'], title: `引用 ${citationNumber}`, 'aria-label': `引用 ${citationNumber}` } } });
          cursor = index + match[0].length;
        }
        if (cursor < value.length) parts.push({ type: 'text', value: value.slice(cursor) });
        return parts.length ? parts : [child];
      });
      node.children.forEach(visit);
    };
    visit(tree);
  };
}
