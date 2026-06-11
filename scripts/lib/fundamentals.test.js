import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reprtCodeForDate, prevPeriod, computeYoY, parseKrAmounts, parseKrRatios, checkGuardrails,
  computeMacroChange,
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
  assert.deepEqual(parseKrRatios([]), { grossMargin: null, opMargin: null, roe: null, debtRatio: null });
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
