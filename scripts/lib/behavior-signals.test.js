import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBehaviorSignals } from './behavior-signals.mjs';

// 체결내역: A날짜0 B구분1 C계좌2 D코드3 E자산군4 F종목명5 G체결가6 H수량7 I금액8 J현재가9 K손익10 L평가11 M수익률12
const baseInput = () => ({
  asof: '2026-06-14',
  weekStart: '2026-06-08',
  tradeRows: [
    // 매입평균 산출용 사전 매수 (매도일 이전)
    ['2026-04-10', '매수', '위탁', '000660', '국내주식', 'SK하이닉스', '2000000', '5', '10000000', '', '', '', ''],   // 하이닉스 매입평균 200만
    ['2026-04-15', '매수', '위탁', 'AAPL', '해외주식', '애플', '502000', '2', '1004000', '', '', '', ''],            // 애플 매입평균 502,000
    // 이번 주 매도 (M열 수익률은 포지션 스냅샷이라 무시, 실현수익률은 매입평균 대비 산출)
    ['2026-06-12', '매도', '위탁', '000660', '국내주식', 'SK하이닉스', '2280000', '5', '11400000', '', '', '', '-5.7%'],  // 실현 +14% (228만 vs 200만)
    ['2026-06-09', '매도', '위탁', 'AAPL', '해외주식', '애플', '477425', '2', '954850', '', '', '', '-7.4%'],            // 실현 -4.9% (477,425 vs 502,000)
    // 이번 주 매수
    ['2026-06-09', '매수', '위탁', 'GOOGL', '해외주식', '알파벳 Class A', '550555', '2', '1101110', '', '', '', ''],
    ['2026-06-08', '매수', 'ISA', '0', '배당주', 'TIME Korea플러스배당액티브', '33350', '15', '500250', '', '', '', ''],
    ['2026-05-20', '매수', '위탁', '005930', '국내주식', '삼성전자', '60000', '100', '6000000', '', '', '', ''],  // 500만 초과
  ],
  // 종목투자노트: A날짜0 B종목1 ... E결론4 ... O상태14
  noteRows: [
    ['2026-05-25', '삼성바이오로직스', '207940', 'KR', '🟢 유효', '', '', '', '', '', '1) 5공장', '', '', '', '보류'],  // 🟢인데 미매수(30일 경과 임박)
    ['2026-06-10', 'SK하이닉스', '000660', 'KR', '🟢 유효', '', '', '', '', '', '1) HBM', '', '', '', '매수'],
  ],
  // 포지션저널: A종목0 ... K상태10 L청산일11 M청산결과12 N교훈13
  journalRows: [
    ['엔비디아', 'NVDA', 'US', '위탁', '확신', '전제', '목표', '이탈', '예상', '진입', '청산', '2026-06-11', '+30% 익절', '목표 도달 후 미련 없이 분할 매도한 것이 주효', '확인', ''],
    ['테슬라', 'TSLA', 'US', '위탁', '배분', '전제', '목표', '이탈', '예상', '진입', '보유', '', '', '', '미작성', ''],
  ],
  riskRows: [
    ['2026-06-13 16:30', 'B', '마이크로소프트', '🔴', '논리 훼손 우려', '...', '{}', ''],
  ],
});

test('buildBehaviorSignals: 이번 주 매수/매도 분리', () => {
  const { signals } = buildBehaviorSignals(baseInput());
  assert.equal(signals.week.sells.length, 2);   // 6/12 하이닉스, 6/9 애플
  assert.equal(signals.week.buys.length, 2);    // 6/9 알파벳, 6/8 TIME (5/20 삼성·4월 매수는 weekStart 이전)
});

test('buildBehaviorSignals: 실현수익률은 M열 아닌 체결이력 매입평균 대비로 산출', () => {
  const { signals } = buildBehaviorSignals(baseInput());
  const hynix = signals.week.sells.find(s => s.name === 'SK하이닉스');
  assert.equal(hynix.avgBuy, 2000000);          // 4/10 매수 200만
  assert.equal(hynix.realizedPct, 14);          // (2,280,000-2,000,000)/2,000,000 = +14% (M열 -5.7% 무시)
});

test('buildBehaviorSignals: 익절/손절 분류 (실현수익률 부호)', () => {
  const { signals } = buildBehaviorSignals(baseInput());
  assert.equal(signals.takeProfit.count, 1);   // 하이닉스 +14%
  assert.equal(signals.stopLoss.count, 1);     // 애플 -4.9%
  assert.equal(signals.takeProfit.avgPct, 14);
});

test('buildBehaviorSignals: 500만 원칙 — 초과 매수 감지(최근 90일)', () => {
  const { signals } = buildBehaviorSignals(baseInput());
  // 최근 90일 매수 5건(4/10·4/15·5/20·6/8·6/9) 중 하이닉스 1000만·삼성 600만 초과 → 위반 2
  assert.equal(signals.rule500.total, 5);
  assert.equal(signals.rule500.violations.length, 2);
  const names = signals.rule500.violations.map(v => v.name);
  assert.ok(names.includes('삼성전자') && names.includes('SK하이닉스'));
});

test('buildBehaviorSignals: 🟢 평가 후 미매수(망설임) 감지', () => {
  const { signals } = buildBehaviorSignals(baseInput());
  // 삼성바이오로직스 🟢(5/25, status 보류) + 30일 내 매수 없음 → missedGreen
  // SK하이닉스 🟢는 status 매수 → 제외
  assert.ok(signals.missedGreen.some(m => m.name === '삼성바이오로직스'));
  assert.ok(!signals.missedGreen.some(m => m.name === 'SK하이닉스'));
});

test('buildBehaviorSignals: 🔴 리스크 보유 지속(미련) 감지', () => {
  const { signals } = buildBehaviorSignals(baseInput());
  assert.ok(signals.unsoldRed.some(u => u.name === '마이크로소프트'));
});

test('buildBehaviorSignals: 청산 교훈 수집', () => {
  const { signals } = buildBehaviorSignals(baseInput());
  assert.equal(signals.lessons.length, 1);   // 엔비디아만 청산+교훈
  assert.equal(signals.lessons[0].name, '엔비디아');
  assert.ok(signals.lessons[0].lesson.includes('분할 매도'));
});

test('buildBehaviorSignals: signalsText에 증거가 포함되고 추정 표현이 없다', () => {
  const { signalsText } = buildBehaviorSignals(baseInput());
  assert.ok(signalsText.includes('SK하이닉스'));
  assert.ok(signalsText.includes('엔비디아'));
  assert.ok(!/추정/.test(signalsText));
});

test('buildBehaviorSignals: 빈 입력도 안전', () => {
  const { signals } = buildBehaviorSignals({ asof: '2026-06-14', weekStart: '2026-06-08' });
  assert.equal(signals.week.buys.length, 0);
  assert.equal(signals.lessons.length, 0);
});
