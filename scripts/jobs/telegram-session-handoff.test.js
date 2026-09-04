import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kstDateStr, kstYesterdayStr, filterProposalsByCreatedDate, filterProposalsByDecidedDate,
  buildModeChangeNotes, buildHandoffText, hasTelegramSessionMarker, pickTelegramTranscriptPaths,
  filterLinesByKstDate, earliestTimestampMs,
  extractConversationTurns, truncateConversationText, buildConversationPrompt,
} from './telegram-session-handoff.mjs';

test('kstDateStr: UTC ISO를 KST 날짜로(자정 근처 날짜이월 확인)', () => {
  // 2026-08-23 15:30 UTC = 2026-08-24 00:30 KST(+9h) — 날짜가 넘어간다.
  assert.equal(kstDateStr('2026-08-23T15:30:00.000Z'), '2026-08-24');
  assert.equal(kstDateStr('2026-08-23T10:00:00.000Z'), '2026-08-23');
});

test('kstDateStr: 값이 없거나 파싱 불가면 null', () => {
  assert.equal(kstDateStr(null), null);
  assert.equal(kstDateStr('이상한값'), null);
});

test('kstYesterdayStr: KST 기준 어제 날짜(03:55 실행을 가정 — 새벽에도 정확히 전날)', () => {
  // 2026-08-29 03:55 KST = 2026-08-28 18:55 UTC
  const now = new Date('2026-08-28T18:55:00.000Z');
  assert.equal(kstYesterdayStr(now), '2026-08-28');
});

test('filterProposalsByCreatedDate·filterProposalsByDecidedDate: 대상일만 골라냄', () => {
  const proposals = [
    { id: 'a', createdAt: '2026-08-23T22:30:15.000Z', decidedAt: null },
    { id: 'b', createdAt: '2026-08-24T05:00:00.000Z', decidedAt: '2026-08-24T06:00:00.000Z' },
    { id: 'c', createdAt: '2026-08-23T10:00:00.000Z', decidedAt: '2026-08-23T23:59:59.000Z' },
  ];
  // a·c의 createdAt(KST)은 08-24(a는 UTC 22:30→KST 08-24 07:30)·08-23. c의 decidedAt은
  // UTC 23:59:59→KST 08-24 08:59:59.
  const createdOn0823 = filterProposalsByCreatedDate(proposals, '2026-08-23');
  assert.deepEqual(createdOn0823.map((p) => p.id), ['c']);
  const decidedOn0824 = filterProposalsByDecidedDate(proposals, '2026-08-24');
  assert.deepEqual(decidedOn0824.map((p) => p.id), ['b', 'c']);
});

test('buildModeChangeNotes: 대상일에 바뀐 모드만 서술, 없으면 빈 배열', () => {
  const modeStates = [
    { name: '킬스위치', state: { active: true, reason: '테스트', changedAt: '2026-08-23T12:00:00.000Z' } },
    { name: '체결모드', state: { mode: '실전', changedAt: '2026-08-20T00:00:00.000Z' } },
    { name: '제안모드', state: null },
  ];
  const notes = buildModeChangeNotes(modeStates, '2026-08-23');
  assert.deepEqual(notes, ['킬스위치: 발동 — 테스트']);
});

test('buildHandoffText: 생성·결정·대기·모드변경 전부 반영, 없으면 "없음"', () => {
  const text = buildHandoffText({
    targetDateStr: '2026-08-28',
    createdToday: [{ track: '자산분배', side: '매수', assetKey: '005930', status: '대기' }],
    decidedToday: [{ track: '자산분배', side: '매도', assetKey: '000660', status: '거부', rejectReason: '오너 일괄 거부' }],
    pendingCount: 5,
    modeNotes: ['제안모드: 금지 — Frank 명령: "제안금지"'],
  });
  assert.match(text, /2026-08-28 텔레그램 세션 인수인계/);
  assert.match(text, /매수 005930 — 대기/);
  assert.match(text, /매도 000660 — 거부\(오너 일괄 거부\)/);
  assert.match(text, /대기 중인 제안: 5건/);
  assert.match(text, /제안모드: 금지/);
});

