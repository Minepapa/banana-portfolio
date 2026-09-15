import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRunToday, ENTRY_SIGNAL_OPTS } from './daily-breakout-signal-scan.mjs';
import { computeBreakoutEntrySignal, RS_ANCHOR_SMOOTH_DAYS, MARKET_CAP_FLOOR_WON } from '../lib/breakout-factor.mjs';

// KST 기준 날짜 확인: 2026-09-14는 월요일, 2026-09-12는 토요일, 2026-09-13은 일요일.
// UTC 06:32는 KST 15:32(같은 달력일, 자정 넘김 없음)로 이 시각을 기준으로 삼는다.
const MONDAY_1532_KST = new Date('2026-09-14T06:32:00Z');
const SATURDAY_1532_KST = new Date('2026-09-12T06:32:00Z');
const SUNDAY_1532_KST = new Date('2026-09-13T06:32:00Z');

// [핵심 안전장치] 코드리뷰 HIGH 지적(2026-09-13) 재발방지 — 하루 여러 번 실행돼도
// 이미 오늘 돌았으면 다시 신호스캔+발주를 안 해야 이중매수를 막는다.
test('shouldRunToday: 평일이고 아직 오늘 실행 기록이 없으면(lastRunDayLabel=null) true', () => {
  assert.equal(shouldRunToday(MONDAY_1532_KST, null), true);
});

test('shouldRunToday: 평일이지만 이미 오늘 실행됐으면(lastRunDayLabel=오늘) false — 재실행 방지', () => {
  assert.equal(shouldRunToday(MONDAY_1532_KST, '2026-09-14'), false);
});

test('shouldRunToday: 평일이고 마지막 실행 기록이 어제면 true', () => {
  assert.equal(shouldRunToday(MONDAY_1532_KST, '2026-09-11'), true);
});

test('shouldRunToday: 토요일이면 실행 기록과 무관하게 항상 false', () => {
  assert.equal(shouldRunToday(SATURDAY_1532_KST, null), false);
});

test('shouldRunToday: 일요일이면 실행 기록과 무관하게 항상 false', () => {
  assert.equal(shouldRunToday(SUNDAY_1532_KST, null), false);
});

// [핵심 안전장치] 이 잡이 실제로 RS 앵커 스무딩(RS_ANCHOR_SMOOTH_DAYS, 오너
// 2026-09-15 확정 배선)을 쓰는지 고정 — computeBreakoutEntrySignal 호출부가
// main() 안에만 있어 이 배선을 직접 검증하는 테스트가 없었다(2026-09-15
// 코드리뷰 MEDIUM 지적). ENTRY_SIGNAL_OPTS를 main() 밖으로 뽑아 여기서 고정.
test('ENTRY_SIGNAL_OPTS: rsAnchorSmoothDays가 breakout-factor.mjs의 RS_ANCHOR_SMOOTH_DAYS와 일치(단일 진실소스 배선 확인)', () => {
  assert.equal(ENTRY_SIGNAL_OPTS.rsAnchorSmoothDays, RS_ANCHOR_SMOOTH_DAYS);
  assert.equal(ENTRY_SIGNAL_OPTS.marketCapFloor, MARKET_CAP_FLOOR_WON);
});

test('ENTRY_SIGNAL_OPTS: 실제로 앵커 스무딩 경로를 태움(단일시점과 다른 RS값을 냄 — 배선이 죽은 설정이 아님을 증명)', () => {
  // 앵커일 근처에 스파이크를 넣어 단일시점 RS를 왜곡시킨 뒤, ENTRY_SIGNAL_OPTS로
  // 계산한 RS가 그 왜곡을 완화하는지 확인 — 이게 이 배선의 실제 존재 이유다.
  const closes = [];
  for (let i = 0; i < 300; i++) closes.push(1000 * (1 + 0.0005 * i));
  const anchorIdx = closes.length - 1 - 60; // breakout-factor.mjs RS_LOOKBACK_DAYS 기본값과 동일
  closes[anchorIdx] *= 1.15; // 앵커일 스파이크
  const highs = closes.map((c) => c * 1.001);
  const bench = new Array(closes.length).fill(1000);
  const candidate = { closes, highs, lows: closes, benchmarkCloses: bench, marcap: MARKET_CAP_FLOOR_WON * 2 };

  const viaEntrySignalOpts = computeBreakoutEntrySignal(candidate, ENTRY_SIGNAL_OPTS);
  const viaSingleAnchorOnly = computeBreakoutEntrySignal(candidate, { marketCapFloor: MARKET_CAP_FLOOR_WON });

  assert.notEqual(viaEntrySignalOpts.relativeStrength, null);
  assert.notEqual(viaSingleAnchorOnly.relativeStrength, null);
  assert.notEqual(viaEntrySignalOpts.relativeStrength, viaSingleAnchorOnly.relativeStrength);
  assert.ok(
    Math.abs(viaEntrySignalOpts.relativeStrength) < Math.abs(viaSingleAnchorOnly.relativeStrength),
    '스무딩이 앵커일 스파이크로 인한 왜곡을 완화해야 함',
  );
});
