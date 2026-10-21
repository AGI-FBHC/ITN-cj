import { bundlePreviewCache } from './bundle-preview-cache.js';

const TOKEN_KEY = 'zhixun-admin-token';
const NAME_KEY = 'zhixun-admin-name';
const orgQuery = (id) => id ? `?orgId=${encodeURIComponent(id)}` : '';
let previewScopeToken;
let previewScopePromise;

function previewScope() {
  const token = adminToken();
  if (!token) return Promise.resolve('');
  if (token !== previewScopeToken) {
    previewScopeToken = token;
    previewScopePromise = Promise.resolve().then(async () => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
    }).catch(() => '');
  }
  return previewScopePromise;
}

export function adminToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function adminName() {
  return localStorage.getItem(NAME_KEY) || '管理员';
}

export function clearAdminSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(NAME_KEY);
}

export class AdminError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = adminToken();
    const response = await fetch(`/api/admin${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new AdminError('服务返回格式异常，请重试', response.status); }
    if (response.status === 401) {
      clearAdminSession();
      throw new AdminError(data.message || '管理会话已失效，请重新登录', 401);
    }
    if (!response.ok) throw new AdminError(data.message || `请求失败（${response.status}）`, response.status);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new AdminError('连接超时，请重试', 0);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const adminApi = {
  login: async (account, password) => {
    const data = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, password }),
    }).then(async (response) => {
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!response.ok) throw new AdminError(parsed.message || '登录失败', response.status);
      return parsed;
    });
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(NAME_KEY, data.displayName || account);
    return data;
  },
  overview: () => request('/overview'),
  courses: () => request('/courses'),
  course: (id) => request(`/courses/${encodeURIComponent(id)}`),
  createCourse: (body) => request('/courses', { method: 'POST', body }),
  updateCourse: (id, body) => request(`/courses/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  setCourseStatus: (id, status) => request(`/courses/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status } }),
  deleteCourse: (id) => request(`/courses/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  addLesson: (id) => request(`/courses/${encodeURIComponent(id)}/lessons`, { method: 'POST', body: {} }),
  lesson: (id, index) => request(`/courses/${encodeURIComponent(id)}/lessons/${index}`),
  saveLesson: (id, index, body) =>
    request(`/courses/${encodeURIComponent(id)}/lessons/${index}`, { method: 'PUT', body }),
  deleteLesson: (id, index) =>
    request(`/courses/${encodeURIComponent(id)}/lessons/${index}`, { method: 'DELETE' }),
  users: () => request('/users'),
  kb: () => request('/kb'),
  kbDocument: (id) => request(`/kb/documents/${encodeURIComponent(id)}`),
  createKbDocument: (body) => request('/kb/documents', { method: 'POST', body }),
  reindexKbDocument: (id) => request(`/kb/documents/${encodeURIComponent(id)}/reindex`, { method: 'POST', body: {} }),
  deleteKbDocument: (id) => request(`/kb/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  kbSearch: (query, topK) => request('/kb/search', { method: 'POST', body: { query, topK } }),
  saveKbSettings: (settings) => request('/kb/settings', { method: 'PUT', body: settings }),
  publishKbDocument: (id, body = {}) => request(`/kb/documents/${encodeURIComponent(id)}/publish`, { method: 'POST', body }),
  unpublishKbDocument: (id) => request(`/kb/documents/${encodeURIComponent(id)}/unpublish`, { method: 'POST', body: {} }),
  testKbModel: (target = 'embedding', extra = {}) => request('/kb/test', { method: 'POST', body: { target, ...extra } }),
  kbBundles: async () => {
    const result = await request('/kb/bundles');
    const scope = await previewScope();
    if (scope && Array.isArray(result.bundles)) {
      await bundlePreviewCache.reconcile(scope, result.bundles.map((bundle) => bundle.id));
    }
    return result;
  },
  kbBundle: (id) => request(`/kb/bundles/${encodeURIComponent(id)}?metadata=1`),
  renameKbBundle: (id, title) => request(`/kb/bundles/${encodeURIComponent(id)}/title`, { method: 'PUT', body: { title } }),
  kbBundleSources: async (id) => {
    const token = adminToken();
    const scope = await previewScope();
    const load = async () => {
      const result = await adminApi.kbBundle(id);
      return { docs: result.docs || [], ready: result.bundle?.status === 'ready' };
    };
    return scope ? bundlePreviewCache.read(scope, id, 'directory', load,
      (value) => value.ready && adminToken() === token) : load();
  },
  kbBundleDocument: async (id, docId) => {
    const token = adminToken();
    const scope = await previewScope();
    const load = () => request(`/kb/bundles/${encodeURIComponent(id)}/docs/${encodeURIComponent(docId)}`);
    return scope ? bundlePreviewCache.read(scope, id, `doc:${docId}`, load,
      (value) => typeof value.doc?.content === 'string' && adminToken() === token) : load();
  },
  kbBundleStatus: (id) => request(`/kb/bundles/${encodeURIComponent(id)}/status`),
  kbBundleChunks: (id, offset = 0, limit = 30) =>
    request(`/kb/bundles/${encodeURIComponent(id)}/chunks?offset=${offset}&limit=${limit}`),
  retryKbBundle: async (id, stage = 'all') => {
    const scope = await previewScope();
    const result = await request(`/kb/bundles/${encodeURIComponent(id)}/retry?metadata=1`, { method: 'POST', body: { stage } });
    if (scope && stage === 'all' && result.bundle?.status !== 'ready') {
      await bundlePreviewCache.remove(scope, id);
    }
    return result;
  },
  publishKbBundle: (id) => request(`/kb/bundles/${encodeURIComponent(id)}/publish`, { method: 'POST', body: {} }),
  unpublishKbBundle: (id) => request(`/kb/bundles/${encodeURIComponent(id)}/unpublish`, { method: 'POST', body: {} }),
  generateLogos: (title, bundleId) => request('/logos/generate', { method: 'POST', body: { title, resourceType: 'kb_bundle', resourceId: bundleId } }),
  logoGeneration: (id) => request(`/logos/${encodeURIComponent(id)}`),
  selectLogo: (id, variantId) => request(`/logos/${encodeURIComponent(id)}/select`, { method: 'POST', body: { variantId } }),
  uploadBundleLogo: async (bundleId, file) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(`/api/admin/kb/bundles/${encodeURIComponent(bundleId)}/logo`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          ...(adminToken() ? { Authorization: `Bearer ${adminToken()}` } : {}),
        },
        body: file,
        signal: controller.signal,
      });
      let data;
      try { data = await response.json(); } catch { throw new AdminError('服务返回格式异常，请重试', response.status); }
      if (response.status === 401) clearAdminSession();
      if (!response.ok) throw new AdminError(data.message || `上传失败（${response.status}）`, response.status);
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new AdminError('图片处理超时，请重试', 0);
      throw error;
    } finally { clearTimeout(timeout); }
  },
  kbBundleAsset: async (path, { signal } = {}) => {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin || !/^\/api\/admin\/kb\/bundles\/[^/]+\/assets\/[^/]+$/.test(url.pathname)) {
      throw new AdminError('图片地址不可用', 0);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 20000);
    try {
      const token = adminToken();
      const response = await fetch(`${url.pathname}${url.search}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });
      if (response.status === 401) {
        clearAdminSession();
        throw new AdminError('管理会话已失效，请重新登录后查看图片', 401);
      }
      if (!response.ok) throw new AdminError('图片文件不存在或暂时无法读取', response.status);
      const blob = await response.blob();
      if (!blob.type.toLowerCase().startsWith('image/')) throw new AdminError('该文件不是可显示的图片', 0);
      return blob;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  },
  deleteKbBundle: async (id) => {
    const scope = await previewScope();
    const result = await request(`/kb/bundles/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (scope) await bundlePreviewCache.remove(scope, id);
    return result;
  },
  cwList: (bundleId) => request(`/kb/courseware${bundleId ? `?bundleId=${encodeURIComponent(bundleId)}` : ''}`),
  cwDetail: (id) => request(`/kb/courseware/${encodeURIComponent(id)}`),
  cwGenerate: (body) => request('/kb/courseware', { method: 'POST', body }),
  cwQueue: () => request('/kb/courseware/queue'),
  cwPublish: (id) => request(`/kb/courseware/${encodeURIComponent(id)}/publish`, { method: 'POST', body: {} }),
  cwUnpublish: (id) => request(`/kb/courseware/${encodeURIComponent(id)}/unpublish`, { method: 'POST', body: {} }),
  cwDelete: (id) => request(`/kb/courseware/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  cwChapters: (bundleId) => request(`/kb/courseware/chapters?bundleId=${encodeURIComponent(bundleId)}`),
  cwPublishChapter: (docId, bundleId, order) => request(`/kb/courseware/chapters/${encodeURIComponent(docId)}/publish`, { method: 'POST', body: { bundleId, order } }),
  cwUnpublishChapter: (docId, bundleId) => request(`/kb/courseware/chapters/${encodeURIComponent(docId)}/unpublish`, { method: 'POST', body: { bundleId } }),
  orgs: () => request('/orgs'),
  createOrg: (body) => request('/orgs', { method: 'POST', body }),
  orgInfo: (orgId) => request(`/org${orgQuery(orgId)}`),
  updateOrg: (body, orgId) => request(`/org${orgQuery(orgId)}`, { method: 'PUT', body }),
  generateOrgOnboarding: (orgId) => request(`/org/generate-onboarding${orgQuery(orgId)}`, {
    method: 'POST',
    body: {},
    timeoutMs: 120000,
  }),
  uploadOrgLogo: async (file, orgId) => {
    const response = await fetch(`/api/admin/org/logo${orgQuery(orgId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        ...(adminToken() ? { Authorization: `Bearer ${adminToken()}` } : {}),
      },
      body: file,
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { throw new AdminError('服务返回格式异常', response.status); }
    if (!response.ok) throw new AdminError(data.message || `上传失败（${response.status}）`, response.status);
    return data;
  },
  deleteOrgLogo: (orgId) => request(`/org/logo${orgQuery(orgId)}`, { method: 'DELETE' }),
  uploadKbBundle: async (file) => {
    const response = await fetch('/api/admin/kb/bundles', {
      method: 'POST',
      headers: {
        'X-Bundle-Name': encodeURIComponent(file.name),
        ...(adminToken() ? { Authorization: `Bearer ${adminToken()}` } : {}),
      },
      body: file,
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { throw new AdminError('服务返回格式异常', response.status); }
    if (!response.ok) throw new AdminError(data.message || `上传失败（${response.status}）`, response.status);
    return data;
  },
};
