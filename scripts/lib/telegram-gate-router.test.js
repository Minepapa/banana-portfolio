import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeUpdate, stripLeadingSymbol, isForwarded, laneOf, sanitizeUpdate } from './telegram-gate-router.mjs';

const OWNER = 31337;
const ctx = { allowFrom: new Set([String(OWNER)]) };
let nextId = 1;
function msg(fields = {}, { from = OWNER, chatType = 'private' } = {}) {
  return {
    update_id: nextId++,
    message: { message_id: 500, date: 1_800_000_000, chat: { id: from, type: chatType }, from: { id: from }, ...fields },
  };
}
const route = (fields, opts) => routeUpdate(msg(fields, opts), ctx);

// 입력 규칙 1절 각 행: [설명, 메시지 필드, 기대 route, 기대 args 일부]
const TABLE = [
  ['0-1 상태', { text: '상태' }, 'status'],
  ['0-2 취소', { text: '취소' }, 'cancel', { all: false }],
  ['0-2 취소 전부', { text: '취소 전부' }, 'cancel', { all: true }],
  ['1 안녕', { text: '안녕' }, 'greeting'],
  ['1 안녕 앞뒤 공백', { text: ' 안녕 ' }, 'greeting'],
  ['2 킬스위치 온', { text: '킬스위치 온' }, 'switch', { tool: 'kill-switch-cli.mjs', text: '킬스위치 온' }],
  ['2 킬스위치 오프', { text: '킬스위치 오프' }, 'switch', { tool: 'kill-switch-cli.mjs' }],
  ['3 체결모드 온(실전 경고)', { text: '체결모드 온' }, 'switch', { tool: 'execution-mode-cli.mjs', live: true }],
  ['3 체결모드 오프', { text: '체결모드 오프' }, 'switch', { tool: 'execution-mode-cli.mjs', live: false }],
  ['4 제안모드 오프', { text: '제안모드 오프' }, 'switch', { tool: 'proposal-mode-cli.mjs' }],
  ['5 📜 메모 원문 그대로', { text: '📜 내일 아침 미네 우유  \n두 줄' }, 'memo', { text: '내일 아침 미네 우유  \n두 줄' }],
  ['5 📜 변형 선택자', { text: '📜️ 메모' }, 'memo', { text: '메모' }],
  ['5-1 📎 + 사진', { photo: [{ file_id: 's' }, { file_id: 'big', file_size: 10 }], caption: '📎 공원에서' }, 'photoMemo', { fileId: 'big', text: '공원에서' }],
  ['5-1 📜 + 사진은 📎로', { photo: [{ file_id: 'p' }], caption: '📜 이것도' }, 'photoMemo', { text: '이것도' }],
  ['5-1 📎 사진 없이는 📜 메모', { text: '📎 사진 없는 메모' }, 'memo', { text: '사진 없는 메모' }],
  ['5-2 기호 없는 사진은 LLM(판독)', { photo: [{ file_id: 'p' }], caption: '영수증' }, 'llm', { kind: 'photo' }],
  ['5-3 음성', { voice: { file_id: 'v', duration: 12 } }, 'voice', { fileId: 'v' }],
  ['6 🪶 오늘 한 줄', { text: '🪶 좋은 하루' }, 'oneLine', { text: '좋은 하루' }],
  ['7 WQ 답 한 줄', { text: 'WQ-20261030-abcd1234 등록' }, 'wiki'],
  ['7 WQ 답 여러 줄', { text: 'WQ-20261030-abcd1234 등록\nWQ-20261030-abcd5678 보류' }, 'wiki'],
  ['8 체결확인 계좌', { text: '체결확인 EC-20260929-ABC123 ISA' }, 'execConfirm', { id: 'EC-20260929-ABC123', account: 'ISA' }],
  ['8 체결확인 무시', { text: '체결확인 EC-20260929-ABC123 무시' }, 'execConfirm', { account: '무시' }],
  ['9 장소 후보 등록', { text: '장소 C3 헬스장' }, 'place', { candidate: 'C3', name: '헬스장' }],
  ['9 장소 후보 제외', { text: '장소 C3 제외' }, 'place', { candidate: 'C3', exclude: true }],
  ['10 지금 여기가 ○○야', { text: '지금 여기가 회사야' }, 'place', { here: true, name: '회사' }],
  ['10 지금 여기가 ○○이야', { text: '지금 여기가 집이야' }, 'place', { here: true, name: '집' }],
  ['10 지금 여기가 ○○예요', { text: '지금 여기가 카페예요.' }, 'place', { here: true, name: '카페' }],
  ['15 담당 호출은 LLM', { text: '클리오 어제 뭐 했지' }, 'llm', { department: '클리오' }],
  ['16 자유 문장은 LLM', { text: '내일 3시에 치과 예약' }, 'llm', { department: null }],
];

