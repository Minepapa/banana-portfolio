// 리스크 신호 dedup+집계 — RiskTab.jsx에서 추출(동작 불변). 판테온탭 Themis 카드가 이 함수를
// 재사용해 RiskTab 요약칩과 숫자가 절대 어긋나지 않게 한다("탭마다 색/숫자 따로 정의" 사고 재발 방지).
const sigLevel = (s) => s.includes('🔴') ? 3 : s.includes('🟡') ? 2 : 1;

export function computeRiskCounts(riskMonitor) {
  const rows = riskMonitor || [];

  // 동일 (유형+대상)은 최신 1건만 — riskMonitor는 최신순.
  // 거시(D)는 대상 텍스트가 실행마다 달라져 (유형+대상) 디듀프가 안 먹으므로,
  // 가장 최근 날짜의 D 신호만 노출(과거 날짜 누적분 자동 제거).
  const latestDDate = rows.reduce((mx, r) => (r.type === 'D' && r.date > mx ? r.date : mx), '');
  const seen = new Set();
  const latest = [];
  const oppSeen = new Set();   // 기회(O) 신호 — 종목당 최신 1건
  for (const r of rows) {                       // riskMonitor 최신순
    if (r.type === 'O') {
      if (oppSeen.has(r.target)) continue;
      oppSeen.add(r.target);
      if (sigLevel(r.signal) === 1) continue;    // 🟢(해소된 기회)는 숨김
      latest.push(r);                            // 대시보드 카운트에 포함
      continue;
    }
    if (r.type === 'D' && r.date !== latestDDate) continue;
    const k = `${r.type}|${r.target}`;
    if (seen.has(k)) continue;
    seen.add(k); latest.push(r);
  }
  // 카드 정렬 = 상단 칩과 같은 순서(경보→기회→주의→정상). 심각도만으로 정렬하면 O(항상 🔴)가
  // 경보와 같은 순위가 돼버려 카테고리 우선, 그다음 심각도로 정렬.
  const categoryRank = (r) => r.type === 'O' ? 2 : (sigLevel(r.signal) === 3 ? 1 : sigLevel(r.signal) === 2 ? 3 : 4);
  latest.sort((a, b) => categoryRank(a) - categoryRank(b) || sigLevel(b.signal) - sigLevel(a.signal));

  // 기회(O)는 리스크가 아니므로 경보/주의에 안 섞고 별도 집계.
  const counts = { red: 0, amber: 0, green: 0, opp: 0 };
  latest.forEach(r => {
    if (r.type === 'O') { counts.opp++; return; }
    const l = sigLevel(r.signal); if (l === 3) counts.red++; else if (l === 2) counts.amber++; else counts.green++;
  });

  // 최신 점검일 — 행 순서에 의존하지 않게 실제 최대 날짜로 계산.
  const lastUpdated = rows.reduce((mx, r) => (r.date > mx ? r.date : mx), '') || '—';

  return { latest, counts, lastUpdated };
}
