// 机构品牌：管理员在「机构设置」里配的名称/简称/Logo，登录后的用户端沿用。
const CACHE_KEY = 'zhixun-org-brand';

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// 同步读取，供渲染直接用；首次使用会先落一次网络结果到缓存。
export function orgBrand() {
  const cached = readCache();
  if (cached && cached.shortName) return cached;
  return null;
}

export function orgName() {
  const brand = orgBrand();
  return (brand && (brand.name || brand.shortName)) || '智训云枢';
}

export function orgShortName() {
  const brand = orgBrand();
  return (brand && (brand.shortName || brand.name)) || '智训云枢';
}

export function orgLogoUrl() {
  const brand = orgBrand();
  return (brand && brand.logoUrl) || '';
}

export async function loadOrgBrand() {
  try {
    const response = await fetch('/api/org');
    if (!response.ok) return null;
    const data = await response.json();
    if (!data || !data.shortName) return null;
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    window.__zxOrg = data;
    if (typeof document !== 'undefined' && data.shortName) document.title = data.shortName;
    window.dispatchEvent(new Event('zx-org-updated'));
    return data;
  } catch {
    return null;
  }
}
