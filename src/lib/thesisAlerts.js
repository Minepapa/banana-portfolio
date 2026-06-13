// 투자논리 훼손 경보: 보유 포지션 중 리스크모니터 B/D 신호(🔴🟡)와 매칭되는 종목 추출.
// 거래결정·포지션·평가 탭이 공유하는 단일 소스. App.jsx에서 추출 (동작 불변).
import { sameStock } from './stockIdentity.js';

export function findThesisAlerts(positionJournal, riskMonitor) {
  const held = (positionJournal || []).filter(p => p.status !== '청산');
  const matches = (p, s) => s.target && (
    (p.ticker && p.ticker.toUpperCase() === s.target.toUpperCase()) ||
    sameStock('', p.name, '', s.target)
  );
  const alerts = [];
  for (const p of held) {
    // 리스크 탭과 동일 기준으로 "최신"을 판정한다(주단위 동기 일치).
    // riskMonitor는 최신순 → 유형(B/D)별 첫 매칭이 그 유형의 최신 신호.
    // 색 무관하게 최신을 먼저 잡아야, 더 최신 🟢가 옛 🔴를 덮을 때 경보가 해소된다.
    // (옛 .find(🔴|🟡)는 최신 🟢를 건너뛰고 묵은 🔴를 계속 경보하던 버그)
    const latestByType = new Map();
    for (const s of (riskMonitor || [])) {
      if (matches(p, s) && !latestByType.has(s.type)) latestByType.set(s.type, s);
    }
    const active = [...latestByType.values()].filter(s => /🔴|🟡/.test(s.signal));
    if (active.length) {
      active.sort((a, b) => (/🔴/.test(b.signal) ? 1 : 0) - (/🔴/.test(a.signal) ? 1 : 0));
      alerts.push({ position: p, signal: active[0] });
    }
  }
  return alerts;
}
