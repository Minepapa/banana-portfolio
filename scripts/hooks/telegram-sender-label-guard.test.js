import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSenderLabel, VALID_SENDER_LABELS } from './telegram-sender-label-guard.mjs';

// [핵심 안전장치] 2026-09-19 — zeus.md "발신자 라벨" 규칙(2026-09-14 재지적으로
// 강화됐는데도 2026-09-19 세션에서 실제로 라벨 없는 reply 2건이 발송된 사고 재발
// 방지). 이 훅이 실제로 막을 수 있는지는 hasSenderLabel의 판정 정확도에 달려있다.
test('hasSenderLabel: "[제우스] "로 시작하면 true', () => {
  assert.equal(hasSenderLabel('[제우스] 안녕하세요, 확인했습니다.'), true);
});

test('hasSenderLabel: 5개 부서 라벨 전부 인정', () => {
  for (const label of ['[투자전략실 Athena]', '[퀀트전략실 Kairos]', '[리스크관리실 Themis]', '[운영실 Hermes]', '[비서실 Apollo]']) {
    assert.equal(hasSenderLabel(`${label} 결과 보고입니다.`), true, label);
  }
});

test('hasSenderLabel: VALID_SENDER_LABELS는 정확히 6개(제우스+부서5개), 순서·오탈자 없이', () => {
  assert.equal(VALID_SENDER_LABELS.length, 6);
  assert.ok(VALID_SENDER_LABELS.includes('[제우스]'));
});

// [재발방지] 2026-09-19 실사고 재현 — 실제로 발송됐던 라벨 없는 메시지 2건.
test('[막아야 함] hasSenderLabel: 라벨 없이 바로 본문으로 시작하면 false(실사고 재현)', () => {
  assert.equal(hasSenderLabel('안녕하세요! 오늘 시장 상황을 확인해드리겠습니다.'), false);
  assert.equal(hasSenderLabel('환율 조회 중입니다...'), false);
});

test('hasSenderLabel: 라벨이 첫머리가 아니라 문장 중간·끝에 있으면 인정 안 함(zeus.md "첫 줄" 원칙)', () => {
  assert.equal(hasSenderLabel('확인 결과를 말씀드리면 [제우스] 다음과 같습니다.'), false);
});

test('hasSenderLabel: 앞쪽 공백만 있고 그다음 라벨이면 인정(개행·트림 방어)', () => {
  assert.equal(hasSenderLabel('  \n[제우스] 확인했습니다.'), true);
});

test('hasSenderLabel: null/undefined/빈 문자열은 false(throw 안 함)', () => {
  assert.equal(hasSenderLabel(null), false);
  assert.equal(hasSenderLabel(undefined), false);
  assert.equal(hasSenderLabel(''), false);
});

test('hasSenderLabel: 비슷하지만 다른 라벨("[재무실 Athena]" 등 오탈자)은 인정 안 함', () => {
  assert.equal(hasSenderLabel('[재무실 Athena] 결과입니다.'), false);
  assert.equal(hasSenderLabel('[아테나] 결과입니다.'), false); // 영문 없는 축약형도 정확일치 아니므로 불인정
});
