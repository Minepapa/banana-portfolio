import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reprtCodeForDate, prevPeriod, computeYoY, parseKrAmounts, parseKrRatios, checkGuardrails,
  computeMacroChange, computeRsi14, compute52wPosition, computeFcfYield,
  computeTtmNetIncome, computeRoe, computePbr,
  computeDrawdownFromPeak, computeRallyFromTrough, parseNaverSise,
  computeBollingerBands,
} from './fundamentals.mjs';

// CLAUDE.md 데이터 기준 표: 1~3월=전년 사업, 4~5월=1Q, 6~8월=반기, 9~12월=3Q
test('reprtCodeForDate: 월→보고서 매핑', () => {
  assert.deepEqual(reprtCodeForDate(new Date('2026-02-15')), { bsnsYear: '2025', reprtCode: '11011' });
  assert.deepEqual(reprtCodeForDate(new Date('2026-05-01')), { bsnsYear: '2026', reprtCode: '11013' });
  assert.deepEqual(reprtCodeForDate(new Date('2026-06-11')), { bsnsYear: '2026', reprtCode: '11012' });
  assert.deepEqual(reprtCodeForDate(new Date('2026-10-01')), { bsnsYear: '2026', reprtCode: '11014' });
  assert.deepEqual(reprtCodeForDate(new Date('2026-12-20')), { bsnsYear: '2026', reprtCode: '11014' });
});

test('prevPeriod: 미공시 폴백 체인 (반기→1Q→전년 사업→전년 3Q)', () => {
  assert.deepEqual(prevPeriod({ bsnsYear: '2026', reprtCode: '11012' }), { bsnsYear: '2026', reprtCode: '11013' });
  assert.deepEqual(prevPeriod({ bsnsYear: '2026', reprtCode: '11013' }), { bsnsYear: '2025', reprtCode: '11011' });
  assert.deepEqual(prevPeriod({ bsnsYear: '2025', reprtCode: '11011' }), { bsnsYear: '2025', reprtCode: '11014' });
  assert.deepEqual(prevPeriod({ bsnsYear: '2026', reprtCode: '11014' }), { bsnsYear: '2026', reprtCode: '11012' });
});

test('computeYoY: 정상/0분모/결측', () => {
  assert.equal(computeYoY(1257119188891, 999544646065), 25.8);  // 삼바 1Q 실측
  assert.equal(computeYoY(100, 0), null);
  assert.equal(computeYoY(null, 100), null);
});

test('parseKrAmounts: CFS 우선, thstrm_add_amount 우선, 콤마 제거', () => {
  const list = [
    { fs_div: 'OFS', sj_div: 'IS', account_nm: '매출액', thstrm_amount: '1', frmtrm_amount: '1' },
    { fs_div: 'CFS', sj_div: 'IS', account_nm: '매출액', thstrm_add_amount: '1,257,119,188,891', frmtrm_add_amount: '999,544,646,065' },
    { fs_div: 'CFS', sj_div: 'IS', account_nm: '영업이익', thstrm_amount: '580,752,580,824', frmtrm_amount: '430,239,537,449' },
    { fs_div: 'CFS', sj_div: 'IS', account_nm: '당기순이익(손실)', thstrm_amount: '469,245,424,673', frmtrm_amount: '375,553,550,929' },
    { fs_div: 'CFS', sj_div: 'BS', account_nm: '부채총계', thstrm_amount: '4,072,163,846,703' },
    { fs_div: 'CFS', sj_div: 'BS', account_nm: '자본총계', thstrm_amount: '7,922,835,735,735' },
  ];
  const a = parseKrAmounts(list);
  assert.equal(a.revenue.curr, 1257119188891);
  assert.equal(a.revenue.prev, 999544646065);
  assert.equal(a.opIncome.curr, 580752580824);
  assert.equal(a.netIncome.curr, 469245424673);
  assert.equal(a.liabilities.curr, 4072163846703);
  assert.equal(a.equity.curr, 7922835735735);
});

