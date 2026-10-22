import { readFile } from 'node:fs/promises';
import path from 'node:path';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Same UTF-8 stored-entry fixture format as bundle-images.test.mjs; no archiver.
export function sourceZip(entries) {
  const files = [];
  const records = [];
  let offset = 0;
  for (const [relative, input] of entries) {
    const name = Buffer.from(relative);
    const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    files.push(local, name, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    records.push(record, name);
    offset += local.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}

export async function ingestionFixture(marker) {
  const imagePath = process.env.ZHIXUN_TEST_IMAGE || path.join(
    process.env.ZHIXUN_TEST_HELLO_AGENTS_DOCS || 'D:\\Desktop\\Projects\\resource\\hello-agents\\docs',
    'images', '3-figures', '1757249275674-0.png',
  );
  const image = await readFile(imagePath);
  if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('ZHIXUN_TEST_IMAGE must name an actual PNG fixture');
  }
  const code = '```javascript\nconst literal = "**这里不是加粗**，$x^2$ 也不是公式";\nfunction step(state) {\n  return { ...state, count: state.count + 1 };\n}\n```';
  const formula = '$$\nQ(s,a)=r+\\gamma\\max_{a\u2032}Q(s\u2032,a\u2032)\n$$';
  const table = '| 阶段 | 输入 | 输出 |\n| --- | --- | --- |\n| 感知 | 环境观测 | 状态 |\n| 行动 | 状态与目标 | 工具调用 |\n| 反馈 | 执行结果 | 下一轮观测 |';
  const caption = '图 1：真实课程配图；图注必须与图片一起保留，不补写来源或结论。';
  const imageBlock = `![验收原图](../images/课程原图.png "图片原始标题")\n\n${caption}`;
  const prose = (prefix, count) => Array.from({ length: count }, (_, index) =>
    `【${prefix}-${index + 1}】学习智能体时，应记录目标、当前状态、工具输入和执行结果。` +
    `这一段强调原文可追溯：先解释做出了什么选择，再观察证据是否支持选择；不把摘要当成原始讲义。` +
    `本段还包含中文、UTF-8 表情🧠、小数 73.25% 与复杂度 O(n log n)，切片不能截断字符或遗漏句子。`,
  ).join('\n\n');
  const structured = `# 可追溯的智能体学习\n\n独有验收标记 ${marker}-structured。\n\n## 原文段落\n\n${prose('结构化', 7)}\n\n## 代码、公式与表格\n\n${code}\n\n${formula}\n\n${table}\n\n## 原图与图注\n\n${imageBlock}\n\n结构化文档到此结束，原文不应被智能体改写。\n`;
  const plain = `独有验收标记 ${marker}-plain。\n\n这一份笔记故意没有 Markdown 标题，仍应走同一条保存、切片、摘要与向量流程。\n\n${prose('无标题', 9)}\n\n无标题文档到此结束。\n`;
  const documents = new Map([
    ['chapters/01-结构化.md', structured], ['notes/02-无标题.txt', plain],
  ]);
  return { bytes: sourceZip([...documents, ['images/课程原图.png', image]]), image, documents, protectedBlocks: [code, formula, table], caption };
}
