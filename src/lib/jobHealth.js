// 잡상태 시트(A2:E) → 헬스 판정 순수 로직. App.jsx 배너와 테스트가 공유.
export function parseJobStatus(rows) {
  return (rows || [])
    .filter(r => String(r?.[0] ?? '').trim())
    .map(r => ({
      job: String(r[0]).trim(),
      lastRun: String(r[1] ?? '').trim(),
      status: String(r[2] ?? '').trim(),
      detail: String(r[3] ?? '').trim(),
      durationSec: String(r[4] ?? '').trim(),
    }));
}

// cadence: { job: maxAgeHours }. 반환: 문제 잡 [{ job, problem:'fail'|'stale', detail }].
export function computeJobHealth(statusRows, cadence, now = Date.now()) {
  const out = [];
  for (const s of statusRows || []) {
    if (s.status && s.status !== 'OK') { out.push({ job: s.job, problem: 'fail', detail: s.detail || '' }); continue; }
    const maxH = cadence[s.job];
    if (maxH == null) continue;
    const ts = Date.parse(s.lastRun);
    if (isNaN(ts) || (now - ts) > maxH * 3600000) out.push({ job: s.job, problem: 'stale', detail: s.detail || '' });
  }
  return out;
}