test('buildHandoffText: 활동 없는 날은 "없음"으로 표시(항상 뭔가 읽을 게 있게)', () => {
  const text = buildHandoffText({ targetDateStr: '2026-08-28', createdToday: [], decidedToday: [], pendingCount: 0, modeNotes: [] });
  assert.match(text, /그날 생성된 제안 \(0건\)\n- 없음/);
  assert.match(text, /그날 결정된 제안 \(0건\)\n- 없음/);
  assert.doesNotMatch(text, /바뀐 모드/);
});

test('buildHandoffText: conversationSummary 있으면 섹션 추가, 없으면(undefined) 섹션 자체가 없음', () => {
  const withSummary = buildHandoffText({
    targetDateStr: '2026-08-28', createdToday: [], decidedToday: [], pendingCount: 0, modeNotes: [],
    conversationSummary: '오너가 리밸런싱 주기를 물었고 세션이 분기 1회로 답함.',
  });
  assert.match(withSummary, /## 오늘 나눈 대화 요약\(LLM 생성\)\n오너가 리밸런싱 주기를/);

  const withoutSummary = buildHandoffText({ targetDateStr: '2026-08-28', createdToday: [], decidedToday: [], pendingCount: 0, modeNotes: [] });
  assert.doesNotMatch(withoutSummary, /오늘 나눈 대화/);
});

test('hasTelegramSessionMarker: agent-name 레코드 있으면 true, 없으면 false', () => {
  assert.equal(hasTelegramSessionMarker('{"type":"agent-name","agentName":"판테온 텔레그램 가상세션","sessionId":"x"}'), true);
  assert.equal(hasTelegramSessionMarker('{"type":"user","message":{}}'), false);
  assert.equal(hasTelegramSessionMarker(''), false);
  assert.equal(hasTelegramSessionMarker(undefined), false);
});

test('[코드리뷰 HIGH 재설계] pickTelegramTranscriptPaths: 텔레그램 세션 마커 있는 파일 전부(mtime로 1개만 고르지 않음)', () => {
  const entries = [
    { path: '/a.jsonl', isTelegramSession: false },
    { path: '/b.jsonl', isTelegramSession: true },
    { path: '/c.jsonl', isTelegramSession: false },
    { path: '/d.jsonl', isTelegramSession: true },
  ];
  assert.deepEqual(pickTelegramTranscriptPaths(entries), ['/b.jsonl', '/d.jsonl']);
});

test('pickTelegramTranscriptPaths: 후보 없으면 빈 배열', () => {
  assert.deepEqual(pickTelegramTranscriptPaths([{ path: '/a.jsonl', isTelegramSession: false }]), []);
  assert.deepEqual(pickTelegramTranscriptPaths([]), []);
  assert.deepEqual(pickTelegramTranscriptPaths(undefined), []);
});

test('[실사고 재현] filterLinesByKstDate: mtime과 무관하게 라인 자신의 timestamp로 대상일만 골라냄', () => {
  // 실측 재현(2026-09-04) — 1ce6c31f 파일은 mtime이 그날 가장 최근이었지만 실제
  // 내용은 새벽 짧은 대화뿐이었다. timestamp 기반이면 이런 파일도 정확히 그 시간대
  // 만큼만 반영되고, mtime과 무관하게 여러 파일에서 같은 날짜 라인을 모을 수 있다.
  const lines = [
    { type: 'user', timestamp: '2026-09-03T10:00:00.000Z' }, // KST 09-03 19:00 — 전날(경계 밖)
    { type: 'user', timestamp: '2026-09-03T19:00:09.000Z' }, // KST 09-04 04:00 — 대상일 시작
    { type: 'assistant', timestamp: '2026-09-04T01:07:24.000Z' }, // KST 09-04 10:07 — 대상일
    { type: 'user', timestamp: '2026-09-04T15:00:00.000Z' }, // KST 09-05 00:00 — 다음날(경계 밖)
    { type: 'agent-name' }, // timestamp 없는 메타 레코드
  ];
  const filtered = filterLinesByKstDate(lines, '2026-09-04');
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0].timestamp, '2026-09-03T19:00:09.000Z');
  assert.equal(filtered[1].timestamp, '2026-09-04T01:07:24.000Z');
});

