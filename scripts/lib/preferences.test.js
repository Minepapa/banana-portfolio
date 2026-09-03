import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrefRows, prefBlock, findExpiredPromotions } from './preferences.mjs';

// 2026-08-20 Vault 네이티브 재작성 — 입력이 구글시트 row-array에서
// Knowledge/Profile/*.md frontmatter 객체로 바뀌었다.

const mkRec = (signalType, obs, vsProfile, status, overrides = {}) =>
  ({ date: '2026-06-10', signalType, observation: obs, evidence: '체결', vsProfile, confidence: '높음', status, ...overrides });

test('renderPrefRows: 기각 레코드는 항상 제외', () => {
  const records = [
    mkRec('매수패턴', '분할매수 선호', '일치(보강)', '확정'),
    mkRec('매도패턴', '손절 주저', '신규', '기각'),
  ];
  const text = renderPrefRows(records);
  assert.ok(text.includes('분할매수 선호'));
  assert.ok(!text.includes('손절 주저'));
});

test('renderPrefRows: confirmedOnly=true 확정만 포함', () => {
  const records = [
    mkRec('매수패턴', '분할매수 선호', '일치(보강)', '확정'),
    mkRec('보유심리', '관망 선호', '', '관찰'),
    mkRec('리스크', '급락 시 추가매수', '', '승격후보'),
  ];
  const text = renderPrefRows(records, { confirmedOnly: true });
  assert.ok(text.includes('분할매수 선호'));
  assert.ok(!text.includes('관망 선호'));
  assert.ok(!text.includes('급락 시 추가매수'));
});

test('renderPrefRows: confirmedOnly=false 기각 외 전체', () => {
  const records = [
    mkRec('매수패턴', '분할매수 선호', '일치(보강)', '확정'),
    mkRec('보유심리', '관망 선호', '', '관찰'),
    mkRec('매도패턴', '손절 주저', '', '기각'),
  ];
  const text = renderPrefRows(records, { confirmedOnly: false });
  assert.ok(text.includes('분할매수 선호'));
  assert.ok(text.includes('관망 선호'));
  assert.ok(!text.includes('손절 주저'));
});

test('renderPrefRows: §3대비 있으면 표시', () => {
  const records = [mkRec('매수패턴', '분할매수 선호', '일치(보강)', '확정')];
  const text = renderPrefRows(records);
  assert.ok(text.includes('§3 대비 일치(보강)'));
});

test('renderPrefRows: 관찰 없는 레코드는 무시', () => {
  const records = [mkRec('매수패턴', '', '', '확정')];
  assert.equal(renderPrefRows(records), '');
});

test('renderPrefRows: 빈 배열', () => {
  assert.equal(renderPrefRows([]), '');
});

test('prefBlock: 확정 텍스트 래핑', () => {
  const text = prefBlock('- [확정] 매수패턴: 분할매수 선호');
  assert.ok(text.includes('[확정 학습 성향'));
  assert.ok(text.includes('분할매수 선호'));
});

test('prefBlock: 확정 없으면 기본 메시지', () => {
  const text = prefBlock('');
  assert.ok(text.includes('아직 확정된 학습 성향 없음'));
});

test('prefBlock: null도 기본 메시지', () => {
  const text = prefBlock(null);
  assert.ok(text.includes('아직 확정된 학습 성향 없음'));
});

// 구조조정 안건5 — 성향관찰 '승격후보' TTL(4주 무응답 시 자동 관찰 보류). 순수 판정 로직만
// (실제 Vault 파일 되돌리기 쓰기는 weekly-report.mjs가 이 결과를 받아 수행).
const NOW = '2026-07-19T00:00:00+09:00';
const mkRecFull = (status, updatedAt, date = '2026-06-01', filepath = '/vault/a.md') =>
  ({ date, signalType: '리스크', observation: '급락 시 추가매수 선호', evidence: '체결', vsProfile: '', confidence: '높음', status, updatedAt, filepath });

