/**
 * Replace the verified release download URL in an existing proposal DOCX.
 * Usage: node tools/replace-release-url.cjs <source.docx> <output.docx> <public-url>
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dependencies = process.env.CODEX_DOCUMENT_NODE_MODULES ||
  'C:/Users/GeJie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const JSZip = require(path.join(dependencies, 'jszip'));

const source = process.argv[2];
const output = process.argv[3];
const publicUrl = process.argv[4];
if (!source || !output || !publicUrl ||
    path.resolve(source) === path.resolve(output)) {
  throw new Error('Provide source DOCX, distinct output DOCX and public URL');
}
if (!/^https?:\/\//i.test(publicUrl)) {
  throw new Error('The public download URL must use HTTP or HTTPS');
}

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();

(async () => {
  const beforeBytes = fs.readFileSync(source);
  const zip = await JSZip.loadAsync(beforeBytes);
  let documentXml = await zip.file('word/document.xml').async('string');
  let relationships = await zip.file('word/_rels/document.xml.rels').async('string');

  const oldTargets = [...relationships.matchAll(
    /<Relationship\b[^>]*\bType="[^"]*\/hyperlink"[^>]*\bTarget="(https?:\/\/[^"]+\.zip)"[^>]*\/>/gi,
  )].map(match => match[1]);
  const uniqueTargets = [...new Set(oldTargets)];
  if (uniqueTargets.length !== 1) {
    throw new Error('Expected exactly one ZIP hyperlink, found ' + uniqueTargets.length);
  }

  const oldUrl = uniqueTargets[0];
  if (!documentXml.includes(oldUrl) || !relationships.includes(oldUrl)) {
    throw new Error('The existing ZIP URL is not present in both document.xml and relationships');
  }

  documentXml = documentXml.split(oldUrl).join(publicUrl);
  relationships = relationships.split(oldUrl).join(publicUrl);

  const oldNotice = '当前为局域网地址，访问设备需与下载主机处于同一网络';
  const newNotice = '公网地址可直接访问';
  const noticeReplaced = documentXml.includes(oldNotice);
  if (noticeReplaced) {
    documentXml = documentXml.split(oldNotice).join(newNotice);
  }

  if (!documentXml.includes(publicUrl) || !relationships.includes(publicUrl) ||
      documentXml.includes(oldUrl) || relationships.includes(oldUrl) ||
      documentXml.includes('172.22.64.189') || relationships.includes('172.22.64.189')) {
    throw new Error('Public URL replacement verification failed');
  }

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
    oldUrl,
    publicUrl,
    noticeReplaced,
  };
  const reportPath = output + '.report.json';
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
