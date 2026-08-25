// 종목 탭 — 계좌별 보유종목 목록. v2 재배선(2026-08-13): 읽기 전용(Firestore mirror는
// 쓰기 API가 없음 — useFirestoreMirror.js 참고). 추가/삭제/인라인 편집·실시간시세(KIS
// 웹소켓, 미러 문서 밖)는 제거. 보유종목을 직접 고치고 싶으면 텔레그램으로 판테온에
// 요청 — 실제 반영은 여전히 검문소를 통과해야 한다(useFirestoreMirror.js 원칙 그대로).
import { profitColor, COLORS } from '../lib/colors.js';
import { MONO } from '../lib/theme.js';

// RebalanceTab의 자산분배 자산군 순서와 동일(2026-08-22 오너 지시 — 두 탭의 자산군
// 순서가 서로 다르면 같은 개념인데 다르게 읽혀 혼동을 준다). 이 목록에 없는 타입
// (ISA "배당주"는 이미 포함, IRP "TDF"·CMA "현금"처럼 단일자산 계좌 전용 타입)은
// 끝으로 보낸다 — 정렬 안정성 위해 원래 순서 유지(Array.sort는 stable).
const ASSET_ORDER = ['채권', '금', '달러', '배당주', '리츠', '국내주식', '해외주식'];
const assetRank = (type) => {
  const i = ASSET_ORDER.indexOf(type);
  return i === -1 ? ASSET_ORDER.length : i;
};

