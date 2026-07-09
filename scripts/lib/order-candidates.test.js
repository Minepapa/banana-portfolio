import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHoldingRows, latestConclusions, convictionMap, latestRiskByType,
  buildRebalanceCandidates, buildCrashBuyCandidates, buildSellFromThesis, buildBuyFromEval,
  checkConstraints, makeMatchKey, RULE500_WON,
} from './order-candidates.mjs';

// ── 픽스처 헬퍼 ──────────────────────────────────────────────────────────────
// 종목투자노트 행: idx1=종목명, idx0=날짜, idx4=결론, idx14=상태
const nrow = (date, name, concl, status = '') => {
  const r = []; r[0] = date; r[1] = name; r[4] = concl; r[14] = status; return r;
};
// 포지션저널 행: idx0=종목명, idx4=유형, idx10=상태
const jrow = (name, kind, status = '보유') => {
  const r = []; r[0] = name; r[4] = kind; r[10] = status; return r;
};
// 리스크모니터 행: idx0=날짜, idx1=유형, idx2=대상, idx3=신호, idx4=요약
const rrow = (date, type, target, signal, summary = '') => [date, type, target, signal, summary];
// 체결내역 행: idx0=날짜, idx1=구분, idx5=종목명
const trow = (date, side, name) => { const r = []; r[0] = date; r[1] = side; r[5] = name; return r; };

test('parseHoldingRows: 병합 자산군 유지·현금성 제외·단가는 평가금/수량(KRW)', () => {
  const rows = [
    ['현금성', '예수금', '', '', '1000000', '', '', '1000000'],
    ['국내주식', '삼성전자', '', '40', '', '', '', '11020000'],
    ['', 'SK하이닉스', '', '5', '', '', '', '10770000'],    // 자산군 병합(빈칸) → 국내주식 유지
    ['달러', '외화 RP', '', '1869', '', '', '', '2808504'],  // 현금성 제외
  ];
  const h = parseHoldingRows('위탁', rows);
  assert.equal(h.length, 2);
  assert.equal(h[0].name, '삼성전자');
  assert.equal(h[0].unitKrw, 275500);
  assert.equal(h[1].assetType, '국내주식');   // 병합 유지
});

test('latestConclusions: 종목별 최신 카드·이모지 판별·매도 카드 표시', () => {
  const m = latestConclusions([
    nrow('2026-06-01', '삼성전자', '🟡 매수관망'),
    nrow('2026-07-01', '삼성전자', '🟢 유효'),
    nrow('2026-07-05', '현대차', '🔴 부적합', '매도'),
  ]);
  assert.equal(m.get('삼성전자').emoji, '🟢');
  assert.equal(m.get('삼성전자').date, '2026-07-01');
  assert.equal(m.get('현대차').isSell, true);
  assert.equal(m.get('현대차').emoji, '🔴');
});

test('convictionMap: 청산 제외·미기재는 배분', () => {
  const m = convictionMap([
    jrow('SK하이닉스', '확신'),
    jrow('현대차', ''),
    jrow('옛종목', '확신', '청산'),
  ]);
  assert.equal(m.get('SK하이닉스'), '확신');
  assert.equal(m.get('현대차'), '배분');
  assert.equal(m.has('옛종목'), false);
});

