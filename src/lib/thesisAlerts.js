// 투자논리 훼손 경보: 보유 포지션 중 리스크모니터 B/D 신호(🔴🟡)와 매칭되는 종목 추출.
// 거래결정·포지션·평가 탭이 공유하는 단일 소스. App.jsx에서 추출 (동작 불변).
import { sameStock } from './stockIdentity.js';

export function findThesisAlerts(positionJournal, riskMonitor) {
  const held = (positionJournal || []).filter(p => p.status !== '청산');
  const alerts = [];
  for (const p of held) {
    const signal = (riskMonitor || []).find(s =>
      /🔴|🟡/.test(s.signal) && s.target && (
        (p.ticker && p.ticker.toUpperCase() === s.target.toUpperCase()) ||
        sameStock('', p.name, '', s.target)
      )
    );
    if (signal) alerts.push({ position: p, signal });
  }
  return alerts;
}
