import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountTag, assetClassTag, stockTag, buildVaultTags } from './vault-tags.mjs';

// ⚠️ 아래 대부분의 테스트는 registry에 빈 Map()을 명시적으로 넘긴다(2026-09-05,
// stock-registry.mjs 연동 후 추가) — stockTag/buildVaultTags의 registry 인자 기본값은
// 실제 Vault 디렉터리를 스캔하는 getCodeRegistry()라, 여기서 안 넘기면 이 단위테스트가
// 실제 디스크 상태에 조용히 결합된다(느리고 비결정적). registry 연동 자체를 검증하는
// 테스트(파일 맨 아래)만 의도적으로 채운 registry를 넘긴다.
const NO_REGISTRY = new Map();

test('accountTag: 계좌 접두사 붙임', () => {
  assert.equal(accountTag('위탁'), '계좌/위탁');
});

test('accountTag: null/undefined/빈 문자열이면 null(태그 생략)', () => {
  assert.equal(accountTag(null), null);
  assert.equal(accountTag(undefined), null);
  assert.equal(accountTag(''), null);
});

test('assetClassTag: 자산군 접두사 붙임', () => {
  assert.equal(assetClassTag('국내주식'), '자산군/국내주식');
});

test('stockTag: 종목 접두사 붙임', () => {
  assert.equal(stockTag('삼성전자', NO_REGISTRY), '종목/삼성전자');
});

test('[Obsidian 태그 유효문자 방어] stockTag: 공백은 하이픈으로, 괄호는 제거', () => {
  assert.equal(stockTag('ACE 미국하이일드액티브(H)', NO_REGISTRY), '종목/ACE-미국하이일드액티브H');
});

test('[Obsidian 태그 유효문자 방어] stockTag: 대괄호도 제거', () => {
  assert.equal(stockTag('TIME Korea플러스배당액티브[주', NO_REGISTRY), '종목/TIME-Korea플러스배당액티브주');
});

test('stockTag: 원본에 슬래시가 있어도 계층 구분자와 섞이지 않게 제거', () => {
  assert.equal(stockTag('A/B', NO_REGISTRY), '종목/AB');
});

test('buildVaultTags: 세 값 모두 있으면 계좌→자산군→종목 순서로 조합', () => {
  assert.deepEqual(
    buildVaultTags({ account: '위탁', assetClass: '국내주식', stockName: '삼성전자' }, NO_REGISTRY),
    ['계좌/위탁', '자산군/국내주식', '종목/삼성전자'],
  );
});

test('buildVaultTags: 없는 축은 자연히 빠짐(예: CashEvents처럼 종목 없는 레코드)', () => {
  assert.deepEqual(buildVaultTags({ account: 'CMA' }, NO_REGISTRY), ['계좌/CMA']);
});

test('buildVaultTags: 전부 없으면 빈 배열', () => {
  assert.deepEqual(buildVaultTags(undefined, NO_REGISTRY), []);
  assert.deepEqual(buildVaultTags({}, NO_REGISTRY), []);
});

test('buildVaultTags: account가 null(예: 퀀트 track proposal)이어도 안 죽고 나머지만 반환', () => {
  assert.deepEqual(buildVaultTags({ account: null, stockName: '017670' }, NO_REGISTRY), ['종목/017670']);
});

// ── stock-registry.mjs 연동(2026-09-05 신설) ────────────────────────────────────
// "퀀트 계좌에서 종목명 vs 종목코드로 기록되기도 하고, 같은 증권사인데 표기가
// 갈라지기도" 하는 문제 해결 — 오너 지시로 태그 파편화와 함께 처리.

test('[레지스트리 연동] stockTag: code 레지스트리에 있는 code면 표준명으로 치환(퀀트 코드↔이름)', () => {
  const registry = new Map([['017670', 'SK텔레콤']]);
  assert.equal(stockTag('017670', registry), '종목/SK텔레콤');
});

test('[레지스트리 연동] stockTag: 수동 별칭표에 있는 이름 파편화도 표준명으로 치환', () => {
  // stock-aliases.mjs에 실제로 등록된 항목 — 별칭표는 registry 인자와 무관하게 항상
  // 적용된다(resolveCanonicalStockName이 별칭표를 먼저 확인).
  assert.equal(stockTag('삼성전자보통주', NO_REGISTRY), '종목/삼성전자');
  assert.equal(stockTag('하이닉스', NO_REGISTRY), '종목/SK하이닉스');
});

test('[레지스트리 연동] stockTag: 레지스트리에도 별칭표에도 없으면 원본 그대로(안전한 폴백)', () => {
  assert.equal(stockTag('처음보는종목', NO_REGISTRY), '종목/처음보는종목');
});

test('[레지스트리 연동] buildVaultTags: registry를 명시적으로 넘기면 종목 축에도 반영', () => {
  const registry = new Map([['005930', '삼성전자']]);
  assert.deepEqual(
    buildVaultTags({ account: '자산분배', stockName: '005930' }, registry),
    ['계좌/자산분배', '종목/삼성전자'],
  );
});
