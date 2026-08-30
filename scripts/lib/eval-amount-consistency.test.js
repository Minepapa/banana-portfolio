import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHomeMirror, buildHoldingsMirror } from './firestore-mirror.mjs';
import { buildReportFacts } from './report-facts.mjs';

// ── 총자산(evalAmount 전체 합계) 교차검증 — 구조적 가드(2026-08-30 신설) ────────────
//
// 배경: 오너 지적 — "리포트 하나 고치는 게 아니라, 원본 데이터를 어떻게 가지고 올건가,
// 잘못된 곳을 가지고 오면 안 되는 방법을 마련하는 게 중요하다." 전수 조사 결과 "총
// 평가액"(State/Holdings 전체 evalAmount 합)을 계산하는 지점이 최소 8개 파일에 각자
// 재구현돼 있었다(firestore-mirror.mjs·mirrorAdapters.js 3곳·report-facts.mjs·
// isa-exposure.mjs·allocation-snapshot.mjs·rebalance-gap.mjs·rebalance-proposal.mjs).
// 지금은 전부 같은 원본(holdings.evalAmount)을 단순 합산하는 동일한 공식이라 우연히
// 일치하지만, 8곳 중 한 곳만 스코프(어느 계좌·자산군을 포함할지)나 필드를 바꿔도
// 나머지와 조용히 갈라진다 — 실제로 2026-08-21에 이 클래스의 사고가 한 번 있었다
// (avgPrice*qty 재계산 방식이 한국 펀드 1,000좌당 기준가에서 1,000배 부풀림 발생,
// firestore-mirror.mjs 헤더 주석 참고).
//
// 8곳 전부를 한 구현으로 통합하는 리팩터는 이번엔 하지 않는다(오너 확인 — 리스크
// 대비 효과가 애매한 대규모 변경이라, 대신 "드리프트가 생기면 즉시 실패하는 테스트"
// 를 심어 최소 침습으로 안전망을 건다). "전체 계좌·자산군 총합"이라는 같은 의미로
// 쓰이는 함수들(대시보드 헤드라인이 읽는 buildHomeMirror/buildHoldingsMirror, 주간
// 리포트가 읽는 report-facts.mjs)만 여기서 교차검증한다 — isa-exposure.mjs·
// rebalance-gap.mjs 등은 의도적으로 스코프가 다른 부분합(3계좌만·5개 자산군만 등)
// 이라 "다른 게 정상"이므로 이 테스트 대상이 아니다.

// SK하이닉스 evalAmount에 일부러 소수점(.4)을 남겼다 — report-facts.mjs의
// hList는 "종목명 기준으로 합산 후 그룹당 Math.round" 하지만(코드리뷰 HIGH-1
// 지적), buildHomeMirror·buildHoldingsMirror는 원시값을 그대로 합산한다. 즉 총
// 평가액이 정수가 아닌 실전 데이터(해외주식 환산 등)에서는 두 계산이 "그룹 개수 ×
// 0.5원" 이내에서 항상 미세하게 갈라지는 게 정상 동작이다 — 이걸 모르고 예전
// 버전처럼 완전 일치(===)를 요구하면 실제 운영 데이터에서 이 가드 자체가 상시
// 오탐(false positive)을 낸다. 여기선 그 비대칭을 일부러 재현해 허용오차 기반
// 비교가 진짜로 필요함을 실증한다.
const FIXTURE_HOLDINGS = [
  { account: '위탁', name: 'SK하이닉스', assetClass: '국내주식', qty: 8, invest: 15920000, evalAmount: 17200000.4 },
  { account: '위탁', name: '애플', assetClass: '해외주식', qty: 8, invest: 2400000, evalAmount: 2651420 },
  // avgPrice=1560/qty=8202681처럼 1,000좌당 기준가 관례를 그대로 재현 — 2026-08-19
  // 사고(avgPrice*qty 재계산이 1,000배 부풀려짐)가 재발한다면 evalAmount가 아니라
  // avgPrice 쪽을 잘못 참고하는 코드에서 터진다는 걸 이 필드로 명시해둔다.
  { account: '연금저축', name: 'VIP한국형가치투자', assetClass: '국내주식', qty: 8202681, avgPrice: 1560, invest: 12000000, evalAmount: 12797000 },
  { account: 'CMA', name: '예수금', assetClass: '현금', qty: 0, invest: 21054004, evalAmount: 21054004, isCashLike: true },
  { account: 'ISA', name: 'TIGER 리츠', assetClass: '리츠', qty: 50, invest: 2000000, evalAmount: 2100000 },
];
const EXPECTED_TOTAL_RAW = 17200000.4 + 2651420 + 12797000 + 21054004 + 2100000; // 원시(비반올림) 합
const EXPECTED_TOTAL_INVEST = 15920000 + 2400000 + 12000000 + 21054004 + 2000000;
// hList가 "종목명별로 묶어 그룹당 반올림"하므로, 그룹(=distinct 종목명) 하나당 최대
// 0.5원까지 rawTotalEval과 갈라질 수 있다(수학적 상한, Math.round 오차구간
// [-0.5, 0.5)). 고정 상수를 쓰면 픽스처를 실전처럼 종목 수를 늘릴 때마다 낡아
// 상시 오탐을 내거나(너무 타이트) 진짜 드리프트를 못 잡는다(너무 느슨, 코드리뷰
// MEDIUM 지적 — 실제 므네모시네 29개 종목 데이터로는 상한이 14.5원이라 고정 5원은
// 이미 그 절반도 못 미침). 종목 수에서 직접 유도해 항상 정확한 상한을 쓴다.
const evalRoundingTolerance = (distinctHoldingNames) => 0.5 * distinctHoldingNames;

