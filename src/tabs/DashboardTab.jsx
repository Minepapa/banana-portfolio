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
import { maskAmountText } from '../lib/textFormat.js';
import { profitColor } from '../lib/colors.js';
import { CARD_BG, RADIUS, INK, INK_2, RADIUS_SM, MONO } from '../lib/theme.js';

export default function DashboardTab({
  totalInvest, totalEval, totalProfit, accounts, fmt, isMobile, setAcctKey, setTab, hideAmounts = false,
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
          { label: "총 투자금", value: `₩${fmt(totalInvest)}`, color: INK_2 },
          { label: "총 평가금", value: `₩${fmt(totalEval)}`, color: INK },
          { label: "수익률", value: `${totalProfit > 0 ? '+' : ''}${totalInvest > 0 ? ((totalProfit / totalInvest) * 100).toFixed(1) : '0.0'}%`, color: profitColor(totalProfit) },
        ].map((s) => (
          <div key={s.label} style={{
            background: CARD_BG, borderRadius: RADIUS, padding: "12px 10px", textAlign: "center",
          }}>
            <div style={{ fontSize: 9, color: INK_2, marginBottom: 4, letterSpacing: 1 }}>{s.label}</div>
            <div style={{
              fontSize: isMobile ? 12 : 15, fontWeight: 800, color: s.color, fontFamily: MONO,
              wordBreak: "break-all", letterSpacing: 0,
            }}>
              {hideAmounts ? maskAmountText(s.value) : s.value}
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
            <div key={k} onClick={() => { setAcctKey(k); setTab("assets"); }}
              style={{
                background: CARD_BG, border: `1px solid ${v.color}33`,
                borderRadius: RADIUS_SM, padding: "14px 16px",
                cursor: "pointer", transition: "all 0.2s",
                boxShadow: `0 0 20px ${v.color}11`,
              }}>
              <div style={{ fontSize: 9, letterSpacing: 2, color: v.color, marginBottom: 4 }}>
                {v.sub.toUpperCase()}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, color: INK }}>
                    {v.label}
                  </div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: INK, marginBottom: 2, fontFamily: MONO, letterSpacing: 0 }}>
                    {hideAmounts ? maskAmountText(`₩${fmt(v.total_eval)}`) : `₩${fmt(v.total_eval)}`}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 9, color: INK_2, marginBottom: 2 }}>수익</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: pColor , fontFamily: MONO}}>
                    {hideAmounts ? maskAmountText(`₩${fmt(v.profit)}`) : `₩${fmt(v.profit)}`}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: pColor }}>
                    {hideAmounts ? maskAmountText(`${v.profit > 0 ? '+' : ''}${pRate}%`) : `${v.profit > 0 ? '+' : ''}${pRate}%`}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
}
