const TOKEN_KEY = 'zhixun-admin-token';
const NAME_KEY = 'zhixun-admin-name';

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

async function request(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
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
  testKbModel: () => request('/kb/test', { method: 'POST', body: {} }),
};
