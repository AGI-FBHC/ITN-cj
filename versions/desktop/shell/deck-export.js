/**
 * Markdown → 可编辑的 Office 文件（.pptx / .docx），**零依赖**、离线、可复现。
 *
 * 为什么自己写 ZIP 与 OOXML：壳这一层不装任何 npm 依赖（打包后要能离线跑），
 * 而"学习成果要能交出去、能自己接着改"就必须有 Office 文件。pptx/docx 都是 ZIP + 一堆 XML，
 * 照着最小可用且**合法**的部件集写一遍，比引依赖更可控（也顺手保证同输入同字节）。
 *
 * 约定（Markdown 子集，够我们的讲义/练习/演示用）：
 *   - 标题：# / ## / ### / ####（docx 里映射标题 1..4；pptx 里 # 是一页的标题）
 *   - 列表：`- ` `* ` 项目符号，`1. ` 编号
 *   - 引用：`> `
 *   - 行内：`**粗体**`（其余原样，不作转义以外的处理）
 *   - 分页（只对 pptx 有意义）：单独一行 `---`
 *   - 表格、图片、脚注、自定义主题：不支持（超集没必要；真需要时再补）
 *
 * 用法：
 *   const { exportPptx, exportDocx } = require("./deck-export");
 *   exportPptx(markdown, "D:/x/讲义.pptx");
 *   exportDocx(markdown, "D:/x/讲义.docx");
 */
const fs = require("fs");
const zlib = require("zlib");

/* ---------------- ZIP（自己写，固定时间戳 → 同输入同字节） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 1980-01-01 00:00:00 的 DOS 时间：写死才可复现。 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;      // 年=1980（0+1980）、月=1、日=1

function zipOf(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8");
    const crc = crc32(raw);
    const deflated = raw.length > 0 ? zlib.deflateRawSync(raw, { level: 9 }) : Buffer.alloc(0);
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);               // version needed
    local.writeUInt16LE(0, 6);                // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);                 // version made by
    cen.writeUInt16LE(20, 6);                 // version needed
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(DOS_TIME, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);                 // extra
    cen.writeUInt16LE(0, 32);                 // comment
    cen.writeUInt16LE(0, 34);                 // disk
    cen.writeUInt16LE(0, 36);                 // internal attrs
    cen.writeUInt32LE(0, 38);                 // external attrs
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

/* ---------------- 文本与 Markdown ---------------- */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** `**粗体**` → 片段数组（其余原样）。 */
function inlineRuns(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out.length ? out : [{ text: text, bold: false }];
}

/** Markdown → 块数组。 */
function parseBlocks(markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = [];
  const flushPara = () => {
    if (para.length) { blocks.push({ type: "p", text: para.join(" ") }); para = []; }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    if (!t) { flushPara(); continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(t))) { flushPara(); blocks.push({ type: "h" + m[1].length, text: m[2].trim() }); continue; }
    if (/^([-*_])\1{2,}$/.test(t)) { flushPara(); blocks.push({ type: "hr" }); continue; }
    if ((m = /^[-*+]\s+(.*)$/.exec(t))) { flushPara(); blocks.push({ type: "li", text: m[1].trim() }); continue; }
    if ((m = /^\d+[.)]\s+(.*)$/.exec(t))) { flushPara(); blocks.push({ type: "oli", text: m[1].trim() }); continue; }
    if ((m = /^>\s?(.*)$/.exec(t))) { flushPara(); blocks.push({ type: "quote", text: m[1].trim() }); continue; }
    para.push(t);
  }
  flushPara();
  return blocks;
}

