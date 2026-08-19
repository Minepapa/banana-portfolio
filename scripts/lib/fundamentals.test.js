import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reprtCodeForDate, prevPeriod, standaloneAmounts, quarterStandalone, computeYoY, parseKrAmounts, parseKrRatios, checkGuardrails,
  computeMacroChange, computeRsi14, compute52wPosition, computeFcfYield,
  computeTtmNetIncome, computeRoe, computePbr,
  computeDrawdownFromPeak, computeRallyFromTrough,
  computeBollingerBands,
  computeMacd, computeMaAlignment, computeAtr, computeStochastic, computeVolumeSurge,
  dropSignal, disclosureDateFromRceptNo, extractOcf, extractNetIncome,
  periodEndDate, isSuspiciouslyLateDisclosure, matchOriginalDisclosure, fetchCfListWithDisclosureDate,
  overlayKrxPriceData,
} from './fundamentals.mjs';

// CLAUDE.md 데이터 기준 표: 1~3월=전년 사업, 4~5월=1Q, 6~8월=반기, 9~12월=3Q
test('reprtCodeForDate: 월→보고서 매핑', () => {
  assert.deepEqual(reprtCodeForDate(new Date('2026-02-15')), { bsnsYear: '2025', reprtCode: '11011' });
  assert.deepEqual(reprtCodeForDate(new Date('2026-05-01')), { bsnsYear: '2026', reprtCode: '11013' });
  assert.deepEqual(reprtCodeForDate(new Date('2026-06-11')), { bsnsYear: '2026', reprtCode: '11012' });
  assert.deepEqual(reprtCodeForDate(new Date('2026-10-01')), { bsnsYear: '2026', reprtCode: '11014' });
  assert.deepEqual(reprtCodeForDate(new Date('2026-12-20')), { bsnsYear: '2026', reprtCode: '11014' });
});

// disclosureDateFromRceptNo — 구현계획서 Phase 9(퀀트 OCF/P 룩어헤드 방지)에서 추가.
// OpenDart rcept_no 앞 8자리 = 접수일자(YYYYMMDD), 실측 확인(2026-08-07, 삼성전자
// 2026 1분기보고서 rcept_no="20260515002181" → 공시일 2026-05-15).
test('disclosureDateFromRceptNo: 앞 8자리를 YYYY-MM-DD로 변환(실측 삼성전자 1분기 사례)', () => {
  assert.equal(disclosureDateFromRceptNo('20260515002181'), '2026-05-15');
});

test('disclosureDateFromRceptNo: 형식이 안 맞으면(8자리 숫자로 시작 안 함) null', () => {
  assert.equal(disclosureDateFromRceptNo('abc'), null);
  assert.equal(disclosureDateFromRceptNo(''), null);
  assert.equal(disclosureDateFromRceptNo(null), null);
  assert.equal(disclosureDateFromRceptNo(undefined), null);
});

// extractOcf — fnlttSinglAcnt.json(주요계정)은 현금흐름표를 아예 안 줘서(2026-08-07
// 실측 확인) fnlttSinglAcntAll.json(전체 재무제표)의 CF 섹션에서 뽑아야 한다.
test('extractOcf: CF 섹션의 영업활동현금흐름 항목에서 금액 추출(실측 삼성전자 사례, 콤마 포함 문자열)', () => {
  const list = [
    { sj_div: 'BS', account_nm: '유동자산', thstrm_amount: '1000' },
    { sj_div: 'CF', account_nm: '영업활동현금흐름', thstrm_amount: '85,315,148,000,000' },
  ];
  assert.equal(extractOcf(list), 85315148000000);
});

test('extractOcf: 표기가 소폭 달라도("영업활동으로 인한 현금흐름") 부분일치로 찾음', () => {
  const list = [{ sj_div: 'CF', account_nm: '영업활동으로 인한 현금흐름', thstrm_amount: '1,000' }];
  assert.equal(extractOcf(list), 1000);
});

