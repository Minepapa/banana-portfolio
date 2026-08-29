import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kstDateStr, kstYesterdayStr, filterProposalsByCreatedDate, filterProposalsByDecidedDate,
  buildModeChangeNotes, buildHandoffText,
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
