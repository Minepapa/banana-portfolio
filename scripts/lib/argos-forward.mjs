// 아르고스 전환 준비(요청 `아르고스 수신부 재설계` 2단계 2·3번).
// 이미 보관한 95_Etna/Events를 읽어 기존 데이터셋 모양으로 바꾼다 — 소비자(동선·지출 요약)는 손대지 않는다.
// - 위치: OwnTracks 모양 점({_type, tst, lat, lon, acc, batt, tid}) → createLocationStore(같은 tst는 저장 안 함)
// - 소비: 알림 앱 spendingInbox 원문 모양({id, ts, source, packageName, appLabel, sender, body, postedAt})
//   ts는 KST "YYYY-MM-DD HH:MM:SS" 문자열이다. 숫자로 넣으면 시각이 사라진다(2026-10-23 실데이터 확인).
// 순수함수만 둔다. 읽기·쓰기는 tools/argos-forward.mjs가 한다.

const KST_OFFSET_MS = 9 * 3_600_000;
// 시계가 의심스러운 이벤트(수신 때 clock_suspect)는 날짜 파일을 잘못 고를 수 있어 넘기지 않는다.
const usable = (event) => event && !event.clock_suspect && event.payload && typeof event.payload === 'object';

export function kstTimestamp(milliseconds) {
  return new Date(milliseconds + KST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

export function locationPointsFromEvents(events) {
  const points = [];
  for (const event of events) {
    if (event?.type !== 'location.point_recorded' || !usable(event)) continue;
    const { lat, lon, acc, batt, tid, tst } = event.payload;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isSafeInteger(tst) || tst <= 0) continue;
    points.push({ _type: 'location', tst, lat, lon,
      ...(Number.isFinite(acc) ? { acc } : {}), ...(Number.isFinite(batt) ? { batt } : {}),
      ...(typeof tid === 'string' ? { tid } : {}) });
  }
  return points;
}

// 아르고스 수집 규칙이 `소비`로 분류한 알림만 넘긴다(분류는 폰 규칙 — 결정 `아르고스-수집-범위`).
// id 앞의 `argos:`로 알림 앱 기록과 구분한다. 같은 이벤트를 다시 넘겨도 같은 id라 한 번만 남는다.
export function spendingRecordsFromEvents(events) {
  const records = [];
  for (const event of events) {
    if (event?.type !== 'notification.received' || !usable(event) || event.payload.category !== '소비') continue;
    const { postedAt, body } = event.payload;
    if (!Number.isSafeInteger(postedAt) || postedAt <= 0 || typeof body !== 'string' || !body.trim()) continue;
    records.push({ id: `argos:${event.id}`, ts: kstTimestamp(postedAt), source: event.payload.source ?? 'argos',
      packageName: event.payload.packageName ?? null, appLabel: event.payload.appLabel ?? null,
      sender: event.payload.sender ?? '', body, postedAt });
  }
  return records;
}