// 코드리뷰 지적 회귀방지(2026-08-07): "영업활동으로 인한 자산·부채의 변동"(하위 항목,
// 이름에 "영업활동"이 포함됨) 같은 항목이 실제 합계보다 먼저 나와도, IFRS 표준계정코드가
// 있으면 그걸 최우선으로 써서 하위 항목에 안 낚인다.
test('extractOcf: 하위 항목("...변동")이 합계보다 먼저 나와도 IFRS 표준코드로 정확히 합계를 찾음', () => {
  const list = [
    { sj_div: 'CF', account_id: 'dart_IncreaseDecreaseInOperatingAssetsAndLiabilities', account_nm: '영업활동으로 인한 자산·부채의 변동', thstrm_amount: '999' },
    { sj_div: 'CF', account_id: 'ifrs-full_CashFlowsFromUsedInOperatingActivities', account_nm: '영업활동현금흐름', thstrm_amount: '85,315,148,000,000' },
  ];
  assert.equal(extractOcf(list), 85315148000000);
});

test('extractOcf: 표준코드가 없는 경우에도 "변동" 하위 항목은 이름 매칭에서 제외', () => {
  const list = [
    { sj_div: 'CF', account_nm: '영업활동으로 인한 자산·부채의 변동', thstrm_amount: '999' },
    { sj_div: 'CF', account_nm: '영업활동현금흐름', thstrm_amount: '1,000' },
  ];
  assert.equal(extractOcf(list), 1000);
});

test('extractOcf: CF 섹션이 아예 없으면(주요계정 API 등) null', () => {
  const list = [{ sj_div: 'BS', account_nm: '유동자산', thstrm_amount: '1000' }];
  assert.equal(extractOcf(list), null);
});

test('extractOcf: 빈 배열·undefined는 null(크래시 없음)', () => {
  assert.equal(extractOcf([]), null);
  assert.equal(extractOcf(undefined), null);
});

// extractNetIncome — PEAD(실적서프라이즈) 진단(2026-08-09)용. 실측 검증(LS·CJ·한국전력·
// SK텔레콤, fnlttSinglAcntAll.json IS/CIS 섹션): 표준코드 접두사가 ifrs_/ifrs-full_ 두 가지로
// 갈리고, IS·CIS 두 섹션에 같은 항목이 값 동일하게 중복 등장하며, "지배기업 소유주 귀속"·
// "비지배지분 귀속" 항목은 총액이 아니라 배제해야 한다.
test('extractNetIncome: 표준코드(ifrs_ProfitLoss)로 총 당기순이익 추출(실측 LS 2018 사업보고서 사례)', () => {
  const list = [
    { sj_div: 'CIS', account_id: 'ifrs_ProfitLossBeforeTax', account_nm: '법인세비용차감전순이익', thstrm_amount: '275,082,000,000' },
    { sj_div: 'CIS', account_id: 'ifrs_ProfitLoss', account_nm: '당기순이익', thstrm_amount: '487,659,000,000' },
    { sj_div: 'CIS', account_id: 'ifrs_ProfitLossAttributableToOwnersOfParent', account_nm: '지배기업의 소유주에게 귀속되는 당기순이익(손실)', thstrm_amount: '404,149,000,000' },
    { sj_div: 'CIS', account_id: 'ifrs_ProfitLossAttributableToNoncontrollingInterests', account_nm: '비지배지분에 귀속되는 당기순이익(손실)', thstrm_amount: '83,510,000,000' },
  ];
  assert.equal(extractNetIncome(list), 487659000000);
});

test('extractNetIncome: 표준코드 접두사가 ifrs-full_인 경우도 매칭(실측 SK텔레콤 2019Q3 사례, "분기순이익" 표기)', () => {
  const list = [{ sj_div: 'CIS', account_id: 'ifrs-full_ProfitLoss', account_nm: '분기순이익', thstrm_amount: '274,425,000,000' }];
  assert.equal(extractNetIncome(list), 274425000000);
});

test('extractNetIncome: 표준코드 없으면 이름 전체일치("당기순이익(손실)")로 폴백, 부분항목엔 안 낚임', () => {
  const list = [
    { sj_div: 'IS', account_nm: '지배기업의 소유주에게 귀속되는 당기순이익(손실)', thstrm_amount: '999' },
    { sj_div: 'IS', account_nm: '당기순이익(손실)', thstrm_amount: '216,000,333,000' },
  ];
  assert.equal(extractNetIncome(list), 216000333000);
});

test('extractNetIncome: IS·CIS 섹션 외(BS 등)는 무시, 매치 없으면 null', () => {
  const list = [{ sj_div: 'BS', account_nm: '당기순이익(손실)', thstrm_amount: '999' }];
  assert.equal(extractNetIncome(list), null);
});

