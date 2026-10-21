import * as React from 'react';

/**
 * 系统品牌标记。三套素材来自 public/brand：
 * 浅色背景用 logo-light、深色背景用 logo-dark、透明底用 logo-transparent。
 * 管理端始终显示系统标记，机构 Logo 仅用于学员端。
 */
export default function BrandLogo({ variant = 'light', size = 34, className = '' }) {
  const src = variant === 'dark' ? '/brand/logo-dark.png' : '/brand/logo-light.png';
  const transparent = variant === 'transparent';

  return (
    <img
      src={transparent ? '/brand/logo-transparent.png' : src}
      alt=""
      aria-hidden="true"
      className={className}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        borderRadius: transparent ? 0 : 10,
        display: 'block',
      }}
    />
  );
}
