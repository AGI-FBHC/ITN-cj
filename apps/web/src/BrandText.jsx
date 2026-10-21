import * as React from 'react';
import { orgBrand } from './org-brand.js';
import './brand-text.css';

export function useOrgBrand() {
  const [brand, setBrand] = React.useState(orgBrand);
  React.useEffect(() => {
    const update = () => setBrand(orgBrand());
    window.addEventListener('zx-org-updated', update);
    update();
    return () => window.removeEventListener('zx-org-updated', update);
  }, []);
  return brand;
}

export default function BrandText({ inverse = false }) {
  const brand = useOrgBrand();
  return <span className={`zx-learner-brand-text${inverse ? ' zx-learner-brand-text-inverse' : ''}`}>
    <span className="zx-learner-brand-name">智训云枢</span>
    {brand?.shortName && <span className="zx-learner-org-badge" title={brand.shortName}>{brand.shortName}</span>}
  </span>;
}
