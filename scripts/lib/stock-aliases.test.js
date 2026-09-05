import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MANUAL_STOCK_ALIASES } from './stock-aliases.mjs';
import { canonName } from '../../src/lib/stockIdentity.js';

// 실제 므네모시네에서 관측된 파편화 사례(2026-09-05 코드리뷰·오너 지시로 확인) —
// 이 테이블에 새 별칭을 추가할 때마다 여기도 같이 추가할 것(회귀 가드).

test('삼성전자보통주 → 삼성전자', () => {
  assert.equal(MANUAL_STOCK_ALIASES.get(canonName('삼성전자보통주')), '삼성전자');
});

test('에스케이하이닉스보통주·하이닉스 → SK하이닉스', () => {
  assert.equal(MANUAL_STOCK_ALIASES.get(canonName('에스케이하이닉스보통주')), 'SK하이닉스');
  assert.equal(MANUAL_STOCK_ALIASES.get(canonName('하이닉스')), 'SK하이닉스');
});

test('ACE 미국국채10년액티브 → ACE 미국10년국채액티브', () => {
  assert.equal(MANUAL_STOCK_ALIASES.get(canonName('ACE 미국국채10년액티브')), 'ACE 미국10년국채액티브');
});

test('KODEX 골드선물(H) ETF → KODEX 골드선물(H)', () => {
  assert.equal(MANUAL_STOCK_ALIASES.get(canonName('KODEX 골드선물(H) ETF')), 'KODEX 골드선물(H)');
});

test('SK텔레콤보통주 → SK텔레콤', () => {
  assert.equal(MANUAL_STOCK_ALIASES.get(canonName('SK텔레콤보통주')), 'SK텔레콤');
});

test('VIP한국형가치투자증권자투자(주식)-C-Pe(신탁 누락) → 신탁 포함 표준명', () => {
  assert.equal(
    MANUAL_STOCK_ALIASES.get(canonName('VIP한국형가치투자증권자투자(주식)-C-Pe')),
    'VIP한국형가치투자증권자투자신탁(주식)-C-Pe',
  );
});

test('타임폴리오 TIME Korea플러스배당액티브 정식장문명 → TIME Korea플러스배당액티브', () => {
  assert.equal(
    MANUAL_STOCK_ALIASES.get(canonName('타임폴리오 TIME Korea플러스배당액티브증권상장지수투자신탁[주')),
    'TIME Korea플러스배당액티브',
  );
});

test('TIGER 리츠부동산TOP10(v1 축약표기) → TIGER 리츠부동산인프라TOP10액티브', () => {
  assert.equal(MANUAL_STOCK_ALIASES.get(canonName('TIGER 리츠부동산TOP10')), 'TIGER 리츠부동산인프라TOP10액티브');
});

test('미래에셋 TIGER 리츠부동산인프라TOP10액티브 정식장문명 → TIGER 리츠부동산인프라TOP10액티브', () => {
  assert.equal(
    MANUAL_STOCK_ALIASES.get(canonName('미래에셋 TIGER 리츠부동산인프라TOP10액티브부동산상장지수투자')),
    'TIGER 리츠부동산인프라TOP10액티브',
  );
});

test('한화 PLUS 고배당주 정식장문명 → PLUS 고배당주', () => {
  assert.equal(MANUAL_STOCK_ALIASES.get(canonName('한화 PLUS 고배당주 증권상장지수투자신탁(주식)')), 'PLUS 고배당주');
});

test('[오너 확인 2026-09-05] TIMEFOLIO Korea배당액티브 → TIME Korea플러스배당액티브', () => {
  assert.equal(MANUAL_STOCK_ALIASES.get(canonName('TIMEFOLIO Korea배당액티브')), 'TIME Korea플러스배당액티브');
});

test('[오너 확인 2026-09-05] 한국투자 ACE 미국하이일드액티브 정식장문명(헤지형) → ACE 미국하이일드액티브(H)', () => {
  assert.equal(
    MANUAL_STOCK_ALIASES.get(canonName('한국투자 ACE 미국하이일드액티브증권상장지수투자신탁[채권-재')),
    'ACE 미국하이일드액티브(H)',
  );
});

test('[오너 확인 2026-09-05] 미래에셋 TIGER 리츠부동산인프라 혼합자산 정식장문명 → TIGER 리츠부동산인프라(일반, TOP10액티브와 별도)', () => {
  assert.equal(
    MANUAL_STOCK_ALIASES.get(canonName('미래에셋 TIGER 리츠부동산인프라혼합자산상장지수투자신탁(재간')),
    'TIGER 리츠부동산인프라',
  );
  // TOP10액티브 별칭과 혼동되지 않는지 교차 확인.
  assert.notEqual(
    MANUAL_STOCK_ALIASES.get(canonName('미래에셋 TIGER 리츠부동산인프라혼합자산상장지수투자신탁(재간')),
    'TIGER 리츠부동산인프라TOP10액티브',
  );
});

test('키는 canonName 기준이라 대소문자·공백 차이는 흡수', () => {
  assert.equal(MANUAL_STOCK_ALIASES.get(canonName('  하이닉스  ')), 'SK하이닉스');
});

test('등록 안 된 이름은 undefined(별칭표 자체는 폴백을 안 함 — resolveCanonicalStockName 몫)', () => {
  assert.equal(MANUAL_STOCK_ALIASES.get(canonName('전혀 다른 종목')), undefined);
});
