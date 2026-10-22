import * as React from 'react';
import SystemLogo from '../SystemLogo.jsx';

/**
 * 复用旧版紫色火焰与科技树系统标记。
 * 管理端始终显示系统标记，机构 Logo 仅用于学员端。
 */
export default function BrandLogo({ variant = 'light', size = 34, className = '' }) {
  return <SystemLogo size={size} className={className} style={{ display: 'block', flexShrink: 0 }} />;
}
