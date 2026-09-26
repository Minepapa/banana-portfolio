import { useState } from 'react';
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { maskAmountText } from '../lib/textFormat.js';
import { profitColor, CHART_BAR_COLOR } from '../lib/colors.js';
import { PAPER_2, CARD_BG, RADIUS, INK, INK_2, ACCENT, EMPHASIS_INK, BORDER, RADIUS_SM, MONO } from '../lib/theme.js';
import HoldingsTab from './HoldingsTab.jsx';
import RebalanceTab from './RebalanceTab.jsx';

export default function AssetsScreen({ initialView = 'positions', holdingsProps, rebalanceProps, monthlyBalances = [] }) {
  const [view, setView] = useState(initialView);
  const [balYear, setBalYear] = useState('전체');
  const [selectedBalKey, setSelectedBalKey] = useState(null);
  const { accounts = {}, isMobile, fmt, hideAmounts = false } = holdingsProps;
  const balYears = ['전체', ...[...new Set(monthlyBalances.map(m => String(m.year)))].sort()];
  const filteredBalances = balYear === '전체' ? monthlyBalances : monthlyBalances.filter(m => String(m.year) === balYear);
  const segmentStyle = (active) => ({
    flex: 1, padding: '10px 12px', border: BORDER, borderRadius: RADIUS_SM,
    background: active ? ACCENT : CARD_BG, color: active ? EMPHASIS_INK : INK_2,
    fontWeight: 700, cursor: 'pointer',
  });

  return (
    <div>
      <div role="tablist" aria-label="자산 화면" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button type="button" role="tab" aria-selected={view === 'positions'} onClick={() => setView('positions')} style={segmentStyle(view === 'positions')}>보유 현황</button>
        <button type="button" role="tab" aria-selected={view === 'target'} onClick={() => setView('target')} style={segmentStyle(view === 'target')}>목표비중</button>
      </div>
      {view === 'positions' && (
        <>
          <HoldingsTab {...holdingsProps} />
          {/* 포트폴리오 총괄 도넛 */}
          {(() => {
            const _te = Object.values(accounts).reduce((s, a) => s + (a.total_eval || 0), 0);
            const _ti = Object.values(accounts).reduce((s, a) => s + (a.total_invest || 0), 0);
            const _tp = _te - _ti;
            const _tr = _ti > 0 ? (_tp / _ti * 100) : 0;
            const donutData = Object.entries(accounts).filter(([, a]) => a.total_eval > 0).map(([, a]) => ({ label: a.label, value: a.total_eval, color: a.color }));
            if (!donutData.length) return null;
            const r = 38, circ = 2 * Math.PI * r;
            let cum = 0;
            const slices = donutData.map(d => {
              const pct = _te > 0 ? d.value / _te : 0;
              const dash = pct * circ;
              const offset = circ / 4 - cum;
              cum += dash;
              return { ...d, dash, offset, pctStr: (pct * 100).toFixed(0) };
            });
            const evalAmt = _te <= 0 ? '—' : _te >= 100000000 ? `${(_te/100000000).toFixed(1)}억` : `${(_te/10000).toFixed(0)}만`;
            return (
              <div style={{ background: CARD_BG, borderRadius: RADIUS, padding: 16, marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: isMobile ? 21 : 25, fontWeight: 800, color: INK, fontFamily: MONO, letterSpacing: 0 }}>{hideAmounts ? maskAmountText(`₩${fmt(_te)}`) : `₩${fmt(_te)}`}</div>
                    <div style={{ fontSize: 11, color: INK_2, marginTop: 2 }}>투자원금 {hideAmounts ? maskAmountText(`₩${fmt(_ti)}`) : `₩${fmt(_ti)}`}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 17, fontWeight: 700, color: profitColor(_tp), fontFamily: MONO, letterSpacing: 0 }}>{hideAmounts ? maskAmountText(`₩${fmt(_tp)}`) : `₩${fmt(_tp)}`}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: profitColor(_tp) }}>{hideAmounts ? maskAmountText(`${_tr >= 0 ? '+' : ''}${_tr.toFixed(1)}%`) : `${_tr >= 0 ? '+' : ''}${_tr.toFixed(1)}%`}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                  <svg viewBox="0 0 100 100" width="110" height="110" style={{ flexShrink: 0 }}>
                    {slices.map((s, i) => <circle key={i} cx="50" cy="50" r={r} fill="none" stroke={s.color} strokeWidth="20" strokeDasharray={`${s.dash} ${circ - s.dash}`} strokeDashoffset={s.offset} />)}
                    <text x="50" y="47" textAnchor="middle" fill={INK} fontSize="9" fontWeight="700">{hideAmounts ? maskAmountText(`₩${fmt(_te)}`) : evalAmt}</text>
                    <text x="50" y="58" textAnchor="middle" fill={INK_2} fontSize="7">총자산</text>
                  </svg>
                  <div style={{ flex: 1, minWidth: 80 }}>
                    {slices.map((s, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: i < slices.length - 1 ? `1px solid ${PAPER_2}` : 'none' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}><div style={{ width: 7, height: 7, borderRadius: 0, background: s.color, flexShrink: 0 }} /><span style={{ fontSize: 10, color: INK_2 }}>{s.label}</span></div>
                        <span style={{ fontSize: 10, fontWeight: 800, color: INK, fontFamily: MONO }}>{hideAmounts ? maskAmountText(`${s.pctStr}%`) : `${s.pctStr}%`}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}
          {/* 월별 잔고 추이 */}
          {monthlyBalances.length > 0 && (
            <>
              <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
                {balYears.map(y => <button key={y} onClick={() => { setBalYear(y); setSelectedBalKey(null); }} style={{ padding: isMobile ? '8px 14px' : '6px 14px', borderRadius: RADIUS_SM, border: BORDER, background: balYear === y ? ACCENT : 'transparent', color: balYear === y ? EMPHASIS_INK : INK_2, cursor: 'pointer', fontSize: 11 }}>{y}</button>)}
              </div>
              <div style={{ background: CARD_BG, borderRadius: RADIUS, padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 10, letterSpacing: 2, color: INK_2, marginBottom: 16 }}>월별 잔고 추이</div>
                {hideAmounts && <div style={{ fontSize: 11, color: INK_2, marginBottom: 8 }}>금액 비공개 중</div>}
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={filteredBalances.map(m => hideAmounts ? { ...m, total: 1 } : m)} barSize={isMobile ? 10 : 16} accessibilityLayer={false}>
                    <CartesianGrid strokeDasharray="3 3" stroke={INK} />
                    <XAxis dataKey="label" tick={{ fill: INK_2, fontSize: 9 }} />
                    <YAxis tickFormatter={v => hideAmounts ? '' : v.toLocaleString()} tick={{ fill: INK_2, fontSize: 9 }} width={55} />
                    <Tooltip formatter={v => [hideAmounts ? maskAmountText(`₩${v.toLocaleString()}`) : `₩${v.toLocaleString()}`, '총잔고']} contentStyle={{ background: PAPER_2, border: BORDER, borderRadius: RADIUS_SM, fontSize: 11 }} labelStyle={{ color: INK }} itemStyle={{ color: INK }} />
                    <Bar dataKey="total" fill={CHART_BAR_COLOR} radius={[3, 3, 0, 0]} cursor="pointer" activeBar={false} onClick={data => setSelectedBalKey(prev => prev === data.label ? null : data.label)}>
                      {filteredBalances.map((m, i) => <Cell key={i} fill={CHART_BAR_COLOR} fillOpacity={selectedBalKey && m.label !== selectedBalKey ? 0.3 : 1} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </>
      )}
      {view === 'target' && <RebalanceTab {...rebalanceProps} />}
    </div>
  );
}
