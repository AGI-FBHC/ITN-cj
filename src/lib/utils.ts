import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const LLM_SPREAD_RE = /(?<![A-Za-z])LLM(?![A-Za-z])/g;

export function spreadLlmForSpeech(text: string) {
  return (text ?? '').replace(LLM_SPREAD_RE, 'L L M');
}
