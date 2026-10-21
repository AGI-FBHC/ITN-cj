// A brand is rendered only after the server resolves the current learning session.
// Persisted entries are separated by organization and never used to guess a new
// account's organization, so account switching cannot flash the previous logo.
const TOKEN_KEY = 'zhixun-learning-v2-token';
const CACHE_PREFIX = 'zhixun-org-brand-v2:';
let resolvedToken;
let currentBrand = null;
let pending;
let revision = 0;

const token = () => localStorage.getItem(TOKEN_KEY) || '';
function notify() {
  window.__zxOrg = currentBrand;
  document.title = '智训云枢';
  window.dispatchEvent(new Event('zx-org-updated'));
}

export function resetOrgBrand() {
  revision += 1;
  resolvedToken = undefined;
  currentBrand = null;
  pending = undefined;
  localStorage.removeItem('zhixun-org-brand');
  notify();
}

export function orgBrand() {
  return resolvedToken === token() ? currentBrand : null;
}

export function orgName() {
  const brand = orgBrand();
  return brand?.name || brand?.shortName || '智训云枢';
}

export function orgShortName() {
  const brand = orgBrand();
  return brand?.shortName || brand?.name || '智训云枢';
}

export function orgLogoUrl() {
  return orgBrand()?.logoUrl || '';
}

export function orgWebsiteUrl() {
  return orgBrand()?.websiteUrl || '';
}

export function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

export async function loadOrgBrand({ force = false } = {}) {
  const sessionToken = token();
  if (!force && pending?.token === sessionToken) return pending.promise;
  if (resolvedToken !== sessionToken) resetOrgBrand();
  const requestRevision = ++revision;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const promise = (async () => {
    try {
      const response = await fetch('/api/org', {
        headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!data?.id || !data.shortName || sessionToken !== token() || requestRevision !== revision) return null;
      const brand = {
        id: data.id,
        name: data.name || data.shortName,
        shortName: data.shortName,
        logoUrl: data.logoUrl || '',
        hasLogo: Boolean(data.hasLogo),
        websiteUrl: safeHttpUrl(data.websiteUrl),
        onboardingQuestions: Array.isArray(data.onboardingQuestions) ? data.onboardingQuestions : [],
      };
      resolvedToken = sessionToken;
      currentBrand = brand;
      try { localStorage.setItem(`${CACHE_PREFIX}${encodeURIComponent(brand.id)}`, JSON.stringify(brand)); } catch { /* Branding still works when storage is full. */ }
      notify();
      return brand;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      if (pending?.revision === requestRevision) pending = undefined;
    }
  })();
  pending = { token: sessionToken, promise, revision: requestRevision };
  return promise;
}

window.addEventListener('storage', (event) => {
  if (event.key !== TOKEN_KEY && event.key !== null) return;
  resetOrgBrand();
  loadOrgBrand();
});
