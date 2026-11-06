import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATE_KEYWORD_TABLE, keywordTarget } from './telegram-gate-keywords.mjs';
import { AGENT_IDS } from './agent-registry.mjs';
import { routeTarget } from './telegram-gate-conversation.mjs';

test('낱말 표: 등록된 담당만, 제우스 낱말 없음, 담당끼리 같은 낱말 없음, 낱말은 공백 아님', () => {
  for (const agent of Object.keys(GATE_KEYWORD_TABLE)) assert.ok(AGENT_IDS.includes(agent) && agent !== 'zeus', agent);
  const seen = new Map();
  for (const [agent, words] of Object.entries(GATE_KEYWORD_TABLE)) {
    for (const w of words) {
      assert.ok(w.trim(), agent);
      assert.equal(seen.get(w) ?? agent, agent, `중복 낱말 ${w}`);
      seen.set(w, agent);
    }
  }
});

test('낱말 라우팅: 한 담당 낱말만이면 그 담당(11-06 시험 질문 포함)', () => {
  for (const [text, agent] of [
    ['미네가 최근에 좋아하게 된 노래가 뭐지?', 'athena'],
    ['11월 14일 가족 중 일정이 등록된 사람이 누구야?', 'hermes'],
    ['내가 최근 언제 미용실을 방문했지?', 'hermes'],
    ['내가 오늘 출근한 동선 어떻게 되지?', 'hermes'],
    ['IRP TDF10주, ISA TIME 10주 모두 실제 체결일이 오늘이야. IRP 예수금은 대금이 빠져나가는', 'plutus'],
    ['오늘 체결 안 된 주문 있어?', 'plutus'],
  ]) assert.equal(keywordTarget(text), agent, text);
});

test('낱말 라우팅: 섞이면·판단이면·낱말이 없으면 제우스', () => {
  for (const text of [
    '미네 이번 주말 일정 알려줘', // 아테나+헤르메스
    '내일 미네랑 어떤 걸 하고 놀면 좋을까?', // 판단
    '다음 미용실은 언제 방문하면 좋겠어?', // 판단
    '리밸런싱 해도 될까?', // 판단
    '내일 공원 산책을 간다면 옷을 어떻게 입으면 좋을까?',
    '안녕하세요 오늘 기분 어때',
    '예수금 늘리려면 소비를 줄여야 하나', // 플루토스+헤르메스
    '',
  ]) assert.equal(keywordTarget(text), null, text);
});

test('routeTarget: 오너 글만 낱말 표를 본다(사진·전달·여러 건·담당 프로세스 없음은 제외)', () => {
  const deps = ['clio', 'themis', 'hermes', 'athena', 'plutus'];
  const it = (args) => ({ meta: {}, args });
  assert.equal(routeTarget([it({ kind: 'text', text: '미용실 언제 갔지' })], deps), 'hermes');
  assert.equal(routeTarget([it({ kind: 'forwarded', text: '미용실 언제 갔지' })], deps), 'zeus');
  assert.equal(routeTarget([it({ kind: 'text', text: '미용실' }), it({ kind: 'text', text: '체결' })], deps), 'zeus');
  assert.equal(routeTarget([it({ kind: 'text', text: '미용실 언제 갔지' })], []), 'zeus');
  assert.equal(routeTarget([it({ kind: 'text', text: '체결 알려줘', department: '아테나' })], deps), 'athena', '이름으로 부르면 그 담당');
});
