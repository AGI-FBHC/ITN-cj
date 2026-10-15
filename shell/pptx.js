const fs = require("fs");
const zlib = require("zlib");

/**
 * 读 .pptx / .ppt 里的文字（离线、只读，只为了在窗口里能预览）。
 *
 * 为什么不用现成的库：壳这一层不装依赖（打包后要能离线跑）。pptx 就是一个 ZIP，
 * 幻灯片正文在 ppt/slides/slideN.xml 的 <a:t> 里，自己解一遍中央目录就够用：
 * 只解压需要的条目，不落盘、不改文件。.ppt（OLE 老格式）没有 ZIP 结构，
 * 退回"扫 UTF-16LE 可读串"的粗办法 —— 它给不出页码，但能让用户看到讲了什么。
 */

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function listEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    out.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf, entry) {
  const lo = entry.localOff;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  try {
    if (entry.method === 0) return raw;
    if (entry.method === 8) return zlib.inflateRawSync(raw);
  } catch (e) {
    return null;
  }
  return null;
}

/** 一页 XML → 若干段文字（<a:p> 之间断行，<a:t> 里才是真正显示的字）。 */
function textOfSlideXml(xml) {
  const paras = [];
  const pRe = /<a:p\b[\s\S]*?<\/a:p>|<a:p\b[^>]*\/>/g;
  const blocks = xml.match(pRe);
  const pool = blocks && blocks.length ? blocks : [xml];
  for (const block of pool) {
    const runs = [];
    const tRe = /<a:t>([\s\S]*?)<\/a:t>/g;
    let m;
    while ((m = tRe.exec(block)) !== null) runs.push(m[1]);
    // 空格/换行在 <a:t xml:space="preserve"> 里是有意义的，这里只做 XML 实体还原
    const line = runs.join("")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
    if (line.trim()) paras.push(line);
  }
  return paras.join("\n");
}

function slidesFromPptx(buf) {
  const entries = listEntries(buf);
  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .map((e) => ({ n: Number(e.name.replace(/\D+/g, "")), e }))
    .sort((a, b) => a.n - b.n);
  const out = [];
  for (const s of slides) {
    const xml = readEntry(buf, s.e);
    if (!xml) continue;
    out.push({ index: s.n, text: textOfSlideXml(xml.toString("utf8")) });
  }
  return out;
}

/** 老 .ppt：没有 ZIP 结构，捞一段范围内可读的 UTF-16LE / GBK 文本，聊胜于无。 */
function looseTextFromPpt(buf) {
  const chars = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = buf.readUInt16LE(i);
    const printable =
      (code >= 0x20 && code <= 0x7e) ||          // ASCII
      (code >= 0x4e00 && code <= 0x9fff) ||       // 汉字
      (code >= 0x3000 && code <= 0x303f) ||       // 中文标点
      (code >= 0xff00 && code <= 0xffef);         // 全角
    chars.push(printable ? String.fromCharCode(code) : "\u0000");
  }
  const runs = chars.join("").split(/\u0000+/).map((x) => x.trim()).filter((x) => x.length >= 4);
  return runs.join("\n");
}

/** 入口：给定文件路径，返回 [{index, text}]。读不动就抛，由主进程转成错误信息。 */
function readDeck(file) {
  const buf = fs.readFileSync(file);
  const lower = String(file).toLowerCase();
  if (lower.endsWith(".pptx") || lower.endsWith(".pptm")) {
    const slides = slidesFromPptx(buf);
    if (slides.length) return { kind: "pptx", slides };
    // 有些导出工具用别的路径名；退到"所有 xml 里找 a:t"
    const loose = listEntries(buf)
      .filter((e) => /\.xml$/.test(e.name))
      .map((e) => readEntry(buf, e))
      .filter(Boolean)
      .map((x) => x.toString("utf8"))
      .filter((x) => x.indexOf("<a:t>") >= 0)
      .map((x) => textOfSlideXml(x))
      .filter((x) => x.trim());
    return { kind: "pptx", slides: loose.map((t, i) => ({ index: i + 1, text: t })) };
  }
  return { kind: "ppt", slides: [{ index: 1, text: looseTextFromPpt(buf) }] };
}

module.exports = { readDeck };