test('filterLinesByKstDate: targetDateStr 없으면 빈 배열(추정 안 함)', () => {
  assert.deepEqual(filterLinesByKstDate([{ timestamp: '2026-09-04T00:00:00.000Z' }], null), []);
  assert.deepEqual(filterLinesByKstDate([{ timestamp: '2026-09-04T00:00:00.000Z' }], undefined), []);
});

test('earliestTimestampMs: 가장 이른 timestamp(ms), timestamp 없는 라인은 무시', () => {
  const lines = [{ timestamp: '2026-09-04T05:00:00.000Z' }, { timestamp: '2026-09-04T01:00:00.000Z' }, { type: 'agent-name' }];
  assert.equal(earliestTimestampMs(lines), new Date('2026-09-04T01:00:00.000Z').getTime());
});

test('earliestTimestampMs: 빈 배열/전부 timestamp 없으면 Infinity(정렬 시 맨 뒤)', () => {
  assert.equal(earliestTimestampMs([]), Infinity);
  assert.equal(earliestTimestampMs([{ type: 'agent-name' }]), Infinity);
});

const CHANNEL_USER = (text) => ({
  type: 'user',
  message: { content: `<channel source="plugin:telegram:telegram" chat_id="1" message_id="1" user="1" user_id="1" ts="2026-09-04T00:00:00.000Z">\n${text}\n</channel>` },
});
const ASSISTANT_TEXT = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('[실사고 재현] extractConversationTurns: 실제 세션 transcript 형태(안녕→답변)에서 오너·세션 turn 추출', () => {
  const lines = [CHANNEL_USER('안녕'), ASSISTANT_TEXT('안녕하세요! 무엇을 도와드릴까요?')];
  const turns = extractConversationTurns(lines);
  assert.deepEqual(turns, [
    { role: 'owner', text: '안녕' },
    { role: 'session', text: '안녕하세요! 무엇을 도와드릴까요?' },
  ]);
});

test('extractConversationTurns: 채널 태그 없는 user 라인(도구 결과 등)은 대화로 안 침', () => {
  const lines = [{ type: 'user', message: { content: [{ type: 'tool_result', content: '결과' }] } }, ASSISTANT_TEXT('네')];
  const turns = extractConversationTurns(lines);
  assert.deepEqual(turns, [{ role: 'session', text: '네' }]);
});

test('extractConversationTurns: 부서 위임(Agent)은 맥락 보존용 요약 turn으로 담김', () => {
  const lines = [
    CHANNEL_USER('위탁계좌 최근 매도 종목?'),
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'hermes', description: '위탁계좌 최근 매도 종목 조회' } }] } },
  ];
  const turns = extractConversationTurns(lines);
  assert.equal(turns[1].text, '[부서 위임: hermes] 위탁계좌 최근 매도 종목 조회');
});

test('extractConversationTurns: 사이드체인 라인은 제외(위임된 서브에이전트가 채널 태그를 인용해도 오염 안 됨)', () => {
  const lines = [
    CHANNEL_USER('정상 메시지'),
    { ...CHANNEL_USER('사이드체인 인용'), isSidechain: true },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: '사이드체인 응답' }] } },
    ASSISTANT_TEXT('정상 응답'),
  ];
  const turns = extractConversationTurns(lines);
  assert.deepEqual(turns, [
    { role: 'owner', text: '정상 메시지' },
    { role: 'session', text: '정상 응답' },
  ]);
});

test('truncateConversationText: maxChars 이하면 그대로, 넘으면 뒷부분(최근)만 남김', () => {
  assert.equal(truncateConversationText('짧은 텍스트', 100), '짧은 텍스트');
  const long = 'x'.repeat(50).concat('끝부분');
  const truncated = truncateConversationText(long, 10);
  assert.match(truncated, /최근 10자만 포함/);
  assert.match(truncated, /끝부분$/);
});

test('buildConversationPrompt: 대상일·오너/세션 구분·요약지시가 프롬프트에 포함', () => {
  const prompt = buildConversationPrompt([{ role: 'owner', text: '안녕' }, { role: 'session', text: '네' }], '2026-09-04');
  assert.match(prompt, /2026-09-04/);
  assert.match(prompt, /\[오너\] 안녕/);
  assert.match(prompt, /\[세션\] 네/);
  assert.match(prompt, /요약하라/);
});
