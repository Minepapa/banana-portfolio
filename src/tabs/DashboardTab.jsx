// 대시보드 탭: 요약 카드 + 계좌 그리드 + 총괄 도넛 + 평가금 추이. App.jsx에서 추출 (동작 불변).
// 저축금 편집(시트 쓰기)·롱프레스 핸들러는 App에 남기고 prop으로 받는다 — 시트 I/O는 App 책임.
import { useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
} from "recharts";
import { PROFIT_POS, PROFIT_NEG, CHART_BAR_COLOR, profitColor } from '../lib/constants.js';

export default function DashboardTab({
  totalInvest, totalEval, totalProfit, accounts, monthlyData,
  fmt, isMobile, baseFont, setAcctKey, setTab,
  showSavings, setShowSavings, showSavingsEdit, savingsEditValue, setSavingsEditValue,
  savingsLpFiredRef, startSavingsLP, endSavingsLP, saveSavingsEdit, setShowSavingsEdit,
}) {
  const [monthYear, setMonthYear] = useState('전체');

  return (
    <div>
      {/* 요약 카드 3개 */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 8, marginBottom: 20,
      }}>
        {[
          { label: "총 투자금", value: `₩${fmt(totalInvest)}`, color: "#9CA3AF" },
          { label: "총 평가금", value: `₩${fmt(totalEval)}`, color: "#F5F7FF" },
          { label: "수익률", value: `${totalProfit > 0 ? '+' : ''}${totalInvest > 0 ? ((totalProfit / totalInvest) * 100).toFixed(1) : '0.0'}%`, color: profitColor(totalProfit) },
        ].map((s) => (
          <div key={s.label} style={{
            background: "#1A1D26", borderRadius: 10, padding: "12px 10px", textAlign: "center",
          }}>
            <div style={{ fontSize: 9, color: "#8A9AB5", marginBottom: 4, letterSpacing: 1 }}>{s.label}</div>
            <div style={{
              fontSize: isMobile ? 10 : 13, fontWeight: 700, color: s.color,
              wordBreak: "break-all",
            }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* 계좌 카드 그리드 (2열) */}
      <div style={{
        display: "grid",
        gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
        gap: 10, marginBottom: 20,
      }}>
        {Object.entries(accounts).map(([k, v]) => {
          const pColor = profitColor(v.profit);
          const pRate = v.total_invest > 0
            ? ((v.profit / v.total_invest) * 100).toFixed(1)
            : '0.0';
          return (
            <div key={k} onClick={() => { setAcctKey(k); setTab("holdings"); }}
              style={{
                background: "#1A1D26", border: `1px solid ${v.color}33`,
                borderRadius: 12, padding: "14px 16px",
                cursor: "pointer", transition: "all 0.2s",
                boxShadow: `0 0 20px ${v.color}11`,
              }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: v.color, marginBottom: 4 }}>
                {v.sub.toUpperCase()}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, color: "#F5F7FF" }}>
                    {v.label}
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#F5F7FF", marginBottom: 2 }}>
                    ₩{fmt(v.total_eval)}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 9, color: "#8A9AB5", marginBottom: 2 }}>수익</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: pColor }}>
                    ₩{fmt(v.profit)}
                  </div>
                  <div style={{ fontSize: 11, color: pColor }}>
                    {v.profit > 0 ? '+' : ''}{pRate}%
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

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
          <div style={{ background: '#1A1D26', borderRadius: 12, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: isMobile ? 20 : 24, fontWeight: 700, color: '#F5F7FF' }}>₩{fmt(_te)}</div>
                <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>투자원금 ₩{fmt(_ti)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: _tp >= 0 ? PROFIT_POS : PROFIT_NEG }}>₩{fmt(_tp)}</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: _tp >= 0 ? PROFIT_POS : PROFIT_NEG }}>{_tr >= 0 ? '+' : ''}{_tr.toFixed(1)}%</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <svg viewBox="0 0 100 100" width="110" height="110" style={{ flexShrink: 0 }}>
                {slices.map((s, i) => (
                  <circle key={i} cx="50" cy="50" r={r} fill="none" stroke={s.color} strokeWidth="20"
                    strokeDasharray={`${s.dash} ${circ - s.dash}`} strokeDashoffset={s.offset} />
                ))}
                <text x="50" y="47" textAnchor="middle" fill="#E8EAF0" fontSize="9" fontWeight="700">{evalAmt}</text>
                <text x="50" y="58" textAnchor="middle" fill="#9CA3AF" fontSize="7">총자산</text>
              </svg>
              <div style={{ flex: 1, minWidth: 80 }}>
                {slices.map((s, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: i < slices.length - 1 ? '1px solid #1E2233' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 10, color: '#9CA3AF' }}>{s.label}</span>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 600, color: '#E8EAF0' }}>{s.pctStr}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 전체 평가금 추이 바차트 */}
      <div style={{ background: "#1A1D26", borderRadius: 12, padding: "16px", marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ fontSize: 10, letterSpacing: 3, color: "#8A9AB5" }}>전체 평가금 추이</div>
            <button
              onClick={() => { if (!savingsLpFiredRef.current) setShowSavings(p => !p); }}
              onMouseDown={startSavingsLP}
              onMouseUp={endSavingsLP}
              onMouseLeave={endSavingsLP}
              onTouchStart={e => { e.preventDefault(); startSavingsLP(); }}
              onTouchEnd={endSavingsLP}
              onTouchCancel={endSavingsLP}
              onContextMenu={e => e.preventDefault()}
              style={{
                padding: '3px 10px', borderRadius: 4,
                border: `1px solid ${showSavings ? '#10B981' : '#2A2F3E'}`,
                background: showSavings ? '#0D2B1A' : 'transparent',
                color: showSavings ? '#10B981' : '#6B7280',
                cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                userSelect: 'none', WebkitUserSelect: 'none',
              }}
            >저축금</button>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {['전체', '2025', '2026'].map(y => (
              <button key={y} onClick={() => setMonthYear(y)} style={{
                padding: '3px 10px', borderRadius: 4,
                border: `1px solid ${monthYear === y ? '#3B82F6' : '#2A2F3E'}`,
                background: monthYear === y ? '#1E3A5F' : 'transparent',
                color: monthYear === y ? '#60A5FA' : '#6B7280',
                cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
              }}>{y}</button>
            ))}
          </div>
        </div>
        {(() => {
          const data = monthYear === '전체' ? monthlyData : monthlyData.filter(d => String(d.year) === monthYear);
          const chartData = showSavings
            ? data.map(d => ({ ...d, base: Math.max(0, d.value - (d.savings || 0)), savingsAmt: d.savings || 0 }))
            : data;
          return data.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} barSize={isMobile ? 8 : 14}>
                <XAxis dataKey="label" tick={{ fill: "#8A9AB5", fontSize: 9 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={v => `${(v / 100000000).toFixed(1)}억`} tick={{ fill: "#8A9AB5", fontSize: 9 }} width={40} axisLine={false} tickLine={false} />
                <Tooltip
                  formatter={(v, name) => {
                    if (name === 'base') return [`₩${v.toLocaleString()}`, '잔고'];
                    if (name === 'savingsAmt') return [`₩${v.toLocaleString()}`, '저축금'];
                    return [`₩${v.toLocaleString()}`, '평가금'];
                  }}
                  contentStyle={{ background: "#1E2233", border: "1px solid #2A2F3E", borderRadius: 8, fontSize: 11 }}
                  labelStyle={{ color: '#E8EAF0' }}
                  itemStyle={{ color: '#E8EAF0' }}
                />
                {showSavings ? (
                  <>
                    <Bar dataKey="base" stackId="a" fill={CHART_BAR_COLOR} />
                    <Bar dataKey="savingsAmt" stackId="a" fill={CHART_BAR_COLOR} radius={[3, 3, 0, 0]} />
                  </>
                ) : (
                  <Bar dataKey="value" fill={CHART_BAR_COLOR} radius={[3, 3, 0, 0]} />
                )}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8A9AB5', fontSize: 12 }}>
              데이터가 없습니다
            </div>
          );
        })()}
        {showSavingsEdit && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2F3E' }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#8A9AB5', marginBottom: 8 }}>이번 달 저축금 수정</div>
            <input
              type="number"
              value={savingsEditValue}
              onChange={e => setSavingsEditValue(e.target.value)}
              style={{
                width: '100%', boxSizing: 'border-box', marginBottom: 8,
                background: '#0D1520', border: '1px solid #2A2F3E', borderRadius: 6,
                color: '#E8EAF0', padding: '6px 10px', fontSize: 12, fontFamily: baseFont,
              }}
              placeholder="0"
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowSavingsEdit(false)} style={{
                padding: '6px 12px', borderRadius: 6, border: '1px solid #2A2F3E',
                background: 'transparent', color: '#6B7280', cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
              }}>취소</button>
              <button onClick={saveSavingsEdit} style={{
                padding: '6px 12px', borderRadius: 6, border: 'none',
                background: '#10B981', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
              }}>저장</button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
