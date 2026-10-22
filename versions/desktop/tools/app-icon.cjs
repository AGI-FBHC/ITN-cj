// Windows executable resources belong to the build step, not the learning kernel.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const shellRequire = createRequire(path.join(__dirname, '../shell/package.json'));

async function main() {
  const [target, mode = '--check'] = process.argv.slice(2);
  if (!target || !['--check', '--apply'].includes(mode)) {
    throw new Error('Usage: node tools/app-icon.cjs <Lumin.exe> [--check|--apply]');
  }
  const RE = await shellRequire('resedit/cjs').load();
  const icon = RE.Data.IconFile.from(fs.readFileSync(path.join(__dirname, '../shell/assets/lumin.ico')));
  const pkg = shellRequire('./package.json');
  const exe = RE.NtExecutable.from(fs.readFileSync(target));
  const resources = RE.NtExecutableResource.from(exe);
  const groups = RE.Resource.IconGroupEntry.fromEntries(resources.entries);
  if (mode === '--apply') {
    // Replace every original group so Explorer cannot fall back to an Electron icon.
    for (const group of groups.length ? groups : [{ id: 1, lang: 1033 }]) {
      RE.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang,
        icon.icons.map(item => item.data));
    }
    const versions = RE.Resource.VersionInfo.fromEntries(resources.entries);
    for (const version of versions) {
      const languages = version.getAllLanguagesForStringValues();
      for (const language of languages) {
        version.setFileVersion(pkg.version, language.lang);
        version.setProductVersion(pkg.version, language.lang);
        version.setStringValues(language, {
          ProductName: 'Lumin', FileDescription: pkg.description,
          InternalName: 'Lumin', OriginalFilename: 'Lumin.exe', CompanyName: 'Lumin',
        });
      }
      version.outputToResourceEntries(resources.entries);
    }
    resources.outputResource(exe);
    fs.writeFileSync(target, Buffer.from(exe.generate()));
  }
  // Read back the actual PE; checking the source image alone misses the original bug.
  const result = RE.NtExecutableResource.from(RE.NtExecutable.from(fs.readFileSync(target)));
  const actualGroups = RE.Resource.IconGroupEntry.fromEntries(result.entries);
  assert(actualGroups.length > 0, 'EXE contains no Windows icon group');
  for (const group of actualGroups) {
    const items = group.getIconItemsFromEntries(result.entries);
    assert.equal(items.length, icon.icons.length, 'EXE icon sizes differ from the project ICO');
    items.forEach((item, index) => assert.deepEqual(Buffer.from(item.bin),
      Buffer.from(icon.icons[index].data.bin), 'EXE still contains a different icon'));
  }
  const version = RE.Resource.VersionInfo.fromEntries(result.entries)[0];
  assert(version, 'EXE has no product information');
  for (const language of version.getAllLanguagesForStringValues()) {
    const values = version.getStringValues(language);
    assert.equal(values.ProductName, 'Lumin');
    assert.equal(values.OriginalFilename, 'Lumin.exe');
    assert.equal(values.FileVersion, pkg.version + '.0');
    assert.equal(values.ProductVersion, pkg.version + '.0');
  }
  console.log('PASS embedded Lumin icon: ' + icon.icons.map(item => item.width || item.data.width).join('/')
    + '; product=Lumin; version=' + pkg.version + '; ' + target);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