test('extractNetIncome: 빈 배열·undefined는 null(크래시 없음)', () => {
  assert.equal(extractNetIncome([]), null);
  assert.equal(extractNetIncome(undefined), null);
});

// 정정공시로 공시일이 밀리는 문제 대응(2026-08-09, LS 006260 실측 발견 — 2017~2020년
// 4개년치가 전부 2021-08-31 하루로 밀려 4년간 2016년 OCF를 재사용한 버그).
test('periodEndDate: 분기 마감일(1Q=3/31, 반기=6/30, 3Q=9/30, 사업=12/31)', () => {
  assert.equal(periodEndDate({ bsnsYear: '2017', reprtCode: '11013' }).toISOString().slice(0, 10), '2017-03-31');
  assert.equal(periodEndDate({ bsnsYear: '2017', reprtCode: '11012' }).toISOString().slice(0, 10), '2017-06-30');
  assert.equal(periodEndDate({ bsnsYear: '2017', reprtCode: '11014' }).toISOString().slice(0, 10), '2017-09-30');
  assert.equal(periodEndDate({ bsnsYear: '2017', reprtCode: '11011' }).toISOString().slice(0, 10), '2017-12-31');
});

test('isSuspiciouslyLateDisclosure: 법정기한 근처(45~90일)의 정상 공시는 의심 안 함', () => {
  // 1분기(3/31 마감) 45일 후 공시 — 정상
  assert.equal(isSuspiciouslyLateDisclosure('2017-05-15', { bsnsYear: '2017', reprtCode: '11013' }), false);
});

test('isSuspiciouslyLateDisclosure: 마감일로부터 150일 넘게 지나면 의심(실측 LS 사례 — 2017 1분기가 2021-08-31에 "공시"됨)', () => {
  assert.equal(isSuspiciouslyLateDisclosure('2021-08-31', { bsnsYear: '2017', reprtCode: '11013' }), true);
});

test('isSuspiciouslyLateDisclosure: 공시일 결측이면 판단 자체를 skip(false)', () => {
  assert.equal(isSuspiciouslyLateDisclosure(null, { bsnsYear: '2017', reprtCode: '11013' }), false);
});

test('matchOriginalDisclosure: report_nm 정확 일치로 원본만 찾고 "[기재정정]" 접두사 붙은 정정본은 배제(실측 LS list.json 응답 형태)', () => {
  const list = [
    { rcept_no: '20210831001729', rcept_dt: '20210831', report_nm: '[기재정정]분기보고서 (2017.03)' },
    { rcept_no: '20170515003882', rcept_dt: '20170515', report_nm: '분기보고서 (2017.03)' },
  ];
  const found = matchOriginalDisclosure(list, { bsnsYear: '2017', reprtCode: '11013' });
  assert.equal(found.rcept_no, '20170515003882');
});

test('matchOriginalDisclosure: 다른 분기·연도의 보고서명은 매칭 안 됨(부분일치 방지)', () => {
  const list = [{ rcept_no: '1', report_nm: '반기보고서 (2017.06)' }, { rcept_no: '2', report_nm: '사업보고서 (2016.12)' }];
  assert.equal(matchOriginalDisclosure(list, { bsnsYear: '2017', reprtCode: '11013' }), null);
});

test('matchOriginalDisclosure: 매칭 없으면(원본 자체가 목록 창 밖) null(추정 안 함)', () => {
  assert.equal(matchOriginalDisclosure([], { bsnsYear: '2017', reprtCode: '11013' }), null);
});

// 완전일치 대신 시작·포함 매칭으로 바꾼 회귀 방지(코드리뷰 지적, 2026-08-09) — 뒤에 추가
// 태그가 붙는 변형이 있어도 원본을 놓치지 않아야 이 수정 전체의 효과가 유지된다.
test('matchOriginalDisclosure: report_nm 뒤에 추가 태그가 붙어도(예: "(신규상장법인)") 원본으로 인식', () => {
  const list = [{ rcept_no: '20170515003882', report_nm: '분기보고서 (2017.03) (신규상장법인)' }];
  const found = matchOriginalDisclosure(list, { bsnsYear: '2017', reprtCode: '11013' });
  assert.equal(found.rcept_no, '20170515003882');
});

