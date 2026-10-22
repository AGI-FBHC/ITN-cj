import * as React from 'react';

// Official ITN mark supplied by the project owner. The dark and light variants
// share identical geometry so the mark stays legible on every surface.
export default function SystemLogo({ size = 36, className = '', style, tone = 'dark' }) {
  const source = tone === 'light' ? '/brand/logo-mark-light.png' : '/brand/logo-mark.png';
  return (
    <img
      src={source}
      width={size}
      height={size}
      className={className}
      style={{ display: 'block', objectFit: 'contain', flexShrink: 0, ...style }}
      alt=""
      aria-hidden="true"
      draggable="false"
    />
  );
}
