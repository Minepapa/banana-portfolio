// 잡상태 시트(A2:F) → 헬스 판정 순수 로직. App.jsx 배너와 테스트가 공유.
export function parseJobStatus(rows) {
  return (rows || [])
    .filter(r => String(r?.[0] ?? '').trim())
    .map(r => ({
      job: String(r[0]).trim(),
      lastRun: String(r[1] ?? '').trim(),
      status: String(r[2] ?? '').trim(),
      detail: String(r[3] ?? '').trim(),
      durationSec: String(r[4] ?? '').trim(),
      failStreak: parseInt(String(r[5] ?? '0'), 10) || 0,  // F열 연속실패 — 심각도 판단용
    }));
}

// cadence: { job: maxAgeHours }. 반환: 문제 잡 [{ job, problem:'fail'|'stale'|'missing', detail }].
export function computeJobHealth(statusRows, cadence, now = Date.now()) {
  const out = [];
  const seen = new Set();
  for (const s of statusRows || []) {
    seen.add(s.job);
    if (s.status && s.status !== 'OK') { out.push({ job: s.job, problem: 'fail', detail: s.detail || '', failStreak: s.failStreak || 0 }); continue; }
    const maxH = cadence[s.job];
    if (maxH == null) continue;
    const ts = Date.parse(s.lastRun);
    if (isNaN(ts) || (now - ts) > maxH * 3600000) out.push({ job: s.job, problem: 'stale', detail: s.detail || '' });
  }
  // cadence에 정의된 필수 잡인데 시트에 행이 아예 없으면 침묵 실패 — heartbeat 누락 자체를 문제로 본다
  for (const job of Object.keys(cadence)) {
    if (!seen.has(job)) out.push({ job, problem: 'missing', detail: '' });
  }
  return out;
}
