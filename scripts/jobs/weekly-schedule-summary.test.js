import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyScheduleText, describeSwitchStatus, SCHEDULE } from './weekly-schedule-summary.mjs';
import { buildKillSwitchState } from '../lib/kill-switch.mjs';
import { buildExecutionModeState, MODE_LIVE, MODE_SHADOW } from '../lib/shadow-mode.mjs';
import { buildProposalModeState, MODE_ALLOWED, MODE_BLOCKED } from '../lib/proposal-mode.mjs';

test('SCHEDULE: 8건(주기적 보고 8개, 2026-09-18 daily-breakout-signal-scan 추가) — 이벤트기반은 포함되지 않는다', () => {
  assert.equal(SCHEDULE.length, 8);
});

test('buildWeeklyScheduleText: 제목과 8건 부서·시각이 전부 본문에 포함된다', () => {
  const text = buildWeeklyScheduleText();
  assert.match(text, /<b>주간 보고 스케쥴<\/b>/);
  assert.match(text, /평일 08:00 \[운영실 Hermes\]/);
  assert.match(text, /평일 15:32 \[운영실 Hermes\]/);
  assert.match(text, /평일 16:15 \[운영실 Hermes\]/);
  assert.match(text, /평일 16:30 \[투자전략실 Athena\]/);
  assert.match(text, /일요일 07:00 \[리스크관리실 Themis\]/);
  assert.match(text, /일요일 07:30 \[비서실 Apollo\]/);
  assert.match(text, /일요일 08:00 \[비서실 Apollo\]/);
  assert.match(text, /월요일 07:10 \[투자전략실 Athena\]/);
});

test('buildWeeklyScheduleText: 커스텀 schedule 배열을 받으면 그것만 반영(순수함수)', () => {
  const text = buildWeeklyScheduleText([{ day: '화요일', time: '09:00', dept: '테스트부서', what: '테스트 보고' }]);
  assert.match(text, /화요일 09:00 \[테스트부서\] 테스트 보고/);
  assert.doesNotMatch(text, /운영실 Hermes/);
});

test('buildWeeklyScheduleText: conditional 항목은 [조건부] 그룹으로 분리되고 발송조건이 괄호로 붙는다(2026-09-14, 오너 지적 반영)', () => {
  const text = buildWeeklyScheduleText([
    { day: '화요일', time: '09:00', dept: 'A부서', what: '고정 보고' },
    { day: '수요일', time: '10:00', dept: 'B부서', what: '조건부 보고', conditional: '이상 있을 때만' },
  ]);
  assert.match(text, /\[매주 고정으로 옴 — 1건\]/);
  assert.match(text, /\[조건부 — 웬만해선 조용함, 1건\]/);
  assert.match(text, /· 화요일 09:00 \[A부서\] 고정 보고\n/); // 고정 항목엔 괄호 없음
  assert.match(text, /· 수요일 10:00 \[B부서\] 조건부 보고\(이상 있을 때만\)/);
});

test('buildWeeklyScheduleText: 그룹 건수는 배열 길이에서 그대로 셈(하드코딩 아님) — 실제 SCHEDULE로도 확인', () => {
  const text = buildWeeklyScheduleText();
  const fixedCount = SCHEDULE.filter((s) => !s.conditional).length;
  const conditionalCount = SCHEDULE.filter((s) => s.conditional).length;
  assert.match(text, new RegExp(`\\[매주 고정으로 옴 — ${fixedCount}건\\]`));
  assert.match(text, new RegExp(`\\[조건부 — 웬만해선 조용함, ${conditionalCount}건\\]`));
});

test('SCHEDULE: ISA 만기 감시는 conditional 항목이어야 함(2026-09-14 오너 지적 — "이번주 이벤트가 아닌데 몇 주째 스케줄에 뜬다")', () => {
  const isa = SCHEDULE.find((s) => s.script === 'isa-maturity-check.mjs');
  assert.notEqual(isa, undefined);
  assert.ok(isa.conditional, 'ISA 만기 감시는 매번 발송되는 항목이 아니므로 conditional 필드가 있어야 함');
});

