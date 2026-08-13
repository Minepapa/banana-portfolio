// 대시보드 탭 — 요약 카드 + 계좌 그리드 + 총괄 도넛. v2 재배선(2026-08-13): 읽기 전용
// (Firestore mirror는 쓰기 API가 없음 — useFirestoreMirror.js 참고), 편집 기능 전부
// 제거. 월별 잔고 추이 차트는 v1 "월별잔고" 시트 전용이라 미러 7종 문서에 대응 값이
// 없어 제거(가짜 데이터로 대체하지 않는다).
import { profitColor } from '../lib/colors.js';
import { MONO } from '../lib/theme.js';

export default function DashboardTab({
  totalInvest, totalEval, totalProfit, accounts, fmt, isMobile, setAcctKey, setTab,
}) {
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
    </div>
  );
}
