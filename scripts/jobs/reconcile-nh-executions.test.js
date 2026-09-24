import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNhExecutionRows, buildNhFillLedgerInput, buildNhProposalStatusInput, isTerminalNhExecution } from './reconcile-nh-executions.mjs';
import { buildExecutionRecord } from '../lib/ledger-vault-writer.mjs';

// 실제 라이브 조회로 확인한 실제 체결 1건 그대로("메리츠금융지주 매도 30주
// @132,000원" — Vault에 이미 카카오 파싱으로 기록된 값과 정확히 일치 확인, 2026-09-03).
test('parseNhExecutionRows: 실측 필드 구조로 정상 체결 1건 파싱', () => {
  const rows = [{
    itg_orr_no: 824268, iem_cd: '138040', iem_nm: '메리츠금융지주',
    sby_dit_cd_nm: '현금매도', orr_qty: 30, tot_cns_qty: 30, cns_avg_uit_pr: 132000,
  }];
  const r = parseNhExecutionRows(rows);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], {
    orderNo: '824268', stockCode: '138040', stockName: '메리츠금융지주',
    tradeType: '매도', quantity: 30, orderQty: 30, fullyFilled: true, price: 132000,
    unfilledQty: null, canceledQty: null, executionAmount: null,
  });
});

test('parseNhExecutionRows: sby_dit_cd_nm에 "매도"·"매수"가 포함되면 각각 매도·매수로 정규화', () => {
  const rows = [
    { itg_orr_no: '1', iem_cd: 'A', iem_nm: 'X', sby_dit_cd_nm: '현금매도', orr_qty: 1, tot_cns_qty: 1, cns_avg_uit_pr: 100 },
    { itg_orr_no: '2', iem_cd: 'B', iem_nm: 'Y', sby_dit_cd_nm: '현금매수', orr_qty: 1, tot_cns_qty: 1, cns_avg_uit_pr: 100 },
  ];
  const r = parseNhExecutionRows(rows);
  assert.equal(r[0].tradeType, '매도');
  assert.equal(r[1].tradeType, '매수');
});

// [핵심 안전장치] 2026-09-03 code-reviewer 지적 — 매매구분은 보유수량 부호를 결정하는
// 값이라 "매도가 아니면 매수"로 단정하면 결측·예상 밖 표기(신용/대주 등)에서 오판이
// applyBuy/applySell을 통째로 뒤집을 수 있다. 화이트리스트에 없으면 필터에서 탈락.
test('[핵심 안전장치] parseNhExecutionRows: sby_dit_cd_nm이 "매도"·"매수" 둘 다 아니거나 결측이면 제외(매수로 추정 안 함)', () => {
  const rows = [
    { itg_orr_no: '1', iem_cd: 'A', iem_nm: '알수없는구분', sby_dit_cd_nm: '신용상환', orr_qty: 10, tot_cns_qty: 10, cns_avg_uit_pr: 100 },
    { itg_orr_no: '2', iem_cd: 'B', iem_nm: '구분결측', orr_qty: 10, tot_cns_qty: 10, cns_avg_uit_pr: 100 },
    { itg_orr_no: '3', iem_cd: 'C', iem_nm: '정상매수', sby_dit_cd_nm: '현금매수', orr_qty: 10, tot_cns_qty: 10, cns_avg_uit_pr: 100 },
  ];
  const r = parseNhExecutionRows(rows);
  assert.equal(r.length, 1);
  assert.equal(r[0].stockName, '정상매수');
});

// [핵심 안전장치] 2026-09-03 code-reviewer 지적 — orderNo(itg_orr_no)가 이 잡의 유일한
// 파일명 충돌 방지 수단(시각이 전부 00:00:00)이라, 결측이면 안전하게 제외한다.
test('[핵심 안전장치] parseNhExecutionRows: itg_orr_no가 결측이면 제외(파일명 충돌 방지 수단이 없어짐)', () => {
  const rows = [
    { iem_cd: 'A', iem_nm: '주문번호결측', sby_dit_cd_nm: '현금매수', orr_qty: 10, tot_cns_qty: 10, cns_avg_uit_pr: 100 },
    { itg_orr_no: '1', iem_cd: 'B', iem_nm: '정상', sby_dit_cd_nm: '현금매수', orr_qty: 10, tot_cns_qty: 10, cns_avg_uit_pr: 100 },
  ];
  const r = parseNhExecutionRows(rows);
  assert.equal(r.length, 1);
  assert.equal(r[0].stockName, '정상');
});

