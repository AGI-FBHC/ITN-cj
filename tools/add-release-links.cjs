/**
 * Add verified repository and release download links to the proposal DOCX.
 * Usage: node tools/add-release-links.cjs <source.docx> <output.docx>
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dependencies = process.env.CODEX_DOCUMENT_NODE_MODULES ||
  'C:/Users/GeJie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const JSZip = require(path.join(dependencies, 'jszip'));

const source = process.argv[2];
const output = process.argv[3];
if (!source || !output || path.resolve(source) === path.resolve(output)) {
  throw new Error('Provide distinct source and output DOCX paths');
}

const repository = 'https://github.com/AGI-FBHC/ITN-cj';
const desktopBranch = repository + '/tree/desktop';
const download = 'http://172.22.64.189:6025/Lumin-0.8.28.zip';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const xmlEscape = value => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const paragraphText = paragraph =>
  [...paragraph.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map(match => match[1])
    .join('');

function run(text, properties = '') {
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return '<w:r>' + properties + '<w:t' + preserve + '>' + xmlEscape(text) + '</w:t></w:r>';
}

function hyperlinkRun(text, relationshipId, properties) {
  return '<w:hyperlink r:id="' + relationshipId + '" w:history="1">' +
    run(text, properties) + '</w:hyperlink>';
}

function bodyRunProperties(baseParagraph) {
  const firstRun = baseParagraph.match(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/)?.[0] || '';
  return firstRun.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || '';
}

function linkRunProperties(baseRunProperties) {
  const additions = '<w:color w:val="0563C1"/><w:u w:val="single"/>';
  if (baseRunProperties.endsWith('</w:rPr>')) {
    return baseRunProperties.replace(/<\/w:rPr>$/, additions + '</w:rPr>');
  }
  return '<w:rPr>' + additions + '</w:rPr>';
}

function makeParagraph(baseParagraph, runs) {
  const paragraphProperties = baseParagraph.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || '';
  return '<w:p>' + paragraphProperties + runs + '</w:p>';
}

(async () => {
  const beforeBytes = fs.readFileSync(source);
  const zip = await JSZip.loadAsync(beforeBytes);
  let documentXml = await zip.file('word/document.xml').async('string');
  let relationships = await zip.file('word/_rels/document.xml.rels').async('string');
  const paragraphs = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)];
  const target = paragraphs.find(match => {
    const text = paragraphText(match[0]);
    return text.includes('源码仓库沿用') && text.includes('Lumin-0.8.28.zip');
  });
  if (!target) throw new Error('Could not find the release entry paragraph');

  const existingIds = new Set([...relationships.matchAll(/\bId="([^"]+)"/g)].map(match => match[1]));
  let nextId = 9001;
  const newRelationshipId = () => {
    while (existingIds.has('rId' + nextId)) nextId += 1;
    const id = 'rId' + nextId++;
    existingIds.add(id);
    return id;
  };
  const repoId = newRelationshipId();
  const branchId = newRelationshipId();
  const downloadId = newRelationshipId();

  const base = target[0];
  const normalProperties = bodyRunProperties(base);
  const linkProperties = linkRunProperties(normalProperties);
  const repoParagraph = makeParagraph(base,
    run('项目代码托管于 GitHub：', normalProperties) +
    hyperlinkRun(repository, repoId, linkProperties) +
    run('；Desktop 源码位于 ', normalProperties) +
    hyperlinkRun('desktop 分支', branchId, linkProperties) +
    run('。', normalProperties));
  const downloadParagraph = makeParagraph(base,
    run('运行包下载：', normalProperties) +
    hyperlinkRun(download, downloadId, linkProperties) +
    run('（231,932,690 字节；当前为局域网地址，访问设备需与下载主机处于同一网络）。SHA256：', normalProperties));
  documentXml = documentXml.replace(base, repoParagraph + downloadParagraph);

  const relationshipXml = [
    '<Relationship Id="' + repoId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + xmlEscape(repository) + '" TargetMode="External"/>',
    '<Relationship Id="' + branchId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + xmlEscape(desktopBranch) + '" TargetMode="External"/>',
    '<Relationship Id="' + downloadId + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + xmlEscape(download) + '" TargetMode="External"/>',
  ].join('');
  relationships = relationships.replace('</Relationships>', relationshipXml + '</Relationships>');

  zip.file('word/document.xml', documentXml);
  zip.file('word/_rels/document.xml.rels', relationships);
  const afterBytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: {level: 6},
  });
  fs.mkdirSync(path.dirname(output), {recursive: true});
  fs.writeFileSync(output, afterBytes);

  const report = {
    source,
    output,
    sourceBytes: beforeBytes.length,
    outputBytes: afterBytes.length,
    sourceSha256: sha(beforeBytes),
    outputSha256: sha(afterBytes),
    repository,
    desktopBranch,
    download,
    relationshipIds: {repoId, branchId, downloadId},
    insertedParagraphs: [paragraphText(repoParagraph), paragraphText(downloadParagraph)],
  };
  fs.writeFileSync(output + '.report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