/** 演示分页：单独的 `---` 行切开；每页里第一个 # 当页标题。 */
function splitSlides(markdown) {
  const raw = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const pages = [];
  let cur = [];
  for (const line of raw) {
    if (/^\s*-{3,}\s*$/.test(line)) { pages.push(cur); cur = []; continue; }
    cur.push(line);
  }
  pages.push(cur);
  const out = [];
  for (const p of pages) {
    const blocks = parseBlocks(p.join("\n"));
    if (!blocks.length) continue;
    let title = "";
    const body = [];
    for (const b of blocks) {
      if (!title && b.type === "h1") { title = b.text; continue; }
      body.push(b);
    }
    if (!title) {
      // 没有一级标题就拿第一个非空行当标题，别让页面顶着"第 N 页"这种占位词
      const first = body.shift();
      title = first ? (first.text || "").slice(0, 40) : "";
    }
    out.push({ title: title, blocks: body });
  }
  return out;
}

/* ---------------- .docx ---------------- */

const DOC_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function docRun(r) {
  return '<w:r><w:rPr>' + (r.bold ? "<w:b/>" : "") + '</w:rPr><w:t xml:space="preserve">' + esc(r.text) + "</w:t></w:r>";
}

function docParagraph(b) {
  if (b.type === "hr") {
    return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr></w:pPr></w:p>';
  }
  let pPr = "";
  if (/^h[1-4]$/.test(b.type)) pPr += '<w:pStyle w:val="Heading' + b.type.slice(1) + '"/>';
  else if (b.type === "quote") pPr += '<w:pStyle w:val="Quote"/>';
  else if (b.type === "li") pPr += '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
  else if (b.type === "oli") pPr += '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>';
  const runs = inlineRuns(b.text || "").map(docRun).join("");
  return "<w:p>" + (pPr ? "<w:pPr>" + pPr + "</w:pPr>" : "") + runs + "</w:p>";
}

function docxParts(markdown) {
  const blocks = parseBlocks(markdown);
  const body = blocks.map(docParagraph).join("");
  const document_xml = XML_HEAD +
    '<w:document ' + DOC_W + '><w:body>' + body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>' +
    "</w:sectPr></w:body></w:document>";

  const h = (n, size, bold) => '<w:style w:type="paragraph" w:styleId="Heading' + n + '"><w:name w:val="heading ' + n + '"/>' +
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="' + (n - 1) + '"/></w:pPr>' +
    "<w:rPr>" + (bold ? "<w:b/>" : "") + '<w:sz w:val="' + size + '"/><w:szCs w:val="' + size + '"/></w:rPr></w:style>';
  const styles_xml = XML_HEAD + '<w:styles ' + DOC_W + '>' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:eastAsia="Microsoft YaHei"/>' +
    '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    h(1, 40, true) + h(2, 32, true) + h(3, 26, true) + h(4, 24, true) +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="4" w:color="CCCCCC"/></w:pBdr></w:pPr>' +
    '<w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>' +
    "</w:styles>";

  const numbering_xml = XML_HEAD + '<w:numbering ' + DOC_W + '>' +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="420" w:hanging="210"/></w:pPr><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>' +
    '</w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="420" w:hanging="210"/></w:pPr></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    "</w:numbering>";

  const content_types = XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    "</Types>";

  const rels = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    "</Relationships>";

  const doc_rels = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    "</Relationships>";

  return [
    { name: "[Content_Types].xml", data: content_types },
    { name: "_rels/.rels", data: rels },
    { name: "word/document.xml", data: document_xml },
    { name: "word/_rels/document.xml.rels", data: doc_rels },
    { name: "word/styles.xml", data: styles_xml },
    { name: "word/numbering.xml", data: numbering_xml },
    { name: "docProps/core.xml", data: coreProps("") },
    { name: "docProps/app.xml", data: appProps("Lumin", "Word") },
  ];
}

function coreProps(title) {
  return XML_HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    "<dc:creator>Lumin</dc:creator><cp:lastModifiedBy>Lumin</cp:lastModifiedBy>" +
    "<dc:title>" + esc(title) + "</dc:title>" +
    '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:modified>' +
    "</cp:coreProperties>";
}

function appProps(app, kind) {
  return XML_HEAD + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    "<Application>" + esc(app) + "</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>" +
    "<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>" +
    "<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion>" +
    "</Properties>";
}

/* ---------------- .pptx ---------------- */

const P_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

