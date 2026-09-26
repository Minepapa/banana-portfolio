// 체결내역 탭 — Facts/Ledger/Executions 미러 목록. v2 재배선(2026-08-13): 읽기 전용.
// v1의 수동 동기화·저축금 반영·셀 편집은 전부 제거 — 체결은 이제 카카오 파싱/KIS API가
// 자동으로 Vault에 기록하고, 이 탭은 그 결과를 보여만 준다.
import { maskAmountText } from '../lib/textFormat.js';
import { PROFIT_POS, PROFIT_NEG } from '../lib/colors.js';
import { PAPER_2, CARD_BG, RADIUS, INK, INK_2, BORDER, RADIUS_SM, MONO } from '../lib/theme.js';

export default function ExecutionsTab({ trades, isMobile, fmt, hideAmounts = false }) {
  return (
    <div>
      <div style={{ background: CARD_BG, borderRadius: RADIUS, overflow: "hidden" }}>
        <div style={{ padding: '10px 16px', borderBottom: BORDER, fontSize: 10, letterSpacing: 2, color: INK_2 }}>
          전체 {trades.length}건
        </div>
        {trades.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: INK_2, fontSize: 12 }}>
            체결내역이 없습니다
          </div>
        )}
        {trades.map((t, i) => {
          const isBuy = String(t.side ?? '').includes('매수');
          // 매수=파랑(PROFIT_NEG)·매도=빨강(PROFIT_POS) — [매수/매도] 배지 색으로만
          // 구분한다(오너 지시, 2026-08-22 — 카드 전체 배경·좌측 강조선·금액 글자색은
          // 다시 뺌, 배지 하나만 색이 있으면 충분하다는 판단).
          const sideColor = isBuy ? PROFIT_NEG : PROFIT_POS;
          const isUsDollar = t.assetClass === '해외주식' && t.account === '위탁';
          const currencySymbol = isUsDollar ? '$' : '₩';
          return (
            <div key={i} style={{
              padding: isMobile ? "10px 16px" : "12px 16px",
              borderBottom: i < trades.length - 1 ? `1px solid ${PAPER_2}` : 'none',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{
                    fontSize: 10, padding: '1px 5px', borderRadius: RADIUS_SM,
                    background: `${sideColor}22`,
                    color: sideColor,
                    fontWeight: 700,
                  }}>{t.side || '—'}</span>
                  <span style={{ fontSize: 10, color: INK_2 }}>{t.account || '미확인'}</span>
                  <span style={{ fontSize: 10, color: INK_2 }}>·</span>
                  <span style={{ fontSize: 10, color: INK_2 }}>{t.date}</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.name || '—'}
                </div>
                <div style={{ fontSize: 10, color: INK_2, marginTop: 2 }}>
                  {t.qty > 0 ? `${t.qty}주` : ''}{t.qty > 0 && t.price > 0 ? ' · ' : ''}{t.price > 0 ? (hideAmounts ? maskAmountText(`${currencySymbol}${t.price.toLocaleString()}`) : `${currencySymbol}${t.price.toLocaleString()}`) : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0, fontSize: 12, color: INK, fontFamily: MONO }}>
                {t.amount ? (hideAmounts ? maskAmountText(`${currencySymbol}${fmt(t.amount)}`) : `${currencySymbol}${fmt(t.amount)}`) : ''}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
