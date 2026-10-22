/**
 * 我的学习书架
 *
 * 学习者「添加到我的学习」的课程会同时写入服务端（learner_course_enrollments），
 * 本地 localStorage 只做即时缓存；首页「正在学习」和热学榜的学习人数都来自服务端。
 */
import { api } from '@/lib/api';

const shelfKey = (learnerId: string) => `lf.myCourses:v1:${learnerId}`;

export function readMyCourses(learnerId: string): string[] {
  if (!learnerId || typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(shelfKey(learnerId)) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((code): code is string => typeof code === 'string') : [];
  } catch {
    return [];
  }
}

function writeMyCourses(learnerId: string, codes: string[]): void {
  try {
    window.localStorage.setItem(shelfKey(learnerId), JSON.stringify(codes));
  } catch {
    /* 本地存储不可用时仅当前会话生效 */
  }
}

/** 书架变更事件：首页推荐每次收到后重新检查 */
export const MY_COURSES_EVENT = 'lf:mycourses-changed';

function notify(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MY_COURSES_EVENT));
}

/** 从服务端同步书架：服务端为准，本地只做缓存；本地旧数据不再回写，避免删掉的课程又出现 */
export async function hydrateMyCourses(learnerId: string): Promise<string[]> {
  if (!learnerId) return [];
  try {
    const { codes } = await api.getMyCourses();
    writeMyCourses(learnerId, codes);
    notify();
    return codes;
  } catch {
    return readMyCourses(learnerId);
  }
}

/** 加入书架；已在书架中返回 false */
export function addMyCourse(learnerId: string, code: string): boolean {
  if (!learnerId || !code) return false;
  const list = readMyCourses(learnerId);
  if (list.includes(code)) return false;
  writeMyCourses(learnerId, [...list, code]);
  void api.addMyCourse(code).catch(() => undefined);
  notify();
  return true;
}

export function removeMyCourse(learnerId: string, code: string): void {
  if (!learnerId || !code) return;
  writeMyCourses(learnerId, readMyCourses(learnerId).filter((item) => item !== code));
  void api.removeMyCourse(code).catch(() => undefined);
  notify();
}
