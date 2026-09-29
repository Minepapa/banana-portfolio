import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExecutionConfirmation,
  buildExecutionFingerprint,
  executionConfirmationLockKey,
  findExactExecutionConfirmation,
  hasExecutionConfirmationForFirestoreDoc,
  findPendingConfirmationByFirestoreDoc,
  findPendingConfirmation,
  parseExecutionConfirmation,
  rejectExecutionConfirmation,
  refreshExecutionConfirmation,
  resolveExecutionConfirmation,
} from './execution-confirmation-queue.mjs';

const event = {
  broker: 'NH투자증권', tradeDate: '2026-09-29 09:27:53', tradeType: '매수',
  stockCode: '329200', stockName: 'TIGER 리츠부동산인프라', quantity: 10, price: 4037,
};

function createConfirmation() {
  return buildExecutionConfirmation({
    firestoreDocId: 'doc-1', event, allowedAccounts: ['ISA', '위탁'],
    reason: '계좌번호 없음', now: new Date('2026-09-29T00:00:00Z'), random: () => 'ABC123',
  });
}

test('buildExecutionConfirmation: 대기 레코드는 허용 계좌와 불변 지문을 보존한다', () => {
  const confirmation = createConfirmation();
  assert.equal(confirmation.record.id, 'EC-20260929-ABC123');
  assert.equal(confirmation.record.status, '대기');
  assert.deepEqual(confirmation.record.allowedAccounts, ['ISA', '위탁']);
  assert.equal(confirmation.record.receivedAt, event.tradeDate);
  assert.equal(confirmation.record.eventFingerprint, buildExecutionFingerprint({ firestoreDocId: 'doc-1', event }));
  assert.equal(confirmation.record.sourceBodyHash.length, 64);
  assert.equal(confirmation.record.acctNo, '');
});

test('parseExecutionConfirmation: 평평한 frontmatter의 계좌 배열을 복원한다', () => {
  const confirmation = createConfirmation();
  const parsed = parseExecutionConfirmation(confirmation.content);
  assert.deepEqual(parsed.allowedAccounts, ['ISA', '위탁']);
  assert.equal(parsed.firestoreDocId, 'doc-1');
});

test('resolveExecutionConfirmation: 허용 계좌 확인만 확인됨 상태로 전이한다', () => {
  const record = createConfirmation().record;
  const resolved = resolveExecutionConfirmation(record, 'ISA', new Date('2026-09-29T00:01:00Z'));
  assert.equal(resolved.status, '확인됨');
  assert.equal(resolved.decision, 'ISA');
  assert.throws(() => resolveExecutionConfirmation(record, '연금저축'), /허용 계좌/);
});

test('resolveExecutionConfirmation: 종결된 레코드는 중복 확인을 거부한다', () => {
  const record = { ...createConfirmation().record, status: '확인됨' };
  assert.throws(() => resolveExecutionConfirmation(record, 'ISA'), /대기 상태/);
});

test('rejectExecutionConfirmation: 무시는 원문을 지우지 않는 종결 상태로 전이한다', () => {
  const rejected = rejectExecutionConfirmation(createConfirmation().record, new Date('2026-09-29T00:01:00Z'));
  assert.equal(rejected.status, '기각');
  assert.equal(rejected.decision, '무시');
  assert.throws(() => rejectExecutionConfirmation(rejected), /대기 상태/);
});

test('findExactExecutionConfirmation: 무시한 동일 원문은 종결 레코드로 찾아 재알림을 막는다', () => {
  const rejected = rejectExecutionConfirmation(createConfirmation().record, new Date('2026-09-29T00:01:00Z'));
  const found = findExactExecutionConfirmation([rejected], { firestoreDocId: 'doc-1', event });
  assert.equal(found?.id, rejected.id);
  assert.equal(found?.status, '기각');
});

test('hasExecutionConfirmationForFirestoreDoc: 대기·기각·기록됨 모두 자동 처리 차단 근거다', () => {
  const record = createConfirmation().record;
  for (const status of ['대기', '기각', '기록됨']) {
    assert.equal(hasExecutionConfirmationForFirestoreDoc([{ ...record, status }], 'doc-1'), true);
  }
  assert.equal(hasExecutionConfirmationForFirestoreDoc([record], 'doc-2'), false);
});

test('findPendingConfirmation: 같은 Firestore 문서와 지문이 모두 일치할 때만 찾는다', () => {
  const current = createConfirmation().record;
  assert.equal(findPendingConfirmation([current], { firestoreDocId: 'doc-1', event }).id, current.id);
  assert.equal(findPendingConfirmation([current], { firestoreDocId: 'doc-2', event }), null);
});

test('refreshExecutionConfirmation: 같은 원문 문서가 바뀌면 ID를 유지하고 새 확인을 요구한다', () => {
  const prior = { ...createConfirmation().record, notifiedAt: '2026-09-29T00:01:00Z' };
  const changedEvent = { ...event, quantity: 11 };
  const refreshed = refreshExecutionConfirmation({
    record: prior, event: changedEvent, allowedAccounts: ['ISA', '위탁'], reason: '원문 내용 갱신',
    receivedAt: '2026-09-29 09:28:00', now: new Date('2026-09-29T00:02:00Z'),
  });
  assert.equal(refreshed.id, prior.id);
  assert.equal(refreshed.quantity, 11);
  assert.equal(refreshed.notifiedAt, null);
  assert.equal(findPendingConfirmationByFirestoreDoc([refreshed], 'doc-1').id, prior.id);
});

test('buildExecutionConfirmation: frontmatter에는 배열을 JSON 문자열 하나로만 저장한다', () => {
  const confirmation = createConfirmation();
  assert.match(confirmation.content, /^allowedAccountsJson: /m);
  assert.doesNotMatch(confirmation.content, /^allowedAccounts: /m);
});

test('executionConfirmationLockKey: Firestore ID를 파일 잠금에 안전한 공용 키로 정규화한다', () => {
  assert.equal(executionConfirmationLockKey('firestore/doc:1'), '.source-firestore_doc_1');
});