test('parseKrAmounts: CFS 없으면 OFS 폴백', () => {
  const list = [{ fs_div: 'OFS', sj_div: 'IS', account_nm: '매출액', thstrm_amount: '100', frmtrm_amount: '50' }];
  assert.equal(parseKrAmounts(list).revenue.curr, 100);
});

test('parseKrRatios: 정확 매칭 — 유사명(총자산영업이익률·유동부채비율)에 오염 안 됨', () => {
  // 삼바 1Q 실측 응답 구조: 순수 '영업이익률'은 없고 유사명만 존재
  const list = [
    { idx_nm: '매출총이익률', idx_val: '54.085' },
    { idx_nm: '총자산영업이익률', idx_val: '5.038' },   // opMargin으로 잡히면 안 됨(과거 버그)
    { idx_nm: '자기자본영업이익률', idx_val: '7.555' },
    { idx_nm: 'ROE', idx_val: '6.104' },
    { idx_nm: '부채비율', idx_val: '51.398' },
    { idx_nm: '유동부채비율', idx_val: '34.584' },     // debtRatio로 잡히면 안 됨
  ];
  const r = parseKrRatios(list);
  assert.equal(r.grossMargin, 54.085);
  assert.equal(r.opMargin, null);       // 순수 영업이익률 부재 → null(페처가 금액으로 계산)
  assert.equal(r.roe, 6.104);
  assert.equal(r.debtRatio, 51.398);
  assert.deepEqual(parseKrRatios([]), { grossMargin: null, opMargin: null, roe: null, debtRatio: null, payoutRatio: null });
});

test('parseKrRatios: 현금배당성향 정확 매칭 (M310000 — KR 배당성향 폴백)', () => {
  const list = [
    { idx_nm: '현금배당성향', idx_val: '28.5' },
    { idx_nm: '배당성향', idx_val: '99.9' },  // 유사명 — 잡히면 안 됨
  ];
  assert.equal(parseKrRatios(list).payoutRatio, 28.5);
});

test('parseKrAmounts: 영업활동현금흐름 CF 항목 파싱', () => {
  const list = [
    { fs_div: 'CFS', sj_div: 'CF', account_nm: '영업활동현금흐름', thstrm_add_amount: '12,345,678', frmtrm_add_amount: '9,000,000' },
    { fs_div: 'CFS', sj_div: 'IS', account_nm: '매출액', thstrm_add_amount: '100', frmtrm_add_amount: '90' },
  ];
  const a = parseKrAmounts(list);
  assert.equal(a.operCf.curr, 12345678);
  assert.equal(a.operCf.prev, 9000000);
  assert.equal(a.revenue.curr, 100);  // IS 항목도 정상
});

test('computeTtmNetIncome: 직전연간 − 직전동기누적 + 당기누적 (누적값 기반 일반화)', () => {
  // SK하이닉스 26-1Q류: 직전연간 + 당기누적 급증 − 직전연도 동기누적 = TTM 75조대
  assert.equal(computeTtmNetIncome(40, 2, 37), 75);   // 37 − 2 + 40
  assert.equal(computeTtmNetIncome(null, 2, 37), null);
  assert.equal(computeTtmNetIncome(40, null, 37), null);
  assert.equal(computeTtmNetIncome(40, 2, null), null);
});

test('computeRoe: TTM순이익/기초자본 — 기초자본(직전사업연도말) 기준, 네이버 정합', () => {
  // SK하이닉스: TTM 75.19조 / 기초자본 120.67조 = 62.3% (네이버 61.6% 근사)
  assert.equal(computeRoe(7519, 12067), 62.3);
  assert.equal(computeRoe(469, 7922), 5.9);  // 일반 케이스
  assert.equal(computeRoe(null, 12067), null);
  assert.equal(computeRoe(7519, 0), null);    // 0 분모 방어
  assert.equal(computeRoe(7519, null), null);
});

