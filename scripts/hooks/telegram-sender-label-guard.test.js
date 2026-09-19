import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasSenderLabel, VALID_SENDER_LABELS } from './telegram-sender-label-guard.mjs';
import { ZEUS_MARKER } from '../lib/telegram-messages.mjs';

// [핵심 안전장치] 2026-09-19 — zeus.md "발신자 라벨" 규칙(2026-09-14 재지적으로
// 강화됐는데도 2026-09-19 세션에서 실제로 라벨 없는 reply 2건이 발송된 사고 재발
// 방지). 이 훅이 실제로 막을 수 있는지는 hasSenderLabel의 판정 정확도에 달려있다.
test('hasSenderLabel: "[Zeus] "로 시작하면 true', () => {
  assert.equal(hasSenderLabel('[Zeus] 안녕하세요, 확인했습니다.'), true);
});

// 2026-09-19 라벨 환원(DevRequest 2026-09-19-제우스-라벨-영문표기-Zeus.md) — 상시
// 텔레그램 세션이 재시작 전까지 옛 지시문으로 이 라벨을 계속 낼 수 있어 레거시로
// 당분간 병행 허용(telegram-sender-label-guard.mjs 상단 주석 참고). [막아야 함]이
// 아님(다른 테스트의 그 태그는 false 단언용 컨벤션 — 이건 true를 확인하는 정상
// 수용 테스트, 코드리뷰 지적으로 태그 제거).
test('hasSenderLabel: 레거시 "[제우스] "도 당분간 인정(상시 세션 재시작 전 무응답 사고 방지)', () => {
  assert.equal(hasSenderLabel('[제우스] 안녕하세요, 확인했습니다.'), true);
});

test('hasSenderLabel: 5개 부서 라벨 전부 인정', () => {
  for (const label of ['[투자전략실 Athena]', '[퀀트전략실 Kairos]', '[리스크관리실 Themis]', '[운영실 Hermes]', '[비서실 Apollo]']) {
    assert.equal(hasSenderLabel(`${label} 결과 보고입니다.`), true, label);
  }
});

test('hasSenderLabel: VALID_SENDER_LABELS는 정확히 7개(Zeus+레거시 제우스+부서5개), 순서·오탈자 없이', () => {
  assert.equal(VALID_SENDER_LABELS.length, 7);
  assert.ok(VALID_SENDER_LABELS.includes('[Zeus]'));
  assert.ok(VALID_SENDER_LABELS.includes('[제우스]'));
});

// [핵심 안전장치] 코드리뷰 지적(2026-09-19) — ZEUS_MARKER(telegram-messages.mjs,
// Node가 조립하는 메시지용)와 VALID_SENDER_LABELS(이 가드, 사람이 reply로 직접
// 보내는 메시지용)가 같은 문자열을 각자 하드코딩해서 들고 있다. "한쪽만 바뀌면
// 같이 갱신할 것"이라는 프로즈 주석만으로는 이 라벨이 5일 만에 두 번째로
// 방향전환한 이력(2026-09-14 [Zeus]→[제우스], 2026-09-19 [제우스]→[Zeus])이
// 증명하듯 실제로 드리프트한다 — CLAUDE.md "프로즈 규칙이 아니라 테스트로
// 강제되는 구조를 우선한다"와 동일 원칙. 정식 라벨이 가드 목록 맨 앞(우선순위상
// 의미는 없지만 "이게 정본"이라는 관례)에 있고 ZEUS_MARKER와 항상 같은 값인지
// 직접 대조한다.
test('[핵심 안전장치] VALID_SENDER_LABELS의 정식 Zeus 라벨은 ZEUS_MARKER와 항상 일치(가드-포맷터 드리프트 방지)', () => {
  assert.equal(VALID_SENDER_LABELS[0], ZEUS_MARKER);
  assert.ok(VALID_SENDER_LABELS.includes(ZEUS_MARKER));
});

// zeus.md·PANTHEON.md가 실제로 현재 ZEUS_MARKER를 지시하는지 대조 — 문서가 옛
// 라벨을 지시문으로 계속 들고 있으면(레거시 언급이 아니라 "이렇게 붙여라"는
// 지시) 에이전트가 그 문서를 다시 읽을 때마다 구 라벨로 되돌아갈 수 있다.
test('[핵심 안전장치] zeus.md·PANTHEON.md가 현재 ZEUS_MARKER(`[Zeus]`)를 지시한다', () => {
  for (const rel of ['../../.claude/agents/zeus.md', '../../.claude/agents/PANTHEON.md']) {
    const content = readFileSync(new URL(rel, import.meta.url), 'utf8');
    assert.ok(content.includes(`\`${ZEUS_MARKER}\``), `${rel}에 ${ZEUS_MARKER} 지시문이 없음`);
  }
});

// [재발방지] 2026-09-19 실사고 재현 — 실제로 발송됐던 라벨 없는 메시지 2건.
test('[막아야 함] hasSenderLabel: 라벨 없이 바로 본문으로 시작하면 false(실사고 재현)', () => {
  assert.equal(hasSenderLabel('안녕하세요! 오늘 시장 상황을 확인해드리겠습니다.'), false);
  assert.equal(hasSenderLabel('환율 조회 중입니다...'), false);
});

test('hasSenderLabel: 라벨이 첫머리가 아니라 문장 중간·끝에 있으면 인정 안 함(zeus.md "첫 줄" 원칙)', () => {
  assert.equal(hasSenderLabel('확인 결과를 말씀드리면 [Zeus] 다음과 같습니다.'), false);
});

test('hasSenderLabel: 앞쪽 공백만 있고 그다음 라벨이면 인정(개행·트림 방어)', () => {
  assert.equal(hasSenderLabel('  \n[Zeus] 확인했습니다.'), true);
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