test('parseNhExecutionRows: 빈 배열/undefined 입력이면 빈 배열 반환', () => {
  assert.deepEqual(parseNhExecutionRows([]), []);
  assert.deepEqual(parseNhExecutionRows(undefined), []);
});

test('[핵심 안전장치] parseNhExecutionRows: 체결수량 0(미체결)이거나 가격 0/결측인 행은 제외(추정 대신 확인)', () => {
  const rows = [
    { itg_orr_no: '1', iem_cd: 'A', iem_nm: '미체결종목', sby_dit_cd_nm: '현금매수', orr_qty: 10, tot_cns_qty: 0, cns_avg_uit_pr: 0 },
    { itg_orr_no: '2', iem_cd: 'B', iem_nm: '가격결측종목', sby_dit_cd_nm: '현금매수', orr_qty: 10, tot_cns_qty: 10, cns_avg_uit_pr: '' },
    { itg_orr_no: '3', iem_cd: 'C', iem_nm: '정상체결종목', sby_dit_cd_nm: '현금매수', orr_qty: 10, tot_cns_qty: 10, cns_avg_uit_pr: 11504 },
  ];
  const r = parseNhExecutionRows(rows);
  assert.equal(r.length, 1);
  assert.equal(r[0].stockName, '정상체결종목');
});

// [핵심 안전장치] tot_cns_qty는 그 주문의 누적 체결수량 — 부분체결 상태를 그대로
// 기록하면 다음 폴링에서 전량체결로 바뀌어도 파일명 dedup에 걸려 나머지 수량이
// 영구 누락된다(reconcile-irp-executions.mjs가 이미 겪은 것과 동일 클래스).
test('[핵심 안전장치] parseNhExecutionRows: 총체결수량<주문수량(부분체결)이면 fullyFilled=false', () => {
  const rows = [{ itg_orr_no: '1', iem_cd: 'A', iem_nm: '부분체결종목', sby_dit_cd_nm: '현금매수', orr_qty: 10, tot_cns_qty: 5, cns_avg_uit_pr: 100, cns_amt: 500, ny_cns_qty: 5, can_qty: 0 }];
  const r = parseNhExecutionRows(rows);
  assert.equal(r[0].fullyFilled, false);
  assert.equal(r[0].executionAmount, 500);
  assert.equal(r[0].unfilledQty, 5);
  assert.equal(r[0].canceledQty, 0);
});

test('isTerminalNhExecution: 부분체결은 미체결 잔량 0을 확인한 뒤에만 종결로 판정', () => {
  assert.equal(isTerminalNhExecution({ fullyFilled: true }), true);
  assert.equal(isTerminalNhExecution({ fullyFilled: false, quantity: 5, orderQty: 10, unfilledQty: 0 }), true);
  assert.equal(isTerminalNhExecution({ fullyFilled: false, quantity: 5, orderQty: 10, unfilledQty: 5 }), false);
  assert.equal(isTerminalNhExecution({ fullyFilled: false, quantity: 5, orderQty: 10, unfilledQty: null }), false);
});

test('[핵심 안전장치] parseNhExecutionRows: orr_qty 필드가 없거나 결측이면 fullyFilled=false(추정 안 함)', () => {
  const rows = [{ itg_orr_no: '1', iem_cd: 'A', iem_nm: 'X', sby_dit_cd_nm: '현금매수', tot_cns_qty: 10, cns_avg_uit_pr: 100 }];
  const r = parseNhExecutionRows(rows);
  assert.equal(r[0].fullyFilled, false);
});

