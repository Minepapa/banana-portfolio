import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectOrderProposalOnce, validateDirectOrderRequestId } from './direct-order-request.mjs';
import { buildProposalRecord, parseProposal, updateProposalRecord } from './proposal-vault.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'direct-order-request-'));
}

function fileStore(dir) {
  const loadProposals = () => readdirSync(dir).filter((f) => f.endsWith('.md')).map((filename) => {
    const content = readFileSync(join(dir, filename), 'utf8');
    return { filename, content, ...parseProposal(content) };
  });
  const createProposal = () => buildProposalRecord({
    track: '자산분배', account: '위탁', assetKey: '삼성전자', side: '매수', quantity: 1,
    proposedPrice: 70000, now: new Date('2026-09-24T00:00:00.000Z'),
  });
  const writeProposal = async (filename, content) => writeFileSync(join(dir, filename), content);
  return { loadProposals, createProposal, writeProposal };
}

test('validateDirectOrderRequestId: 실제 chat/message ID 형식만 허용하고 nonce·빈 값·경로문자는 거부', () => {
  assert.equal(validateDirectOrderRequestId('telegram:12345:18416600'), 'telegram:12345:18416600');
  assert.equal(validateDirectOrderRequestId('telegram:-10012345:18416600'), 'telegram:-10012345:18416600');
  assert.equal(validateDirectOrderRequestId('request_01HXYZ-42'), null, '새 nonce로 중복검사를 우회할 수 없어야 함');
  assert.equal(validateDirectOrderRequestId('telegram:18416600'), null, 'chat_id 누락 거부');
  assert.equal(validateDirectOrderRequestId(''), null);
  assert.equal(validateDirectOrderRequestId('../other'), null);
});

test('createDirectOrderProposalOnce: 같은 원본 요청 ID의 동시 호출은 하나만 제안을 생성한다', async () => {
  const dir = tempDir();
  const store = fileStore(dir);
  try {
    const call = () => createDirectOrderProposalOnce({
      requestId: 'telegram:12345:18416600', proposalsDir: dir, ...store,
      findActive: () => null,
    });
    const results = await Promise.all([call(), call()]);

    assert.equal(results.filter((r) => r.action === 'created').length, 1);
    assert.equal(results.filter((r) => r.action === 'duplicate-request').length, 1);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.md')).length, 1);
    assert.equal(store.loadProposals()[0].directOrderRequestId, 'telegram:12345:18416600');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createDirectOrderProposalOnce: 체결 완료 뒤 같은 요청 ID 재시도도 차단한다', async () => {
  const dir = tempDir();
  const store = fileStore(dir);
  try {
    const args = { requestId: 'telegram:12345:18416601', proposalsDir: dir, ...store, findActive: () => null };
    const first = await createDirectOrderProposalOnce(args);
    const path = join(dir, first.proposal.filename);
    const proposal = store.loadProposals()[0];
    writeFileSync(path, updateProposalRecord(proposal.content, { status: '체결' }));

    const retry = await createDirectOrderProposalOnce(args);
    assert.equal(retry.action, 'duplicate-request');
    assert.equal(retry.proposal.id, first.proposal.id);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.md')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createDirectOrderProposalOnce: 새 요청 ID는 기존 활성 안건을 중복 생성하지 않는다', async () => {
  const dir = tempDir();
  const store = fileStore(dir);
  try {
    const active = await createDirectOrderProposalOnce({
      requestId: 'telegram:12345:18416602', proposalsDir: dir, ...store, findActive: () => null,
    });
    const second = await createDirectOrderProposalOnce({
      requestId: 'telegram:12345:18416603', proposalsDir: dir, ...store,
      findActive: (proposals) => proposals.find((p) => p.id === active.proposal.id),
    });
    assert.equal(second.action, 'active-proposal');
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.md')).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createDirectOrderProposalOnce: 오래된 락도 시간만으로 탈취하지 않고 생성은 실패로 닫음', async () => {
  const dir = tempDir();
  const store = fileStore(dir);
  const lockFile = join(dir, '.direct-order-request.lock');
  try {
    writeFileSync(lockFile, '999999');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile, old, old);
    await assert.rejects(createDirectOrderProposalOnce({
      requestId: 'telegram:12345:18416604', proposalsDir: dir, ...store, findActive: () => null,
    }), /락 획득 실패/);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.md')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