function aRun(text, opts) {
  const o = opts || {};
  const rPr = '<a:rPr lang="zh-CN" altLang="en-US" sz="' + (o.size || 1800) + '"' + (o.bold ? ' b="1"' : "") +
    ((o.color || "1F2328") ? ' ><a:solidFill><a:srgbClr val="' + (o.color || "1F2328") + '"/></a:solidFill>' : "") +
    '<a:latin typeface="Segoe UI"/><a:ea typeface="Microsoft YaHei"/></a:rPr>';
  return "<a:r>" + rPr + "<a:t>" + esc(text) + "</a:t></a:r>";
}

function aPara(text, opts) {
  const o = opts || {};
  let inner = "";
  if (o.bullet) inner += '<a:buChar char="' + (o.bulletChar || "•") + '"/>';
  if (o.indent) inner += '<a:spcBef><a:spcPts val="600"/></a:spcBef>';
  const pPr = inner ? "<a:pPr>" + inner + "</a:pPr>" : "<a:pPr/>";
  return "<a:p>" + pPr + aRun(text, o) + "</a:p>";
}

function slideXml(page, index) {
  const bodyParts = [];
  for (const b of page.blocks) {
    if (/^h[2-4]$/.test(b.type)) bodyParts.push(aPara(b.text, { size: 2000, bold: true, color: "11593C", indent: true }));
    else if (b.type === "li") bodyParts.push(aPara(b.text, { size: 1800, bullet: true }));
    else if (b.type === "oli") bodyParts.push(aPara(b.text, { size: 1800, bullet: true, bulletChar: "–" }));
    else if (b.type === "quote") bodyParts.push(aPara(b.text, { size: 1600, color: "55606A", indent: true }));
    else if (b.type === "hr") bodyParts.push(aPara("", { size: 1200 }));
    else bodyParts.push(aPara(b.text, { size: 1800 }));
  }
  const titleShape =
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title ' + index + '"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="838200" y="457200"/><a:ext cx="10515600" cy="1325563"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    '<p:txBody><a:bodyPr anchor="b"/><a:lstStyle/>' +
    aPara(page.title || ("第 " + index + " 页"), { size: 3200, bold: true, color: "0B2217" }) +
    "</p:txBody></p:sp>";
  const bodyShape =
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body ' + index + '"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="838200" y="2057400"/><a:ext cx="10515600" cy="4102738"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    '<p:txBody><a:bodyPr anchor="t"/><a:lstStyle/>' + bodyParts.join("") + "</p:txBody></p:sp>";
  return XML_HEAD + '<p:sld ' + P_NS + '><p:cSld><p:spTree>' +
    "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>" +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    titleShape + bodyShape +
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>";
}

