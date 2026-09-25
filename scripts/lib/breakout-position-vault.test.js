import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBreakoutPositionRecord, updateBreakoutPositionRecord, parseBreakoutPosition,
  listBreakoutPositionsFromContents, findOpenPositions, findUnprotectedPositions,
  PROTECTION_STATUS,
} from './breakout-position-vault.mjs';

const now = new Date('2026-09-13T00:00:00.000Z');

test('buildBreakoutPositionRecord: 생성 시 보호상태 pending, 청산 전 필드는 null', () => {
  const { id, filename, content } = buildBreakoutPositionRecord({
    code: '005930', name: '삼성전자', entryDate: '2026-09-13', entryPrice: 71000,
    quantity: 140, investedWon: 10_000_000, stopPrice: 65320, now,
  });
  const p = parseBreakoutPosition(content);
  assert.equal(id, '005930-2026-09-13');
  assert.equal(filename, '005930-2026-09-13.md');
  assert.equal(p.quantity, 140);
  assert.equal(p.status, '보유');
  assert.equal(p.protectionStatus, PROTECTION_STATUS.PENDING);
  assert.equal(p.stopOrderNo, null);
  assert.equal(p.stopOrderOrgNo, null);
  assert.equal(p.profitOrderNo, null);
  assert.equal(p.profitOrderOrgNo, null);
  assert.equal(p.partialSold, false);
  assert.equal(p.highSinceEntry, 71000);
  assert.equal(p.exitDate, null);
  assert.equal(p.profitOrderApplicable, true);
  assert.deepEqual(p.related, ['[[Knowledge/Topics/돌파매매-전략]]']);
});

// [MEDIUM 재발방지] 2026-09-19 코드리뷰 — ATR 가변손절 실전배선. stopLossPct가
// frontmatter 왕복(buildFrontmatter→parseFrontmatter)에서 문자열이 아니라 숫자로
// 정확히 복원되는지(0.04처럼 정수 아닌 값 포함) 직접 고정 — 산술 강제변환으로
// 조용히 통과하는 값이 아니라 실제 숫자여야 트레일링·3R 재시도 계산이 정확하다.
test('buildBreakoutPositionRecord: stopLossPct 왕복 — 숫자로 정확히 복원됨(0.04)', () => {
  const { content } = buildBreakoutPositionRecord({
    code: '005930', entryDate: '2026-09-13', entryPrice: 71000, quantity: 140,
    investedWon: 10_000_000, stopPrice: 68160, stopLossPct: 0.04, now,
  });
  const p = parseBreakoutPosition(content);
  assert.equal(p.stopLossPct, 0.04);
  assert.equal(typeof p.stopLossPct, 'number');
});

test('buildBreakoutPositionRecord: stopLossPct 생략 시 null(과거 레코드 하위호환)', () => {
  const { content } = buildBreakoutPositionRecord({
    code: '005930', entryDate: '2026-09-13', entryPrice: 71000, quantity: 140,
    investedWon: 10_000_000, stopPrice: 65320, now,
  });
  assert.equal(parseBreakoutPosition(content).stopLossPct, null);
});

test('buildBreakoutPositionRecord: profitOrderApplicable=false로 생성 가능(수량이 적어 부분익절 주문 자체가 불필요한 경우)', () => {
  const { content } = buildBreakoutPositionRecord({
    code: 'A', entryDate: '2026-09-13', entryPrice: 100, quantity: 1, investedWon: 100, stopPrice: 92,
    profitOrderApplicable: false, now,
  });
  assert.equal(parseBreakoutPosition(content).profitOrderApplicable, false);
});

test('updateBreakoutPositionRecord: 보호주문 발주 성공 반영 — 다른 필드는 보존', () => {
  const { content } = buildBreakoutPositionRecord({
    code: '005930', entryDate: '2026-09-13', entryPrice: 71000, investedWon: 10_000_000, stopPrice: 65320, now,
  });
  const updated = updateBreakoutPositionRecord(content, {
    protectionStatus: PROTECTION_STATUS.PROTECTED, stopOrderNo: '123', profitOrderNo: '124',
  });
  const p = parseBreakoutPosition(updated);
  assert.equal(p.protectionStatus, PROTECTION_STATUS.PROTECTED);
  assert.equal(p.stopOrderNo, '123');
  assert.equal(p.profitOrderNo, '124');
  assert.equal(p.entryPrice, 71000); // 보존 확인
});

test('updateBreakoutPositionRecord: 청산 반영', () => {
  const { content } = buildBreakoutPositionRecord({
    code: '005930', entryDate: '2026-09-13', entryPrice: 71000, investedWon: 10_000_000, stopPrice: 65320, now,
  });
  const updated = updateBreakoutPositionRecord(content, {
    status: '청산', exitDate: '2026-09-20', exitReason: '트레일링스탑',
  });
  const p = parseBreakoutPosition(updated);
  assert.equal(p.status, '청산');
  assert.equal(p.exitReason, '트레일링스탑');
});

test('findOpenPositions: 청산된 포지션은 제외', () => {
  const open = parseBreakoutPosition(buildBreakoutPositionRecord({
    code: 'A', entryDate: '2026-09-13', entryPrice: 100, investedWon: 1000, stopPrice: 92, now,
  }).content);
  const closedContent = updateBreakoutPositionRecord(
    buildBreakoutPositionRecord({ code: 'B', entryDate: '2026-09-01', entryPrice: 100, investedWon: 1000, stopPrice: 92, now }).content,
    { status: '청산' },
  );
  const closed = parseBreakoutPosition(closedContent);
  const positions = listBreakoutPositionsFromContents([]).concat([open, closed]);
  assert.deepEqual(findOpenPositions(positions).map((p) => p.code), ['A']);
});

test('findUnprotectedPositions: pending·failed은 포함, protected는 제외', () => {
  const pending = parseBreakoutPosition(buildBreakoutPositionRecord({
    code: 'A', entryDate: '2026-09-13', entryPrice: 100, investedWon: 1000, stopPrice: 92, now,
  }).content);
  const protectedContent = updateBreakoutPositionRecord(
    buildBreakoutPositionRecord({ code: 'B', entryDate: '2026-09-13', entryPrice: 100, investedWon: 1000, stopPrice: 92, now }).content,
    { protectionStatus: PROTECTION_STATUS.PROTECTED },
  );
  const failedContent = updateBreakoutPositionRecord(
    buildBreakoutPositionRecord({ code: 'C', entryDate: '2026-09-13', entryPrice: 100, investedWon: 1000, stopPrice: 92, now }).content,
    { protectionStatus: PROTECTION_STATUS.FAILED },
  );
  const positions = [pending, parseBreakoutPosition(protectedContent), parseBreakoutPosition(failedContent)];
  assert.deepEqual(findUnprotectedPositions(positions).map((p) => p.code).sort(), ['A', 'C']);
});