test('findExpiredPromotions: 4주(기본 TTL) 이상 무응답인 승격후보만 대상', () => {
  const records = [
    mkRecFull('승격후보', '2026-06-15T00:00:00+09:00', '2026-06-01', '/vault/expired.md'), // 34일 전 — 만료
    mkRecFull('승격후보', '2026-07-10T00:00:00+09:00', '2026-06-01', '/vault/fresh.md'),   // 9일 전 — 미만료
  ];
  const expired = findExpiredPromotions(records, { now: NOW });
  assert.equal(expired.length, 1);
  assert.equal(expired[0].filepath, '/vault/expired.md');
  assert.match(expired[0].obs, /급락 시 추가매수/);
});

test('findExpiredPromotions: 승격후보가 아닌 상태(관찰/확정/기각)는 대상 아님', () => {
  const records = [
    mkRecFull('관찰', '2026-05-01T00:00:00+09:00'),
    mkRecFull('확정', '2026-05-01T00:00:00+09:00'),
    mkRecFull('기각', '2026-05-01T00:00:00+09:00'),
  ];
  assert.deepEqual(findExpiredPromotions(records, { now: NOW }), []);
});

test('findExpiredPromotions: updatedAt 없으면 date로 폴백', () => {
  const records = [mkRecFull('승격후보', '', '2026-06-01')]; // updatedAt 빈값 → date(2026-06-01) 기준 48일 전
  const expired = findExpiredPromotions(records, { now: NOW });
  assert.equal(expired.length, 1);
});

test('findExpiredPromotions: 날짜도 파싱 불가하면 판정 보류(추정 금지 — 만료 처리 안 함)', () => {
  const records = [mkRecFull('승격후보', '', '알수없음')];
  assert.deepEqual(findExpiredPromotions(records, { now: NOW }), []);
});

test('findExpiredPromotions: ttlWeeks 커스터마이즈 가능', () => {
  const records = [mkRecFull('승격후보', '2026-07-10T00:00:00+09:00')]; // 9일 전
  assert.equal(findExpiredPromotions(records, { now: NOW, ttlWeeks: 4 }).length, 0);
  assert.equal(findExpiredPromotions(records, { now: NOW, ttlWeeks: 1 }).length, 1); // 1주(7일) 기준이면 만료
});

test('findExpiredPromotions: 빈 배열은 빈 결과', () => {
  assert.deepEqual(findExpiredPromotions([], { now: NOW }), []);
});

test('findExpiredPromotions: nowKST() 실제 프로덕션 포맷("YYYY-MM-DD HH:MM", 오프셋 없음)도 파싱', () => {
  const records = [mkRecFull('승격후보', '2026-06-15 09:00')]; // 34일 전, 실제 저장 포맷 그대로
  const expired = findExpiredPromotions(records, { now: NOW });
  assert.equal(expired.length, 1);
});

test('findExpiredPromotions: 정확히 ttlWeeks 경계(=)는 만료로 포함(>= 이므로)', () => {
  const exactly4weeks = new Date(new Date(NOW).getTime() - 4 * 7 * 24 * 3600_000).toISOString();
  const records = [mkRecFull('승격후보', exactly4weeks)];
  assert.equal(findExpiredPromotions(records, { now: NOW, ttlWeeks: 4 }).length, 1);
});

test('findExpiredPromotions: updatedAt·date 둘 다 있으면 updatedAt이 우선', () => {
  // updatedAt은 최근(미만료), date는 오래됨(만료) — updatedAt을 써야 하므로 미만료로 판정돼야 정합.
  const records = [mkRecFull('승격후보', '2026-07-15T00:00:00+09:00', '2026-01-01')];
  assert.deepEqual(findExpiredPromotions(records, { now: NOW }), []);
});

test('findExpiredPromotions: now를 Date 객체로 넘겨도 동작(문자열 아닌 인자 분기)', () => {
  const records = [mkRecFull('승격후보', '2026-06-01T00:00:00+09:00')];
  const expired = findExpiredPromotions(records, { now: new Date(NOW) });
  assert.equal(expired.length, 1);
});
