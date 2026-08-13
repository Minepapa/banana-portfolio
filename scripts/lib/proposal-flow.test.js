import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAndSendProposal, buildProposalMessageBody } from './proposal-flow.mjs';
import { buildProposalRecord, parseProposal } from './proposal-vault.mjs';

// existingProposals 로더 출력을 흉내(process-telegram-reply.mjs loadProposals와 동일 형태:
// {filename, content, ...parseProposal()}) — buildProposalRecord로 실제와 같은 content를
// 만들고 그 위에 상태만 덮어써서 테스트 픽스처를 구성한다.
function fixture({ track = '퀀트', assetKey = '005930', side = '매수', status = '대기', decidedAt = null, createdAt } = {}) {
  const { filename, content, id } = buildProposalRecord({
    track, assetKey, side, quantity: 10, proposedPrice: 70000, reason: '기존안건',
    now: createdAt ? new Date(createdAt) : new Date('2026-08-01T00:00:00.000Z'),
  });
  const updated = content
    .replace(/^status: .*$/m, `status: ${status}`)
    + (decidedAt ? '' : '');
  const withDecided = decidedAt ? updated.replace(/^decidedAt: .*$/m, `decidedAt: ${decidedAt}`) : updated;
  return { filename, content: withDecided, id, ...parseProposal(withDecided) };
}

function mockWriter() {
  const writes = [];
  const fn = async (filename, content) => { writes.push({ filename, content }); };
  fn.writes = writes;
  return fn;
}

function mockSender(result = { message_id: 999 }) {
  const calls = [];
  const fn = async (text) => { calls.push(text); return result; };
  fn.calls = calls;
  return fn;
}

test('buildProposalMessageBody: 가격 있으면 수량·단가·개산금액 + 사유', () => {
  const body = buildProposalMessageBody({ side: '매수', name: '삼성전자', assetKey: '005930', quantity: 10, proposedPrice: 70000, reason: 'OCF/P 1위' });
  assert.equal(body, '매수 삼성전자(005930) 10주 @70,000원 ≈ 700,000원\n사유: OCF/P 1위');
});

test('buildProposalMessageBody: 가격 없으면(정액 리밸런싱 등) 개산금액 생략, 사유 없으면 사유줄 생략', () => {
  const body = buildProposalMessageBody({ side: '매도', name: '채권ETF', assetKey: '채권', quantity: 5 });
  assert.equal(body, '매도 채권ETF(채권) 5주');
});

test('createAndSendProposal: 신규 생성 — 파일 쓰고 텔레그램 발송 후 telegramMessageId까지 갱신', async () => {
  const writer = mockWriter();
  const sender = mockSender({ message_id: 12345 });
  const result = await createAndSendProposal({
    track: '퀀트', assetKey: '005930', name: '삼성전자', side: '매수', quantity: 10, proposedPrice: 70000,
    reason: 'OCF/P 1위', departmentLabel: '카이로스',
    existingProposals: [], writeProposalFile: writer, sendMessage: sender,
  });
  assert.equal(result.action, 'created');
  assert.equal(result.telegramMessageId, 12345);
  assert.equal(result.supersededId, null);
  // 파일이 최소 2번 쓰임(최초 생성 + telegramMessageId 갱신), 마지막 내용에 반영돼 있어야 함
  assert.ok(writer.writes.length >= 2);
  const last = writer.writes[writer.writes.length - 1];
  assert.equal(last.filename, result.filename);
  assert.match(last.content, /telegramMessageId: 12345/);
  // 발송 메시지에 부서라벨+본문 포함
  assert.match(sender.calls[0], /\[카이로스\]/);
  assert.match(sender.calls[0], /매수 삼성전자\(005930\)/);
});

test('createAndSendProposal: 거부 재상정 쿨다운이면 blocked — 파일도 안 쓰고 발송도 안 함', async () => {
  const recentlyRejected = fixture({ status: '거부', decidedAt: new Date().toISOString() });
  const writer = mockWriter();
  const sender = mockSender();
  const result = await createAndSendProposal({
    track: '퀀트', assetKey: '005930', side: '매수', quantity: 10, proposedPrice: 70000,
    departmentLabel: '카이로스',
    existingProposals: [recentlyRejected], writeProposalFile: writer, sendMessage: sender,
  });
  assert.equal(result.action, 'blocked');
  assert.equal(writer.writes.length, 0);
  assert.equal(sender.calls.length, 0);
});

test('createAndSendProposal: 같은 안건에 대기 중 제안이 있으면 대체(supersede) — 기존 제안도 갱신됨', async () => {
  const pending = fixture({ status: '대기' });
  const writer = mockWriter();
  const sender = mockSender({ message_id: 1 });
  const result = await createAndSendProposal({
    track: '퀀트', assetKey: '005930', side: '매수', quantity: 20, proposedPrice: 71000,
    departmentLabel: '카이로스',
    existingProposals: [pending], writeProposalFile: writer, sendMessage: sender,
  });
  assert.equal(result.action, 'created');
  assert.equal(result.supersededId, pending.id);
  const oldWrite = writer.writes.find((w) => w.filename === pending.filename);
  assert.ok(oldWrite);
  assert.match(oldWrite.content, /status: "대체됨"/);
  assert.match(oldWrite.content, new RegExp(`supersededBy: "${result.id}"`));
});

test('[막아야 함] createAndSendProposal: 같은 안건이 "승인"(검문소에 막혀 미체결) 상태여도 대체(supersede) — 승인 두 건 동시존재 방지', async () => {
  const blockedApproved = fixture({ status: '승인', decidedAt: '2026-08-01T01:00:00.000Z' });
  const writer = mockWriter();
  const sender = mockSender({ message_id: 2 });
  const result = await createAndSendProposal({
    track: '퀀트', assetKey: '005930', side: '매수', quantity: 20, proposedPrice: 71000,
    departmentLabel: '카이로스',
    existingProposals: [blockedApproved], writeProposalFile: writer, sendMessage: sender,
  });
  assert.equal(result.action, 'created');
  assert.equal(result.supersededId, blockedApproved.id);
  const oldWrite = writer.writes.find((w) => w.filename === blockedApproved.filename);
  assert.ok(oldWrite);
  assert.match(oldWrite.content, /status: "대체됨"/);
});

test('createAndSendProposal: 발송 응답에 message_id가 없으면 telegramMessageId는 null, 두 번째 쓰기 없음', async () => {
  const writer = mockWriter();
  const sender = mockSender({}); // message_id 없음
  const result = await createAndSendProposal({
    track: '퀀트', assetKey: '005930', side: '매수', quantity: 10, proposedPrice: 70000,
    departmentLabel: '카이로스',
    existingProposals: [], writeProposalFile: writer, sendMessage: sender,
  });
  assert.equal(result.telegramMessageId, null);
  assert.equal(writer.writes.length, 1); // 최초 생성 1회만 — 갱신 재쓰기 없음
});