// ── buildNhFillLedgerInput(2026-09-21 독립 코드리뷰 지적, MEDIUM 재발방지 — 최초
// watch-nh-order-fill.mjs는 이 필드들을 CLI 인자에서 따로 채워, reconcile 경로와
// dedup 키가 "우연히 같은 문자열"에만 의존했다(CRITICAL 사고 경로). 이 함수를 두
// 경로가 공유하게 해 dedupKey 일치를 구조적으로 보장한다 — 같은 row를 넣으면 둘
// 다 반드시 같은 dedupKey가 나와야 한다.) ──

test('buildNhFillLedgerInput: row 하나로 buildExecutionRecord 입력을 만들면 reconcile-nh-executions.mjs와 watch-nh-order-fill.mjs가 항상 같은 dedupKey를 냄', () => {
  const row = parseNhExecutionRows([{
    itg_orr_no: 847026, iem_cd: '0086B0', iem_nm: 'TIGER 리츠부동산인프라TOP10액티브',
    sby_dit_cd_nm: '현금매도', orr_qty: 49, tot_cns_qty: 49, cns_avg_uit_pr: 9455,
  }])[0];
  // reconcile-nh-executions.mjs의 일일 폴링 경로가 이 row를 만났을 때와
  const fromReconcile = buildExecutionRecord(buildNhFillLedgerInput(row, { today: '2026-09-21', account: '위탁', actNo: '20501596019' }));
  // watch-nh-order-fill.mjs의 즉시감시 경로가 *같은* row를 만났을 때(주문 접수
  // 직후 CLI 인자로 받은 --account/--code/--name/--side가 무엇이었든, Ledger에는
  // row 쪽 값만 쓰므로 결과가 같아야 한다) — 두 경로 모두 같은 함수를 호출.
  const fromWatcher = buildExecutionRecord(buildNhFillLedgerInput(row, { today: '2026-09-21', account: '위탁', actNo: '20501596019' }));
  assert.equal(fromReconcile.dedupKey, fromWatcher.dedupKey);
  assert.equal(fromReconcile.filename, fromWatcher.filename);
  assert.equal(fromReconcile.dedupKey, '2026-09-21 00:00:00|매도|TIGER 리츠부동산인프라TOP10액티브|49|847026');
});

test('buildNhFillLedgerInput: account·actNo는 호출부가 주입한 값을 그대로 쓰고 acctNo는 마스킹됨', () => {
  const row = parseNhExecutionRows([{
    itg_orr_no: '1', iem_cd: 'A', iem_nm: '금 99.99K', sby_dit_cd_nm: '현금매수', orr_qty: 1, tot_cns_qty: 1, cns_avg_uit_pr: 130000,
  }])[0];
  const input = buildNhFillLedgerInput(row, { today: '2026-09-21', account: '금현물', actNo: '20902920556' });
  assert.equal(input.account, '금현물');
  assert.equal(input.broker, 'NH투자증권');
  assert.notEqual(input.acctNo, '20902920556'); // 마스킹돼야 함(원본 그대로 노출 금지)
  assert.ok(input.acctNo.length > 0);
});

test('buildNhProposalStatusInput: 부분체결도 당일 대사에서 Proposal 누적수량 갱신 대상으로 만든다', () => {
  assert.deepEqual(buildNhProposalStatusInput(
    { id: 'proposal-1' },
    { orderNo: '847026', fullyFilled: false, orderQty: 10, quantity: 7, price: 9450 },
    '/tmp/proposals',
  ), {
    proposalsDir: '/tmp/proposals', proposalId: 'proposal-1', brokerOrderId: '847026',
    status: '부분체결', filledQty: 7, avgFillPrice: 9450,
  });
});

test('buildNhProposalStatusInput: 주문수량이 없어 부분/전량 판정 불가면 상태전이를 보류한다', () => {
  assert.equal(buildNhProposalStatusInput(
    { id: 'proposal-1' }, { orderNo: '847026', fullyFilled: false, orderQty: null, quantity: 7, price: 9450 }, '/tmp/proposals',
  ), null);
});
