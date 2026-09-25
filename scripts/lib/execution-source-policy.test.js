import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKakaoExecution } from './execution-source-policy.mjs';
import { buildApiCoveredExecutionArchive } from '../jobs/parse-notifications-to-vault.mjs';

test('NH API가 조회하는 위탁 국내주식과 금현물은 카카오 체결을 장부에 기록하지 않는다', () => {
  assert.deepEqual(classifyKakaoExecution({
    kind: 'stock',
    event: { broker: 'NH투자증권', acctNo: '205-01-59***9' },
  }), { action: 'exclude-api', account: '위탁', reason: 'NH_API' });
  assert.deepEqual(classifyKakaoExecution({ kind: 'gold', event: { broker: 'NH투자증권' } }), {
    action: 'exclude-api', account: '금현물', reason: 'NH_API',
  });
});

test('실측상 체결 API가 동작하지 않는 IRP는 카카오를 유지하고, KIS API가 작동하는 퀀트만 제외한다', () => {
  assert.deepEqual(classifyKakaoExecution({
    kind: 'stock', event: { broker: '한국투자증권', acctNo: '43****82-29' },
  }), { action: 'record', account: 'IRP', reason: 'API_UNAVAILABLE' });
  assert.equal(classifyKakaoExecution({
    kind: 'stock', event: { broker: '한국투자증권', acctNo: '46****07-01' },
  }).action, 'exclude-api');
});

test('API 체결조회가 없는 ISA·연금저축·위탁 해외주식은 카카오 체결을 유지한다', () => {
  assert.deepEqual(classifyKakaoExecution({
    kind: 'stock', event: { broker: 'NH투자증권', acctNo: '209-02-89***2' },
  }), { action: 'record', account: 'ISA', reason: 'API_UNAVAILABLE' });
  assert.deepEqual(classifyKakaoExecution({
    kind: 'stock', event: { broker: '삼성증권', acctNo: '' },
  }), { action: 'record', account: '연금저축', reason: 'API_UNAVAILABLE' });
  assert.deepEqual(classifyKakaoExecution({
    kind: 'stock', event: { broker: 'NH투자증권 해외', acctNo: '' },
  }), { action: 'record', account: null, reason: 'API_UNAVAILABLE' });
});

test('NH 국내주식 계좌를 판별할 수 없으면 중복 기록도 원문 삭제도 하지 않도록 보류한다', () => {
  assert.deepEqual(classifyKakaoExecution({
    kind: 'stock', event: { broker: 'NH투자증권', acctNo: '' },
  }), { action: 'unresolved', account: null, reason: 'ACCOUNT_UNKNOWN' });
});

test('금 g 체결도 NH 발신 근거가 없으면 API 대상으로 제외하지 않는다', () => {
  assert.deepEqual(classifyKakaoExecution({ kind: 'gold', event: { broker: '다른증권' } }), {
    action: 'unresolved', account: null, reason: 'ACCOUNT_UNKNOWN',
  });
});

test('API 정본으로 제외한 카카오 원문은 삭제 전에 비원장 보관 파일로 만든다', () => {
  const archive = buildApiCoveredExecutionArchive({
    id: 'firestore/doc:1', ts: '2026-09-25 09:10:00', body: '원문 체결 알림',
    event: { broker: 'NH투자증권', orderNo: '847026', stockName: '삼성전자' }, account: '위탁',
  });
  assert.match(archive.filepath, /RawNotifications\/ExecutionApiCovered/);
  assert.match(archive.filepath, /firestore_doc_1\.md$/);
  assert.match(archive.content, /원문 체결 알림/);
  assert.match(archive.content, /orderNo: "847026"/);
});
