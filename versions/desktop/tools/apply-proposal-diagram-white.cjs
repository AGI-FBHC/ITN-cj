/** Replace only the architecture and topology figures with white-background versions.
 *
 * Usage:
 *   node tools/apply-proposal-diagram-white.cjs <source.docx> <output.docx>
 *
 * The document is located by figure caption and its OOXML relationship, not by a
 * hard-coded media filename. Only the two referenced PNG entries are changed.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('C:/Users/GeJie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/jszip');
const sharp = require('C:/Users/GeJie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');

const source = process.argv[2];
const output = process.argv[3];
if (!source || !output || path.resolve(source) === path.resolve(output)) {
  throw new Error('Provide distinct source and output DOCX paths');
}

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
const plain = xml => [...xml.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)]
  .map(match => match[1])
  .join('')
  .replace(/\s+/g, '');

const targets = [
  {
    name: 'architecture',
    caption: '图6-1Web与Desktop的组件职责',
    dimensions: [1800, 1100],
  },
  {
    name: 'topology',
    caption: '图7-1Web部署与Desktop本机运行',
    dimensions: [1800, 1080],
  },
];

function getRelationshipTarget(relsXml, id) {
  const relationship = [...relsXml.matchAll(/<Relationship\s[^>]*\/?>/g)]
    .map(match => Object.fromEntries(
      [...match[0].matchAll(/([\w:]+)="([^"]*)"/g)].map(attr => [attr[1], attr[2]]),
    ))
    .find(item => item.Id === id);
  if (!relationship || relationship.TargetMode === 'External') {
    throw new Error(`Expected an embedded image relationship for ${id}`);
  }
  const target = path.posix.normalize(`word/${relationship.Target}`);
  if (!target.startsWith('word/media/')) {
    throw new Error(`Relationship ${id} does not point to word/media`);
  }
  return target;
}

function findTargetMedia(documentXml, relsXml, caption) {
  const paragraphs = [...documentXml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(match => match[0]);
  const captionIndexes = paragraphs
    .map((paragraph, index) => plain(paragraph) === caption ? index : -1)
    .filter(index => index >= 0);
  if (captionIndexes.length !== 1) {
    throw new Error(`Expected one caption "${caption}", found ${captionIndexes.length}`);
  }

  let pictureParagraph;
  for (let index = captionIndexes[0] - 1; index >= 0; index -= 1) {
    if (paragraphs[index].includes('r:embed=')) {
      pictureParagraph = paragraphs[index];
      break;
    }
    if (plain(paragraphs[index])) {
      throw new Error(`No adjacent picture before "${caption}"`);
    }
  }
  if (!pictureParagraph) {
    throw new Error(`Missing picture before "${caption}"`);
  }

  const relationshipId = pictureParagraph.match(/r:embed="([^"]+)"/)?.[1];
  if (!relationshipId) {
    throw new Error(`Missing image relationship before "${caption}"`);
  }
  const uses = [...documentXml.matchAll(new RegExp(`r:embed="${relationshipId}"`, 'g'))].length;
  if (uses !== 1) {
    throw new Error(`Target image ${relationshipId} is used ${uses} times`);
  }
  return {
    relationshipId,
    mediaPath: getRelationshipTarget(relsXml, relationshipId),
  };
}

async function whiteBackground(imageBytes) {
  const { data, info } = await sharp(imageBytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let cleared = 0;
  let neutralized = 0;
  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);

    // Remove neutral page whites and pale green fills such as #F5F9F6.
    if ((max >= 248 && max - min <= 3)
      || (g > r && g > b && min >= 228)) {
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      cleared += 1;
      continue;
    }

    // Keep dark green arrows and labels; neutralize only the pale green card
    // borders/antialiasing that would still leave a green cast on white.
    if (g > r && g > b && min >= 200) {
      const neutral = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      data[index] = neutral;
      data[index + 1] = neutral;
      data[index + 2] = neutral;
      neutralized += 1;
    }
  }

  const rendered = await sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
  }).png({
    compressionLevel: 9,
    adaptiveFiltering: true,
  }).toBuffer();
  const verification = await sharp(rendered).ensureAlpha().raw().toBuffer();
  let greenCast = 0;
  let whitePixels = 0;
  for (let index = 0; index < verification.length; index += 4) {
    const r = verification[index];
    const g = verification[index + 1];
    const b = verification[index + 2];
    if (r === 255 && g === 255 && b === 255) {
      whitePixels += 1;
    }
    if (Math.min(r, g, b) >= 225 && g > r + 1 && g > b + 1) {
      greenCast += 1;
    }
  }
  if (greenCast !== 0) {
    throw new Error(`White-background conversion left ${greenCast} pale green pixels`);
  }
  return {
    bytes: rendered,
    stats: {
      width: info.width,
      height: info.height,
      cleared,
      neutralized,
      greenCast,
      whitePixelRatio: Number((whitePixels / (info.width * info.height)).toFixed(4)),
    },
  };
}

(async () => {
  const sourceBytes = fs.readFileSync(source);
  const before = await JSZip.loadAsync(sourceBytes);
  const documentXml = await before.file('word/document.xml').async('string');
  const relsXml = await before.file('word/_rels/document.xml.rels').async('string');
  const after = await JSZip.loadAsync(sourceBytes);
  const replacements = [];

  for (const target of targets) {
    const located = findTargetMedia(documentXml, relsXml, target.caption);
    const original = await before.file(located.mediaPath).async('nodebuffer');
    const metadata = await sharp(original).metadata();
    if (metadata.format !== 'png'
      || metadata.width !== target.dimensions[0]
      || metadata.height !== target.dimensions[1]) {
      throw new Error(
        `${target.name} expected PNG ${target.dimensions.join('x')}, `
        + `got ${metadata.format} ${metadata.width}x${metadata.height}`,
      );
    }
    const converted = await whiteBackground(original);
    after.file(located.mediaPath, converted.bytes);
    replacements.push({
      name: target.name,
      caption: target.caption,
      mediaPath: located.mediaPath,
      relationshipId: located.relationshipId,
      originalHash: sha(original),
      outputHash: sha(converted.bytes),
      ...converted.stats,
    });
  }

  const outputBytes = await after.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const verify = await JSZip.loadAsync(outputBytes);
  if (Object.keys(before.files).join('\n') !== Object.keys(verify.files).join('\n')) {
    throw new Error('DOCX package entries changed unexpectedly');
  }
  const changed = [];
  for (const name of Object.keys(before.files)) {
    if (before.files[name].dir) continue;
    const previous = await before.file(name).async('nodebuffer');
    const current = await verify.file(name).async('nodebuffer');
    if (sha(previous) !== sha(current)) changed.push(name);
  }
  const expectedChanges = replacements.map(item => item.mediaPath).sort();
  if (changed.sort().join('\n') !== expectedChanges.join('\n')) {
    throw new Error(`Unexpected package changes: ${changed.join(', ')}`);
  }
  if (changed.includes('word/document.xml')) {
    throw new Error('word/document.xml must remain byte-identical');
  }

  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, outputBytes);
  const previewDir = path.join(path.dirname(path.resolve(output)), 'proposal-diagrams-after');
  fs.mkdirSync(previewDir, { recursive: true });
  for (const replacement of replacements) {
    fs.writeFileSync(
      path.join(previewDir, `${replacement.name}.png`),
      await verify.file(replacement.mediaPath).async('nodebuffer'),
    );
  }

  const report = {
    source: path.resolve(source),
    sourceHash: sha(sourceBytes),
    output: path.resolve(output),
    outputHash: sha(outputBytes),
    changedEntries: changed,
    documentXmlUnchanged: true,
    replacements,
  };
  const reportPath = output.replace(/\.docx$/i, '-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(error => {
  console.error(`FAIL ${error.stack || error.message}`);
  process.exitCode = 1;
});
