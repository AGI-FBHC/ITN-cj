import * as React from 'react';

// Restored from the purple frontend's components/Logo.tsx (FlameLogo).
export default function SystemLogo({ size = 36, className = '', style }) {
  const gradient = `system-flame-${React.useId().replace(/:/g, '')}`;
  return <svg width={size} height={size} className={className} style={style} viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <defs><linearGradient id={gradient} x1="32" y1="4" x2="32" y2="60" gradientUnits="userSpaceOnUse">
      <stop stopColor="#A78BFA" /><stop offset="1" stopColor="#6D28D9" />
    </linearGradient></defs>
    <path d="M32 3C34 12 46 16 46 30c0 4-1.4 7-3.4 9.6C47 36 49 31 48.6 27 54 32 56 38.5 56 44c0 11-10.7 18-24 18S8 55 8 44c0-8 4.6-13.4 9-18-.4 5 1 9 3.4 11.4C19 34 18 28 22 22c3-4.5 8-7 10-19Z" fill={`url(#${gradient})`} />
    <g stroke="#EDE9FE" strokeWidth="2.4" strokeLinecap="round"><path d="M32 58V38M32 46l-7-6M32 42l7-6M32 50l-9-2" /></g>
    <g fill="#EDE9FE"><circle cx="32" cy="36" r="2.6" /><circle cx="24" cy="39" r="2.2" /><circle cx="40" cy="35" r="2.2" /><circle cx="22" cy="47.5" r="2" /></g>
  </svg>;
}
