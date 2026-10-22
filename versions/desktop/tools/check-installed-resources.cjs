const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const [installed, output, pdf] = process.argv.slice(2);
const app = path.join(installed, 'resources', 'app');
(async () => {
  const {exportPptx, exportDocx} = require(path.join(app, 'deck-export.js'));
  const ppt = path.join(output, 'installed-export.pptx');
  const markdown = '# 安装版资源检查\n\n资料与学习记录\n\n---\n\n# 下一页\n\n安装后的文件输出';
  exportPptx(markdown, ppt);
  const {readResourceFile} = require(path.join(app, 'resource-reader.js'));
  const deck = await readResourceFile(ppt);
  if (deck.slides.length !== 2 || !deck.text.includes('安装版资源检查')) throw Error('Installed PPT output/read failed');
  console.log('PPT_EXPORT_AND_READ=OK');
  const doc = path.join(output, 'installed-export.docx');
  exportDocx(markdown, doc);
  if (!(await readResourceFile(doc)).text.includes('安装版资源检查')) throw Error('Installed DOCX output/read failed');
  console.log('DOCX_EXPORT_AND_READ=OK');
  const document = await readResourceFile(pdf);
  if (document.kind !== 'pdf' || document.text.length < 100) throw Error('Installed PDF dependencies failed');
  console.log('PDF_READ=OK chars=' + document.text.length);
  const python = path.join(app, 'renderer', 'ppt-renderer', 'python', 'python.exe');
  execFileSync(python, ['-X', 'utf8', '-c', 'import pptx, PIL, lxml; print("PPT_RUNTIME=OK")'], {stdio: 'inherit', windowsHide: true});
  const {DatabaseSync} = require('node:sqlite');
  const db = new DatabaseSync(path.join(output, 'Lumin', 'itn.db'), {readOnly: true});
  try { if (Object.values(db.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw Error('Installed application database corruption'); }
  finally { db.close(); }
  console.log('ISOLATED_DATABASE=OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
