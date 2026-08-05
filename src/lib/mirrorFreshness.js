// Firestore mirror/* 문서의 신선도 판정 — 순수 함수(구현계획서 Phase 6 "데이터 신선도
// 배너" 항목). sync-firestore-mirror.mjs가 각 문서에 updatedAt(ISO 문자열)을 찍어두므로,
// 그 값이 임계치(기본 2시간)보다 오래됐으면 대시보드가 "옛 데이터"임을 사용자에게 보여준다.
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

export function isMirrorStale(updatedAt, now = new Date(), thresholdMs = DEFAULT_STALE_MS) {
  if (!updatedAt) return true; // 아직 한 번도 동기화 안 됨 — 신선함을 주장할 근거가 없으므로 stale 취급
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > thresholdMs;
}