test('buildRebalanceCandidates: 초과 자산군 매도 — 확신 제외·평가 나쁜 순 선정·수량=갭/단가', () => {
  const holdings = [
    { acct: '위탁', name: 'SK하이닉스', assetType: '국내주식', qty: 5, evalWon: 10770000, unitKrw: 2154000 },
    { acct: '위탁', name: '현대차', assetType: '국내주식', qty: 8, evalWon: 3856000, unitKrw: 482000 },
    { acct: '위탁', name: '삼성전자', assetType: '국내주식', qty: 40, evalWon: 11020000, unitKrw: 275500 },
  ];
  const conviction = new Map([['SK하이닉스', '확신'], ['현대차', '배분'], ['삼성전자', '배분']]);
  const conclusions = new Map([['현대차', { emoji: '🟡', date: '2026-07-05' }]]);   // 삼성전자 무평가
  const gaps = [{ acct: '위탁', assetType: '국내주식', targetPct: 30, currentPct: 36, rebalAmt: -1500000 }];
  const out = buildRebalanceCandidates({ gaps, holdings, conviction, conclusions });
  assert.equal(out.length, 1);
  assert.equal(out[0].side, '매도');
  assert.equal(out[0].name, '현대차');            // 확신(SK하이닉스) 제외, 🟡 > 무평가 우선
  assert.equal(out[0].qty, 3);                    // floor(1,500,000 / 482,000)
  assert.equal(out[0].amount, 3 * 482000);
});

test('buildRebalanceCandidates: 부족 자산군 매수 — 기존 최대 보유에 적립', () => {
  const holdings = [
    { acct: '위탁', name: 'TIGER 리츠', assetType: '리츠', qty: 350, evalWon: 3333750, unitKrw: 9525 },
  ];
  const gaps = [{ acct: '위탁', assetType: '리츠', targetPct: 5, currentPct: -1, rebalAmt: 2859512 }];
  const out = buildRebalanceCandidates({ gaps, holdings, conviction: new Map(), conclusions: new Map() });
  assert.equal(out.length, 1);
  assert.equal(out[0].side, '매수');
  assert.equal(out[0].qty, Math.floor(2859512 / 9525));
});

test('buildRebalanceCandidates: 갭 5%p 미만·풀 전체 확신이면 후보 없음', () => {
  const holdings = [{ acct: '위탁', name: 'SK하이닉스', assetType: '국내주식', qty: 5, evalWon: 1e7, unitKrw: 2e6 }];
  const conviction = new Map([['SK하이닉스', '확신']]);
  assert.equal(buildRebalanceCandidates({
    gaps: [{ acct: '위탁', assetType: '국내주식', targetPct: 30, currentPct: 33, rebalAmt: -1e6 }],
    holdings, conviction, conclusions: new Map(),
  }).length, 0);   // 3%p < 트리거
  assert.equal(buildRebalanceCandidates({
    gaps: [{ acct: '위탁', assetType: '국내주식', targetPct: 30, currentPct: 37, rebalAmt: -1e6 }],
    holdings, conviction, conclusions: new Map(),
  }).length, 0);   // 유일 후보가 확신 → 매도 안 함
});

test('buildCrashBuyCandidates: O🔴만·500만/예수금 이내 수량·보유 계좌로', () => {
  const oSignals = latestRiskByType([
    rrow('2026-07-09', 'O', '현대차', '🔴', '급락 매수 기회 — 5일 -12%'),
    rrow('2026-07-09', 'O', '삼성전자', '🟢', '트리거 없음'),
  ], 'O');
  const holdings = [{ acct: '위탁', name: '현대차', assetType: '국내주식', qty: 8, evalWon: 3856000, unitKrw: 482000 }];
  const out = buildCrashBuyCandidates({ oSignals, holdings, cash: { 위탁: 1200000 } });
  assert.equal(out.length, 1);                     // 🟢 제외
  assert.equal(out[0].qty, 2);                     // floor(min(5M, 1.2M)/482,000)
  assert.equal(out[0].acct, '위탁');
});

