import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usTicker, parseCorpCodeXml, lookupField } from './instruments.mjs';

test('usTicker: 한글명→티커, 공백·대소문자 정규화', () => {
  assert.equal(usTicker('애플'), 'AAPL');
  assert.equal(usTicker('알파벳 Class A'), 'GOOGL');
  assert.equal(usTicker('알파벳  class a'), 'GOOGL');
  assert.equal(usTicker('없는종목'), null);
});

test('parseCorpCodeXml: 상장사만 corp_code 매핑', () => {
  const xml = `<result><list><corp_code>00877059</corp_code><corp_name>삼성바이오로직스</corp_name><stock_code>207940</stock_code><modify_date>20260101</modify_date></list>
<list><corp_code>99999999</corp_code><corp_name>비상장사</corp_name><stock_code> </stock_code><modify_date>20260101</modify_date></list></result>`;
  const m = parseCorpCodeXml(xml);
  assert.equal(m['삼성바이오로직스'].corp, '00877059');
  assert.equal(m['삼성바이오로직스'].stock, '207940');
  assert.equal(m['비상장사'], undefined);
});

test('parseCorpCodeXml: corp_eng_name이 끼어 있어도 매핑(실데이터 구조)', () => {
  const xml = `<list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><corp_eng_name>SAMSUNG ELECTRONICS</corp_eng_name><stock_code>005930</stock_code><modify_date>20260101</modify_date></list>`;
  assert.equal(parseCorpCodeXml(xml)['삼성전자'].corp, '00126380');
});

test('parseCorpCodeXml: stock_code도 함께 보존 (KR 시세용)', () => {
  const xml = `<list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><corp_eng_name>SEC</corp_eng_name><stock_code>005930</stock_code></list>`;
  assert.equal(parseCorpCodeXml(xml)['삼성전자'].stock, '005930');
});

test('parseCorpCodeXml: 동명 3건 — null 고착(리셋 안 됨)', () => {
  const xml = `<list><corp_code>001</corp_code><corp_name>A</corp_name><stock_code>111</stock_code></list>
<list><corp_code>002</corp_code><corp_name>A</corp_name><stock_code>222</stock_code></list>
<list><corp_code>001</corp_code><corp_name>A</corp_name><stock_code>111</stock_code></list>`;
  assert.equal(parseCorpCodeXml(xml)['A'], null); // 한 번 null이면 끝까지 null
});

test('parseCorpCodeXml: 동명 다른 corp_code → null(모호 표시로 환각 차단)', () => {
  // 실데이터에 미래에셋증권·우리금융지주 등 34건 존재
  const xml = `<list><corp_code>00311030</corp_code><corp_name>미래에셋증권</corp_name><stock_code>006800</stock_code></list>
<list><corp_code>00111722</corp_code><corp_name>미래에셋증권</corp_name><stock_code>037620</stock_code></list>`;
  assert.equal(parseCorpCodeXml(xml)['미래에셋증권'], null);
});

test('lookupField: 정상 객체 항목 → 해당 필드 반환', () => {
  const cache = { '삼성전자': { corp: '00126380', stock: '005930' } };
  assert.equal(lookupField(cache, '삼성전자', 'corp'), '00126380');
  assert.equal(lookupField(cache, '삼성전자', 'stock'), '005930');
});

test('lookupField: 미발견 → null', () => {
  assert.equal(lookupField({ '삼성전자': { corp: '00126380', stock: '005930' } }, '없는회사', 'corp'), null);
});

test('lookupField: 구형 문자열 캐시(잘못된 shape) → null (undefined 누출 차단)', () => {
  // 30일 TTL 내 구형 캐시: map 값이 객체가 아닌 bare corp_code 문자열.
  // entry.corp/entry.stock는 undefined이지만 절대 undefined를 반환하면 안 됨.
  const oldCache = { '테스트사': '00999999' };
  assert.equal(lookupField(oldCache, '테스트사', 'corp'), null);
  assert.equal(lookupField(oldCache, '테스트사', 'stock'), null);
});

test('lookupField: null 항목(파싱 모호) → null', () => {
  assert.equal(lookupField({ '미래에셋증권': null }, '미래에셋증권', 'corp'), null);
});
