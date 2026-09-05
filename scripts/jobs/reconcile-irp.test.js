import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIrpHoldings, buildIrpHoldingsPlan } from './reconcile-irp.mjs';

// 2026-08-22 — v1 구글시트 대사 기준을 Vault State/Holdings로 교체.
// 2026-09-04 — "비교해서 경고"(buildIrpMismatches)를 "KIS가 정본, 직접 덮어쓰기"
// (buildIrpHoldingsPlan)로 재전환(reconcile-irp.mjs 헤더 주석 참고). 코드리뷰 지적으로
// code 우선매칭·전량청산 오탐가드·assetClass 결측 경고를 추가(같은 파일 buildIrpHoldingsPlan
// 헤더 주석 참고).
// 순수 함수만 테스트(파일시스템·KIS 네트워크는 주입/스텁).

test('readIrpHoldings: 존재하지 않는 디렉토리면 빈 배열', () => {
  assert.deepEqual(readIrpHoldings('/no/such/dir'), []);
});

test('buildIrpHoldingsPlan: 수량·평단가 모두 일치하면 changed:false', () => {
  const { writes, closes, skipped, suspiciousEmpty } = buildIrpHoldingsPlan(
    [{ name: 'TIGER TDF2045', ticker: '0025N0', qty: 100, avgPrice: 11500, assetClass: 'TDF' }],
    [{ code: '0025N0', name: 'TIGER TDF2045', qty: 100, avgPrice: 11500, invest: 1150000, curPrice: 11900, evalAmount: 1190000, profitAmount: 40000, profitPct: 3.48 }],
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].changed, false);
  assert.equal(writes[0].assetClass, 'TDF'); // 기존 Vault identity 필드 보존
  assert.equal(writes[0].ticker, '0025N0');
  assert.deepEqual(closes, []);
  assert.deepEqual(skipped, []);
  assert.equal(suspiciousEmpty, false);
});

test('buildIrpHoldingsPlan: 수량 불일치면 changed:true로 KIS 값 반영', () => {
  const { writes } = buildIrpHoldingsPlan(
    [{ name: 'TIGER TDF2045', ticker: '0025N0', qty: 412, avgPrice: 11504.5 }],
    [{ code: '0025N0', name: 'TIGER TDF2045', qty: 413, avgPrice: 11505.57, invest: 4751800, curPrice: 11925, evalAmount: 4925025, profitAmount: 173225, profitPct: 3.64 }],
  );
  assert.equal(writes[0].changed, true);
  assert.equal(writes[0].qty, 413);
  assert.equal(writes[0].avgPrice, 11505.57);
});

test('buildIrpHoldingsPlan: code로 매칭 — 종목명이 바뀌어도 같은 code면 기존 identity 보존(전량청산 오판 방지)', () => {
  const { writes, closes } = buildIrpHoldingsPlan(
    [{ name: 'TIGER TDF2045 적격(구)', ticker: '0025N0', qty: 413, avgPrice: 11505, assetClass: 'TDF' }],
    [{ code: '0025N0', name: 'TIGER TDF2045 적격(신)', qty: 413, avgPrice: 11505.57, invest: 4751800, curPrice: 11925, evalAmount: 4925025, profitAmount: 173225, profitPct: 3.64 }],
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'TIGER TDF2045 적격(신)');
  assert.equal(writes[0].assetClass, 'TDF'); // code로 매칭됐으니 옛 이름 파일의 assetClass를 그대로 이어받음
  assert.deepEqual(closes, []); // 이름이 바뀐 것뿐, 청산 아님
});

test('[코드리뷰 발견/이중계상 재현] buildIrpHoldingsPlan: 상품명이 바뀌면 옛 이름을 renames로 담아 옛 파일을 정리 대상으로 표시', () => {
  const { writes, closes, renames } = buildIrpHoldingsPlan(
    [{ name: 'TIGER TDF2045 적격(구)', ticker: '0025N0', qty: 413, avgPrice: 11505, assetClass: 'TDF' }],
    [{ code: '0025N0', name: 'TIGER TDF2045 적격(신)', qty: 413, avgPrice: 11505.57, invest: 4751800, curPrice: 11925, evalAmount: 4925025, profitAmount: 173225, profitPct: 3.64 }],
  );
  // 새 이름으로 파일을 쓰고(writes) + 청산 목록엔 안 들어가면서(closes 비어있음) +
  // 동시에 옛 이름 파일을 지워야 한다는 신호(renames)가 함께 있어야 한다 — 셋 중
  // 하나라도 빠지면 옛 파일이 남아 이중계상된다.
  assert.equal(writes[0].name, 'TIGER TDF2045 적격(신)');
  assert.deepEqual(closes, []);
  assert.deepEqual(renames, [{ oldName: 'TIGER TDF2045 적격(구)', newName: 'TIGER TDF2045 적격(신)' }]);
});

