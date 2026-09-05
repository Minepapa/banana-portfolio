import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountTag, assetClassTag, stockTag, buildVaultTags } from './vault-tags.mjs';

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
  assert.equal(stockTag('삼성전자'), '종목/삼성전자');
});

test('[Obsidian 태그 유효문자 방어] stockTag: 공백은 하이픈으로, 괄호는 제거', () => {
  assert.equal(stockTag('ACE 미국하이일드액티브(H)'), '종목/ACE-미국하이일드액티브H');
});

test('[Obsidian 태그 유효문자 방어] stockTag: 대괄호도 제거', () => {
  assert.equal(stockTag('TIME Korea플러스배당액티브[주'), '종목/TIME-Korea플러스배당액티브주');
});

test('stockTag: 원본에 슬래시가 있어도 계층 구분자와 섞이지 않게 제거', () => {
  assert.equal(stockTag('A/B'), '종목/AB');
});

test('buildVaultTags: 세 값 모두 있으면 계좌→자산군→종목 순서로 조합', () => {
  assert.deepEqual(
    buildVaultTags({ account: '위탁', assetClass: '국내주식', stockName: '삼성전자' }),
    ['계좌/위탁', '자산군/국내주식', '종목/삼성전자'],
  );
});

test('buildVaultTags: 없는 축은 자연히 빠짐(예: CashEvents처럼 종목 없는 레코드)', () => {
  assert.deepEqual(buildVaultTags({ account: 'CMA' }), ['계좌/CMA']);
});

test('buildVaultTags: 전부 없으면 빈 배열', () => {
  assert.deepEqual(buildVaultTags(), []);
  assert.deepEqual(buildVaultTags({}), []);
});

test('buildVaultTags: account가 null(예: 퀀트 track proposal)이어도 안 죽고 나머지만 반환', () => {
  assert.deepEqual(buildVaultTags({ account: null, stockName: '017670' }), ['종목/017670']);
});