test('buildSellFromThesis: 매도평가 🔴 있으면 전량 매도, 없으면 매도평가 의뢰', () => {
  const bSignals = latestRiskByType([
    rrow('2026-07-06', 'B', '현대차', '🔴', '수익성 훼손'),
    rrow('2026-07-06', 'B', '테슬라', '🔴', '전제 붕괴'),
  ], 'B');
  const holdings = [
    { acct: '위탁', name: '현대차', assetType: '국내주식', qty: 8, evalWon: 3856000, unitKrw: 482000 },
    { acct: '위탁', name: '테슬라', assetType: '해외주식', qty: 23, evalWon: 13620357, unitKrw: 592189 },
  ];
  const conclusions = new Map([['현대차', { date: '2026-07-08', emoji: '🔴', isSell: true }]]);
  const { candidates, evalRequests } = buildSellFromThesis({
    bSignals, holdings, conviction: new Map(), conclusions,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, '현대차');
  assert.equal(candidates[0].qty, 8);              // 전량
  assert.equal(evalRequests.length, 1);
  assert.equal(evalRequests[0].name, '테슬라');    // 카드 없음 → 의뢰
});

test('buildBuyFromEval: 🟢 후 미매수만·미보유는 price null(잡이 해결)', () => {
  const conclusions = new Map([
    ['삼성전자', { date: '2026-07-01', emoji: '🟢', isSell: false }],   // 이후 매수함 → 제외
    ['가온전선', { date: '2026-07-01', emoji: '🟢', isSell: false }],   // 미보유·미매수 → 후보(price null)
    ['현대차', { date: '2026-07-05', emoji: '🟡', isSell: false }],     // 🟢 아님 → 제외
  ]);
  const execRows = [trow('2026-07-03 10:00', '매수', '삼성전자')];
  const out = buildBuyFromEval({ conclusions, execRows, holdings: [], cash: { 위탁: 3000000 } });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, '가온전선');
  assert.equal(out[0].price, null);
  assert.equal(out[0].qty, null);
});

test('checkConstraints: 매수 예수금·500만(확신 예외)·매도 확신보호', () => {
  const conviction = new Map([['SK하이닉스', '확신']]);
  // 예수금 부족 → ✗
  const c1 = checkConstraints({ side: '매수', acct: '위탁', name: '삼성전자', amount: 2000000 },
    { cash: { 위탁: 1000000 }, conviction });
  assert.equal(c1.find(x => x.k === '예수금').ok, false);
  // 500만 초과 + 확신 → ok(예외 라벨)
  const c2 = checkConstraints({ side: '매수', acct: '위탁', name: 'SK하이닉스', amount: 6000000 },
    { cash: { 위탁: 10000000 }, conviction });
  const rule = c2.find(x => x.k === '500만원칙');
  assert.equal(rule.ok, true);
  assert.match(rule.d, /확신/);
  // 확신 종목 매도 → ✗ 플래그
  const c3 = checkConstraints({ side: '매도', acct: '위탁', name: 'SK하이닉스' }, { cash: {}, conviction });
  assert.equal(c3.find(x => x.k === '확신보호').ok, false);
});

test('날짜 시리얼 방어: 평가일이 시리얼이어도 이후 매수를 정확히 감지 (사전순 비교 버그 회귀)', () => {
  // 46193 = 2026-06-20. 시리얼 그대로면 '2026-07-03' >= '46193' 이 사전순으로 false 가 되어
  // 매수했는데도 "미매수"로 오판 → 중복 매수 제안이 나가는 버그(2026-07-10 실측 발견).
  const conclusions = latestConclusions([nrow('46193', '삼성전자', '🟢 유효')]);
  assert.equal(conclusions.get('삼성전자').date, '2026-06-20');   // 시리얼 → ISO
  const execRows = [trow('2026-07-03 10:00', '매수', '삼성전자')];
  const out = buildBuyFromEval({ conclusions, execRows, holdings: [], cash: { 위탁: 3000000 } });
  assert.equal(out.length, 0);   // 평가 후 매수했으므로 제안 없음
});

test('makeMatchKey + RULE500 상수', () => {
  assert.equal(makeMatchKey({ acct: '위탁', name: '삼성전자', side: '매수' }), '위탁|삼성전자|매수');
  assert.equal(RULE500_WON, 5000000);
});