test('computePbr: 시가총액/자기자본 — yfinance .KS priceToBook null 보강, 0·결측 방어', () => {
  assert.equal(computePbr(1.2e15, 4e14), 3);       // 1,200조 / 400조 = 3.00
  assert.equal(computePbr(2199.8e12, 400e12), 5.5);// 소수 둘째자리 반올림
  assert.equal(computePbr(1e15, 0), null);          // 0 분모(자본잠식 등)
  assert.equal(computePbr(1e15, -5e13), null);      // 음수 자본
  assert.equal(computePbr(null, 4e14), null);
  assert.equal(computePbr(1e15, null), null);
});

test('computeRallyFromTrough: 오늘 종가 vs 최근 N일 저점 상승폭 — USDKRW 급약세 포착', () => {
  // 저점 90 → 현재 110: (110-90)/90 = 22.22%
  assert.equal(computeRallyFromTrough([100, 90, 95, 99, 105, 110]), 22.22);
  // 단조 하락 → 현재가 곧 저점 → 상승폭 0
  assert.equal(computeRallyFromTrough([110, 105, 100]), 0);
  // window=2면 마지막 3개[100,105,110] 저점100 → +10
  assert.equal(computeRallyFromTrough([50, 100, 105, 110], 2), 10);
  // 데이터 부족 → null
  assert.equal(computeRallyFromTrough([100]), null);
  assert.equal(computeRallyFromTrough([]), null);
});

test('computeDrawdownFromPeak: 오늘 종가 vs 최근 N일 고점 낙폭 — 진행 중 급락 포착', () => {
  // 고점 110 → 현재 90: (90-110)/110 = -18.18%
  assert.equal(computeDrawdownFromPeak([100, 110, 105, 99, 95, 90]), -18.18);
  // 단조 상승 → 현재가 곧 고점 → 낙폭 0
  assert.equal(computeDrawdownFromPeak([90, 95, 100]), 0);
  // 이틀 누적 슬라이드(단일일 -5%씩, 끝점비교론 못 잡지만 고점 대비론 -10.5%)
  assert.equal(computeDrawdownFromPeak([100, 95, 89.5]), -10.5);
  // window 밖 더 높은 값은 무시: window=2면 마지막 3개[100,95,90] 고점100 → -10
  assert.equal(computeDrawdownFromPeak([200, 100, 95, 90], 2), -10);
  // 데이터 부족 → null
  assert.equal(computeDrawdownFromPeak([100]), null);
  assert.equal(computeDrawdownFromPeak([]), null);
});

test('parseNaverSise: 네이버 siseJson JS배열 → 종가 시계열(과거→현재), 헤더·결측 방어', () => {
  const raw = "[['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],\n"
    + '["20240102", 2645.47, 2675.8, 2641.88, 2669.81, 409872, 0.0],\n'
    + '["20240103", 2643.54, 2643.72, 2607.31, 2607.31, 463132, 0.0],]';
  assert.deepEqual(parseNaverSise(raw), [2669.81, 2607.31]);
  assert.deepEqual(parseNaverSise(''), []);
  assert.deepEqual(parseNaverSise('garbage'), []);
});

test('computeMacroChange: 현재값=마지막 종가, 변화율=5거래일 전 대비', () => {
  // 10개 종가, 5거래일 전(인덱스 -6)=100 → 현재 105 = +5%
  assert.deepEqual(computeMacroChange([90, 95, 98, 99, 100, 101, 102, 103, 104, 105]),
    { value: 105, change5d: 5 });
  // NaN/공백 섞여도 유한값만; 6개 미만이면 변화율 null
  assert.deepEqual(computeMacroChange([100, 110]), { value: 110, change5d: null });
  assert.deepEqual(computeMacroChange([]), { value: null, change5d: null });
  // 소수 둘째자리 반올림
  assert.equal(computeMacroChange([1500, 1, 1, 1, 1, 1521.7]).change5d, 1.45);
});

