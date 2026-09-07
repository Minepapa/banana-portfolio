import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRejectionStreak, shouldNudgeRejectionStreak, buildRejectionStreakNudge } from './rejection-pattern.mjs';

function p(status, decidedAt, track = '자산분배') {
  return { track, status, decidedAt };
}

test('detectRejectionStreak: 최근 결정이 전부 거부면 그 개수를 센다', () => {
  const proposals = [
    p('거부', '2026-09-05T00:00:00Z'),
    p('거부', '2026-09-06T00:00:00Z'),
    p('거부', '2026-09-07T00:00:00Z'),
  ];
  assert.equal(detectRejectionStreak(proposals), 3);
});

test('detectRejectionStreak: 승인이 하나라도 섞이면 그 지점에서 스트릭이 끊김(최근 것부터 셈)', () => {
  const proposals = [
    p('거부', '2026-09-01T00:00:00Z'), // 가장 오래됨 — 승인 이전이라 스트릭에 안 들어감
    p('승인', '2026-09-05T00:00:00Z'),
    p('거부', '2026-09-06T00:00:00Z'),
    p('거부', '2026-09-07T00:00:00Z'), // 가장 최근
  ];
  assert.equal(detectRejectionStreak(proposals), 2); // 09-07·09-06만 카운트, 09-05 승인에서 멈춤
});

test('detectRejectionStreak: 최근이 승인이면 0', () => {
  const proposals = [p('거부', '2026-09-06T00:00:00Z'), p('승인', '2026-09-07T00:00:00Z')];
  assert.equal(detectRejectionStreak(proposals), 0);
});

test('detectRejectionStreak: 결정 이력이 없으면(대기만 있거나 비어있음) 0', () => {
  assert.equal(detectRejectionStreak([]), 0);
  assert.equal(detectRejectionStreak([{ track: '자산분배', status: '대기', decidedAt: null }]), 0);
});

test('detectRejectionStreak: track이 다르면(퀀트 등) 제외 — 기본은 자산분배만 봄', () => {
  const proposals = [p('거부', '2026-09-06T00:00:00Z', '퀀트'), p('거부', '2026-09-07T00:00:00Z', '자산분배')];
  assert.equal(detectRejectionStreak(proposals), 1); // 퀀트 거부는 안 셈
});

test('detectRejectionStreak: decidedAt 순서와 무관하게(배열 순서 뒤죽박죽) 최근 것부터 정렬해서 판단', () => {
  const proposals = [
    p('거부', '2026-09-07T00:00:00Z'),
    p('승인', '2026-09-01T00:00:00Z'),
    p('거부', '2026-09-06T00:00:00Z'),
  ];
  assert.equal(detectRejectionStreak(proposals), 2);
});

test('shouldNudgeRejectionStreak: threshold의 배수일 때만 true(3,6,9...)', () => {
  assert.equal(shouldNudgeRejectionStreak(1, 3), false);
  assert.equal(shouldNudgeRejectionStreak(2, 3), false);
  assert.equal(shouldNudgeRejectionStreak(3, 3), true);
  assert.equal(shouldNudgeRejectionStreak(4, 3), false);
  assert.equal(shouldNudgeRejectionStreak(6, 3), true);
});

test('shouldNudgeRejectionStreak: streak 0이면 false(0은 3의 배수 수학적으로는 맞지만 "0회 거부"는 알릴 게 없음)', () => {
  assert.equal(shouldNudgeRejectionStreak(0, 3), false);
});

test('buildRejectionStreakNudge: 거부 횟수·원칙 재확인·재검토 옵션이 포함된 안내문', () => {
  const text = buildRejectionStreakNudge(3);
  assert.match(text, /3회 연속/);
  assert.match(text, /하락한 자산군을 매수해 목표비중을 지킨다/);
  assert.match(text, /전략 재검토/);
});
