import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAndSendProposal, buildProposalMessageBody, buildProposalFacts, buildProposalStatusEditText } from './proposal-flow.mjs';
import { buildProposalRecord, findActiveProposal, parseProposal } from './proposal-vault.mjs';

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
  assert.match(writer.writes[0].content, /status: "발송중"/);
  const last = writer.writes[writer.writes.length - 1];
  assert.equal(last.filename, result.filename);
  assert.match(last.content, /status: "대기"/);
  assert.match(last.content, /telegramMessageId: 12345/);
  // 발송 메시지에 부서라벨+본문 포함
  assert.match(sender.calls[0], /\[카이로스\]/);
  assert.match(sender.calls[0], /매수 삼성전자\(005930\)/);
});

// 전체 텍스트 스냅샷(2026-09-01 코드리뷰 지적, MEDIUM) — reason(부서 LLM 판단)이
// context로 들어가 [맥락] 아래 렌더되는 게 맞는지, [결론]·[의사결정]은 안 넘겼으니
// 안 붙는지 고정.
test('[막아야 함] createAndSendProposal: 발송 메시지 전체 텍스트 스냅샷 — reason은 [맥락] 아래, [결론]·[의사결정]은 안 붙음', async () => {
  const writer = mockWriter();
  const sender = mockSender({ message_id: 12345 });
  await createAndSendProposal({
    track: '퀀트', assetKey: '005930', name: '삼성전자', side: '매수', quantity: 10, proposedPrice: 70000,
    reason: 'OCF/P 1위', departmentLabel: '퀀트전략실 Kairos',
    existingProposals: [], writeProposalFile: writer, sendMessage: sender,
  });
  assert.equal(
    sender.calls[0],
    '[제안] [퀀트전략실 Kairos]\n\n[사실]\n· 매수 삼성전자(005930)\n\n· 수량 10주\n\n· 제안가 70,000원\n\n· 개산금액 ≈ 700,000원\n\n[맥락]\nOCF/P 1위',
  );
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

test('createAndSendProposal: 성공 결과의 원문 content를 재사용해 같은 실행의 후속 제안 대체도 기존 필드를 보존', async () => {
  const writer = mockWriter();
  const first = await createAndSendProposal({
    track: '자산분배', assetKey: 'TIGER 200', side: '매수', quantity: 1, proposedPrice: 40000,
    departmentLabel: '투자전략실 Athena', now: new Date('2026-09-24T00:00:00.000Z'), existingProposals: [], writeProposalFile: writer,
    sendMessage: mockSender({ message_id: 10 }),
  });
  const inMemoryProposal = { filename: first.filename, content: first.content, ...parseProposal(first.content) };
  const second = await createAndSendProposal({
    track: '자산분배', assetKey: 'TIGER 200', side: '매수', quantity: 2, proposedPrice: 41000,
    departmentLabel: '투자전략실 Athena', now: new Date('2026-09-24T00:00:01.000Z'), existingProposals: [inMemoryProposal], writeProposalFile: writer,
    sendMessage: mockSender({ message_id: 11 }),
  });

  const superseded = parseProposal(writer.writes.filter((write) => write.filename === first.filename).at(-1).content);
  assert.equal(first.action, 'created');
  assert.equal(second.supersededId, first.id);
  assert.equal(superseded.id, first.id);
  assert.equal(superseded.assetKey, 'TIGER 200');
  assert.equal(superseded.side, '매수');
  assert.equal(superseded.status, '대체됨');
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

test('createAndSendProposal: 발송 응답에 message_id가 없으면 활성 대기 상태로 남기지 않는다', async () => {
  const writer = mockWriter();
  const sender = mockSender({}); // message_id 없음
  const result = await createAndSendProposal({
    track: '퀀트', assetKey: '005930', side: '매수', quantity: 10, proposedPrice: 70000,
    departmentLabel: '카이로스',
    existingProposals: [], writeProposalFile: writer, sendMessage: sender,
  });
  assert.equal(result.telegramMessageId, null);
  assert.equal(result.action, 'failed');
  assert.equal(writer.writes.length, 2);
  assert.match(writer.writes.at(-1).content, /status: "발송오류"/);
});

test('[핵심 안전장치] createAndSendProposal: Telegram 성공 후 ID 저장 실패 시 비활성 발송오류로 격리하고 경고를 보낸다', async () => {
  const persisted = new Map();
  let writeCount = 0;
  const writer = async (filename, content) => {
    writeCount++;
    if (writeCount === 2) throw new Error('simulated write failure');
    persisted.set(filename, content);
  };
  const sender = mockSender({ message_id: 12345 });

  const result = await createAndSendProposal({
    track: '자산분배', assetKey: 'TIGER 200', name: 'TIGER 200', side: '매수', quantity: 1, proposedPrice: 40000,
    departmentLabel: '투자전략실 Athena', existingProposals: [], writeProposalFile: writer, sendMessage: sender,
  });

  const storedProposal = parseProposal(persisted.get(result.filename));
  assert.equal(result.action, 'failed');
  assert.equal(storedProposal.status, '발송오류');
  assert.equal(storedProposal.telegramMessageId, null);
  assert.equal(findActiveProposal([storedProposal], { track: '자산분배', assetKey: 'TIGER 200', side: '매수' }), null);
  assert.equal(sender.calls.length, 2);
  assert.match(sender.calls[1], /전송됐지만.*승인 연결정보/);
});

test('[핵심 안전장치] createAndSendProposal: 재제안 발송이 실패하면 기존 대기 제안은 계속 활성', async () => {
  const previous = fixture({ status: '대기' });
  const persisted = new Map([[previous.filename, previous.content]]);
  const writer = async (filename, content) => { persisted.set(filename, content); };
  let sendCount = 0;
  const sender = async () => {
    sendCount++;
    if (sendCount === 1) throw new Error('simulated network failure');
    return { message_id: 200 };
  };

  const result = await createAndSendProposal({
    track: '퀀트', assetKey: '005930', side: '매수', quantity: 20, proposedPrice: 71000,
    departmentLabel: '퀀트전략실 Kairos', existingProposals: [previous], writeProposalFile: writer, sendMessage: sender,
  });

  assert.equal(result.action, 'failed');
  assert.equal(parseProposal(persisted.get(previous.filename)).status, '대기');
  assert.equal(findActiveProposal([parseProposal(persisted.get(previous.filename))], { track: '퀀트', assetKey: '005930', side: '매수' }).id, previous.id);
  assert.equal(parseProposal(persisted.get(result.filename)).status, '발송오류');
  assert.equal(sendCount, 2); // 원 제안 실패 뒤 승인 불가 경고 발송 재시도
});

test('[핵심 안전장치] createAndSendProposal: 새 제안 ID 저장이 실패하면 대체한 기존 제안을 복구', async () => {
  const previous = fixture({ status: '대기' });
  const persisted = new Map([[previous.filename, previous.content]]);
  let writeCount = 0;
  const writer = async (filename, content) => {
    writeCount++;
    if (writeCount === 3) throw new Error('simulated new proposal write failure');
    persisted.set(filename, content);
  };
  const sender = mockSender({ message_id: 300 });

  const result = await createAndSendProposal({
    track: '퀀트', assetKey: '005930', side: '매수', quantity: 20, proposedPrice: 71000,
    departmentLabel: '퀀트전략실 Kairos', existingProposals: [previous], writeProposalFile: writer, sendMessage: sender,
  });

  const restored = parseProposal(persisted.get(previous.filename));
  assert.equal(result.action, 'failed');
  assert.equal(restored.status, '대기');
  assert.equal(findActiveProposal([restored], { track: '퀀트', assetKey: '005930', side: '매수' }).id, previous.id);
  assert.equal(parseProposal(persisted.get(result.filename)).status, '발송오류');
  assert.match(sender.calls[1], /저장하지 못했습니다/);
});

test('[핵심 안전장치] createAndSendProposal: 최초 발송중 파일 저장 실패는 Telegram을 발송하지 않고 경고', async () => {
  const persisted = new Map();
  let writeCount = 0;
  const writer = async (filename, content) => {
    writeCount++;
    if (writeCount === 1) throw new Error('simulated initial write failure');
    persisted.set(filename, content);
  };
  const sender = mockSender({ message_id: 400 });

  const result = await createAndSendProposal({
    track: '자산분배', assetKey: 'TIGER 200', side: '매수', quantity: 1, proposedPrice: 40000,
    departmentLabel: '투자전략실 Athena', existingProposals: [], writeProposalFile: writer, sendMessage: sender,
  });

  assert.equal(result.action, 'failed');
  assert.equal(sender.calls.length, 1); // 제안 본문이 아니라 경고만 발송
  assert.match(sender.calls[0], /제안 메시지는 발송하지 않았습니다/);
  assert.equal(parseProposal(persisted.get(result.filename)).status, '발송오류');
});

test('[핵심 안전장치] createAndSendProposal: 기존 제안 복구도 실패하면 경고에 수동 확인 필요를 명시', async () => {
  const previous = fixture({ status: '대기' });
  const persisted = new Map([[previous.filename, previous.content]]);
  let writeCount = 0;
  const writer = async (filename, content) => {
    writeCount++;
    if (writeCount === 3 || writeCount === 4) throw new Error(`simulated write failure ${writeCount}`);
    persisted.set(filename, content);
  };
  const sender = mockSender({ message_id: 500 });

  const result = await createAndSendProposal({
    track: '퀀트', assetKey: '005930', side: '매수', quantity: 20, proposedPrice: 71000,
    departmentLabel: '퀀트전략실 Kairos', existingProposals: [previous], writeProposalFile: writer, sendMessage: sender,
  });

  assert.equal(result.action, 'failed');
  assert.equal(parseProposal(persisted.get(previous.filename)).status, '대체됨');
  assert.match(sender.calls[1], /상태 복구도 실패했습니다/);
  assert.match(sender.calls[1], new RegExp(previous.id));
  assert.equal(parseProposal(persisted.get(result.filename)).status, '발송오류');
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

// 전체 텍스트 스냅샷(2026-09-01 코드리뷰 지적, MEDIUM) — 위 느슨한 regex 조합만으로는
// decidedLine이 어느 섹션([사실] vs [맥락]) 아래 렌더되는지 못 잡는다(실제로 그게
// 4단 구조 개정 때 처음엔 [맥락] 아래 잘못 렌더됐었는데도 위 테스트들은 계속 통과했음).
// decidedLine은 Node가 계산한 사실이라 [사실] 아래(불릿)에 있어야 하고, reason(부서
// LLM의 원래 판단 서술)만 [맥락] 아래 있어야 한다 — 전체 문자열을 고정해 그 배치가
// 조용히 다시 틀어지는 걸 막는다.
test('[막아야 함] buildProposalStatusEditText: 전체 텍스트 스냅샷 — decidedLine은 [사실] 아래(Node 사실), reason만 [맥락] 아래(LLM 근거)', () => {
  const proposal = fixture({ track: '퀀트' });
  const text = buildProposalStatusEditText({
    proposal: { ...proposal, status: '승인', decidedAt: '2026-08-23T01:30:00.000Z' },
    action: 'approve',
    decidedAt: '2026-08-23T01:30:00.000Z',
  });
  assert.equal(
    text,
    '[승인] [퀀트전략실 Kairos]\n\n[사실]\n· 매수 005930(005930)\n\n· 수량 10주\n\n· 제안가 70,000원\n\n· 개산금액 ≈ 700,000원\n\n· 승인됨 (2026-08-23 10:30 KST)\n\n[맥락]\n기존안건',
  );
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
