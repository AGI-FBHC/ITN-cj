import * as React from 'react';
import { useLearning } from './learning-api.jsx';
import './cangjie-watermark.css';

export default function CangjieWatermark() {
  const learning = useLearning();
  if (!learning.ready || !learning.data?.profile) return null;
  return <span className="zx-cangjie-watermark" aria-hidden="true">Powered by Cangjie</span>;
}
