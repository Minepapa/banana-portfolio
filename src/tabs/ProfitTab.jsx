// 수익금 탭: 월별 수익금 차트 + 상세/연도별 합계. App.jsx에서 추출 (동작 불변).
import { useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { PROFIT_POS, PROFIT_NEG } from '../lib/colors.js';

export default function ProfitTab({ profitData, isMobile, baseFont, fmt }) {
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
            borderRadius: 0,
            border: `1px solid ${profitYear === y ? '#141414' : '#141414'}`,
            background: profitYear === y ? '#E4F5A0' : 'transparent',
            color: profitYear === y ? '#141414' : '#6B675C',
            cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
          }}>{y}</button>
        ))}
      </div>

      <div style={{ background: "#FFFFFF", borderRadius: 0, padding: "16px", marginBottom: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: "#6B675C", marginBottom: 16 }}>월별 수익금</div>
        {filtered.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={filtered.map(d => ({ ...d, label: `${String(d.year).slice(-2)}.${String(d.month).padStart(2, '0')}` }))}
              barSize={isMobile ? 10 : 16}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#141414" />
              <XAxis dataKey="label" tick={{ fill: "#6B675C", fontSize: 9 }} />
              <YAxis tickFormatter={v => v.toLocaleString()} tick={{ fill: "#6B675C", fontSize: 9 }} width={55} />
              <Tooltip
                formatter={v => [`₩${v.toLocaleString()}`, '수익금']}
                contentStyle={{ background: "#EAE6DA", border: "1px solid #141414", borderRadius: 0, fontSize: 11 }}
                labelStyle={{ color: '#141414' }}
                itemStyle={{ color: '#141414' }}
              />
              <Bar dataKey="total" radius={[3, 3, 0, 0]} cursor="pointer" activeBar={false}
                onClick={(data) => {
                  const key = `${data.year}-${data.month}`;
                  setSelectedProfitKey(prev => prev === key ? null : key);
                }}>
                {filtered.map((d, i) => {
                  const dim = selectedProfitKey && `${d.year}-${d.month}` !== selectedProfitKey;
                  return <Cell key={i} fill={d.total >= 0 ? PROFIT_POS : PROFIT_NEG} fillOpacity={dim ? 0.3 : 1} />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B675C', fontSize: 12 }}>
            수익금 데이터가 없습니다
          </div>
        )}

        {selectedItem && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #141414' }}>
            <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 8, letterSpacing: 1 }}>
              {selectedItem.year}년 {selectedItem.month}월 상세
            </div>
            {selectedItem.items.map((item, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #EAE6DA' }}>
                <span style={{ fontSize: 12, color: '#141414' }}>{item.name}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: item.profit >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                  ₩{fmt(Math.abs(item.profit))}
                </span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8 }}>
              <span style={{ fontSize: 11, color: '#6B675C' }}>합계</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: selectedItem.total >= 0 ? PROFIT_POS : PROFIT_NEG }}>
                ₩{fmt(Math.abs(selectedItem.total))}
              </span>
            </div>
          </div>
        )}
      </div>

      <div style={{ background: "#FFFFFF", borderRadius: 0, padding: "16px" }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: "#6B675C", marginBottom: 12 }}>연도별 합계</div>
        {yearTotals.map(row => (
          <div key={row.year} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #EAE6DA' }}>
            <span style={{ fontSize: 12, color: '#6B675C' }}>{row.year}년 합계</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: row.total >= 0 ? PROFIT_POS : PROFIT_NEG }}>
              ₩{fmt(Math.abs(row.total))}
            </span>
          </div>
        ))}
        {(() => { const gt = profitData.reduce((s, d) => s + d.total, 0); return (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10 }}>
            <span style={{ fontSize: 12, color: '#141414', fontWeight: 700 }}>전체 합계</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: gt >= 0 ? PROFIT_POS : PROFIT_NEG }}>
              ₩{fmt(Math.abs(gt))}
            </span>
          </div>
        ); })()}
      </div>
    </div>
  );
}