test('SCHEDULE: conditional 필드가 있으면 반드시 비어있지 않은 문자열이어야 함(2026-09-14 코드리뷰 지적 — conditional: "" 이면 !s.conditional로 [매주 고정] 그룹에 조용히 섞여 원래 버그와 동일한 증상 재발)', () => {
  for (const s of SCHEDULE) {
    if ('conditional' in s) {
      assert.equal(typeof s.conditional, 'string', `${s.script}의 conditional은 문자열이어야 함`);
      assert.ok(s.conditional.trim().length > 0, `${s.script}의 conditional이 빈 문자열이면 조건부인데 [매주 고정] 그룹으로 조용히 오분류됨`);
    }
  }
});

// 2026-09-18 오너 지시("매주 운영실 보고에 세 가지 스위치의 상태도 함께 알려줘")로
// 신설 — describeSwitchStatus는 이미 읽어온 State 파일 content(문자열|null)만 받는
// 순수함수라 I/O 없이 8가지 on/off 조합을 전부 테스트 가능.
test('describeSwitchStatus: 전부 파일 없음(null) → 안전 기본값(킬스위치 오프·섀도우·제안 온)', () => {
  const text = describeSwitchStatus({ killSwitchContent: null, executionModeContent: null, proposalModeContent: null });
  assert.match(text, /킬스위치: 오프/);
  assert.match(text, /실전모드: 오프\(섀도우/);
  assert.match(text, /제안모드: 온/);
});

test('describeSwitchStatus: 킬스위치 온이면 표시', () => {
  const content = buildKillSwitchState({ active: true, reason: 'test' });
  const text = describeSwitchStatus({ killSwitchContent: content, executionModeContent: null, proposalModeContent: null });
  assert.match(text, /킬스위치: 온/);
});

test('describeSwitchStatus: 실전모드 온(MODE_LIVE)이면 표시', () => {
  const content = buildExecutionModeState({ mode: MODE_LIVE, reason: 'test' });
  const text = describeSwitchStatus({ killSwitchContent: null, executionModeContent: content, proposalModeContent: null });
  assert.match(text, /실전모드: 온/);
});

test('describeSwitchStatus: 실전모드 오프(MODE_SHADOW)면 섀도우로 표시', () => {
  const content = buildExecutionModeState({ mode: MODE_SHADOW, reason: 'test' });
  const text = describeSwitchStatus({ killSwitchContent: null, executionModeContent: content, proposalModeContent: null });
  assert.match(text, /실전모드: 오프\(섀도우/);
});

test('describeSwitchStatus: 제안모드 금지(MODE_BLOCKED)면 오프로 표시', () => {
  const content = buildProposalModeState({ mode: MODE_BLOCKED, reason: 'test' });
  const text = describeSwitchStatus({ killSwitchContent: null, executionModeContent: null, proposalModeContent: content });
  assert.match(text, /제안모드: 오프/);
});

test('describeSwitchStatus: 제안모드 허용(MODE_ALLOWED)이면 온으로 표시', () => {
  const content = buildProposalModeState({ mode: MODE_ALLOWED, reason: 'test' });
  const text = describeSwitchStatus({ killSwitchContent: null, executionModeContent: null, proposalModeContent: content });
  assert.match(text, /제안모드: 온/);
});

test('buildWeeklyScheduleText: switchStatus를 넘기면 본문에 포함, 생략하면(기존 호출부 하위호환) 포함 안 됨', () => {
  const withStatus = buildWeeklyScheduleText(SCHEDULE, '[스위치 상태]\n· 킬스위치: 오프');
  assert.match(withStatus, /\[스위치 상태\]/);
  const withoutStatus = buildWeeklyScheduleText();
  assert.doesNotMatch(withoutStatus, /\[스위치 상태\]/);
});
