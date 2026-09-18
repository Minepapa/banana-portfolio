// State/BreakoutPendingEntries 파일(대기 항목 하나당 파일 하나) 빌더·파서 — 순수함수.
// breakout-position-vault.mjs와 동일 패턴(파일 하나=레코드 하나, buildFrontmatter/
// parseFrontmatter로 평평한 key:value).
//
// 이 파일이 왜 필요한가(2026-09-13, 진입 체결방식 "장후시간외 우선+다음날시가 폴백"
// 확정): place-breakout-entry-order.mjs가 장후시간외(ORD_DVSN=06) 매수를 시도했는데
// 그 세션(15:40~16:00 KRX) 안에 전혀 체결이 안 되면(filledQty===0), 다음날 시가로
// 다시 시도해야 한다 — 그 사이 프로세스가 끝나므로(장후시간외 감시 스크립트가 자정
// 넘겨 계속 떠 있을 수 없다) "내일 아침에 할 일"을 파일로 남겨두고, 별도 잡
// (place-breakout-fallback-entry.mjs)이 시가 근처에 이 파일들을 읽어 처리한다.
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';

function sanitizeSegment(s) {
  return String(s ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-');
}

// status: 'pending'(아직 처리 안 됨) | 'placing'(주문 접수 중 — 접수 직전에 먼저
// 기록해 크래시 창을 좁힌다, 2026-09-13 코드리뷰 지적) | 'placed'(다음날시가 주문
// 접수 완료, 체결감시는 watch-breakout-entry-fill.mjs가 별도로 이어감) | 'failed'
// (주문이 확실히 미접수로 거부됨, 수동확인 필요) | 'uncertain'(전날 장후시간외
// 주문의 생사를 확인 못했거나, 시장가 주문 응답이 불명(confirmedNotSent 없음)해서
// 실제로는 접수됐을 수 있음 — 둘 다 "재시도하면 이중매수 위험"이라 findUnprocessed
// 대상에서 제외하고 수동확인으로 넘김) | 'expired'(킬스위치가 여러 날 켜져 있는
// 동안 신호일이 너무 오래돼 조건 재검증 없이 그대로 발주하면 위험하다고 판단해
// 자동 거부됨, isPendingEntryStale 참고 — 2026-09-18 코드리뷰 HIGH 지적).
export const PENDING_ENTRY_STATUS = {
  PENDING: 'pending', PLACING: 'placing', PLACED: 'placed', FAILED: 'failed', UNCERTAIN: 'uncertain', EXPIRED: 'expired',
};

// 킬스위치가 여러 날 켜져 있다가 꺼지면, 그동안 쌓인 'pending' 항목이 다음 실행에서
// 한꺼번에 "신호일 가격·조건" 재검증 없이 시가 시장가로 나갈 수 있다(2026-09-18
// 코드리뷰 HIGH — place-breakout-fallback-entry.mjs가 findUnprocessedPendingEntries의
// 결과를 나이 구분 없이 전부 처리했음). 정상 운영 중엔 이 잡이 매 평일 09:03 돌아
// 'pending'이 하루 이상 버티는 유일한 경우가 주말(금요일 저녁 신호 → 월요일 아침
// 폴백, 최대 3일)뿐이므로, maxAgeDays 기본값은 그보다 여유 있게 5(연휴 등 흡수)로
// 잡는다 — 그 이상 묵었다면 킬스위치가 개입했거나 이 잡 자체가 며칠 못 돈 비정상
// 상황으로 보고 자동발주 대신 수동확인으로 넘긴다.
export function isPendingEntryStale(entry, { maxAgeDays = 5, now = new Date() } = {}) {
  if (!entry.signalDate) return false; // 신호일 자체가 없으면 나이를 판단할 근거가 없다 — 안전하지 않은 쪽(자동거부)으로 다루지 않고 기존 처리 경로에 맡김
  const signal = new Date(`${entry.signalDate}T00:00:00+09:00`);
  if (Number.isNaN(signal.getTime())) return false;
  const ageDays = (now.getTime() - signal.getTime()) / (24 * 60 * 60 * 1000);
  return ageDays > maxAgeDays;
}

export function buildPendingEntryRecord({
  code, name = '', signalDate, investedWon, afterHoursOrderNo = null, reason = '', now = new Date(),
}) {
  const id = `${sanitizeSegment(code)}-${sanitizeSegment(signalDate)}`;
  const filename = `${id}.md`;
  const content = buildFrontmatter({
    id, code, name, signalDate, investedWon, afterHoursOrderNo, reason,
    status: PENDING_ENTRY_STATUS.PENDING,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  return { id, filename, content };
}

export function updatePendingEntryRecord(currentContent, updates) {
  const merged = { ...parseFrontmatter(currentContent), ...updates };
  return buildFrontmatter(merged);
}

export function parsePendingEntry(content) {
  return parseFrontmatter(content);
}

// 다음날 아침 처리 잡이 순회할 대상 — 아직 처리 안 된 것만(재실행 시 이미 placed/failed된
// 항목을 중복 주문하지 않기 위함).
export function findUnprocessedPendingEntries(entries) {
  return entries.filter((e) => e.status === PENDING_ENTRY_STATUS.PENDING);
}
