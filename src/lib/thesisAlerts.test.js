import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findThesisAlerts, isThesisBreach, thesisAlertLabel } from './thesisAlerts.js';

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

test('거시(D) 신호는 투자논리 훼손이 아님 — B만 본다', () => {
  const journal = [pos('삼성전자')];
  const risk = [{ date: '2026-06-11', type: 'D', target: '삼성전자', signal: '🔴', summary: '거시 충격' }];
  assert.equal(findThesisAlerts(journal, risk).length, 0);
});

test('가격(O) 신호는 투자논리 훼손이 아님 — 차익실현🟡·급락매수🔴 모두 무시', () => {
  const journal = [pos('삼성전자')];
  const riskTrim = [{ date: '2026-06-12', type: 'O', target: '삼성전자', signal: '🟡', summary: '차익실현 검토 — 52주 92%' }];
  const riskBuy  = [{ date: '2026-06-12', type: 'O', target: '삼성전자', signal: '🔴', summary: '급락 매수 기회 — RSI 28' }];
  assert.equal(findThesisAlerts(journal, riskTrim).length, 0);
  assert.equal(findThesisAlerts(journal, riskBuy).length, 0);
});

test('B 🟡(논리 약화)는 경보, 같은 종목 O🔴가 있어도 B만 반영', () => {
  const journal = [pos('삼성전자')];
  const risk = [
    { date: '2026-06-12', type: 'O', target: '삼성전자', signal: '🔴', summary: '급락 매수' },
    { date: '2026-06-12', type: 'B', target: '삼성전자', signal: '🟡', summary: '영익률 약화' },
  ];
  const alerts = findThesisAlerts(journal, risk);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].signal.type, 'B');
  assert.equal(alerts[0].signal.signal, '🟡');
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

test('isThesisBreach·thesisAlertLabel: 🔴=훼손, 🟡=주의 (주문 가드와 동일 어휘)', () => {
  assert.equal(isThesisBreach('🔴 영익률 훼손'), true);
  assert.equal(isThesisBreach('🟡 영익 약화'), false);
  assert.equal(isThesisBreach(''), false);
  assert.equal(isThesisBreach(null), false);
  assert.equal(thesisAlertLabel('🔴 x'), '투자논리 훼손');
  assert.equal(thesisAlertLabel('🟡 x'), '논리 주의');
});
