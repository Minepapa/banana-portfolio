// State/BreakoutPositions 파일(포지션 하나당 파일 하나) 빌더·파서·조회 헬퍼 — 순수
// 함수. proposal-vault.mjs와 동일 패턴(파일 하나=레코드 하나, buildFrontmatter/
// parseFrontmatter로 평평한 key:value) — 이미 검증된 관례를 그대로 재사용한다.
//
// 이 파일이 왜 필요한가(2026-09-13, 돌파매매 전략 실전 구현): 다음날 시가 진입 후
// KIS에 스톱지정가(손절 -8%, 3R 부분익절) 주문을 걸어두는데, ①이 두 주문이 실제로
// 걸렸는지(protectionStatus) ②트레일링스탑은 KIS가 자동으로 안 올려주므로(스톱
// 지정가는 고정된 조건가 1개일 뿐, 진짜 트레일링은 우리 시스템이 주가가 오를 때마다
// 기존 손절주문을 "정정"(취소+재발주 아님 — reviseKrOrder, KIS주문정정취소API)해
// 조건가만 올려야 구현됨 — Knowledge/API/KIS.md 참고) 지금 손절선이 얼마인지 ③3R
// 부분익절을 이미 했는지를 하루하루, 프로세스 재시작을 넘어 이어서 추적해야 한다.
// 실제 파일 I/O는 호출부(state-writer.mjs)가 한다.
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';

function sanitizeSegment(s) {
  return String(s ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-');
}

// protectionStatus: 'pending'(보호주문 미발주/발주 시도 전) | 'protected'(손절+부분익절
// 주문 둘 다 살아있음 확인됨) | 'failed'(재시도 소진 후에도 못 걸음 — 즉시 알림 대상).
export const PROTECTION_STATUS = { PENDING: 'pending', PROTECTED: 'protected', FAILED: 'failed' };

// stopLossPct(2026-09-19, ATR 가변손절 실전배선) — 이 포지션이 진입 신호 시점에
// 확정받은 손절폭(4%/8%). 명시 저장하는 이유: stopPrice/entryPrice로 역산 가능해
// 보여도 부동소수점 나눗셈에 기대는 대신, 트레일링스탑(computeTrailingStop)·3R
// 재시도(ensurePositionProtected)가 원래 확정값을 그대로 다시 쓸 수 있어야 한다
// (breakout-simulator.mjs 백테스트가 position.stopLossPct를 쓰는 것과 동일 패턴,
// 라이브·백테스트 정합성 유지). 기본값 null — 과거(이 필드 신설 전) 레코드와
// 하위호환, null이면 호출측이 STOP_LOSS_PCT(8%)로 폴백.
export function buildBreakoutPositionRecord({
  code, name = '', entryDate, entryPrice, units = 1, quantity, investedWon, stopPrice, stopLossPct = null,
  profitOrderApplicable = true, now = new Date(),
}) {
  const id = `${sanitizeSegment(code)}-${sanitizeSegment(entryDate)}`;
  const filename = `${id}.md`;
  const content = buildFrontmatter({
    id, code, name, entryDate, entryPrice, units, quantity, investedWon,
    highSinceEntry: entryPrice,
    stopPrice, stopLossPct,
    partialSold: false,
    pyramided: false,
    protectionStatus: PROTECTION_STATUS.PENDING,
    stopOrderNo: null,
    stopOrderOrgNo: null, // 정정(트레일링 재계산)에 필요한 계좌관리점코드(KRX_FWDG_ORD_ORGNO) — 주문번호만으론 정정 불가
    profitOrderNo: null,
    profitOrderOrgNo: null,
    // 수량이 적어(1주 등) 부분익절 수량이 0이 되면 그 주문 자체가 애초에 필요없다
    // (breakout-protection.mjs computeProtectionOrders) — 이 경우 profitOrderNo가
    // 계속 null이어도 "아직 못 걺"이 아니라 "해당없음"이라 재시도 대상에서 빼야
    // 한다. 이 필드로 그 둘을 구분(호출측이 포지션 생성 시점에 이미 계산된 결과를
    // 넘겨줌).
    profitOrderApplicable,
    status: '보유',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    exitDate: null,
    exitReason: null,
  });
  return { id, filename, content };
}

// 기존 레코드에 updates 병합(proposal-vault.mjs updateProposalRecord와 동일 패턴) —
// updatedAt은 호출부가 명시적으로 안 넘기면 자동 갱신하지 않는다(순수함수라 "지금
// 시각"을 스스로 알 수 없음, 호출부가 now를 책임지고 넘김).
export function updateBreakoutPositionRecord(currentContent, updates) {
  const merged = { ...parseFrontmatter(currentContent), ...updates };
  return buildFrontmatter(merged);
}

export function parseBreakoutPosition(content) {
  return parseFrontmatter(content);
}

export function listBreakoutPositionsFromContents(contents) {
  return contents.map((c) => parseBreakoutPosition(c));
}

// 아직 청산 안 된(status==='보유') 포지션만 — 매일 신호스캔/보호주문 재확인 잡이
// 순회할 대상.
export function findOpenPositions(positions) {
  return positions.filter((p) => p.status === '보유');
}

// 보호주문(손절+3R부분익절)이 둘 다 안 걸려있는(pending|failed) 포지션 — 재시도·
// 알림 대상 판별용.
export function findUnprotectedPositions(positions) {
  return findOpenPositions(positions).filter((p) => p.protectionStatus !== PROTECTION_STATUS.PROTECTED);
}
