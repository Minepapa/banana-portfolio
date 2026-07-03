// job-alerts 순수 로직 테스트 — 시그니처·24h 억제 판단(네트워크·파일 없는 부분만).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warningsSignature, shouldNotify, collectWarning, warningCount, resetWarnings } from './job-alerts.mjs';

test('warningsSignature: 순서 무관 동일, 내용 다르면 상이', () => {
  const a = warningsSignature(['배당 귀속실패: X', '금 매칭실패: Y']);
  const b = warningsSignature(['금 매칭실패: Y', '배당 귀속실패: X']);   // 순서만 다름
  const c = warningsSignature(['배당 귀속실패: X']);
  assert.equal(a, b);       // 매시간 잡의 경고 순서 흔들림에도 동일 시그니처 → 중복 억제 유지
  assert.notEqual(a, c);    // 경고 구성 바뀌면 새 시그니처 → 재발송
});

test('shouldNotify: 동일 시그니처 24h 내 억제, 경과·변경 시 발송', () => {
  const now = 1_000_000_000_000;
  const state = { drain: { sig: 'abc', ts: now - 3600_000 } };          // 1시간 전 발송
  assert.equal(shouldNotify(state, 'drain', 'abc', now), false);        // 같은 경고 → 억제
  assert.equal(shouldNotify(state, 'drain', 'def', now), true);         // 내용 변경 → 발송
  assert.equal(shouldNotify(state, 'drain', 'abc', now + 25 * 3600_000), true); // 24h 경과 → 재발송
  assert.equal(shouldNotify(state, 'parse-notifications', 'abc', now), true);   // 다른 잡 → 독립
  assert.equal(shouldNotify({}, 'drain', 'abc', now), true);            // 첫 발송
});

test('collectWarning: 빈/공백 무시, 카운트 누적', () => {
  resetWarnings();
  collectWarning('경고 1');
  collectWarning('   ');
  collectWarning(null);
  collectWarning('경고 2');
  assert.equal(warningCount(), 2);
  resetWarnings();
  assert.equal(warningCount(), 0);
});
