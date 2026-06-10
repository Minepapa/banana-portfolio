// 배당 탭: 월별 배당 차트 + 종목명 인라인 편집 + 연도별 합계. App.jsx에서 추출 (동작 불변).
import { useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { CHART_BAR_COLOR, PROFIT_POS } from '../lib/constants.js';
import { useLongPress } from '../hooks/useLongPress.js';

export default function DividendTab({ dividendData, isMobile, baseFont, fmt, sheets }) {
  const [divYear, setDivYear] = useState('전체');
  const [editingDivRow, setEditingDivRow] = useState(null); // 배당 종목명 편집 중인 시트 행
  const [editDivName, setEditDivName] = useState('');
  const [divSaving, setDivSaving] = useState(false);
  const lp = useLongPress();
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
            borderRadius: 20,
            border: `1px solid ${divYear === y ? '#3B82F6' : '#2A2F3E'}`,
            background: divYear === y ? '#1E3A5F' : 'transparent',
            color: divYear === y ? '#60A5FA' : '#6B7280',
            cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
          }}>{y}</button>
        ))}
      </div>

      <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: 3, color: "#8A9AB5", marginBottom: 16 }}>월별 배당금</div>
        {filteredDividends.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={filteredDividends.map(d => ({ ...d, label: `${String(d.year).slice(-2)}.${String(d.month).padStart(2, '0')}` }))}
              barSize={isMobile ? 10 : 16}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3E" />
              <XAxis dataKey="label" tick={{ fill: "#8A9AB5", fontSize: 9 }} />
              <YAxis tickFormatter={v => v.toLocaleString()} tick={{ fill: "#8A9AB5", fontSize: 9 }} width={55} />
              <Tooltip
                formatter={v => [`₩${v.toLocaleString()}`, '배당금']}
                contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }}
                labelStyle={{ color: '#E8EAF0' }}
                itemStyle={{ color: '#E8EAF0' }}
              />
              <Bar dataKey="amount" fill={CHART_BAR_COLOR} radius={[3, 3, 0, 0]} cursor="pointer"
                onClick={(data) => {
                  const key = `${data.year}-${data.month}`;
                  setSelectedDivKey(prev => prev === key ? null : key);
                }} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8A9AB5', fontSize: 12 }}>
            배당 데이터가 없습니다
          </div>
        )}

        {selectedDivItem && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2F3E' }}>
            <div style={{ fontSize: 10, color: '#8A9AB5', marginBottom: 8, letterSpacing: 1 }}>
              {selectedDivItem.year}년 {selectedDivItem.month}월 상세
            </div>
            {selectedDivItem.items.map((item, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #1E2233' }}>
                {editingDivRow === item.row ? (
                  <>
                    <input value={editDivName} onChange={e => setEditDivName(e.target.value)} autoFocus
                      style={{ flex: 1, minWidth: 0, fontSize: 12, padding: '4px 6px', borderRadius: 4, border: '1px solid #3B82F6', background: '#0F1117', color: '#E8EAF0', fontFamily: baseFont }} />
                    <button disabled={divSaving} onClick={async () => {
                      const v = editDivName.trim(); if (!v) return;
                      setDivSaving(true);
                      try { await sheets.writeRange(`배당금!C${item.row}`, [v]); await sheets.fetch(); setEditingDivRow(null); }
                      finally { setDivSaving(false); }
                    }} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, border: 'none', background: '#10B981', color: '#fff', cursor: 'pointer', flexShrink: 0 }}>{divSaving ? '…' : '저장'}</button>
                    <button onClick={() => setEditingDivRow(null)} style={{ fontSize: 11, padding: '4px 8px', borderRadius: 4, border: '1px solid #2A2F3E', background: 'transparent', color: '#9CA3AF', cursor: 'pointer', flexShrink: 0 }}>취소</button>
                  </>
                ) : (
                  <>
                    <span
                      {...lp.bind(item.row, () => { setEditingDivRow(item.row); setEditDivName(item.name); })}
                      title="길게 눌러 이름 수정"
                      style={{ position: 'relative', fontSize: 12, color: lp.activeId === item.row ? '#60A5FA' : '#E8EAF0', cursor: 'pointer', flex: 1, minWidth: 0, textAlign: 'left', userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'manipulation' }}>
                      {item.name || '(이름 없음)'}
                      {lp.activeId === item.row && <div className="lp-progress" />}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: PROFIT_POS, flexShrink: 0 }}>₩{fmt(item.amount)}</span>
                  </>
                )}
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 8 }}>
              <span style={{ fontSize: 11, color: '#9CA3AF' }}>합계</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: PROFIT_POS }}>
                ₩{fmt(selectedDivItem.amount)}
              </span>
            </div>
          </div>
        )}
      </div>

      <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px" }}>
        <div style={{ fontSize: 10, letterSpacing: 3, color: "#8A9AB5", marginBottom: 12 }}>연도별 합계</div>
        {divYearTotals.map(row => (
          <div key={row.year} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #1E2233' }}>
            <span style={{ fontSize: 12, color: '#9CA3AF' }}>{row.year}년 합계</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: PROFIT_POS }}>₩{fmt(row.total)}</span>
          </div>
        ))}
        {(() => { const gt = dividendData.reduce((s, d) => s + d.amount, 0); return (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10 }}>
            <span style={{ fontSize: 12, color: '#E8EAF0', fontWeight: 600 }}>전체 합계</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: PROFIT_POS }}>₩{fmt(gt)}</span>
          </div>
        ); })()}
      </div>
    </div>
  );
}