test('buildIrpHoldingsPlan: 상품명이 그대로면(이름매칭) renames 없음', () => {
  const { renames } = buildIrpHoldingsPlan(
    [{ name: 'TIGER TDF2045', ticker: '0025N0', qty: 100, avgPrice: 11500, assetClass: 'TDF' }],
    [{ code: '0025N0', name: 'TIGER TDF2045', qty: 100, avgPrice: 11500, invest: 1150000, curPrice: 11900, evalAmount: 1190000, profitAmount: 40000, profitPct: 3.48 }],
  );
  assert.deepEqual(renames, []);
});

test('buildIrpHoldingsPlan: 신규 종목(기존 Vault에 없음)은 renames 없음(이름 변경이 아니라 진짜 신규)', () => {
  const { renames } = buildIrpHoldingsPlan(
    [],
    [{ code: '999999', name: '신규매수종목', qty: 5, avgPrice: 10000, invest: 50000, curPrice: 10100, evalAmount: 50500, profitAmount: 500, profitPct: 1 }],
  );
  assert.deepEqual(renames, []);
});

test('buildIrpHoldingsPlan: KIS에만 있는 신규 종목 — assetClass 빈 문자열 + assetClassMissing에 담김', () => {
  const { writes, assetClassMissing } = buildIrpHoldingsPlan(
    [],
    [{ code: '999999', name: '신규매수종목', qty: 5, avgPrice: 10000, invest: 50000, curPrice: 10100, evalAmount: 50500, profitAmount: 500, profitPct: 1 }],
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].changed, true);
  assert.equal(writes[0].assetClass, '');
  assert.deepEqual(assetClassMissing, ['신규매수종목']);
});

test('buildIrpHoldingsPlan: Vault에만 있고 KIS엔 최소 1개 다른 종목이 있으면(정상 응답) 사라진 종목은 closes', () => {
  const { writes, closes } = buildIrpHoldingsPlan(
    [{ name: '청산된종목', ticker: '111111', qty: 10, avgPrice: 5000 }],
    [{ code: '222222', name: '다른보유종목', qty: 1, avgPrice: 20000, invest: 20000, curPrice: 20000, evalAmount: 20000, profitAmount: 0, profitPct: 0 }],
  );
  assert.equal(writes.length, 1);
  assert.deepEqual(closes, ['청산된종목']);
});

test('[코드리뷰 CRITICAL] buildIrpHoldingsPlan: KIS 응답이 통째로 빈 배열이면(간헐적 결측 가능성) 전량청산으로 추정 안 함 — closes 비고 suspiciousEmpty:true', () => {
  const { writes, closes, suspiciousEmpty } = buildIrpHoldingsPlan(
    [{ name: 'TIGER TDF2045', ticker: '0025N0', qty: 413, avgPrice: 11505 }],
    [],
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(closes, []); // 빈 응답만으로 지우지 않음 — CRITICAL 버그 재발 방지
  assert.equal(suspiciousEmpty, true);
});

test('buildIrpHoldingsPlan: 양쪽 다 원래 비어있으면 suspiciousEmpty:false(정상적인 무보유 상태)', () => {
  const { writes, closes, skipped, suspiciousEmpty } = buildIrpHoldingsPlan([], []);
  assert.deepEqual(writes, []);
  assert.deepEqual(closes, []);
  assert.deepEqual(skipped, []);
  assert.equal(suspiciousEmpty, false);
});

test('buildIrpHoldingsPlan: avgPrice/invest 결측 종목은 skipped로 분리(추정 안 함) + Vault에서 지워지지 않음', () => {
  const { writes, closes, skipped } = buildIrpHoldingsPlan(
    [{ name: '필드결측종목', ticker: '333333', qty: 10, avgPrice: 5000 }],
    [{ code: '333333', name: '필드결측종목', qty: 12, avgPrice: null, invest: null, curPrice: 5100, evalAmount: 61200, profitAmount: null, profitPct: null }],
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(skipped, ['필드결측종목']);
  assert.deepEqual(closes, []); // 결측이어도 KIS가 보유 중이라 보고했으므로 청산 아님
});
