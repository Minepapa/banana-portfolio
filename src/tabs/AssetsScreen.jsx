import { useState } from 'react';
import { BORDER, RADIUS_SM, ACCENT, CARD_BG, EMPHASIS_INK, INK_2 } from '../lib/theme.js';
import HoldingsTab from './HoldingsTab.jsx';
import RebalanceTab from './RebalanceTab.jsx';

export default function AssetsScreen({ initialView = 'positions', holdingsProps, rebalanceProps }) {
  const [view, setView] = useState(initialView);
  const [touchStart, setTouchStart] = useState(null);
  const segmentStyle = (active) => ({
    flex: 1, padding: '8px 12px', border: BORDER, borderRadius: RADIUS_SM,
    background: active ? ACCENT : CARD_BG, color: active ? EMPHASIS_INK : INK_2,
    fontSize: 12, fontWeight: 700, cursor: 'pointer',
  });
  const handleContentTouchEnd = (event) => {
    if (!touchStart) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = touch.clientY - touchStart.y;
    setTouchStart(null);
    if (Math.abs(deltaX) < 50 || Math.abs(deltaY) > Math.abs(deltaX)) return;
    setView(deltaX < 0 ? 'target' : 'positions');
  };

  return (
    <div>
      <div role="tablist" aria-label="자산 화면" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button type="button" role="tab" aria-selected={view === 'positions'} onClick={() => setView('positions')} style={segmentStyle(view === 'positions')}>보유 현황</button>
        <button type="button" role="tab" aria-selected={view === 'target'} onClick={() => setView('target')} style={segmentStyle(view === 'target')}>목표비중</button>
      </div>
      <div onTouchStart={event => setTouchStart({ x: event.touches[0].clientX, y: event.touches[0].clientY })} onTouchEnd={handleContentTouchEnd}>
        {view === 'positions' && <HoldingsTab {...holdingsProps} />}
        {view === 'target' && <RebalanceTab {...rebalanceProps} />}
      </div>
    </div>
  );
}