function pptxParts(markdown, slides) {
  const content_types = XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    slides.map((_, i) => '<Override PartName="/ppt/slides/slide' + (i + 1) +
      '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>').join("") +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    "</Types>";

  const presentation_xml = XML_HEAD + '<p:presentation ' + P_NS + ' saveSubsetFonts="1">' +
    "<p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>" +
    "<p:sldIdLst>" + slides.map((_, i) => '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 2) + '"/>').join("") + "</p:sldIdLst>" +
    '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>' +
    "<p:defaultTextStyle><a:defPPr><a:defRPr lang=\"zh-CN\"/></a:defPPr></p:defaultTextStyle>" +
    "</p:presentation>";

  const presentation_rels = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    slides.map((_, i) => '<Relationship Id="rId' + (i + 2) +
      '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (i + 1) + '.xml"/>').join("") +
    "</Relationships>";

  const slide_rels = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    "</Relationships>";

  const master_xml = XML_HEAD + '<p:sldMaster ' + P_NS + '><p:cSld><p:spTree>' +
    "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>" +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    "<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang=\"zh-CN\"/><a:t>点一下编辑标题</a:t></a:r></a:p></p:txBody></p:sp>" +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Text Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    "<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang=\"zh-CN\"/><a:t>点一下编辑正文</a:t></a:r></a:p></p:txBody></p:sp>" +
    "</p:spTree></p:cSld>" +
    "<p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" " +
    "accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>" +
    "<p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst>" +
    "<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>" +
    "</p:sldMaster>";

  const master_rels = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    "</Relationships>";

  const layout_xml = XML_HEAD + '<p:sldLayout ' + P_NS + ' type="titleAndContent" preserve="1"><p:cSld name="标题和内容"><p:spTree>' +
    "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>" +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    "<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang=\"zh-CN\"/><a:t>标题</a:t></a:r></a:p></p:txBody></p:sp>" +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    "<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang=\"zh-CN\"/><a:t>正文</a:t></a:r></a:p></p:txBody></p:sp>" +
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";

  const layout_rels = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
    "</Relationships>";

  const theme_xml = XML_HEAD + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Lumin">' +
    "<a:themeElements><a:clrScheme name=\"Lumin\">" +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="0B2217"/></a:dk2><a:lt2><a:srgbClr val="F5F7F5"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="14684A"/></a:accent1><a:accent2><a:srgbClr val="1F7A57"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="51596A"/></a:accent3><a:accent4><a:srgbClr val="7A8B84"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="B08968"/></a:accent5><a:accent6><a:srgbClr val="5C6BC0"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="0F6CBD"/></a:hlink><a:folHlink><a:srgbClr val="8C5AA8"/></a:folHlink>' +
    "</a:clrScheme>" +
    '<a:fontScheme name="Lumin"><a:majorFont><a:latin typeface="Segoe UI"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Segoe UI"/><a:ea typeface="Microsoft YaHei"/><a:cs typeface=""/></a:minorFont></a:fontScheme>' +
    "<a:fmtScheme name=\"Lumin\"><a:fillStyleLst>" +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    "</a:fillStyleLst><a:lnStyleLst>" +
    '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
    "</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>" +
    "<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>" +
    "<a:bgFillStyleLst>" +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    "</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>";

  const root_rels = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    "</Relationships>";

  const parts = [
    { name: "[Content_Types].xml", data: content_types },
    { name: "_rels/.rels", data: root_rels },
    { name: "ppt/presentation.xml", data: presentation_xml },
    { name: "ppt/_rels/presentation.xml.rels", data: presentation_rels },
    { name: "ppt/slideMasters/slideMaster1.xml", data: master_xml },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: master_rels },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: layout_xml },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: layout_rels },
    { name: "ppt/theme/theme1.xml", data: theme_xml },
    { name: "docProps/core.xml", data: coreProps("") },
    { name: "docProps/app.xml", data: appProps("Lumin", "PowerPoint") },
  ];
  slides.forEach((page, i) => {
    parts.push({ name: "ppt/slides/slide" + (i + 1) + ".xml", data: slideXml(page, i + 1) });
    parts.push({ name: "ppt/slides/_rels/slide" + (i + 1) + ".xml.rels", data: slide_rels });
  });
  return parts;
}

/* ---------------- 对外入口 ---------------- */

function writeZip(parts, outPath) {
  if (!outPath) throw new Error("缺少输出路径");
  const buf = zipOf(parts);
  fs.writeFileSync(outPath, buf);
  return outPath;
}

/**
 * Markdown → .pptx。`---` 分页；每页第一个 `# ` 当标题（没有就用第一行）。
 * opts.slides：直接给 [{title, blocks}]，跳过 Markdown 分页。
 */
function exportPptx(markdown, outPath, opts) {
  const slides = (opts && opts.slides) || splitSlides(markdown);
  if (!slides.length) throw new Error("没有可导出的内容（Markdown 是空的）");
  return writeZip(pptxParts(markdown, slides), outPath);
}

/** Markdown → .docx。# / ## / ### 映射标题 1..3，`- ` 项目符号，`1. ` 编号。 */
function exportDocx(markdown, outPath, opts) {
  return writeZip(docxParts(markdown), outPath);
}

module.exports = { exportPptx, exportDocx, splitSlides, parseBlocks, crc32 };
