// 투자논리 훼손 경보: 보유 포지션 중 리스크모니터 B(논리/펀더멘털) 신호(🔴🟡)와 매칭되는 종목 추출.
// ⚠️ B(논리 훼손)만 본다 — 가격 기반 O(급락매수·차익실현 52주/RSI)·거시 D는 "투자논리 훼손"이 아니다.
//    (Frank 철학: 가격 상승 ≠ 논리 훼손, 리스크 우선순위 B>D>가격). 매도 검토는 펀더멘털 훼손에서만 나온다.
// 거래결정·포지션·평가 탭이 공유하는 단일 소스. App.jsx에서 추출.
import { sameStock } from './stockIdentity.js';

// B신호 심각도별 라벨 — 🔴=훼손(확정), 🟡=주의(약화·"훼손 확정 아님"). Frank 결정 2026-07:
// 포지션 탭이 🟡까지 "훼손"으로 뭉뚱그리던 것을 주문 가드(applyThesisGuard)와 동일 어휘로 세분화.
// (🔴만 매수 제외·훼손, 🟡은 매수 경고·주의) — 세 탭이 같은 신호를 같은 말로 부르게 한다.
export const isThesisBreach = (signal) => String(signal ?? '').includes('🔴');
export const thesisAlertLabel = (signal) => isThesisBreach(signal) ? '투자논리 훼손' : '논리 주의';

export function findThesisAlerts(positionJournal, riskMonitor) {
  const held = (positionJournal || []).filter(p => p.status !== '청산');
  const matches = (p, s) => s.target && (
    (p.ticker && p.ticker.toUpperCase() === s.target.toUpperCase()) ||
    sameStock('', p.name, '', s.target)
  );
  const alerts = [];
  for (const p of held) {
    // B(논리) 신호만. riskMonitor는 최신순이라 첫 B가 최신 — 최신이 🟢면 자동 해소.
    const latestB = (riskMonitor || []).find(s => s.type === 'B' && matches(p, s));
    if (latestB && /🔴|🟡/.test(latestB.signal)) {
      alerts.push({ position: p, signal: latestB });
    }
  }
  return alerts;
}
