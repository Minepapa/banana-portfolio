// 위탁 해외주식 보유 ↔ NH 해외주식 잔고 외부 대사 — 순수 판정 테스트(가상 종목·가상 수량만, 볼트·NH 접근 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGbBalanceRows, selectGbHoldings, reconcileGbBalance, businessDaysBetween, buildGbSummary,
  hasGbAlertIssues, gbAlertSignature, buildGbReconMessage, kstDay, GB_PENDING_ALERT_BUSINESS_DAYS,
} from './holdings-gb-balance-recon.mjs';
import { renderAgentMessage } from './pantheon-send.mjs';

const holding = (over = {}) => ({
  account: '위탁', assetClass: '해외주식', name: '가상해외주식A', ticker: '', market: '', qty: 10, isCashLike: false, ...over,
});
const nhRow = (over = {}) => ({
  fc_sec_trd_nat_cd: '200', iem_cd: 'VAAA', iem_nm: '가상해외주식A', cns_bse_bnc_qty: '10', byn_cns_qty: '0', sll_cns_qty: '0',
  cur_cd: 'USD', ...over,
});
const body = (rows) => ({ Output_0: {}, Output_1: rows });
const run = (holdings, rows, extra = {}) => reconcileGbBalance({ holdings, body: body(rows), today: '2026-09-09', ...extra });

test('응답 구조: 없음·Output_1 없음·배열 아님·빈 배열·행 이상은 건너뜀(사유), 쉼표 숫자는 읽는다', () => {
  for (const [input, pattern] of [[null, /응답 없음/], [{}, /Output_1 없음/], [{ Output_1: {} }, /배열이 아님/],
    [{ Output_1: [] }, /빈 응답/], [{ Output_1: [null] }, /객체가 아님/], [{ Output_1: [{ cns_bse_bnc_qty: '1' }] }, /종목코드·종목명 없음/],
    [{ Output_1: [{ iem_cd: 'VAAA', cns_bse_bnc_qty: '' }] }, /cns_bse_bnc_qty/],
    [{ Output_1: [{ iem_cd: 'VAAA', cns_bse_bnc_qty: '1', byn_cns_qty: 'x' }] }, /byn_cns_qty/]]) {
    const parsed = parseGbBalanceRows(input);
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, pattern);
    assert.equal(reconcileGbBalance({ holdings: [holding()], body: input, today: '2026-09-09' }).status, 'skipped');
  }
  const parsed = parseGbBalanceRows(body([nhRow({ cns_bse_bnc_qty: '1,200', byn_cns_qty: undefined, iem_cd: 'vaaa US' })]));
  assert.deepEqual(parsed.rows, [{ code: 'VAAA', name: '가상해외주식A', balanceQty: 1200, buyPending: 0, sellPending: 0 }]);
});

test('대상 보유: 위탁·해외주식·현금성 아님만, 로트 파일은 합친다', () => {
  const targets = selectGbHoldings([
    holding({ qty: 4 }), holding({ qty: 6 }), holding({ account: 'ISA', name: '가상해외주식B' }),
    holding({ assetClass: '국내주식', name: '가상국내주식' }), holding({ assetClass: '해외주식', name: '외화 RP', isCashLike: 'true' }),
  ]);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].qty, 10);
});

test('일치: 보유 == 체결기준 잔고(이름 매칭·소수 수량 허용오차)', () => {
  const result = run([holding({ qty: 2.5 })], [nhRow({ cns_bse_bnc_qty: '2.5000001' })]);
  assert.equal(result.status, 'ok');
  assert.equal(result.compared, 1);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].matchedBy, 'name');
  assert.equal(hasGbAlertIssues(result), false);
});