test('matchOriginalDisclosure: "[기재정정]" 외 다른 대괄호 접두사(예: "[첨부정정]")도 startsWith에서 자동 배제', () => {
  const list = [
    { rcept_no: '20210831999999', report_nm: '[첨부정정]분기보고서 (2017.03)' },
    { rcept_no: '20170515003882', report_nm: '분기보고서 (2017.03)' },
  ];
  const found = matchOriginalDisclosure(list, { bsnsYear: '2017', reprtCode: '11013' });
  assert.equal(found.rcept_no, '20170515003882');
});

// fetchCfListWithDisclosureDate — 이상치 감지→list.json 보정→폴백 배선 자체의 회귀방지
// (코드리뷰 지적, 2026-08-09 — 하위 순수함수는 다 테스트됐지만 이 배선은 무방비였음).
// fetchList·fetchOriginal 주입으로 네트워크 없이 LS 006260 시나리오를 직접 재현한다.
test('fetchCfListWithDisclosureDate: 정상 공시일이면 list.json 보정 없이 그대로 통과(추가 호출 없음)', async () => {
  const fetchList = async () => [{ rcept_no: '20170515003882' }];
  const fetchOriginal = async () => { throw new Error('호출되면 안 됨 — 정상 케이스는 보정 스킵'); };
  const result = await fetchCfListWithDisclosureDate('corp', { bsnsYear: '2017', reprtCode: '11013' }, 'key', { fetchList, fetchOriginal });
  assert.equal(result.disclosureDate, '2017-05-15');
  assert.equal(result.correctedFromLateDisclosure, false);
});

test('fetchCfListWithDisclosureDate: 정정공시로 밀린 날짜는 원본으로 보정(LS 006260 재현)', async () => {
  const fetchList = async () => [{ rcept_no: '20210831001729' }]; // 2017 1분기가 2021-08-31로 밀린 실측 사례
  const fetchOriginal = async () => '2017-05-15';
  const result = await fetchCfListWithDisclosureDate('corp', { bsnsYear: '2017', reprtCode: '11013' }, 'key', { fetchList, fetchOriginal });
  assert.equal(result.disclosureDate, '2017-05-15');
  assert.equal(result.correctedFromLateDisclosure, true);
});

test('fetchCfListWithDisclosureDate: 의심되는데 list.json도 원본을 못 찾으면(null) rcept_no 기반 날짜로 폴백(크래시 없음)', async () => {
  const fetchList = async () => [{ rcept_no: '20210831001729' }];
  const fetchOriginal = async () => null;
  const result = await fetchCfListWithDisclosureDate('corp', { bsnsYear: '2017', reprtCode: '11013' }, 'key', { fetchList, fetchOriginal });
  assert.equal(result.disclosureDate, '2021-08-31');
  assert.equal(result.correctedFromLateDisclosure, false);
});

test('fetchCfListWithDisclosureDate: fetchList가 null이면(미공시) 그대로 null', async () => {
  const result = await fetchCfListWithDisclosureDate('corp', { bsnsYear: '2017', reprtCode: '11013' }, 'key', { fetchList: async () => null });
  assert.equal(result, null);
});

test('prevPeriod: 미공시 폴백 체인 (반기→1Q→전년 사업→전년 3Q)', () => {
  assert.deepEqual(prevPeriod({ bsnsYear: '2026', reprtCode: '11012' }), { bsnsYear: '2026', reprtCode: '11013' });
  assert.deepEqual(prevPeriod({ bsnsYear: '2026', reprtCode: '11013' }), { bsnsYear: '2025', reprtCode: '11011' });
  assert.deepEqual(prevPeriod({ bsnsYear: '2025', reprtCode: '11011' }), { bsnsYear: '2025', reprtCode: '11014' });
  assert.deepEqual(prevPeriod({ bsnsYear: '2026', reprtCode: '11014' }), { bsnsYear: '2026', reprtCode: '11012' });
});

test('standaloneAmounts: 누적치 − 같은 해 직전 리포트 누적치 = 단일분기 (현대차 4Q 2025 실측)', () => {
  // 사업보고서(FY2025 누적) − 3분기보고서(9개월 누적) = 4분기 단독. 실측: 16,954억(4Q25) / 28,222억(4Q24) ≈ YoY -39.9%
  const annual = { curr: 11467851000000, prev: 14239592000000 };   // FY2025, FY2024
  const nineMo = { curr: 9772472000000, prev: 11417398000000 };    // 2025 9개월 누적, 2024 9개월 누적
  const q4 = standaloneAmounts(annual, nineMo);
  assert.equal(q4.curr, 1695379000000);
  assert.equal(q4.prev, 2822194000000);
  assert.equal(computeYoY(q4.curr, q4.prev), -39.9);
});

