// 사용량 한도 전역 쿨다운 테스트 — parseResetTime(순수) + getCooldown/setCooldown(파일).
// COOLDOWN_FILE 환경변수를 임시 경로로 지정해 실제 ~/.config 를 건드리지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

process.env.COOLDOWN_FILE = join(tmpdir(), `banana-cooldown-test-${process.pid}.json`);
const { parseResetTime, setCooldown, getCooldown, LIMIT_RE } = await import('./quota-cooldown.mjs');

function cleanup() { try { rmSync(process.env.COOLDOWN_FILE); } catch { /* noop */ } }

// KST 기준 특정 시각을 만드는 헬퍼: 2026-06-16 09:00 KST = 2026-06-16 00:00 UTC.
const KST = 9 * 3600_000;
const at = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - KST;

test('parseResetTime: 오전 분 포함 (resets 10:50am)', () => {
  const now = at(2026, 6, 16, 9, 0);              // 09:00 KST
  const r = parseResetTime('resets 10:50am (Asia/Seoul)', now);
  assert.equal(r, at(2026, 6, 16, 10, 50));        // 같은 날 10:50 KST
});

test('parseResetTime: 분 생략 (resets 8pm)', () => {
  const now = at(2026, 6, 16, 9, 0);
  const r = parseResetTime('You\'ve hit your limit · resets 8pm (Asia/Seoul)', now);
  assert.equal(r, at(2026, 6, 16, 20, 0));         // 20:00 KST
});

test('parseResetTime: 이미 지난 시각이면 다음날로 롤오버', () => {
  const now = at(2026, 6, 16, 23, 0);              // 23:00 KST
  const r = parseResetTime('resets 3:50am (Asia/Seoul)', now);
  assert.equal(r, at(2026, 6, 17, 3, 50));         // 다음날 03:50 KST
});

test('parseResetTime: 12am→자정, 12pm→정오', () => {
  const now = at(2026, 6, 16, 6, 0);
  assert.equal(parseResetTime('resets 12pm', now), at(2026, 6, 16, 12, 0));
  const now2 = at(2026, 6, 16, 1, 0);
  assert.equal(parseResetTime('resets 12am', now2), at(2026, 6, 16, 0, 0) + 24 * 3600_000); // 12am 1시 기준 → 다음날 자정
});

test('parseResetTime: 패턴 없으면 null', () => {
  assert.equal(parseResetTime('API Error: 401 authentication_error'), null);
  assert.equal(parseResetTime(''), null);
  assert.equal(parseResetTime(undefined), null);
});

test('LIMIT_RE: 한도 메시지 매치, 401·529 비매치', () => {
  assert.ok(LIMIT_RE.test("You've hit your limit · resets 8pm"));
  assert.ok(LIMIT_RE.test('hit your session limit'));
  assert.ok(!LIMIT_RE.test('API Error: 401 authentication_error'));
  assert.ok(!LIMIT_RE.test('API Error: 529 Overloaded'));
});

test('setCooldown/getCooldown: 활성 쿨다운 반환', () => {
  cleanup();
  const now = Date.now();
  setCooldown(now + 3600_000, '한도 테스트');
  const cd = getCooldown(now);
  assert.ok(cd);
  assert.equal(cd.resetAt, now + 3600_000);
  assert.equal(cd.reason, '한도 테스트');
  cleanup();
});

test('getCooldown: 만료되면 null + 파일 삭제', () => {
  cleanup();
  const now = Date.now();
  setCooldown(now - 1000, '만료됨');               // 이미 지난 reset
  assert.equal(getCooldown(now), null);
  assert.equal(getCooldown(now), null);            // 삭제됐으므로 여전히 null
  cleanup();
});

test('getCooldown: 파일 없으면 null', () => {
  cleanup();
  assert.equal(getCooldown(), null);
});
