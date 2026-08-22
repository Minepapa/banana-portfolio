// 체결내역 탭 — Facts/Ledger/Executions 미러 목록. v2 재배선(2026-08-13): 읽기 전용.
// v1의 수동 동기화·저축금 반영·셀 편집은 전부 제거 — 체결은 이제 카카오 파싱/KIS API가
// 자동으로 Vault에 기록하고, 이 탭은 그 결과를 보여만 준다.
import { PROFIT_POS, PROFIT_NEG } from '../lib/colors.js';
import { MONO } from '../lib/theme.js';

export default function ExecutionsTab({ trades, isMobile, fmt }) {
  return (
    <div>
      <div style={{ background: "#FFFFFF", borderRadius: 0, overflow: "hidden" }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #141414', fontSize: 10, letterSpacing: 2, color: '#6B675C' }}>
          전체 {trades.length}건
        </div>
        {trades.length === 0 && (
          <div style={{ padding: 32, textAlign: 'center', color: '#6B675C', fontSize: 12 }}>
            체결내역이 없습니다
          </div>
        )}
        {trades.map((t, i) => {
          const isBuy = String(t.side ?? '').includes('매수');
          // 매수=파랑(PROFIT_NEG)·매도=빨강(PROFIT_POS) — 카드 배경·글자색 전체를
          // 구분(오너 지시, 2026-08-22). 이 앱의 기존 색 관례(이익=빨강·손실=파랑)를
          // 그대로 재사용 — 매수·매도 전용 새 색을 추가하지 않는다.
          const sideColor = isBuy ? PROFIT_NEG : PROFIT_POS;
          const isUsDollar = t.assetClass === '해외주식' && t.account === '위탁';
          const currencySymbol = isUsDollar ? '$' : '₩';
          return (
            <div key={i} style={{
              padding: isMobile ? "10px 16px" : "12px 16px",
              borderBottom: i < trades.length - 1 ? '1px solid #EAE6DA' : 'none',
              borderLeft: `3px solid ${sideColor}`,
              background: `${sideColor}11`,
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{
                    fontSize: 10, padding: '1px 5px', borderRadius: 0,
                    background: `${sideColor}22`,
                    color: sideColor,
                    fontWeight: 700,
                  }}>{t.side || '—'}</span>
                  <span style={{ fontSize: 10, color: '#6B675C' }}>{t.account || '미확인'}</span>
                  <span style={{ fontSize: 10, color: '#6B675C' }}>·</span>
                  <span style={{ fontSize: 10, color: '#6B675C' }}>{t.date}</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#141414', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.name || '—'}
                </div>
                <div style={{ fontSize: 10, color: '#6B675C', marginTop: 2 }}>
                  {t.qty > 0 ? `${t.qty}주` : ''}{t.qty > 0 && t.price > 0 ? ' · ' : ''}{t.price > 0 ? `${currencySymbol}${t.price.toLocaleString()}` : ''}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0, fontSize: 12, color: sideColor, fontFamily: MONO, fontWeight: 700 }}>
                {t.amount ? `${currencySymbol}${fmt(t.amount)}` : ''}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