test('매칭: ticker 우선, ticker가 비면 원장 stockCode, 그다음 이름(공백 정규화)', () => {
  const byTicker = run([holding({ ticker: 'VAAA', name: '다른표기' })], [nhRow()]);
  assert.equal(byTicker.matched[0].matchedBy, 'ticker');
  const executions = [{ account: '위탁', stockName: '다른표기', stockCode: 'VAAA', tradeType: '매수', quantity: 1 }];
  const byLedger = reconcileGbBalance({ holdings: [holding({ name: '다른표기' })], executions, body: body([nhRow()]), today: '2026-09-09' });
  assert.equal(byLedger.matched[0].matchedBy, 'ledgerCode');
  // 원장 코드가 둘로 갈리면 추정하지 않는다 → 이름도 안 맞으면 차이.
  const split = reconcileGbBalance({ holdings: [holding({ name: '다른표기' })], body: body([nhRow()]), today: '2026-09-09',
    executions: [...executions, { ...executions[0], stockCode: 'VBBB' }] });
  assert.equal(split.mismatches.length, 2);
  const spaced = run([holding({ name: ' 가상해외주식A ' })], [nhRow({ iem_nm: '가상해외주식A' })]);
  assert.equal(spaced.matched.length, 1);
});

test('게시 대기: 보유 == 잔고 − 매수 대기 + 매도 대기 → 경고 없음, 시작일 기억', () => {
  const buy = run([holding({ qty: 8 })], [nhRow({ cns_bse_bnc_qty: '10', byn_cns_qty: '2' })]);
  assert.equal(buy.pending.length, 1);
  assert.equal(buy.pending[0].since, '2026-09-09');
  assert.deepEqual(buy.nextPendingState.pending, { '위탁|가상해외주식A': { since: '2026-09-09' } });
  assert.equal(hasGbAlertIssues(buy), false);
  const sell = run([holding({ qty: 10 })], [nhRow({ cns_bse_bnc_qty: '7', sll_cns_qty: '3' })]);
  assert.equal(sell.pending.length, 1);
  // 대기분이 있어도 게시된 수량과 안 맞으면 차이.
  const off = run([holding({ qty: 9 })], [nhRow({ cns_bse_bnc_qty: '10', byn_cns_qty: '2' })]);
  assert.equal(off.mismatches.length, 1);
});

test('게시 대기 영업일: 평일 2일까지는 조용히, 2일 초과면 경고, 주말은 세지 않는다', () => {
  assert.equal(GB_PENDING_ALERT_BUSINESS_DAYS, 2);
  // 2026-09-04(금) 시작 → 월(1) 화(2) 수(3).
  assert.equal(businessDaysBetween('2026-09-04', '2026-09-05'), 0);
  assert.equal(businessDaysBetween('2026-09-04', '2026-09-07'), 1);
  assert.equal(businessDaysBetween('2026-09-04', '2026-09-08'), 2);
  assert.equal(businessDaysBetween('2026-09-04', '2026-09-09'), 3);
  assert.equal(businessDaysBetween('2026-09-09', '2026-09-04'), 0);
  const args = [[holding({ qty: 8 })], [nhRow({ byn_cns_qty: '2' })]];
  const pendingState = { pending: { '위탁|가상해외주식A': { since: '2026-09-04' } } };
  const tue = run(...args, { pendingState, today: '2026-09-08' });
  assert.equal(tue.pending[0].businessDays, 2);
  assert.equal(tue.stalePending.length, 0);
  const wed = run(...args, { pendingState, today: '2026-09-09' });
  assert.equal(wed.stalePending.length, 1);
  assert.equal(wed.pending[0].since, '2026-09-04', '시작일은 처음 본 날로 유지');
  assert.equal(hasGbAlertIssues(wed), true);
  // 대기가 풀리면 상태에서 빠진다.
  const posted = run([holding({ qty: 10 })], [nhRow()], { pendingState });
  assert.deepEqual(posted.nextPendingState.pending, {});
});