test('총자산 교차검증: buildHomeMirror(대시보드 헤드라인) vs buildHoldingsMirror(보유탭) vs report-facts.mjs(주간 리포트) — 같은 holdings로 셋 다 허용오차 내 같은 총평가액·총원금', () => {
  const home = buildHomeMirror({ holdings: FIXTURE_HOLDINGS });
  const holdingsMirror = buildHoldingsMirror({ holdings: FIXTURE_HOLDINGS });
  const { facts } = buildReportFacts({ asof: '2026-08-30', weekStart: '2026-08-24', holdings: FIXTURE_HOLDINGS, macro: {} });

  assert.equal(home.totalEval, EXPECTED_TOTAL_RAW);
  const holdingsMirrorTotal = holdingsMirror.items.reduce((s, h) => s + (h.evalAmount || 0), 0);
  assert.equal(holdingsMirrorTotal, EXPECTED_TOTAL_RAW);

  // report-facts.mjs는 종목명 그룹당 반올림하므로 정수가 아닌 원시합과는 정확히
  // 같을 수 없다 — 허용오차 내에서만 비교(코드리뷰 HIGH-1: 예전엔 여기서 완전
  // 일치를 요구해 실제 데이터에서 상시 실패했을 것). 상한은 실제 종목 수(distinct
  // 이름 기준, facts.holdings가 바로 그 종목명별 그룹 목록)에서 유도한다.
  const tolerance = evalRoundingTolerance(facts.holdings.length);
  assert.ok(
    Math.abs(home.totalEval - facts.totalEval) <= tolerance,
    `총평가액 차이가 허용오차(${tolerance}원)를 넘음: home=${home.totalEval} facts=${facts.totalEval}`,
  );
  assert.ok(
    Math.abs(holdingsMirrorTotal - facts.totalEval) <= tolerance,
    `총평가액 차이가 허용오차(${tolerance}원)를 넘음: holdingsMirror=${holdingsMirrorTotal} facts=${facts.totalEval}`,
  );

  // 총원금(invest)은 어느 함수도 반올림하지 않으므로 완전 일치해야 정상 —
  // 2026-08-21 "130억" 사고가 실제로 터진 필드는 evalAmount가 아니라 invest 쪽이라
  // (코드리뷰 HIGH-2), 여기서 정확히 그 필드를 교차검증한다. 이 픽스처는 모든 행이
  // account를 갖고 있어 home(전체 holdings 합)과 facts.accounts(account 있는 것만
  // 집계) 스코프가 우연히 같다 — 그 전제가 깨지는 경우는 아래 별도 테스트에서 다룬다.
  const factsTotalInvest = facts.accounts.reduce((s, a) => s + a.invest, 0);
  assert.equal(home.totalInvest, EXPECTED_TOTAL_INVEST);
  assert.equal(factsTotalInvest, EXPECTED_TOTAL_INVEST);
  assert.equal(home.totalInvest, factsTotalInvest);

  // buildHoldingsMirror의 weightPct는 내부에서 자체 totalEval(반환되지 않음)로
  // 나눠 계산한 값이다 — 위 holdingsMirrorTotal 비교는 items[].evalAmount를 그대로
  // 재합산할 뿐이라 이 내부 계산을 전혀 실행 검증하지 못한다(코드리뷰 MEDIUM-1,
  // 트리비얼 패스스루). weightPct 합이 100%에 수렴하는지로 그 내부 계산 자체를
  // 실행 검증한다.
  const weightPctSum = holdingsMirror.items.reduce((s, i) => s + i.weightPct, 0);
  assert.ok(Math.abs(weightPctSum - 100) < 0.01, `weightPct 합이 100%가 아님: ${weightPctSum}`);
});

