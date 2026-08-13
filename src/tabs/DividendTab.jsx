// 배당 탭 — 월별 배당 차트 + 연도별 합계. v2 재배선(2026-08-13): 읽기 전용(종목명
// 인라인 편집은 시트 쓰기 기능이었음 — 제거).
import { useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { PROFIT_POS } from '../lib/colors.js';
import { MONO } from '../lib/theme.js';

export default function DividendTab({ dividendData, isMobile, baseFont, fmt }) {
  const [divYear, setDivYear] = useState('전체');
  const [selectedDivKey, setSelectedDivKey] = useState(null);

  const divYears = ['전체', ...[...new Set(dividendData.map(d => String(d.year)))].sort()];
  const filteredDividends = divYear === '전체'
    ? dividendData
    : dividendData.filter(d => String(d.year) === divYear);

  const divYearTotals = divYears.filter(y => y !== '전체').map(y => ({
    year: y,
    total: dividendData.filter(d => String(d.year) === y).reduce((s, d) => s + d.amount, 0),
  }));
  const selectedDivItem = selectedDivKey ? dividendData.find(d => `${d.year}-${d.month}` === selectedDivKey) : null;

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {divYears.map(y => (
          <button key={y} onClick={() => { setDivYear(y); setSelectedDivKey(null); }} style={{
            padding: isMobile ? "8px 14px" : "6px 14px",
            borderRadius: 0,
            border: '1px solid #141414',
            background: divYear === y ? '#E4F5A0' : 'transparent',
            color: divYear === y ? '#141414' : '#6B675C',
            cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
          }}>{y}</button>
        ))}
      </div>

      <div style={{ background: "#FFFFFF", borderRadius: 0, padding: "16px", marginBottom: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: "#6B675C", marginBottom: 16 }}>월별 배당금</div>
        {filteredDividends.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={filteredDividends.map(d => ({ ...d, label: `${String(d.year).slice(-2)}.${String(d.month).padStart(2, '0')}` }))}
              barSize={isMobile ? 10 : 16}
              accessibilityLayer={false}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#141414" />
              <XAxis dataKey="label" tick={{ fill: "#6B675C", fontSize: 9 }} />
              <YAxis tickFormatter={v => v.toLocaleString()} tick={{ fill: "#6B675C", fontSize: 9 }} width={55} />
              <Tooltip
                formatter={v => [`₩${v.toLocaleString()}`, '배당금']}
                contentStyle={{ background: "#EAE6DA", border: "1px solid #141414", borderRadius: 0, fontSize: 11 }}
                labelStyle={{ color: '#141414' }}
                itemStyle={{ color: '#141414' }}
              />
              <Bar dataKey="amount" fill={PROFIT_POS} radius={[3, 3, 0, 0]} cursor="pointer" activeBar={false}
                onClick={(data) => {
                  const key = `${data.year}-${data.month}`;
                  setSelectedDivKey(prev => prev === key ? null : key);
                }}>
                {filteredDividends.map((d, i) => {
                  const dim = selectedDivKey && `${d.year}-${d.month}` !== selectedDivKey;
                  return <Cell key={i} fill={PROFIT_POS} fillOpacity={dim ? 0.3 : 1} />;
                })}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B675C', fontSize: 12 }}>
            배당 데이터가 없습니다
          </div>
        )}

        {selectedDivItem && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #141414' }}>
            <div style={{ fontSize: 10, color: '#6B675C', marginBottom: 8, letterSpacing: 1 }}>
              {selectedDivItem.year}년 {selectedDivItem.month}월 상세
            </div>
            {selectedDivItem.items.map((item, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #EAE6DA' }}>
                <span style={{ fontSize: 12, color: '#141414', flex: 1, minWidth: 0, textAlign: 'left' }}>{item.name || '(이름 없음)'}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: PROFIT_POS, flexShrink: 0, fontFamily: MONO }}>₩{fmt(item.amount)}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8 }}>
              <span style={{ fontSize: 11, color: '#6B675C' }}>합계</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: PROFIT_POS , fontFamily: MONO}}>
                ₩{fmt(selectedDivItem.amount)}
              </span>
            </div>
          </div>
        )}
      </div>

      <div style={{ background: "#FFFFFF", borderRadius: 0, padding: "16px" }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: "#6B675C", marginBottom: 12 }}>연도별 합계</div>
        {divYearTotals.map(row => (
          <div key={row.year} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #EAE6DA' }}>
            <span style={{ fontSize: 12, color: '#6B675C' }}>{row.year}년 합계</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: PROFIT_POS, fontFamily: MONO }}>₩{fmt(row.total)}</span>
          </div>
        ))}
        {(() => { const gt = dividendData.reduce((s, d) => s + d.amount, 0); return (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10 }}>
            <span style={{ fontSize: 12, color: '#141414', fontWeight: 700 }}>전체 합계</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: PROFIT_POS, fontFamily: MONO }}>₩{fmt(gt)}</span>
          </div>
        ); })()}
      </div>
    </div>
  );
}
