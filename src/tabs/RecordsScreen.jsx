import { useState } from 'react';
import { CARD_BG, ACCENT, EMPHASIS_INK, INK_2, BORDER, RADIUS_SM, PAPER_2, INK } from '../lib/theme.js';
import ExecutionsTab from './ExecutionsTab.jsx';
import DividendTab from './DividendTab.jsx';
import ProfitTab from './ProfitTab.jsx';

const views = [
  ['exec', '체결내역'],
  ['div', '배당금'],
  ['profit', '수익금'],
];

export default function RecordsScreen({ initialView = 'exec', executionsProps, dividendProps, profitProps }) {
  const [view, setView] = useState(initialView);
  const [search, setSearch] = useState('');
  const [touchStart, setTouchStart] = useState(null);
  const handleContentTouchEnd = (event) => {
    if (!touchStart) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = touch.clientY - touchStart.y;
    setTouchStart(null);
    if (Math.abs(deltaX) < 50 || Math.abs(deltaY) > Math.abs(deltaX)) return;
    const index = views.findIndex(([key]) => key === view);
    const nextIndex = index + (deltaX < 0 ? 1 : -1);
    if (nextIndex >= 0 && nextIndex < views.length) setView(views[nextIndex][0]);
  };
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredTrades = normalizedSearch
    ? executionsProps.trades.filter(trade =>
      `${trade.name ?? ''} ${trade.account ?? ''}`.toLocaleLowerCase().includes(normalizedSearch))
    : executionsProps.trades;
  return (
    <div>
      <div role="tablist" aria-label="기록 화면" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {views.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)} style={{
            flex: 1, padding: '10px 12px', border: BORDER, borderRadius: RADIUS_SM,
            background: view === key ? ACCENT : CARD_BG, color: view === key ? EMPHASIS_INK : INK_2,
            fontWeight: 700, cursor: 'pointer',
          }}>{label}</button>
        ))}
      </div>
      <div onTouchStart={event => setTouchStart({ x: event.touches[0].clientX, y: event.touches[0].clientY })} onTouchEnd={handleContentTouchEnd}>
        {view === 'exec' && <>
          <input
            type="search"
            aria-label="체결내역 검색"
            placeholder="종목명 또는 계좌명 검색"
            value={search}
            onChange={event => setSearch(event.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', marginBottom: 12, padding: '10px 12px', border: BORDER, borderRadius: RADIUS_SM, background: PAPER_2, color: INK, fontSize: 12 }}
          />
          <ExecutionsTab {...executionsProps} trades={filteredTrades} />
        </>}
        {view === 'div' && <DividendTab {...dividendProps} />}
        {view === 'profit' && <ProfitTab {...profitProps} />}
      </div>
    </div>
  );
}
