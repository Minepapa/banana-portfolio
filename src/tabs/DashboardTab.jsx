// 대시보드 탭: 요약 카드 + 계좌 그리드 + 총괄 도넛 + 평가금 추이. App.jsx에서 추출 (동작 불변).
// 저축금 편집(시트 쓰기)·롱프레스 핸들러는 App에 남기고 prop으로 받는다 — 시트 I/O는 App 책임.
import { useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
} from "recharts";
import { PROFIT_POS, PROFIT_NEG, CHART_BAR_COLOR, profitColor } from '../lib/colors.js';
import { MONO } from '../lib/theme.js';
import { useLongPress } from '../hooks/useLongPress.js';

export default function DashboardTab({
  totalInvest, totalEval, totalProfit, accounts, monthlyData,
  fmt, isMobile, baseFont, setAcctKey, setTab,
  showSavings, setShowSavings, showSavingsEdit, savingsEditValue, setSavingsEditValue,
  beginSavingsEdit, saveSavingsEdit, setShowSavingsEdit,
}) {
  const [monthYear, setMonthYear] = useState('전체');
  const lp = useLongPress();

  return (
    <div>
      {/* 요약 카드 3개 */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 8, marginBottom: 20,
      }}>
        {[
          { label: "총 투자금", value: `₩${fmt(totalInvest)}`, color: "#6B675C" },
          { label: "총 평가금", value: `₩${fmt(totalEval)}`, color: "#141414" },
          { label: "수익률", value: `${totalProfit > 0 ? '+' : ''}${totalInvest > 0 ? ((totalProfit / totalInvest) * 100).toFixed(1) : '0.0'}%`, color: profitColor(totalProfit) },
        ].map((s) => (
          <div key={s.label} style={{
            background: "#FFFFFF", borderRadius: 0, padding: "12px 10px", textAlign: "center",
          }}>
            <div style={{ fontSize: 9, color: "#6B675C", marginBottom: 4, letterSpacing: 1 }}>{s.label}</div>
            <div style={{
              fontSize: isMobile ? 12 : 15, fontWeight: 800, color: s.color, fontFamily: MONO,
              wordBreak: "break-all", letterSpacing: -0.3,
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
                background: "#FFFFFF", border: `1px solid ${v.color}33`,
                borderRadius: 0, padding: "14px 16px",
                cursor: "pointer", transition: "all 0.2s",
                boxShadow: `0 0 20px ${v.color}11`,
              }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: v.color, marginBottom: 4 }}>
                {v.sub.toUpperCase()}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, color: "#141414" }}>
                    {v.label}
                  </div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "#141414", marginBottom: 2, fontFamily: MONO, letterSpacing: -0.3 }}>
                    ₩{fmt(v.total_eval)}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 9, color: "#6B675C", marginBottom: 2 }}>수익</div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: pColor }}>
                    ₩{fmt(v.profit)}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: pColor }}>
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
          <div style={{ background: '#FFFFFF', borderRadius: 0, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: isMobile ? 21 : 25, fontWeight: 800, color: '#141414', fontFamily: MONO, letterSpacing: -0.5 }}>₩{fmt(_te)}</div>
                <div style={{ fontSize: 11, color: '#6B675C', marginTop: 2 }}>투자원금 ₩{fmt(_ti)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: _tp >= 0 ? PROFIT_POS : PROFIT_NEG, fontFamily: MONO, letterSpacing: -0.3 }}>₩{fmt(_tp)}</div>
                <div style={{ fontSize: 13, fontWeight: 800, color: _tp >= 0 ? PROFIT_POS : PROFIT_NEG }}>{_tr >= 0 ? '+' : ''}{_tr.toFixed(1)}%</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <svg viewBox="0 0 100 100" width="110" height="110" style={{ flexShrink: 0 }}>
                {slices.map((s, i) => (
                  <circle key={i} cx="50" cy="50" r={r} fill="none" stroke={s.color} strokeWidth="20"
                    strokeDasharray={`${s.dash} ${circ - s.dash}`} strokeDashoffset={s.offset} />
                ))}
                <text x="50" y="47" textAnchor="middle" fill="#141414" fontSize="9" fontWeight="700">{evalAmt}</text>
                <text x="50" y="58" textAnchor="middle" fill="#6B675C" fontSize="7">총자산</text>
              </svg>
              <div style={{ flex: 1, minWidth: 80 }}>
                {slices.map((s, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: i < slices.length - 1 ? '1px solid #EAE6DA' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 7, height: 7, borderRadius: 0, background: s.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 10, color: '#6B675C' }}>{s.label}</span>
                    </div>
                    <span style={{ fontSize: 10, fontWeight: 800, color: '#141414' }}>{s.pctStr}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 전체 평가금 추이 바차트 */}
      <div style={{ background: "#FFFFFF", borderRadius: 0, padding: "16px", marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ fontSize: 10, letterSpacing: 3, color: "#6B675C" }}>전체 평가금 추이</div>
            <button
              onClick={() => { if (!lp.firedRef.current) setShowSavings(p => !p); }}
              {...lp.bind('savings', beginSavingsEdit)}
              style={{
                position: 'relative', overflow: 'hidden',
                padding: '3px 10px', borderRadius: 0,
                border: `1px solid ${lp.activeId === 'savings' ? '#141414' : showSavings ? '#10B981' : '#141414'}`,
                background: showSavings ? '#DDF3E4' : 'transparent',
                color: showSavings ? '#10B981' : '#6B675C',
                cursor: 'pointer', fontSize: 10, fontFamily: baseFont,
                userSelect: 'none', WebkitUserSelect: 'none',
              }}
            >저축금{lp.activeId === 'savings' && <div className="lp-progress" />}</button>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {['전체', '2025', '2026'].map(y => (
              <button key={y} onClick={() => setMonthYear(y)} style={{
                padding: '3px 10px', borderRadius: 0,
                border: '1px solid #141414',
                background: monthYear === y ? '#E4F5A0' : 'transparent',
                color: '#141414', fontWeight: monthYear === y ? 800 : 600,
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
                <XAxis dataKey="label" tick={{ fill: "#6B675C", fontSize: 9 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={v => `${(v / 100000000).toFixed(1)}억`} tick={{ fill: "#6B675C", fontSize: 9 }} width={40} axisLine={false} tickLine={false} />
                <Tooltip
                  formatter={(v, name) => {
                    if (name === 'base') return [`₩${v.toLocaleString()}`, '잔고'];
                    if (name === 'savingsAmt') return [`₩${v.toLocaleString()}`, '저축금'];
                    return [`₩${v.toLocaleString()}`, '평가금'];
                  }}
                  contentStyle={{ background: "#EAE6DA", border: "1px solid #141414", borderRadius: 0, fontSize: 11 }}
                  labelStyle={{ color: '#141414' }}
                  itemStyle={{ color: '#141414' }}
                />
                {showSavings ? (
                  <>
                    <Bar dataKey="base" stackId="a" fill={CHART_BAR_COLOR} activeBar={false} />
                    <Bar dataKey="savingsAmt" stackId="a" fill={CHART_BAR_COLOR} radius={[3, 3, 0, 0]} activeBar={false} />
                  </>
                ) : (
                  <Bar dataKey="value" fill={CHART_BAR_COLOR} radius={[3, 3, 0, 0]} activeBar={false} />
                )}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B675C', fontSize: 12 }}>
              데이터가 없습니다
            </div>
          );
        })()}
        {showSavingsEdit && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #141414' }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: '#6B675C', marginBottom: 8 }}>이번 달 저축금 수정</div>
            <input
              type="number"
              value={savingsEditValue}
              onChange={e => setSavingsEditValue(e.target.value)}
              style={{
                width: '100%', boxSizing: 'border-box', marginBottom: 8,
                background: '#FFFFFF', border: '1px solid #141414', borderRadius: 0,
                color: '#141414', padding: '6px 10px', fontSize: 12, fontFamily: baseFont,
              }}
              placeholder="0"
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowSavingsEdit(false)} style={{
                padding: '6px 12px', borderRadius: 0, border: '1px solid #141414',
                background: 'transparent', color: '#6B675C', cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
              }}>취소</button>
              <button onClick={saveSavingsEdit} style={{
                padding: '6px 12px', borderRadius: 0, border: 'none',
                background: '#10B981', color: '#fff', cursor: 'pointer', fontSize: 11, fontFamily: baseFont,
              }}>저장</button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