test('총자산 교차검증: evalAmount 결측 보유가 섞여도 세 함수가 동일하게(0 취급) 처리', () => {
  const holdings = [...FIXTURE_HOLDINGS, { account: '위탁', name: '데이터없는종목', assetClass: '국내주식', qty: 1, invest: 100000 }]; // evalAmount 없음
  const home = buildHomeMirror({ holdings });
  const holdingsMirror = buildHoldingsMirror({ holdings });
  const { facts } = buildReportFacts({ asof: '2026-08-30', weekStart: '2026-08-24', holdings, macro: {} });
  const tolerance = evalRoundingTolerance(facts.holdings.length);
  assert.ok(Math.abs(home.totalEval - facts.totalEval) <= tolerance);
  const holdingsMirrorTotal = holdingsMirror.items.reduce((s, h) => s + (h.evalAmount || 0), 0);
  assert.ok(Math.abs(holdingsMirrorTotal - facts.totalEval) <= tolerance);
  const factsTotalInvest = facts.accounts.reduce((s, a) => s + a.invest, 0);
  assert.equal(home.totalInvest, factsTotalInvest);
});

test('총자산 교차검증: account 없는(고아) 보유는 home 전체합엔 들어가고 facts.accounts 계좌별 집계엔 빠짐 — 의도된 스코프 차이(드리프트 아님)', () => {
  // report-facts.mjs의 byAcct 집계는 account가 빈 문자열이면 건너뛴다(계좌별로 보여줄
  // 방법이 없으므로) — home.totalInvest(전체 holdings 단순합)는 그런 구분이 없다.
  // 이 차이를 모르고 두 값을 항상 같다고 가정하면(코드리뷰 MEDIUM 지적 — 위 메인
  // 테스트가 모든 행에 account가 있는 픽스처만 써서 이 차이를 우연히 가려왔다) 실제로
  // account 결측 데이터가 섞였을 때 "왜 재고 안 맞지"를 이 가드가 못 잡는다. 여기서
  // 그 경계를 명시적으로 고정한다.
  const holdings = [
    { account: '위탁', name: 'SK하이닉스', assetClass: '국내주식', qty: 8, invest: 1000000, evalAmount: 1100000 },
    { account: '', name: '계좌미상', assetClass: '국내주식', qty: 1, invest: 500000, evalAmount: 500000 },
  ];
  const home = buildHomeMirror({ holdings });
  const { facts } = buildReportFacts({ asof: '2026-08-30', weekStart: '2026-08-24', holdings, macro: {} });
  const factsTotalInvest = facts.accounts.reduce((s, a) => s + a.invest, 0);
  assert.equal(home.totalInvest, 1500000); // 전체 합 — 고아 보유 포함
  assert.equal(factsTotalInvest, 1000000); // 계좌별 집계 — 고아 보유 제외(의도됨)
  assert.notEqual(home.totalInvest, factsTotalInvest);
});

test('총자산 교차검증: 빈 holdings에서도 세 함수가 동일하게 0', () => {
  const home = buildHomeMirror({ holdings: [] });
  const holdingsMirror = buildHoldingsMirror({ holdings: [] });
  const { facts } = buildReportFacts({ asof: '2026-08-30', weekStart: '2026-08-24', holdings: [], macro: {} });
  assert.equal(home.totalEval, 0);
  assert.equal(holdingsMirror.items.length, 0);
  assert.equal(facts.totalEval, null); // report-facts.mjs는 보유가 아예 없으면 "데이터 부족"을 null로 명시(추정 금지) — home은 0이 맞는 값이라 다른 의미, 회귀 아님
});
