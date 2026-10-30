import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHandoffNote, conversationTranscript, createJournal, handoffNoteRelPath, openItems, promiseItems } from './telegram-gate-journal.mjs';
import { businessDay } from './telegram-gate-session.mjs';

const ENTRIES = [
  { type: 'in', text: '삼성전자 10주 사줘' },
  { type: 'tool', name: 'mcp__gate__order_stage' },
  { type: 'out', agent: 'zeus', text: '확인 질문을 보냈습니다' },
  { type: 'confirm', id: 'CF-1', status: '대기', summary: '삼성전자 10주 매수(현재가 지정가)' },
  { type: 'confirm', id: 'CF-2', status: '대기', summary: '하이닉스 1주 매수' },
  { type: 'confirm', id: 'CF-2', status: '거절', summary: '하이닉스 1주 매수' },
  { type: 'llm', status: '시간 초과', input: '주간 리포트 다시 정리해줘' },
  { type: 'det', route: 'execConfirm', status: '실패', detail: '대기 건 없음' },
  { type: 'det', route: 'memo', status: '완료', detail: '기록함' },
  { type: 'promise', text: '내일 아침 브리핑에 반영', due: '2026-10-31' },
];

test('진행 중인 일: 아직 대기인 확인·실패·시간 초과만(거절된 확인은 뺀다)', () => {
  assert.deepEqual(openItems(ENTRIES), [
    '대화 시간 초과: "주간 리포트 다시 정리해줘"',
    '처리 실패: execConfirm — 대기 건 없음',
    '확인 대기: 삼성전자 10주 매수(현재가 지정가) — 접수 안 됨',
  ]);
  assert.deepEqual(promiseItems(ENTRIES), ['내일 아침 브리핑에 반영 (기한 2026-10-31)']);
});

test('인수인계 노트: 네 칸 고정, 요약 실패해도 앞의 두 칸은 남는다', () => {
  const now = new Date('2026-10-30T19:01:00Z');
  const ok = buildHandoffNote({ day: '2026-10-30', entries: ENTRIES, summary: { decisions: ['"삼성 10주 사줘" — 직접 매수 지시'], summary: ['미결: 삼성 매수 확인 대기'] }, now });
  const order = ['■ 진행 중인 일', '■ 약속', '■ 오너 결정·지시', '■ 대화 요약'].map((h) => ok.body.indexOf(h));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), '네 칸이 순서대로');
  assert.match(ok.body, /확인 대기: 삼성전자 10주/);
  assert.match(ok.body, /직접 매수 지시/);
  assert.match(ok.content, /^---\ntype: "telegram-log"/);
  const failed = buildHandoffNote({ day: '2026-10-30', entries: ENTRIES, summary: null, summaryError: '사용량 한도', now });
  assert.match(failed.body, /확인 대기: 삼성전자 10주/);
  assert.match(failed.body, /요약 실패: 사용량 한도/);
  assert.equal(handoffNoteRelPath('/v/log', '2026-10-30'), '/v/log/2026/2026-10-30 텔레그램 세션 인수인계.md');
});

test('요약용 원문: 오너 입력·답·결정론 처리만, 길면 뒤쪽', () => {
  const t = conversationTranscript(ENTRIES);
  assert.match(t, /^오너: 삼성전자 10주 사줘/);
  assert.match(t, /관문\(zeus\): 확인 질문을 보냈습니다/);
  assert.doesNotMatch(t, /order_stage/);
  assert.match(conversationTranscript([{ type: 'in', text: 'x'.repeat(100) }], 20), /^…\(앞부분 생략\)/);
});

test('기록: 업무일 파일에 덧붙이고 읽는다(04:00 경계)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-journal-'));
  try {
    let clock = new Date('2026-10-30T18:59:00Z');
    const journal = createJournal({ stateDir: dir, now: () => clock, dayOf: businessDay });
    journal.append({ type: 'in', text: '새벽 3시 59분' });
    clock = new Date('2026-10-30T19:00:00Z');
    journal.append({ type: 'in', text: '새벽 4시' });
    assert.deepEqual(journal.read('2026-10-30').map((e) => e.text), ['새벽 3시 59분']);
    assert.deepEqual(journal.read('2026-10-31').map((e) => e.text), ['새벽 4시']);
    assert.deepEqual(journal.read('2026-11-01'), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('인수인계 약속 칸은 약속 대기열(대기 중)을 쓴다', () => {
  const note = buildHandoffNote({ day: '2026-10-30', entries: [], summary: { decisions: [], summary: [] }, now: new Date(),
    pendingPromises: [{ id: 'P-20261030-abcdef', text: '밤 전사 끝나면 알려줘', condition: 'media-audio 잡이 성공하면', expiresAt: '2026-11-06T05:00:00Z' }] });
  assert.match(note.body, /■ 약속\n\n- P-20261030-abcdef: 밤 전사 끝나면 알려줘 \(media-audio 잡이 성공하면, 기한 2026-11-06\)/);
});
