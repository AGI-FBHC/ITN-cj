export function markLearningMapReturn(learnerId?: string | null): void {
  if (!learnerId || learnerId === 'loading' || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(`lf.knowledgeGraph3dReturn:v1:${learnerId}`, 'breadcrumb');
  } catch {
    // sessionStorage 不可用时仍允许正常返回学习地图。
  }
}

export function fullLearningResourcePath(resourceId: string | null): string {
  return `/learn/resource/${encodeURIComponent(resourceId ?? '')}?view=full`;
}
