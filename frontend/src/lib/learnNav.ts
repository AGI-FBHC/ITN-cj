/**
 * 学习地图跳转辅助。
 *
 * 所有“去学 / 继续学习 / 进入课程”类按钮统一走这里：
 * - 清掉上一会话遗留的 3D 知识点弹窗卡片（sessionStorage），避免从别的页面跳进来时卡片还开着；
 * - 清掉“从资源页返回地图”的镜头/视图还原标记，保证深链进入时是干净状态；
 * - 生成带 kp / unitTopic 深链参数的 /learn 地址（与“章节速览/去学这块”同一套展开逻辑）。
 */

const topicCardKey = (learnerId: string) => `lf.knowledgeGraph3dTopic:v1:${learnerId}`;
const learnViewKey = (learnerId: string) => `lf.learnView:v1:${learnerId}`;

export function clearLearnMapTransient(learnerId: string): void {
  try {
    window.sessionStorage.removeItem(topicCardKey(learnerId));
    window.sessionStorage.removeItem(learnViewKey(learnerId));
  } catch {
    /* ignore */
  }
}

export function learnMapPath(
  learnerId: string,
  kpId?: string | null,
  topicId?: string | null,
): string {
  clearLearnMapTransient(learnerId);
  if (!kpId) return '/learn';
  const params = new URLSearchParams();
  params.set('kp', kpId);
  if (topicId) params.set('unitTopic', topicId);
  return `/learn?${params.toString()}`;
}