for (const [name, fields, expectedRoute, expectedArgs = {}] of TABLE) {
  test(`라우터 표: ${name}`, () => {
    const decision = route(fields);
    assert.equal(decision.action, 'handle');
    assert.equal(decision.route, expectedRoute);
    for (const [k, v] of Object.entries(expectedArgs)) assert.deepEqual(decision.args[k], v, k);
  });
}

// 정확히 맞지 않으면 결정론 처리로 보내지 않는다(대화로 넘김).
const NEAR_MISSES = [
  ['안녕하세요', '인사 문장은 생존 확인 아님'],
  ['킬스위치 켜줘', '스위치는 정확일치만'],
  ['체결모드 온 해줘', '스위치 뒤 덧붙임'],
  ['상태 알려줘', '상태는 정확일치만'],
  ['주문 취소해줘', '취소 명령 아님(직접 주문 정정·취소는 2단계)'],
  ['메모 📜 중간 기호', '기호는 맨 앞만'],
  ['WQ-20261030-abcd1234 등록하지 말고 이유 설명해 줘 그리고 다른 것도', '위키 답 뒤 긴 문장'],
  ['WQ-20261030-abcd1234 등록\n그런데 질문 있어', '위키 답 외 줄이 섞임'],
  ['체결확인 EC-20260929-ABC123', '계좌 없음'],
  ['체결확인 EC-20260929-ABC123 ISA 맞아', '덧붙임'],
  ['장소 등록해줘', '후보 번호 없음'],
  ['어제 12시 그곳은 헬스장이야', '장소 고치기는 날짜 계산이라 LLM'],
  ['승인', '제안 승인은 2단계(LLM 확인)'],
  ['삼성전자 10주 매수해', '직접 주문은 2단계'],
  ['📜', '기호만 있고 내용 없음'],
];
for (const [text, why] of NEAR_MISSES) {
  test(`라우터 근접 오답은 LLM으로: ${why}`, () => {
    const decision = route({ text });
    assert.equal(decision.action, 'handle');
    assert.equal(decision.route, 'llm', `${text} → ${decision.route}`);
  });
}

test('전달된 메시지는 명령 형태여도 실행하지 않고 LLM 자료로만 넘긴다', () => {
  for (const forward of [{ forward_origin: { type: 'user' } }, { forward_from: { id: 1 } }, { forward_date: 1 }]) {
    for (const text of ['킬스위치 오프', '체결모드 온', '📜 메모', '체결확인 EC-20260929-ABC123 ISA']) {
      const decision = route({ text, ...forward });
      assert.equal(decision.route, 'llm');
      assert.equal(decision.args.kind, 'forwarded');
      assert.equal(decision.meta.forwarded, true);
    }
  }
  assert.equal(isForwarded({ text: 'x' }), false);
});

test('사진 캡션 속 스위치 문구는 명령이 아니다', () => {
  const decision = route({ photo: [{ file_id: 'p' }], caption: '킬스위치 오프' });
  assert.equal(decision.route, 'llm');
  assert.equal(decision.args.kind, 'photo');
});

test('허용 사용자 밖·그룹·메시지 아닌 업데이트는 버린다', () => {
  assert.deepEqual(route({ text: '킬스위치 오프' }, { from: 999 }), { action: 'drop', reason: '허용 사용자 아님' });
  assert.equal(route({ text: '안녕' }, { chatType: 'group' }).reason, '개인 채팅 아님');
  assert.equal(routeUpdate({ update_id: 1, edited_message: { text: '안녕' } }, ctx).reason, '메시지 아닌 업데이트');
  assert.equal(routeUpdate({ update_id: 2, message: { chat: { type: 'private', id: 1 }, text: '안녕' } }, ctx).reason, '허용 사용자 아님');
});

