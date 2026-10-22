import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const LLM_SPREAD_RE = /(?<![A-Za-z])LLM(?![A-Za-z])/g;

/**
 * 解析后端返回的时间戳。
 * 后端（agents / Spring）有不少字段返回的是 **UTC 但不带时区标记** 的 ISO 字符串
 * （例如 2026-10-13T13:15:04.582363）。JS 的 new Date() 对“日期+时间但无时区”的
 * 字符串按**本地时间**解析，会整体偏移 8 小时；这里统一按 UTC 处理。
 */
export function parseApiInstant(value: string | null | undefined): Date | null {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const isNaiveDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text) && !hasZone;
  const parsed = new Date(isNaiveDateTime ? `${text.replace(' ', 'T')}Z` : text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function spreadLlmForSpeech(text: string) {
  return (text ?? '').replace(LLM_SPREAD_RE, 'L L M');
}
