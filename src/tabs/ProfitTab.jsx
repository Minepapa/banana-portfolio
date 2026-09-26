// 수익금 탭: 월별 수익금 차트 + 상세/연도별 합계. App.jsx에서 추출 (동작 불변).
import { maskAmountText } from '../lib/textFormat.js';
import { useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { profitColor } from '../lib/colors.js';
import { PAPER_2, CARD_BG, RADIUS, INK, INK_2, ACCENT, EMPHASIS_INK, BORDER, RADIUS_SM, MONO } from '../lib/theme.js';

export default function ProfitTab({ profitData, isMobile, baseFont, fmt, hideAmounts = false }) {
  const [profitYear, setProfitYear] = useState('전체');
  const [selectedProfitKey, setSelectedProfitKey] = useState(null);

  const profitYears = ['전체', ...[...new Set(profitData.map(d => String(d.year)))].sort()];
  const filtered = profitYear === '전체' ? profitData : profitData.filter(d => String(d.year) === profitYear);
  const selectedItem = selectedProfitKey ? profitData.find(d => `${d.year}-${d.month}` === selectedProfitKey) : null;
  const yearTotals = profitYears.filter(y => y !== '전체').map(y => ({
    year: y,
    total: profitData.filter(d => String(d.year) === y).reduce((s, d) => s + d.total, 0),
  }));

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {profitYears.map(y => (
          <button key={y} onClick={() => { setProfitYear(y); setSelectedProfitKey(null); }} style={{
            padding: isMobile ? "8px 14px" : "6px 14px",
            borderRadius: RADIUS_SM,
            border: `1px solid ${profitYear === y ? INK : INK}`,
            background: profitYear === y ? ACCENT : 'transparent',
            color: profitYear === y ? EMPHASIS_INK : INK_2,
            cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
          }}>{y}</button>
        ))}
      </div>

      <div style={{ background: CARD_BG, borderRadius: RADIUS, padding: "16px", marginBottom: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: INK_2, marginBottom: 16 }}>월별 수익금</div>
        {filtered.length > 0 ? (
          <>
          {hideAmounts && <div style={{ fontSize: 11, color: INK_2, marginBottom: 8 }}>금액 비공개 중</div>}
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={filtered.map(d => ({ ...d, label: `${String(d.year).slice(-2)}.${String(d.month).padStart(2, '0')}`, total: hideAmounts ? 1 : d.total }))}
              barSize={isMobile ? 10 : 16}
              accessibilityLayer={false}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={INK} />
              <XAxis dataKey="label" tick={{ fill: INK_2, fontSize: 9 }} />
              <YAxis tickFormatter={v => hideAmounts ? '' : v.toLocaleString()} tick={{ fill: INK_2, fontSize: 9 }} width={55} />
              <Tooltip
                formatter={v => [hideAmounts ? maskAmountText(`₩${v.toLocaleString()}`) : `₩${v.toLocaleString()}`, '수익금']}
                contentStyle={{ background: PAPER_2, border: BORDER, borderRadius: RADIUS_SM, fontSize: 11 }}
                labelStyle={{ color: INK }}
                itemStyle={{ color: INK }}
              />
              <Bar dataKey="total" radius={[3, 3, 0, 0]} cursor="pointer" activeBar={false}
                onClick={(data) => {
                  const key = `${data.year}-${data.month}`;
                  setSelectedProfitKey(prev => prev === key ? null : key);
                }}>
                {filtered.map((d, i) => {
                  const dim = selectedProfitKey && `${d.year}-${d.month}` !== selectedProfitKey;
                  return <Cell key={i} fill={profitColor(d.total)} fillOpacity={dim ? 0.3 : 1} />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          </>
        ) : (
          <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: INK_2, fontSize: 12 }}>
            수익금 데이터가 없습니다
          </div>
        )}

        {selectedItem && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: BORDER }}>
            <div style={{ fontSize: 10, color: INK_2, marginBottom: 8, letterSpacing: 1 }}>
              {selectedItem.year}년 {selectedItem.month}월 상세
            </div>
            {selectedItem.items.map((item, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: `1px solid ${PAPER_2}` }}>
                <span style={{ fontSize: 12, color: INK }}>{item.name}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: profitColor(item.profit) , fontFamily: MONO}}>
                  {hideAmounts ? maskAmountText(`₩${fmt(Math.abs(item.profit))}`) : `₩${fmt(Math.abs(item.profit))}`}
                </span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8 }}>
              <span style={{ fontSize: 11, color: INK_2 }}>합계</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: profitColor(selectedItem.total) , fontFamily: MONO}}>
                {hideAmounts ? maskAmountText(`₩${fmt(Math.abs(selectedItem.total))}`) : `₩${fmt(Math.abs(selectedItem.total))}`}
              </span>
            </div>
          </div>
        )}
      </div>

      <div style={{ background: CARD_BG, borderRadius: RADIUS, padding: "16px" }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: INK_2, marginBottom: 12 }}>연도별 합계</div>
        {yearTotals.map(row => (
          <div key={row.year} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${PAPER_2}` }}>
            <span style={{ fontSize: 12, color: INK_2 }}>{row.year}년 합계</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: profitColor(row.total) , fontFamily: MONO}}>
              {hideAmounts ? maskAmountText(`₩${fmt(Math.abs(row.total))}`) : `₩${fmt(Math.abs(row.total))}`}
            </span>
          </div>
        ))}
        {(() => { const gt = profitData.reduce((s, d) => s + d.total, 0); return (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10 }}>
            <span style={{ fontSize: 12, color: INK, fontWeight: 700 }}>전체 합계</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: profitColor(gt) , fontFamily: MONO}}>
              {hideAmounts ? maskAmountText(`₩${fmt(Math.abs(gt))}`) : `₩${fmt(Math.abs(gt))}`}
            </span>
          </div>
        ); })()}
      </div>
    </div>
  );
}
