const fs = require('node:fs');
const path = require('node:path');
const [source, output, modules] = process.argv.slice(2);
const sharp = require(path.join(modules, 'sharp'));
(async () => {
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map(size => sharp(source).resize(size, size).png().toBuffer()));
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((buffer, i) => {
    const p = 6 + i * 16;
    header[p] = header[p + 1] = sizes[i] === 256 ? 0 : sizes[i];
    header.writeUInt16LE(1, p + 4);
    header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(buffer.length, p + 8);
    header.writeUInt32LE(offset, p + 12);
    offset += buffer.length;
  });
  fs.writeFileSync(output, Buffer.concat([header, ...images]));
})().catch(error => { console.error(error); process.exitCode = 1; });