test('standaloneAmounts: priorCum 결측(조회 실패 포함)이면 null — cum을 그대로 반환하지 않음', () => {
  assert.equal(standaloneAmounts({ curr: 100, prev: 90 }, null), null);
  assert.equal(standaloneAmounts({ curr: null, prev: 90 }, { curr: 10, prev: 5 }), null);
  assert.equal(standaloneAmounts({ curr: 100, prev: 90 }, { curr: null, prev: 5 }), null);
});

test('quarterStandalone: 1분기는 SAME_YEAR_PRIOR_REPORT에 없어 조회 없이 누적치 그대로(이미 단일분기)', () => {
  const q1 = { curr: 100, prev: 90 };
  assert.deepEqual(quarterStandalone({ bsnsYear: '2026', reprtCode: '11013' }, q1, null), q1);
});

test('quarterStandalone: 1분기 외 리포트인데 priorOp 조회 실패(null) → null (옛 버그처럼 누적치를 단일분기인 척 쓰지 않음)', () => {
  const fy = { curr: 11467851000000, prev: 14239592000000 };
  assert.equal(quarterStandalone({ bsnsYear: '2025', reprtCode: '11011' }, fy, null), null);
});

test('quarterStandalone: 사업보고서 − 3분기 누적 = 4분기 단독 (현대차 실측)', () => {
  const annual = { curr: 11467851000000, prev: 14239592000000 };
  const nineMo = { curr: 9772472000000, prev: 11417398000000 };
  const q4 = quarterStandalone({ bsnsYear: '2025', reprtCode: '11011' }, annual, nineMo);
  assert.equal(computeYoY(q4.curr, q4.prev), -39.9);
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

test('dropSignal: ATR 있고 임계배수(2배) 이상이면 hit(5일 낙폭%·기대변동폭·배수를 why에 인용)', () => {
  const r = dropSignal(-50, 10);
  assert.equal(r.hit, true);
  assert.equal(r.multiple, 2.2);
  assert.equal(r.expectedRange, 22.4);
  assert.equal(r.why, '5일 -50%(5일 기대변동폭 22.4% 대비 2.2배)');
});

test('dropSignal: ATR 있고 임계배수 미달이면 miss', () => {
  const r = dropSignal(-40, 10);
  assert.equal(r.hit, false);
  assert.equal(r.why, null);
});

test('dropSignal: 반올림 경계 회귀(표시용 반올림이 1.96배를 2.0배로 보이게 해도 실제 비교는 원값 기준 — hit 안 함)', () => {
  // atrPct=10 → 기대변동폭≈22.36, weekChange=-43.83 → 원배수≈1.96(<2, miss여야 함).
  // 반올림 후 비교하는 버그였다면 표시값 2.0으로 올림돼 잘못 hit=true가 됐을 케이스(테스트
  // 작성 중 실제로 발견해 수정 — dropSignal 구현부 주석 참고).
  const r = dropSignal(-43.83, 10);
  assert.equal(r.hit, false);
  assert.equal(r.multiple, 2); // 표시상으로는 2.0으로 반올림되지만
  assert.equal(r.why, null);  // hit 판정 자체는 원값 기준이라 미발동
});

test('dropSignal: ATR 없으면(null/0) 판정 자체를 skip(miss) — 예전 고정 -10% 폴백은 근거없는 임의값이라 폐기(2026-07)', () => {
  assert.equal(dropSignal(-15, null).hit, false);
  assert.equal(dropSignal(-50, 0).hit, false); // atrPct=0도 "없음" 취급
  assert.equal(dropSignal(-15, undefined).hit, false);
});

test('dropSignal: weekChange가 0 이상(상승)이거나 null이면 ATR 유무와 무관하게 항상 miss', () => {
  assert.equal(dropSignal(5, 10).hit, false);
  assert.equal(dropSignal(0, 10).hit, false);
  assert.equal(dropSignal(null, 10).hit, false);
  assert.equal(dropSignal(5, null).hit, false);
});

test('checkGuardrails: 영업이익 2분기 연속 감소', () => {
  assert.deepEqual(checkGuardrails({ opYoYCurr: -5, opYoYPrev: -3 }), ['영업이익 YoY 2분기 연속 감소']);
  assert.deepEqual(checkGuardrails({ opYoYCurr: 10, opYoYPrev: -3 }), []);
  assert.deepEqual(checkGuardrails({ opYoYCurr: 10, opYoYPrev: null }), []);
});

test('checkGuardrails: 현금흐름 적자전환(직전 흑자→이번 적자만 발동, 이미 적자 지속은 미발동)', () => {
  assert.deepEqual(checkGuardrails({ cfCurr: -100, cfPrev: 50 }), ['현금흐름 적자전환(직전 대비)']);
  assert.deepEqual(checkGuardrails({ cfCurr: -100, cfPrev: -50 }), []); // 이미 적자 지속 — "전환" 아님
  assert.deepEqual(checkGuardrails({ cfCurr: 100, cfPrev: 50 }), []); // 계속 흑자
  assert.deepEqual(checkGuardrails({ cfCurr: null, cfPrev: 50 }), []); // 결측 방어
});

test('checkGuardrails: 부채비율 절대수준(200% 초과)만 남음(변화량 +20%p 가드레일은 2026-07 근거없어 삭제)', () => {
  assert.deepEqual(checkGuardrails({ debtRatio: 250 }), [
    '부채비율 고위험 절대수준(250%, 200% 초과 — 신용평가 실무 기준)',
  ]);
  assert.deepEqual(checkGuardrails({ debtRatio: 200 }), []); // 정확히 200%는 "초과" 아님
  assert.deepEqual(checkGuardrails({ debtRatio: 150 }), []);
  assert.deepEqual(checkGuardrails({ debtRatio: null }), []);
  // baselineDebtRatio를 넘겨도(호출부 하위호환) 더 이상 아무 영향 없음 — 변화량 가드레일 삭제됨
  assert.deepEqual(checkGuardrails({ debtRatio: 210, baselineDebtRatio: 180 }), [
    '부채비율 고위험 절대수준(210%, 200% 초과 — 신용평가 실무 기준)',
  ]);
});

test('checkGuardrails: 3개 조건이 동시에 걸리면 3건 모두 반환(순서 고정)', () => {
  const g = { opYoYCurr: -5, opYoYPrev: -3, debtRatio: 250, cfCurr: -100, cfPrev: 50 };
  assert.deepEqual(checkGuardrails(g), [
    '영업이익 YoY 2분기 연속 감소',
    '부채비율 고위험 절대수준(250%, 200% 초과 — 신용평가 실무 기준)',
    '현금흐름 적자전환(직전 대비)',
  ]);
});

test('checkGuardrails: opinionDowngrades를 넘겨도(호출부 하위호환) 더 이상 아무 가드레일도 발동 안 함(2026-07 근거없어 삭제)', () => {
  assert.deepEqual(checkGuardrails({ opinionDowngrades: 5 }), []);
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

// ── 기술지표(strategy_builder/backtester 참고 이식, 2026-07) ──────────────────

test('computeMacd: 데이터 부족(slow+signal 미만)이면 null', () => {
  assert.equal(computeMacd(Array(20).fill(100)), null);
});

test('computeMacd: null/빈 배열 입력이면 데이터부족과 동일하게 null(throw 안 함)', () => {
  assert.equal(computeMacd(null), null);
  assert.equal(computeMacd([]), null);
});

test('computeMacd: 급등 후 되돌림 국면에서 데드크로스(macd가 signal 아래로) 감지', () => {
  // 50일 평평(100) → 15일 200 유지. 초반 급등 직후엔 macd>signal이나, 가격이 새 레벨에서
  // 안정되며 signal(지연)이 macd를 따라잡아 뒤늦게 역전 — MACD의 전형적인 추세감속 신호.
  const closes = [...Array(50).fill(100), ...Array(15).fill(200)];
  const r = computeMacd(closes);
  assert.notEqual(r, null);
  assert.equal(r.crossDown, true);
  assert.equal(r.crossUp, false);
  assert.ok(r.macd < r.signal);
});

test('computeMacd: 급락 후 되돌림 국면에서 골든크로스(macd가 signal 위로) 감지(대칭)', () => {
  const closes = [...Array(50).fill(100), ...Array(15).fill(50)];
  const r = computeMacd(closes);
  assert.equal(r.crossUp, true);
  assert.equal(r.crossDown, false);
});

test('computeMaAlignment: 데이터 부족(가장 긴 period 미만)이면 null', () => {
  assert.equal(computeMaAlignment(Array(50).fill(100)), null);
});

test('computeMaAlignment: 지속 상승(오름차순) 시퀀스는 정배열(단기>중기>장기)', () => {
  const closes = Array.from({ length: 90 }, (_, i) => 100 + i);
  const r = computeMaAlignment(closes);
  assert.equal(r.alignment, '정배열');
  assert.ok(r.sma[5] > r.sma[20] && r.sma[20] > r.sma[60]);
});

test('computeMaAlignment: 지속 하락(내림차순) 시퀀스는 역배열(단기<중기<장기)', () => {
  const closes = Array.from({ length: 90 }, (_, i) => 200 - i);
  assert.equal(computeMaAlignment(closes).alignment, '역배열');
});

test('computeMaAlignment: 평평하다가 마지막날 급등하면 단기선이 중기선을 상향돌파(골든크로스)', () => {
  const closes = [...Array(59).fill(100), 300];
  const r = computeMaAlignment(closes);
  assert.equal(r.goldenCross, true);
  assert.equal(r.deadCross, false);
});

test('computeMaAlignment: 평평하다가 마지막날 급락하면 단기선이 중기선을 하향돌파(데드크로스, 대칭)', () => {
  const closes = [...Array(59).fill(100), 10];
  const r = computeMaAlignment(closes);
  assert.equal(r.deadCross, true);
  assert.equal(r.goldenCross, false);
});

test('computeAtr: 데이터 부족(period+1 미만)이면 null', () => {
  assert.equal(computeAtr(Array(10).fill(105), Array(10).fill(95), Array(10).fill(100)), null);
});

test('computeAtr: 매 봉 True Range가 일정(H=105,L=95,C=100)하면 ATR도 그 값(10)으로 수렴, pct=현재가 대비 10%', () => {
  const n = 30;
  const r = computeAtr(Array(n).fill(105), Array(n).fill(95), Array(n).fill(100));
  assert.equal(r.atr, 10);
  assert.equal(r.pct, 10);
});

test('computeStochastic: 데이터 부족(kPeriod+dPeriod 미만)이면 null', () => {
  assert.equal(computeStochastic(Array(10).fill(110), Array(10).fill(90), Array(10).fill(100)), null);
});

test('computeStochastic: 마지막 종가가 최근 14일 최고가와 같으면 %K=100(과열)', () => {
  const n = 20;
  const closes = Array(n).fill(100); closes[n - 1] = 110;
  const r = computeStochastic(Array(n).fill(110), Array(n).fill(90), closes);
  assert.equal(r.k, 100);
  assert.equal(r.overbought, true);
  assert.equal(r.oversold, false);
});

test('computeVolumeSurge: 데이터 부족(window+1 미만)이면 null', () => {
  assert.equal(computeVolumeSurge(Array(10).fill(1000), Array(10).fill(100)), null);
});

test('computeVolumeSurge: 오늘 거래대금이 직전 20일 평균의 정확히 2배면 ratio=2', () => {
  const n = 25;
  const vols = Array(n).fill(1000); vols[n - 1] = 2000;
  const r = computeVolumeSurge(vols, Array(n).fill(100));
  assert.equal(r.ratio, 2);
  assert.equal(r.latest, 200000);
  assert.equal(r.avgPrior, 100000);
});

test('computeVolumeSurge: 직전 평균 거래대금이 0이면 null(0으로 나누기 방지)', () => {
  const n = 25;
  const vols = Array(n).fill(0); vols[n - 1] = 1000;
  assert.equal(computeVolumeSurge(vols, Array(n).fill(100)), null);
});

// ── overlayKrxPriceData: KRX 가격 시계열로 yfinance 가격 파생 지표 덮어쓰기(2026-08-19) ──
import { rmSync } from 'node:fs';
import { join, dirname as _dirname } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';
const _CACHE_DIR = join(_dirname(_fileURLToPath(import.meta.url)), '..', '.cache', 'krx-daily');
const _cleanupDays = (basDds) => basDds.forEach((b) => rmSync(join(_CACHE_DIR, `${b}.json`), { force: true }));

test('overlayKrxPriceData: yfData가 null이면 KRX 호출 없이 그대로 null', async () => {
  const r = await overlayKrxPriceData('005930', null, {});
  assert.equal(r, null);
});

test('overlayKrxPriceData: KRX 조회 실패 시 폴백하지 않고 throw(가용성보다 출처 추적성 우선, 오너 지시 2026-08-19)', async () => {
  const yfData = { rsi14: 50, pos52w: 60, forwardPE: 10, pbr: 1.2, tech: { macd: null } };
  const fetchImpl = async () => { throw new Error('network down'); };
  await assert.rejects(
    () => overlayKrxPriceData('005930', yfData, { fetchImpl, apiKey: 'K', delayMs: 0 }),
    /network down/,
  );
});

test('overlayKrxPriceData: 확보 일수가 15일 미만이면 폴백 없이 throw(RSI14도 못 낼 정도면 KRX 데이터 자체가 이상)', async () => {
  const yfData = { rsi14: 50, pos52w: 60, tech: {} };
  const startDate = new Date(1997, 0, 6); // 테스트 전용 과거 날짜대 — 실캐시와 무관
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ OutBlock_1: [{ ISU_CD: 'X', TDD_CLSPRC: '100' }] }) });
  try {
    await assert.rejects(
      () => overlayKrxPriceData('X', yfData, { fetchImpl, apiKey: 'K', delayMs: 0, startDate, maxScanDays: 10 }),
      /KRX 가격 시계열 부족/,
    ); // maxScanDays=10 → 10일치만 확보(15 미만)
  } finally {
    const basDds = Array.from({ length: 15 }, (_, i) => {
      const d = new Date(startDate.getTime() - i * 86400000);
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    });
    _cleanupDays(basDds);
  }
});