test('수량 차이·한쪽만 존재: 보유만(qty>0) / NH만(대기분으로 설명 안 됨)은 차이, NH만인데 전량 매수 대기면 게시 대기', () => {
  const diff = run([holding({ qty: 9 })], [nhRow()]);
  assert.equal(diff.mismatches.length, 1);
  const onlyHoldings = run([holding({ name: '가상해외주식B', qty: 3 }), holding()], [nhRow()]);
  assert.deepEqual(onlyHoldings.mismatches.map((item) => [item.name, item.side, item.nhQty]), [['가상해외주식B', 'holdings-only', null]]);
  const zeroHolding = run([holding({ name: '가상해외주식B', qty: 0 }), holding()], [nhRow()]);
  assert.equal(zeroHolding.compared, 1, '보유 0 + NH 없음은 비교 대상이 아니다');
  const onlyNh = run([holding()], [nhRow(), nhRow({ iem_cd: 'VBBB', iem_nm: '가상해외주식B', cns_bse_bnc_qty: '5' })]);
  assert.deepEqual(onlyNh.mismatches.map((item) => [item.name, item.side, item.holdingsQty]), [['가상해외주식B', 'nh-only', null]]);
  const onlyNhPending = run([holding()], [nhRow(), nhRow({ iem_cd: 'VBBB', iem_nm: '가상해외주식B', cns_bse_bnc_qty: '5', byn_cns_qty: '5' })]);
  assert.equal(onlyNhPending.mismatches.length, 0);
  assert.equal(onlyNhPending.pending[0].side, 'nh-only');
  const zeroRow = run([holding()], [nhRow(), nhRow({ iem_cd: 'VBBB', iem_nm: '가상해외주식B', cns_bse_bnc_qty: '0' })]);
  assert.equal(zeroRow.compared, 1, '잔고·대기 모두 0인 NH 행은 비교 대상이 아니다');
});

test('요약·서명·메시지: 수량 차이와 2영업일 초과 대기만 싣고, 4단 구조로 렌더된다', () => {
  const pendingState = { pending: { '위탁|가상해외주식B': { since: '2026-09-01' } } };
  const result = run([holding({ qty: 9 }), holding({ name: '가상해외주식B', qty: 1 }), holding({ name: '가상해외주식C', qty: 4 })], [
    nhRow(), nhRow({ iem_cd: 'VBBB', iem_nm: '가상해외주식B', cns_bse_bnc_qty: '3', byn_cns_qty: '2' }),
    nhRow({ iem_cd: 'VCCC', iem_nm: '가상해외주식C', cns_bse_bnc_qty: '4' }),
  ], { pendingState });
  const summary = buildGbSummary(result, '2026-09-09T12:10:00.000Z');
  assert.equal(summary.status, 'ok');
  assert.equal(summary.compared, 3);
  assert.deepEqual(summary.matched, [{ name: '가상해외주식C', holdingsQty: 4, nhQty: 4 }]);
  assert.deepEqual(summary.pending, [{ name: '가상해외주식B', holdingsQty: 1, nhQty: 3, since: '2026-09-01', businessDays: 6 }]);
  assert.deepEqual(summary.mismatches, [{ name: '가상해외주식A', holdingsQty: 9, nhQty: 10, side: null }]);
  assert.deepEqual(buildGbSummary({ status: 'skipped', reason: '빈 응답' }, 'x'), { checkedAt: 'x', status: 'skipped', reason: '빈 응답' });
  const signature = gbAlertSignature(result);
  assert.match(signature, /^gb-m:위탁\|가상해외주식A:9:10$/m);
  assert.match(signature, /^gb-p:위탁\|가상해외주식B:2026-09-01$/m);
  const message = buildGbReconMessage(result);
  assert.equal(message.agent, 'plutus');
  assert.equal(message.kind, '판단');
  assert.equal(message.facts.length, 2);
  assert.match(message.facts[0], /수량 차이 1종목/);
  assert.match(message.facts[1], /게시 대기 2영업일 초과 1종목\n가상해외주식B: 보유 1 · NH 3 · 2026-09-01부터 평일 6일/);
  const rendered = renderAgentMessage(message);
  assert.match(rendered, /위탁 해외주식 보유 파일과 NH 해외주식 잔고가 맞지 않습니다/);
  assert.equal(hasGbAlertIssues({ status: 'skipped' }), false);
});

test('kstDay: UTC 15시 이후는 다음 날', () => {
  assert.equal(kstDay(new Date('2026-09-09T14:59:00Z')), '2026-09-09');
  assert.equal(kstDay(new Date('2026-09-09T15:00:00Z')), '2026-09-10');
});
