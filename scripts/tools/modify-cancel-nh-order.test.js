import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findProposalByOrderNo, buildProposalUpdates } from './modify-cancel-nh-order.mjs';

test('findProposalByOrderNo: executionLog에 "주문번호 N"이 있는 제안 1건을 찾음', () => {
  const proposals = [
    { filename: 'a.md', executionLog: 'NH PLUG 실주문 접수 — 주문번호 847026(매도 TIGER 49주 @9455, KR_STOCK)' },
    { filename: 'b.md', executionLog: 'NH PLUG 실주문 접수 — 주문번호 111111(매수 삼성전자 1주 @75000, KR_STOCK)' },
  ];
  const found = findProposalByOrderNo(proposals, '847026');
  assert.equal(found.filename, 'a.md');
});

test('findProposalByOrderNo: 못 찾으면 null(추정 안 함)', () => {
  const proposals = [{ filename: 'a.md', executionLog: '주문번호 111111' }];
  assert.equal(findProposalByOrderNo(proposals, '999999'), null);
});

test('findProposalByOrderNo: 같은 번호가 2건 이상이면 null(추정 안 함)', () => {
  const proposals = [
    { filename: 'a.md', executionLog: '주문번호 847026' },
    { filename: 'b.md', executionLog: '정정 — 주문번호 847026' },
  ];
  assert.equal(findProposalByOrderNo(proposals, '847026'), null);
});

test('findProposalByOrderNo: executionLog가 없는(null/undefined) 제안은 매칭 안 됨(안 터짐)', () => {
  const proposals = [{ filename: 'a.md', executionLog: null }, { filename: 'b.md' }];
  assert.equal(findProposalByOrderNo(proposals, '847026'), null);
});

test('findProposalByOrderNo: 부분 문자열 오탐 방지 — "84702"로는 "847026"을 못 찾음(prefix 접두어 매칭 아님)', () => {
  const proposals = [{ filename: 'a.md', executionLog: '주문번호 847026' }];
  assert.equal(findProposalByOrderNo(proposals, '84702'), null);
});

test('findProposalByOrderNo: 왼쪽 경계 — "취소주문번호 847026"은 "주문번호 847026"과 다른 매칭으로 취급 안 됨(오탐 방지)', () => {
  // 이 CLI 자신이 취소 기록에 "취소주문번호 N"을 남기므로, 왼쪽 경계를 안 막으면
  // "주문번호 N"·"취소주문번호 N"을 가진 두 레코드가 둘 다 매칭돼(2건) null로
  // 빠져 조용히 갱신이 스킵된다(2026-09-21 독립 코드리뷰 LOW 지적).
  const proposals = [
    { filename: 'a.md', executionLog: 'NH PLUG 실주문 접수 — 주문번호 847026(매도)' },
    { filename: 'b.md', executionLog: '취소 — 취소주문번호 900001(2026-09-21)' },
  ];
  assert.equal(findProposalByOrderNo(proposals, '847026').filename, 'a.md');
  assert.equal(findProposalByOrderNo(proposals, '900001'), null);
});

test('buildProposalUpdates: 정정은 새 주문을 주문접수 상태로 기록 + executionLog 한 줄', () => {
  const proposal = { executionLog: 'NH PLUG 실주문 접수 — 주문번호 847026(매도 49주 @9455)' };
  const updates = buildProposalUpdates({
    action: '정정', proposal, newOrderNo: 900001, newPrice: 9450, now: '2026-09-21T00:00:00.000Z',
  });
  assert.equal(updates.proposedPrice, 9450);
  assert.equal(updates.status, '주문접수');
  assert.equal(updates.brokerOrderId, 900001);
  assert.equal(updates.submittedAt, '2026-09-21T00:00:00.000Z');
  assert.equal(updates.executedAt, null);
  assert.equal(updates.filledQuantity, null);
  assert.ok(!updates.executionLog.includes('\n'), 'executionLog에 개행이 있으면 안 됨(vault-frontmatter.mjs 왕복 파괴, HIGH 재발방지)');
  assert.equal(
    updates.executionLog,
    'NH PLUG 실주문 접수 — 주문번호 847026(매도 49주 @9455) | 정정 — 새 주문번호 900001, 새 가격 9450(2026-09-21T00:00:00.000Z)',
  );
});

test('buildProposalUpdates: 취소 — status/rejectReason 세팅 + executionLog 한 줄 유지', () => {
  const proposal = { executionLog: 'NH PLUG 실주문 접수 — 주문번호 847026(매도 49주 @9455)' };
  const updates = buildProposalUpdates({
    action: '취소', proposal, newOrderNo: 900002, newPrice: null, now: '2026-09-21T00:00:00.000Z',
  });
  assert.equal(updates.status, '취소');
  assert.equal(updates.brokerOrderId, 900002);
  assert.match(updates.rejectReason, /900002/);
  assert.ok(!updates.executionLog.includes('\n'));
});

test('buildProposalUpdates: executionLog가 빈 문자열이어도 안 터지고 구분자 없이 시작', () => {
  const updates = buildProposalUpdates({
    action: '정정', proposal: { executionLog: '' }, newOrderNo: 1, newPrice: 100, now: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(updates.executionLog, '정정 — 새 주문번호 1, 새 가격 100(2026-01-01T00:00:00.000Z)');
});