test('overlayKrxPriceData: 데이터 충분하면 가격 파생 지표를 KRX로 덮어쓰고 재무추정치는 yfinance 유지', async () => {
  const yfData = {
    rsi14: 999, pos52w: 999, weekChange: 999, marketCap: 1, currentPrice: 1, high52w: 1, low52w: 1,
    forwardPE: 12.3, pbr: 1.5, fcfYield: 4.2, payoutRatio: 30,
    tech: { macd: 'stale', maAlignment: 'stale', atr: 'stale', stochastic: 'stale', volumeSurge: 'stale' },
    source: 'yfinance 005930.KS',
  };
  const startDate = new Date(1996, 0, 8); // 또 다른 테스트 전용 과거 날짜대 — 격리
  let day = 0;
  const fetchImpl = async (url) => {
    const isKospi = /stk_bydd_trd/.test(url);
    if (!isKospi) return { ok: true, status: 200, text: async () => JSON.stringify({ OutBlock_1: [] }) };
    day++;
    // 워크백은 오늘→과거 순으로 호출되므로(day=1이 가장 최근일) 우상향 시계열(과거→현재
    // 증가)을 만들려면 day가 클수록(더 과거) 종가가 낮아야 한다.
    const close = 200 - day; // 과거→현재 오름차순(우상향) → RSI14가 50보다 커야 정상
    const rows = [{ ISU_CD: 'X', TDD_CLSPRC: String(close), TDD_HGPRC: String(close + 5), TDD_LWPRC: String(close - 5), ACC_TRDVOL: '1000', ACC_TRDVAL: '100000', MKTCAP: String(close * 1_000_000) }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ OutBlock_1: rows }) };
  };
  const cleanupBasDds = [];
  try {
    const r = await overlayKrxPriceData('X', yfData, { fetchImpl, apiKey: 'K', delayMs: 0, startDate, maxScanDays: 20 });
    // 가격 파생 지표는 KRX로 교체됨(더 이상 yfData의 더미값 999/1이 아님)
    assert.notEqual(r.rsi14, 999);
    assert.notEqual(r.marketCap, 1);
    assert.notEqual(r.currentPrice, 1);
    assert.notEqual(r.high52w, 1);
    assert.notEqual(r.low52w, 1);
    assert.ok(r.rsi14 > 50); // 우상향 시계열이므로 RSI14 > 50이 정상
    // 재무추정치는 KRX에 없는 필드라 yfinance 값 그대로 유지
    assert.equal(r.forwardPE, 12.3);
    assert.equal(r.pbr, 1.5);
    assert.equal(r.fcfYield, 4.2);
    assert.equal(r.payoutRatio, 30);
    assert.equal(r.source, 'yfinance 005930.KS + KRX(가격 실측)');
  } finally {
    for (let i = 0; i < 25; i++) {
      const d = new Date(startDate.getTime() - i * 86400000);
      cleanupBasDds.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
    }
    _cleanupDays(cleanupBasDds);
  }
});
