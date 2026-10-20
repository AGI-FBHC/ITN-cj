import * as React from 'react';

/**
 * 系统品牌标记。三套素材来自 public/brand：
 * 浅色背景用 logo-light、深色背景用 logo-dark、透明底用 logo-transparent。
 * 机构在上传自己的 Logo 后，这里优先显示机构的。
 */
export default function BrandLogo({ variant = 'light', size = 34, className = '' }) {
  const [orgLogo, setOrgLogo] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    fetch('/api/org')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => { if (alive && data?.logoUrl) setOrgLogo(data.logoUrl); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const src = orgLogo || (variant === 'dark' ? '/brand/logo-dark.png' : '/brand/logo-light.png');
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