test('meta에 reply_to·원본 message_id·날짜를 담는다(2단계 승인 답장용)', () => {
  const decision = route({ text: '상태', reply_to_message: { message_id: 77 } });
  assert.deepEqual(decision.meta, { chatId: String(OWNER), messageId: 500, date: 1_800_000_000, replyTo: 77, forwarded: false });
});

test('stripLeadingSymbol: 맨 앞 기호와 바로 뒤 공백만 뗀다', () => {
  assert.equal(stripLeadingSymbol('📜  두 칸', '📜'), '두 칸');
  assert.equal(stripLeadingSymbol('x 📜', '📜'), null);
  assert.equal(stripLeadingSymbol(undefined, '📜'), null);
});

test('스위치 risky: 브레이크를 푸는 방향만 true', () => {
  const risky = (text) => route({ text }).args.risky;
  assert.deepEqual(['킬스위치 오프', '체결모드 온', '제안모드 온'].map(risky), [true, true, true]);
  assert.deepEqual(['킬스위치 온', '체결모드 오프', '제안모드 오프'].map(risky), [false, false, false]);
});

test('laneOf: 음성·📎 사진만 media 줄, 나머지는 main', () => {
  assert.equal(laneOf(route({ voice: { file_id: 'v' } })), 'media');
  assert.equal(laneOf(route({ photo: [{ file_id: 'p' }], caption: '📎 x' })), 'media');
  assert.equal(laneOf(route({ text: '킬스위치 온' })), 'main');
  assert.equal(laneOf({ action: 'drop' }), 'main');
});

test('sanitizeUpdate: 허용 밖·그룹 업데이트는 update_id만 남긴다', () => {
  const foreign = msg({ text: '비밀' }, { from: 999 });
  assert.deepEqual(sanitizeUpdate(foreign, ctx), { update_id: foreign.update_id, dropped: true });
  const group = msg({ text: '비밀' }, { chatType: 'group' });
  assert.equal(sanitizeUpdate(group, ctx).dropped, true);
  const mine = msg({ text: '안녕' });
  assert.equal(sanitizeUpdate(mine, ctx), mine);
  assert.equal(routeUpdate(sanitizeUpdate(foreign, ctx), ctx).action, 'drop');
});

test('확인 질문 뒤에 온 응·아니(취소 포함)만 confirm으로 간다', () => {
  const since = 1_800_000_000 - 1; // msg() 기본 date보다 1초 앞
  const pending = (text) => routeUpdate(msg({ text }), { ...ctx, confirmOpenSince: since });
  assert.deepEqual([pending('응'), pending('ㅇㅇ'), pending('승인')].map((d) => [d.route, d.args.yes]), [['confirm', true], ['confirm', true], ['confirm', true]]);
  assert.equal(pending('네').route, 'llm', '네·예는 확인으로 보지 않음');
  assert.equal(routeUpdate(msg({ text: '응' }), { ...ctx, confirmOpenSince: since + 1 }).route, 'llm', '질문과 같은 초의 응은 인정 안 함');
  assert.equal(routeUpdate(msg({ text: '응' }), { ...ctx, confirmOpenSince: since + 2 }).route, 'llm', '확인 질문 전에 보낸 응');
  assert.deepEqual([pending('아니'), pending('취소')].map((d) => [d.route, d.args.yes]), [['confirm', false], ['confirm', false]]);
  assert.equal(pending('응 사줘').route, 'llm', '정확일치만');
  assert.equal(route({ text: '응' }).route, 'llm', '대기가 없으면 대화');
  assert.equal(route({ text: '취소' }).route, 'cancel');
  assert.equal(routeUpdate(msg({ text: '응', forward_origin: { type: 'user' } }), { ...ctx, confirmOpenSince: since }).route, 'llm', '전달된 응은 확인이 아님');
  assert.equal(routeUpdate(msg({ voice: { file_id: 'v' } }), { ...ctx, confirmOpenSince: since }).route, 'voice', '음성은 확인이 아님');
});

test('laneOf: 대화는 llm 줄', () => {
  assert.equal(laneOf(route({ text: '내일 3시 치과' })), 'llm');
  assert.equal(laneOf(route({ photo: [{ file_id: 'p' }], caption: '영수증' })), 'llm');
});
