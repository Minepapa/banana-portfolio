import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyScheduleText, SCHEDULE } from './weekly-schedule-summary.mjs';

test('SCHEDULE: 7건(주기적 보고 7개, 2026-09-04 weekly-vault-health-check 추가) — 이벤트기반은 포함되지 않는다', () => {
  assert.equal(SCHEDULE.length, 7);
});

test('buildWeeklyScheduleText: 제목과 7건 부서·시각이 전부 본문에 포함된다', () => {
  const text = buildWeeklyScheduleText();
  assert.match(text, /<b>주간 보고 스케쥴<\/b>/);
  assert.match(text, /평일 08:00 \[운영실 Hermes\]/);
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
