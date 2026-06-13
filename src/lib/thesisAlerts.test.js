import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findThesisAlerts } from './thesisAlerts.js';

// riskMonitor는 최신순(index 0 = 최신). findThesisAlerts는 리스크 탭과 동일하게
// 대상의 유형별 최신 신호를 보고, 그게 🔴🟡일 때만 경보한다.
const pos = (name, extra = {}) => ({ name, status: '보유', rowIndex: 0, ...extra });

test('최신 🟢가 옛 🔴를 덮으면 경보 해소 (핵심 버그 수정)', () => {
  const journal = [pos('메리츠금융지주')];
  const risk = [
    { date: '2026-06-12', type: 'B', target: '메리츠금융지주', signal: '🟢', summary: '정상' },
    { date: '2026-06-05', type: 'B', target: '메리츠금융지주', signal: '🔴', summary: 'ROE 급락' },
  ];
  assert.equal(findThesisAlerts(journal, risk).length, 0);
});

test('최신 신호가 🔴면 경보', () => {
  const journal = [pos('삼성전자', { ticker: '005930' })];
  const risk = [{ date: '2026-06-12', type: 'B', target: '005930', signal: '🔴', summary: '영익률 훼손' }];
  const alerts = findThesisAlerts(journal, risk);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].signal.signal, '🔴');
});

test('유형별로 최신 판정 — B는 🟢여도 D 최신이 🔴면 경보', () => {
  const journal = [pos('삼성전자')];
  const risk = [
    { date: '2026-06-12', type: 'B', target: '삼성전자', signal: '🟢', summary: '논리 정상' },
    { date: '2026-06-11', type: 'D', target: '삼성전자', signal: '🔴', summary: '거시 충격' },
  ];
  const alerts = findThesisAlerts(journal, risk);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].signal.type, 'D');
});

test('여러 활성 신호 중 🔴를 🟡보다 우선 노출', () => {
  const journal = [pos('삼성전자')];
  const risk = [
    { date: '2026-06-12', type: 'B', target: '삼성전자', signal: '🟡', summary: '주의' },
    { date: '2026-06-12', type: 'D', target: '삼성전자', signal: '🔴', summary: '경보' },
  ];
  assert.equal(findThesisAlerts(journal, risk)[0].signal.signal, '🔴');
});

test('청산 포지션은 제외', () => {
  const journal = [pos('삼성전자', { status: '청산' })];
  const risk = [{ date: '2026-06-12', type: 'B', target: '삼성전자', signal: '🔴', summary: 'x' }];
  assert.equal(findThesisAlerts(journal, risk).length, 0);
});

test('매칭 신호 없으면 경보 없음', () => {
  const journal = [pos('카카오')];
  const risk = [{ date: '2026-06-12', type: 'B', target: '삼성전자', signal: '🔴', summary: 'x' }];
  assert.equal(findThesisAlerts(journal, risk).length, 0);
});
