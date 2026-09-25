// 2026-09-25 KST부터 위탁 미국주식 체결의 장부 정본을 카카오 알림에서 NH PLUG
// gbstock 일별거래내역으로 전환한다. 이 날짜 이전 거래는 이미 카카오 경로에서
// holdingsApplied까지 끝났으므로, 이번 전환 경로가 소급 대사·재기록하지 않는다.
export const GB_EXECUTION_API_CUTOVER_KST_DATE = '2026-09-25';

export function kstDateOrNull(value) {
  const match = String(value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:\s|$)/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}
