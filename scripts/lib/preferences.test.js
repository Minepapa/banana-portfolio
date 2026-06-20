import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPrefRows, prefBlock } from './preferences.mjs';

const mkRow = (type, obs, vsProfile, status) =>
  ['2026-06-10', type, obs, '체결', vsProfile, '높음', status, ''];

test('renderPrefRows: 기각 행은 항상 제외', () => {
  const rows = [
    mkRow('매수패턴', '분할매수 선호', '일치(보강)', '확정'),
    mkRow('매도패턴', '손절 주저', '신규', '기각'),
  ];
  const text = renderPrefRows(rows);
  assert.ok(text.includes('분할매수 선호'));
  assert.ok(!text.includes('손절 주저'));
});

test('renderPrefRows: confirmedOnly=true 확정만 포함', () => {
  const rows = [
    mkRow('매수패턴', '분할매수 선호', '일치(보강)', '확정'),
    mkRow('보유심리', '관망 선호', '', '관찰'),
    mkRow('리스크', '급락 시 추가매수', '', '승격후보'),
  ];
  const text = renderPrefRows(rows, { confirmedOnly: true });
  assert.ok(text.includes('분할매수 선호'));
  assert.ok(!text.includes('관망 선호'));
  assert.ok(!text.includes('급락 시 추가매수'));
});

test('renderPrefRows: confirmedOnly=false 기각 외 전체', () => {
  const rows = [
    mkRow('매수패턴', '분할매수 선호', '일치(보강)', '확정'),
    mkRow('보유심리', '관망 선호', '', '관찰'),
    mkRow('매도패턴', '손절 주저', '', '기각'),
  ];
  const text = renderPrefRows(rows, { confirmedOnly: false });
  assert.ok(text.includes('분할매수 선호'));
  assert.ok(text.includes('관망 선호'));
  assert.ok(!text.includes('손절 주저'));
});

test('renderPrefRows: 3대비 있으면 표시', () => {
  const rows = [mkRow('매수패턴', '분할매수 선호', '일치(보강)', '확정')];
  const text = renderPrefRows(rows);
  assert.ok(text.includes('§3 대비 일치(보강)'));
});

test('renderPrefRows: 관찰 없는 행은 무시', () => {
  const rows = [['2026-06-10', '매수패턴', '', '', '', '', '확정', '']];
  assert.equal(renderPrefRows(rows), '');
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
