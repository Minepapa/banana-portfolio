// 잡상태 시트(A2:F: job·lastRun·status·detail·durationSec·failStreak) upsert 위치 계산.
// rows: 기존 값 2차원 배열. job(A열 매칭) 있으면 1-based 시트행(A2→2)을, 없으면 null(append) 반환.
export function findStatusRow(rows, job) {
  const target = String(job ?? '').trim();
  const idx = (rows || []).findIndex(r => String(r?.[0] ?? '').trim() === target);
  return idx < 0 ? null : idx + 2;
}
