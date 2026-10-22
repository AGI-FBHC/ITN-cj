/**
 * 外观设置：整页背景色切换
 *
 * 通过 <html data-bg="..."> 覆盖 --bg-base / 光晕 / 渐变等背景变量，
 * 生效于 body 与 body::before 绘制的整页底色，选择结果存 localStorage。
 */
export type BackgroundName = 'cream' | 'white' | 'mist' | 'haze';

export const BACKGROUNDS: Array<{ name: BackgroundName; label: string; hint: string; swatch: string }> = [
  { name: 'cream', label: '奶油', hint: '默认 · 温暖', swatch: '#F6F4EC' },
  { name: 'white', label: '暖白', hint: '干净 · 明亮', swatch: '#FAF9F5' },
  { name: 'mist', label: '雾青', hint: '清爽 · 护眼', swatch: '#EDF3EE' },
  { name: 'haze', label: '淡蓝', hint: '冷静 · 专注', swatch: '#EEF2F7' },
];

const BACKGROUND_KEY = 'lf.background';

export function readBackground(): BackgroundName {
  if (typeof window === 'undefined') return 'cream';
  try {
    const value = window.localStorage.getItem(BACKGROUND_KEY);
    return BACKGROUNDS.some((item) => item.name === value) ? (value as BackgroundName) : 'cream';
  } catch {
    return 'cream';
  }
}

export function applyBackground(name: BackgroundName): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.bg = name;
  try {
    window.localStorage.setItem(BACKGROUND_KEY, name);
  } catch {
    /* 存储不可用时仅本次生效 */
  }
}

/** 应用启动时读取并套用已保存的背景色 */
export function applyStoredBackground(): void {
  applyBackground(readBackground());
}
