const fs = require('node:fs/promises');
const path = require('node:path');
const {fileURLToPath} = require('node:url');

function failure(code, error, resolvedPath) {
  return {ok: false, code, error, ...(resolvedPath ? {path: resolvedPath} : {})};
}

function isAbsolute(value) {
  if (!path.isAbsolute(value)) return false;
  // A Windows root-relative path still needs a drive; never infer it from cwd.
  return process.platform !== 'win32' || /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
}

function localPath(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw Object.assign(new Error('路径为空或包含无效字符'), {code: 'INVALID_PATH'});
  }
  const text = value.trim();
  if (/^file:/i.test(text)) {
    try {
      const url = new URL(text);
      return {path: fileURLToPath(url), fragment: url.hash.slice(1)};
    } catch (error) {
      throw Object.assign(new Error('无效的文件链接：' + error.message), {code: 'INVALID_PATH'});
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) {
    throw Object.assign(new Error('该引用不是本地文件路径'), {code: 'UNSUPPORTED_PROTOCOL'});
  }
  // Percent signs are valid in native filenames. Decode only actual file URIs.
  return {path: text, fragment: ''};
}

function location(fragment) {
  const match = String(fragment).match(/^L?([1-9]\d*)(?:[C:]([1-9]\d*))?(?:-L?[1-9]\d*)?$/i);
  if (!match) return {};
  const line = Number(match[1]), column = match[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(line) || (column !== undefined && !Number.isSafeInteger(column))) return {};
  return {line, ...(column !== undefined ? {column} : {})};
}

async function existingPath(resolvedPath) {
  const info = await fs.stat(resolvedPath);
  if (!info.isFile() && !info.isDirectory()) {
    throw Object.assign(new Error('该路径不是文件或目录'), {code: 'UNSUPPORTED_PATH_KIND'});
  }
  return {ok: true, path: await fs.realpath(resolvedPath), kind: info.isDirectory() ? 'directory' : 'file'};
}

async function resolveReferencePath(reference) {
  const input = typeof reference === 'string' ? {path: reference} : reference;
  let resolvedPath;
  try {
    const parsed = localPath(input?.path);
    if (isAbsolute(parsed.path)) {
      resolvedPath = path.normalize(parsed.path);
    } else {
      if (!input.baseDir) return failure('BASE_DIR_REQUIRED', '相对路径需要指定所属目录');
      let base;
      try {
        base = localPath(input.baseDir).path;
        if (!isAbsolute(base) || !(await fs.stat(base)).isDirectory()) throw new Error('baseDir must be an existing absolute directory');
      } catch (error) {
        return failure('INVALID_BASE_DIR', '所属目录不可用：' + error.message);
      }
      resolvedPath = path.resolve(base, parsed.path);
    }
    try {
      const resolved = await existingPath(resolvedPath);
      return {...resolved, ...(resolved.kind === 'file' ? location(parsed.fragment) : {})};
    } catch (originalError) {
      // Try editor-style locations only after the full literal filename failed.
      if (!['ENOENT', 'ENOTDIR', 'EINVAL'].includes(originalError.code)) throw originalError;
      const suffix = resolvedPath.match(/(?::([1-9]\d*)(?::([1-9]\d*))?|#(L?[1-9]\d*(?:[C:][1-9]\d*)?(?:-L?[1-9]\d*)?))$/i);
      if (suffix) {
        try {
          const resolved = await existingPath(resolvedPath.slice(0, suffix.index));
          const position = location(suffix[3] || suffix[1] + (suffix[2] ? ':' + suffix[2] : ''));
          if (resolved.kind === 'file' && position.line) return {...resolved, ...position};
        } catch (_error) { /* Report the original full reference if both lookups fail. */ }
      }
      throw originalError;
    }
  } catch (error) {
    const message = error.code === 'ENOENT' || error.code === 'ENOTDIR'
      ? '路径不存在：' + resolvedPath
      : String(error.message || error);
    return failure(error.code || 'RESOLVE_FAILED', message, resolvedPath);
  }
}

function resolveExternalUrl(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    return failure('INVALID_URL', '无效的链接');
  }
  const text = value.trim();
  if (/^lumin:/i.test(text)) return failure('INTERNAL_REFERENCE', '请在 Lumin 内打开会话链接');
  if (!/^(?:https?:\/\/|mailto:)/i.test(text)) {
    return failure('UNSUPPORTED_PROTOCOL', '只允许打开 http、https 或 mailto 链接');
  }
  try {
    const url = new URL(text);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new Error('Unsupported URL protocol');
    if (url.protocol !== 'mailto:' && !url.hostname) throw new Error('Missing URL host');
    return {ok: true, url: url.href};
  } catch (_error) {
    return failure('INVALID_URL', '无效的链接');
  }
}

function threadIdFromUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'lumin:' || url.hostname.toLowerCase() !== 'thread' || url.username || url.password || url.port) return '';
    return url.pathname.match(/^\/([A-Za-z0-9_-]+)\/?$/)?.[1] || '';
  } catch (_error) {
    return '';
  }
}

module.exports = {resolveReferencePath, resolveExternalUrl, threadIdFromUrl};