export default function HoldingsTab({ accounts, acct, acctKey, setAcctKey, isMobile, baseFont, fmt, holdSort, setHoldSort }) {
  const rawHoldings = (acct.holdings || [])
    // 현금성 행(예수금·외화RP·MMF)은 잔액이 0이어도 유지 — 음수→행 소멸 버그 방지.
    .filter(h => h.isCashLike || (h.invest > 0 && h.eval > 0));

  const SORT_FN = {
    sheet:       (a, b) => assetRank(a.type) - assetRank(b.type),
    rate_desc:   (a, b) => b.rate   - a.rate,
    rate_asc:    (a, b) => a.rate   - b.rate,
    eval_desc:   (a, b) => b.eval   - a.eval,
    profit_desc: (a, b) => b.profit - a.profit,
  };
  // 예수금은 정렬 방식과 무관하게 항상 최상단(오너 지시, 2026-08-22) — 선택된 정렬은
  // 예수금을 제외한 나머지에만 2차 기준으로 적용.
  const withCashFirst = (cmp) => (a, b) => {
    const aCash = a.name === '예수금' ? 1 : 0;
    const bCash = b.name === '예수금' ? 1 : 0;
    return aCash !== bCash ? bCash - aCash : cmp(a, b);
  };
  const sortedHoldings = [...rawHoldings].sort(withCashFirst(SORT_FN[holdSort] || SORT_FN.sheet));

  return (
    <div>
      {/* 계좌 선택 — 6개(ISA·위탁·연금저축·IRP·CMA·금현물). 2026-08-22 오너 지시로 한
          줄 고정(flexWrap 제거) + 좌우 폭 축소 — 공간이 모자란 연금저축만 "연금"으로
          줄여서 6칸이 좁은 화면에서도 한 줄에 들어가게 함. */}
      <div style={{ display: "flex", flexWrap: "nowrap", gap: 4, marginBottom: 16 }}>
        {Object.entries(accounts).map(([k, a]) => (
          <button key={k} onClick={() => setAcctKey(k)} style={{
            flex: "1 1 0", minWidth: 0, padding: isMobile ? "7px 2px" : "6px 3px",
            textAlign: 'center',
            borderRadius: 0,
            border: `1px solid ${acctKey === k ? a.color : "#141414"}`,
            background: acctKey === k ? `${a.color}22` : "transparent",
            color: acctKey === k ? a.color : "#6B675C",
            cursor: "pointer", fontSize: isMobile ? 10 : 11, fontFamily: baseFont,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {a.label === '연금저축' ? '연금' : a.label}
          </button>
        ))}
      </div>

      {/* 계좌 요약 카드 */}
      <div style={{
        background: `${acct.color}22`,
        border: '2px solid #141414', boxShadow: '4px 4px 0 #141414',
        borderRadius: 0, padding: "16px", marginBottom: 16,
      }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: acct.color, marginBottom: 4 }}>
          {acct.sub.toUpperCase()}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: isMobile ? 16 : 20, fontWeight: 700, color: "#141414" , fontFamily: MONO}}>
              ₩{fmt(acct.total_eval)}
            </div>
            <div style={{ fontSize: 11, color: "#6B675C", marginTop: 2 }}>
              투자금 ₩{fmt(acct.total_invest)}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{
              fontSize: isMobile ? 13 : 16, fontWeight: 700,
              color: profitColor(acct.profit),
            fontFamily: MONO}}>
              ₩{fmt(acct.profit)}
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: profitColor(acct.profit) }}>
              {acct.profit >= 0 ? '+' : ''}
              {acct.total_invest > 0 ? ((acct.profit / acct.total_invest) * 100).toFixed(1) : '0.0'}%
            </div>
          </div>
        </div>
      </div>

      {/* 정렬 버튼 — "정렬" 라벨 삭제(오너 지시, 2026-08-22): 버튼 자체가 키워드라 라벨 불필요. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center' }}>
        {[
          { key: 'sheet',       label: '자산군순' },
          { key: 'rate_desc',   label: '수익률↓' },
          { key: 'rate_asc',    label: '수익률↑' },
          { key: 'eval_desc',   label: '평가금↓' },
        ].map(s => (
          <button key={s.key} onClick={() => setHoldSort(s.key)} style={{
            padding: '4px 8px', borderRadius: 0, fontSize: 10,
            border: '1px solid #141414',
            background: holdSort === s.key ? '#E4F5A0' : 'transparent',
            color: '#141414', fontWeight: holdSort === s.key ? 800 : 600,
            cursor: 'pointer', fontFamily: baseFont,
          }}>{s.label}</button>
        ))}
      </div>

      {/* 보유 종목 목록 */}
      <div style={{ background: "#FFFFFF", borderRadius: 0, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid #141414", fontSize: 10, letterSpacing: 2, color: "#6B675C" }}>
          보유 종목 ({sortedHoldings.length})
        </div>
        {sortedHoldings.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: '#6B675C', fontSize: 12 }}>종목이 없습니다</div>
        )}
        {sortedHoldings.map((h, vi) => {
          const color = profitColor(h.rate);
          const typeName = h.type || '';
          const isUsDollar = String(typeName).includes('해외') && acctKey === '위탁';
          return (
            <div key={`${acctKey}-${h.name}`} style={{ borderBottom: vi < sortedHoldings.length - 1 ? "1px solid #EAE6DA" : "none" }}>
              <div style={{
                padding: isMobile ? "10px 16px" : "12px 16px",
                display: "flex", alignItems: "center", gap: 8,
              }}>
                {typeName && (
                  <div style={{ fontSize: 10, background: (COLORS[typeName] || '#aaa') + '33', color: COLORS[typeName] || '#aaa', padding: '2px 6px', borderRadius: 0, flexShrink: 0, whiteSpace: 'nowrap' }}>
                    {typeName}
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#141414", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {h.name}
                  </div>
                  <div style={{ fontSize: 10, color: "#6B675C", marginTop: 2 }}>
                    {h.qty}주 · 매수 {isUsDollar ? `$${Number(h.price).toFixed(2)}` : `₩${fmt(h.price)}`}
                  </div>
                  {h.currentPrice > 0 && (
                    <div style={{ fontSize: 10, color: "#6B675C" }}>
                      현재 {isUsDollar ? `$${Number(h.currentPrice).toFixed(2)}` : `₩${fmt(h.currentPrice)}`}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: isMobile ? 11 : 12, color: "#141414", fontFamily: MONO }}>₩{fmt(h.eval)}</div>
                  <div style={{ fontSize: isMobile ? 10 : 11, fontWeight: 700, color }}>
                    {h.rate >= 0 ? '+' : ''}{h.rate.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 10, color , fontFamily: MONO}}>
                    ₩{fmt(Math.abs(h.profit))}
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
