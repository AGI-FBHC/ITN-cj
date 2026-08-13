type MdNode = { type?: string; value?: string; children?: MdNode[]; data?: { hName?: string; hProperties?: Record<string, unknown> } };

/** 将没有脚注定义的 [^2] 引用标记渲染为上标；标准脚注节点不受影响。 */
export default function remarkCitationMarks() {
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || !child.value?.includes('[^')) { visit(child); return [child]; }
        const parts: MdNode[] = [];
        const pattern = /\[\^(\d+)\]/g;
        let cursor = 0;
        for (const match of child.value.matchAll(pattern)) {
          const index = match.index ?? 0;
          if (index > cursor) parts.push({ type: 'text', value: child.value.slice(cursor, index) });
          parts.push({ type: 'text', value: match[1], data: { hName: 'sup', hProperties: { className: ['citation-mark'], title: `引用 ${match[1]}`, 'aria-label': `引用 ${match[1]}` } } });
          cursor = index + match[0].length;
        }
        if (cursor < child.value.length) parts.push({ type: 'text', value: child.value.slice(cursor) });
        return parts.length ? parts : [child];
      });
      node.children.forEach(visit);
    };
    visit(tree);
  };
}
