import { useState } from 'react';
import { CARD_BG, ACCENT, EMPHASIS_INK, INK_2, BORDER, RADIUS_SM } from '../lib/theme.js';
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
      {view === 'exec' && <ExecutionsTab {...executionsProps} />}
      {view === 'div' && <DividendTab {...dividendProps} />}
      {view === 'profit' && <ProfitTab {...profitProps} />}
    </div>
  );
}
