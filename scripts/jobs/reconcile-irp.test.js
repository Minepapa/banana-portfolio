import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIrpHoldings, buildIrpMismatches } from './reconcile-irp.mjs';

// 2026-08-22 — v1 구글시트 대사 기준을 Vault State/Holdings로 교체(reconcile-irp.mjs
// 헤더 주석 참고). 순수 함수만 테스트(파일시스템·KIS 네트워크는 주입/스텁).

test('readIrpHoldings: 존재하지 않는 디렉토리면 빈 배열', () => {
  assert.deepEqual(readIrpHoldings('/no/such/dir'), []);
});

test('buildIrpMismatches: 수량 일치하면 mismatches 없음', () => {
  const r = buildIrpMismatches(
    [{ name: 'TIGER TDF2045', qty: 100 }],
    [{ name: 'TIGER TDF2045', qty: 100 }],
  );
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.totalNames, 1);
});

test('buildIrpMismatches: 수량 불일치 종목만 보고', () => {
  const r = buildIrpMismatches(
    [{ name: 'TIGER TDF2045', qty: 100 }, { name: 'KODEX 200', qty: 10 }],
    [{ name: 'TIGER TDF2045', qty: 90 }, { name: 'KODEX 200', qty: 10 }],
  );
  assert.equal(r.mismatches.length, 1);
  assert.deepEqual(r.mismatches[0], { name: 'TIGER TDF2045', vaultQty: 100, kisQty: 90 });
});

test('buildIrpMismatches: 한쪽에만 있는 종목도 상대쪽 0으로 비교(신규 매수 등)', () => {
  const r = buildIrpMismatches([], [{ name: '신규매수종목', qty: 5 }]);
  assert.equal(r.mismatches.length, 1);
  assert.deepEqual(r.mismatches[0], { name: '신규매수종목', vaultQty: 0, kisQty: 5 });
});

test('buildIrpMismatches: 양쪽 다 비어있으면 대사 대상 없음', () => {
  const r = buildIrpMismatches([], []);
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.totalNames, 0);
});
