// 대시보드 탭 — 요약 카드 + 계좌 그리드 + 총괄 도넛 + 월별 잔고 추이. v2 재배선
// (2026-08-13): 읽기 전용(Firestore mirror는 쓰기 API가 없음 — useFirestoreMirror.js
// 참고), 편집 기능 전부 제거. 월별 잔고 추이 차트는 당시 v1 "월별잔고" 시트 전용이라
// 미러 문서에 대응 값이 없어 뺐었는데(가짜 데이터로 대체하지 않는다는 원칙), 2026-08-21
// v1→v2 전수감사에서 그 시트를 mirror/monthlyBalances로 1회성 이관하며 되살렸다.
// 2026-08-22 오너 확정으로 한 번 더 바뀜 — v1 시트는 더 이상 안 쓰고,
// update-monthly-balance-snapshot.mjs(매일 23:50 KST)가 State/Holdings 합산 총자산을
// 이번 달 파일에 매일 덮어쓴다(달이 바뀌면 지난달 파일은 더 이상 안 건드려져 그
// 마지막 값이 자연히 그 달 확정치가 됨). 차트 스타일은 DividendTab/ProfitTab과
// 동일하게 맞춤(오너 지시) — 연도 필터·클릭 하이라이트 포함.
import { useState } from 'react';
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { profitColor, CHART_BAR_COLOR } from '../lib/colors.js';
import { MONO } from '../lib/theme.js';

export default function DashboardTab({
  totalInvest, totalEval, totalProfit, accounts, fmt, isMobile, setAcctKey, setTab, monthlyBalances = [],
}) {
  const [balYear, setBalYear] = useState('전체');
  const [selectedBalKey, setSelectedBalKey] = useState(null);
  const balYears = ['전체', ...[...new Set(monthlyBalances.map(m => String(m.year)))].sort()];
  const filteredBalances = balYear === '전체' ? monthlyBalances : monthlyBalances.filter(m => String(m.year) === balYear);
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
                  <div style={{ fontSize: 13, fontWeight: 800, color: pColor , fontFamily: MONO}}>
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
                <div style={{ fontSize: 17, fontWeight: 800, color: _tp >= 0 ? '#159E52' : '#E5484D', fontFamily: MONO, letterSpacing: -0.3 }}>₩{fmt(_tp)}</div>
                <div style={{ fontSize: 13, fontWeight: 800, color: _tp >= 0 ? '#159E52' : '#E5484D' }}>{_tr >= 0 ? '+' : ''}{_tr.toFixed(1)}%</div>
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
                    <span style={{ fontSize: 10, fontWeight: 800, color: '#141414' , fontFamily: MONO}}>{s.pctStr}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 월별 잔고 추이 — DividendTab/ProfitTab과 동일한 차트 스타일(오너 지시, 2026-08-22) */}
      {monthlyBalances.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
            {balYears.map(y => (
              <button key={y} onClick={() => { setBalYear(y); setSelectedBalKey(null); }} style={{
                padding: isMobile ? "8px 14px" : "6px 14px",
                borderRadius: 0,
                border: '1px solid #141414',
                background: balYear === y ? '#E4F5A0' : 'transparent',
                color: balYear === y ? '#141414' : '#6B675C',
                cursor: 'pointer', fontSize: 11,
              }}>{y}</button>
            ))}
          </div>
          <div style={{ background: "#FFFFFF", borderRadius: 0, padding: "16px", marginBottom: 16 }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: "#6B675C", marginBottom: 16 }}>월별 잔고 추이</div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={filteredBalances}
                barSize={isMobile ? 10 : 16}
                accessibilityLayer={false}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#141414" />
                <XAxis dataKey="label" tick={{ fill: "#6B675C", fontSize: 9 }} />
                <YAxis tickFormatter={v => v.toLocaleString()} tick={{ fill: "#6B675C", fontSize: 9 }} width={55} />
                <Tooltip
                  formatter={v => [`₩${v.toLocaleString()}`, '총잔고']}
                  contentStyle={{ background: "#EAE6DA", border: "1px solid #141414", borderRadius: 0, fontSize: 11 }}
                  labelStyle={{ color: '#141414' }}
                  itemStyle={{ color: '#141414' }}
                />
                <Bar dataKey="total" fill={CHART_BAR_COLOR} radius={[3, 3, 0, 0]} cursor="pointer" activeBar={false}
                  onClick={(data) => {
                    setSelectedBalKey(prev => prev === data.label ? null : data.label);
                  }}>
                  {filteredBalances.map((m, i) => {
                    const dim = selectedBalKey && m.label !== selectedBalKey;
                    return <Cell key={i} fill={CHART_BAR_COLOR} fillOpacity={dim ? 0.3 : 1} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