test('checkGuardrails: 영업이익 2분기 연속 감소 / 부채비율 +20%p', () => {
  assert.deepEqual(checkGuardrails({ opYoYCurr: -5, opYoYPrev: -3, debtRatio: 51, baselineDebtRatio: 50 }),
    ['영업이익 YoY 2분기 연속 감소']);
  assert.deepEqual(checkGuardrails({ opYoYCurr: 10, opYoYPrev: -3, debtRatio: 75, baselineDebtRatio: 50 }),
    ['부채비율 급증(기준선 대비 +20%p 이상)']);
  assert.deepEqual(checkGuardrails({ opYoYCurr: 10, opYoYPrev: null, debtRatio: null, baselineDebtRatio: 50 }), []);
});

test('computeRsi14: Wilder 평활 RSI — 표준 14기간', () => {
  // 첫 상승만 있는 단조 증가 → RSI 100 수렴
  const up = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.equal(computeRsi14(up), 100);
  // 단조 하락 → RSI 0 수렴
  const down = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.equal(computeRsi14(down), 0);
  // 15개 미만(계산 불가) → null
  assert.equal(computeRsi14([1, 2, 3]), null);
  const sample = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
                  45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
  // Wilder 평활 RSI(14)를 최신 종가 기준으로 산출 — 이 20개 종가열의 마지막 시점 값 = 57.92
  assert.equal(computeRsi14(sample), 57.92);
});

test('compute52wPosition: (현재-저)/(고-저)*100, 경계·결측 방어', () => {
  assert.equal(compute52wPosition(150, 200, 100), 50);   // 중앙
  assert.equal(compute52wPosition(200, 200, 100), 100);  // 고점
  assert.equal(compute52wPosition(100, 200, 100), 0);    // 저점
  assert.equal(compute52wPosition(150, 100, 100), null); // 고=저(0 분모)
  assert.equal(compute52wPosition(null, 200, 100), null);
});

test('computeFcfYield: FCF/시총*100, 결측·0분모 → null', () => {
  assert.equal(computeFcfYield(5e9, 1e11), 5);
  assert.equal(computeFcfYield(-1e9, 1e11), -1);
  assert.equal(computeFcfYield(5e9, 0), null);
  assert.equal(computeFcfYield(null, 1e11), null);
});

test('computeBollingerBands: 정상 계산 (MA, sigma, upper, lower, zscore)', () => {
  // 250개 종가: 1300~1500 범위, 평균 1400
  const closes = Array.from({ length: 250 }, (_, i) => 1300 + (i % 5) * 50);
  const b = computeBollingerBands(closes);
  assert.notEqual(b, null);
  assert.equal(b.window, 250);
  assert.equal(typeof b.ma, 'number');
  assert.equal(typeof b.sigma, 'number');
  assert.ok(b.upper > b.ma);
  assert.ok(b.lower < b.ma);
  assert.ok(b.upper === b.ma + 2 * b.sigma || Math.abs(b.upper - (b.ma + 2 * b.sigma)) < 0.02);
});

test('computeBollingerBands: 데이터 부족 시 null (window 절반 미만)', () => {
  assert.equal(computeBollingerBands(Array(124).fill(1400)), null);
  assert.equal(computeBollingerBands([]), null);
  assert.equal(computeBollingerBands(null), null);
});

test('computeBollingerBands: zscore 방향 — 현재가 MA 위면 양수', () => {
  // 200개 1400 + 마지막 50개 1500 → 평균 ~1425, 현재 1500 → z > 0
  const closes = [...Array(200).fill(1400), ...Array(50).fill(1500)];
  const b = computeBollingerBands(closes);
  assert.ok(b.zscore > 0);
});

test('computeBollingerBands: 커스텀 window', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 1380 + i);
  const b = computeBollingerBands(closes, 60);
  assert.notEqual(b, null);
  assert.equal(b.window, 60);
});
