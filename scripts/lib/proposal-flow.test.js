import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAndSendProposal, buildProposalMessageBody, buildProposalFacts, buildProposalStatusEditText } from './proposal-flow.mjs';
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

test('buildProposalFacts: 가격 있으면 사실 배열에 종목·수량·제안가·개산금액 순서로', () => {
  const facts = buildProposalFacts({ side: '매수', name: '삼성전자', assetKey: '005930', quantity: 10, proposedPrice: 70000 });
  assert.deepEqual(facts, ['매수 삼성전자(005930)', '수량 10주', '제안가 70,000원', '개산금액 ≈ 700,000원']);
});

test('buildProposalFacts: 가격 없으면(정액 리밸런싱 등) 제안가·개산금액 라인 생략', () => {
  const facts = buildProposalFacts({ side: '매도', name: '채권ETF', assetKey: '채권', quantity: 5 });
  assert.deepEqual(facts, ['매도 채권ETF(채권)', '수량 5주']);
});

test('buildProposalFacts: 수량 null(신규종목·가격 미확인)이면 amountWon으로 목표 배분액 표시 — quantity*price의 null→0 강제변환 버그 회귀 방지(2026-08-23)', () => {
  const facts = buildProposalFacts({ side: '매수', name: '미국달러ETF', assetKey: '미국달러ETF', quantity: null, proposedPrice: 10000, amountWon: 300000 });
  assert.deepEqual(facts, ['매수 미국달러ETF(미국달러ETF)', '제안가 10,000원', '목표 배분액 ≈ 300,000원(수량은 체결 시 확정)']);
  assert.ok(!facts.some((f) => f.startsWith('개산금액')), '개산금액 ≈ 0원처럼 quantity=null이 강제변환된 값이 나오면 안 됨');
});

test('buildProposalFacts: 수량 null이고 amountWon도 없으면 금액 관련 라인 전부 생략', () => {
  const facts = buildProposalFacts({ side: '매수', name: '미국달러ETF', assetKey: '미국달러ETF', quantity: null, proposedPrice: null });
  assert.deepEqual(facts, ['매수 미국달러ETF(미국달러ETF)']);
});

test('buildProposalMessageBody: 수량 null이어도 amountWon 있으면 목표 배분액 표시', () => {
  const body = buildProposalMessageBody({ side: '매수', name: '미국달러ETF', assetKey: '미국달러ETF', quantity: null, proposedPrice: null, amountWon: 300000, reason: '분산' });
  assert.equal(body, '매수 미국달러ETF(미국달러ETF) 약 300,000원어치(수량은 체결 시 확정)\n사유: 분산');
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

test('createAndSendProposal: proposalsBlocked=true면 blocked — 파일도 안 쓰고 발송도 안 함(단일활성제안 판정보다도 먼저 막힘)', async () => {
  const writer = mockWriter();
  const sender = mockSender();
  const result = await createAndSendProposal({
    track: '퀀트', assetKey: '005930', name: '삼성전자', side: '매수', quantity: 10, proposedPrice: 70000,
    reason: 'OCF/P 1위', departmentLabel: '카이로스',
    existingProposals: [], writeProposalFile: writer, sendMessage: sender,
    proposalsBlocked: true,
  });
  assert.equal(result.action, 'blocked');
  assert.match(result.reason, /제안금지/);
  assert.equal(writer.writes.length, 0);
  assert.equal(sender.calls.length, 0);
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

test('buildProposalStatusEditText: 승인 — 트랙에서 부서 라벨을 되짚고 [승인] 태그를 단다', () => {
  const proposal = fixture({ track: '퀀트' });
  const text = buildProposalStatusEditText({
    proposal: { ...proposal, status: '승인', decidedAt: '2026-08-23T01:30:00.000Z' },
    action: 'approve',
    decidedAt: '2026-08-23T01:30:00.000Z',
  });
  assert.match(text, /^\[승인\] \[퀀트전략실 Kairos\]/);
  assert.match(text, /매수 005930\(005930\)/);
  assert.match(text, /승인됨 \(2026-08-23 10:30 KST\)/); // UTC+9
  assert.match(text, /기존안건/); // 원래 사유(reason) 보존
});

test('buildProposalStatusEditText: 거부 — [거부] 태그 + 거부사유가 사유 뒤에 붙는다', () => {
  const proposal = fixture({ track: '자산분배' });
  const text = buildProposalStatusEditText({
    proposal: { ...proposal, status: '거부', decidedAt: '2026-08-23T01:30:00.000Z', rejectReason: '지금은 필요 없음' },
    action: 'reject',
    decidedAt: '2026-08-23T01:30:00.000Z',
  });
  assert.match(text, /^\[거부\] \[투자전략실 Athena\]/);
  assert.match(text, /거부됨 \(2026-08-23 10:30 KST\)/);
  assert.match(text, /거부 사유: 지금은 필요 없음/);
});

test('buildProposalStatusEditText: 매핑에 없는 track이면 raw 문자열로 폴백(throw 없이 계속 진행)', () => {
  const proposal = fixture({ track: '신규트랙' });
  const text = buildProposalStatusEditText({
    proposal: { ...proposal, status: '승인', decidedAt: '2026-08-23T01:30:00.000Z' },
    action: 'approve',
    decidedAt: '2026-08-23T01:30:00.000Z',
  });
  assert.match(text, /^\[승인\] \[신규트랙\]/);
});

test('buildProposalStatusEditText: decidedAt이 없거나 파싱 불가여도 throw하지 않고 안전 문구로 폴백', () => {
  const proposal = fixture({ track: '퀀트' });
  const text = buildProposalStatusEditText({ proposal: { ...proposal, status: '승인' }, action: 'approve', decidedAt: undefined });
  assert.match(text, /승인됨 \(\(시각 불명\) KST\)/);
});
