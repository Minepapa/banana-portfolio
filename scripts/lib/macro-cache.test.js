import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCachedMacroIndicators, parseMacroCache, findMacroAnomalies, ANOMALY_THRESHOLD_PCT,
} from './macro-cache.mjs';
import { buildFrontmatter } from './vault-frontmatter.mjs';

function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), 'macro-cache-')), 'MacroIndicators.md');
}

test('parseMacroCache: 파일 없으면(content null) null', () => {
  assert.equal(parseMacroCache(null), null);
});

test('parseMacroCache: asof·macroJson 있으면 파싱', () => {
  const content = buildFrontmatter({ asof: '2026-09-06', macroJson: JSON.stringify({ KOSPI: { value: 1, change5d: 1 } }), computedAt: 'x' });
  const r = parseMacroCache(content);
  assert.deepEqual(r.macro, { KOSPI: { value: 1, change5d: 1 } });
  assert.equal(r.asof, '2026-09-06');
});

test('parseMacroCache: macroJson이 깨진 JSON이면 null(추정 안 함)', () => {
  const content = buildFrontmatter({ asof: '2026-09-06', macroJson: '{broken' });
  assert.equal(parseMacroCache(content), null);
});

test('findMacroAnomalies: 임계값 초과 지표만 골라냄', () => {
  const macro = { KOSPI: { change5d: -4.82 }, WTI: { change5d: 15.5 }, VIX: { change5d: null } };
  assert.deepEqual(findMacroAnomalies(macro), ['WTI']);
});

test('findMacroAnomalies: 전부 임계값 이내면 빈 배열', () => {
  const macro = { KOSPI: { change5d: -1.5 }, KOSDAQ: { change5d: -2.97 } };
  assert.deepEqual(findMacroAnomalies(macro), []);
});

test('getCachedMacroIndicators: 캐시 없으면 fetchFn 호출 후 저장', async () => {
  const filepath = tmpFile();
  let calls = 0;
  const fetchFn = async () => { calls++; return { KOSPI: { value: 6687.21, change5d: -1.5 } }; };
  const macro = await getCachedMacroIndicators({ now: new Date('2026-09-06T08:03:00+09:00'), fetchFn, filepath });
  assert.equal(calls, 1);
  assert.equal(macro.KOSPI.change5d, -1.5);
  const saved = JSON.parse(readFileSync(filepath, 'utf8').match(/macroJson: "(.+)"/)[1].replace(/\\"/g, '"'));
  assert.equal(saved.KOSPI.value, 6687.21);
});

test('[핵심] getCachedMacroIndicators: 같은 KST 달력일 안에서는 두 번째 호출이 fetchFn을 다시 안 부름(캐시 재사용)', async () => {
  const filepath = tmpFile();
  let calls = 0;
  const fetchFn = async () => { calls++; return { KOSPI: { value: 6687.21, change5d: -1.5 } }; };
  // Themis(07:02)가 먼저 계산 — 캐시 없음, fetchFn 호출.
  const first = await getCachedMacroIndicators({ now: new Date('2026-09-06T07:02:00+09:00'), fetchFn, filepath });
  // weekly-report(08:03, 같은 날) — 캐시 재사용, fetchFn 호출 안 함.
  const second = await getCachedMacroIndicators({ now: new Date('2026-09-06T08:03:00+09:00'), fetchFn, filepath });
  assert.equal(calls, 1, 'fetchFn은 하루에 한 번만 호출돼야 함');
  assert.deepEqual(first, second, '같은 날엔 완전히 같은 값을 반환해야 함(이번 사고 회귀 방지)');
});

test('getCachedMacroIndicators: KST 달력일이 바뀌면 다시 계산', async () => {
  const filepath = tmpFile();
  let calls = 0;
  const fetchFn = async () => { calls++; return { KOSPI: { value: 100 * calls, change5d: calls } }; };
  const day1 = await getCachedMacroIndicators({ now: new Date('2026-09-06T23:59:00+09:00'), fetchFn, filepath });
  const day2 = await getCachedMacroIndicators({ now: new Date('2026-09-07T00:01:00+09:00'), fetchFn, filepath });
  assert.equal(calls, 2);
  assert.notDeepEqual(day1, day2);
});

test('getCachedMacroIndicators: 이상치가 있어도 값은 그대로 반환(폴백·수정 없음, 콘솔 경고만)', async () => {
  const filepath = tmpFile();
  const fetchFn = async () => ({ WTI: { value: 91.48, change5d: 15.5 } });
  const macro = await getCachedMacroIndicators({ now: new Date('2026-09-06T07:00:00+09:00'), fetchFn, filepath });
  assert.equal(macro.WTI.change5d, 15.5);
});

test('ANOMALY_THRESHOLD_PCT: 이번 사고 폭(3.3%p)보다 넓게 잡혀있어 정상 변동은 안 잡힘', () => {
  assert.ok(ANOMALY_THRESHOLD_PCT > 5);
});
