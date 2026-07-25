import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usTicker, parseCorpCodeXml, lookupField, parseKisMasterText, mergeMstEntry } from './instruments.mjs';

// KIS 종목마스터 행 조립 헬퍼(테스트용) — 실 레이아웃: 0:9=단축코드, 9:21=표준코드,
// 21:=한글명(그룹코드 앵커 전까지). groupCode는 실측대로 이름에 공백 없이 바로 붙는 경우
// (ETF류)와 긴 공백 패딩 뒤에 붙는 경우(주식류) 둘 다 재현 가능하게 pad로 조절.
const kisRow = (code, name, { std = 'KR7000000000', groupCode = 'EF', pad = 0 } = {}) =>
  code.padEnd(9) + std.padEnd(12) + name + ' '.repeat(pad) + groupCode + '000000000000';

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

test('parseKisMasterText: ETF명이 그룹코드와 공백 없이 바로 붙어도(실측 패턴) 정상 추출', () => {
  // 실측: "...커버드콜EF 000000000000NN..." — 이름 뒤에 패딩 공백이 없는 케이스(2026-07 버그 재현).
  const text = kisRow('0008S0', 'TIGER 미국배당다우존스타겟데일리커버드콜', { pad: 0 });
  assert.equal(parseKisMasterText(text)['TIGER 미국배당다우존스타겟데일리커버드콜'], '0008S0');
});

test('parseKisMasterText: 주식명처럼 긴 공백 패딩 뒤 그룹코드가 와도 정상 추출', () => {
  const text = kisRow('005930', '삼성전자', { groupCode: 'ST', pad: 30 });
  assert.equal(parseKisMasterText(text)['삼성전자'], '005930');
});

test('parseKisMasterText: 여러 행 파싱 + 개행 섞여도 정상', () => {
  const text = [
    kisRow('005930', '삼성전자', { groupCode: 'ST', pad: 30 }),
    kisRow('000660', 'SK하이닉스', { groupCode: 'ST', pad: 28 }),
  ].join('\n');
  const m = parseKisMasterText(text);
  assert.equal(m['삼성전자'], '005930');
  assert.equal(m['SK하이닉스'], '000660');
});

test('parseKisMasterText: 동일명 다른 코드 → null 고착(DART parseCorpCodeXml과 동일 원칙)', () => {
  const text = [kisRow('111111', '중복종목', { pad: 0 }), kisRow('222222', '중복종목', { pad: 0 })].join('\n');
  assert.equal(parseKisMasterText(text)['중복종목'], null);
});

test('parseKisMasterText: 동일명 동일 코드 반복은 충돌 아님', () => {
  const text = [kisRow('005930', '삼성전자', { pad: 0 }), kisRow('005930', '삼성전자', { pad: 0 })].join('\n');
  assert.equal(parseKisMasterText(text)['삼성전자'], '005930');
});

test('parseKisMasterText: 너무 짧은 행(깨진 데이터)·그룹코드 앵커 없는 행은 조용히 skip', () => {
  const text = 'short\nnogroupcodehere' + ' '.repeat(20) + '\n' + kisRow('005930', '삼성전자', { pad: 0 });
  const m = parseKisMasterText(text);
  assert.equal(m['삼성전자'], '005930');
  assert.equal(Object.keys(m).length, 1);
});

test('parseKisMasterText: 앵커가 이름 자체를 먹어 1자 이하로 남으면 신뢰 안 함(오탐 방어)', () => {
  // name='A' + groupCode='BC' + pad=0 → "ABC000000000000"에서 정규식이 index1("BC"+숫자)에
  // 매치돼 이름이 "A" 1자로 잘림 — 신뢰할 수 없는 값이라 length<2 가드로 버려져야 한다.
  const text = kisRow('999999', 'A', { pad: 0, groupCode: 'BC' });
  const m = parseKisMasterText(text);
  assert.equal(Object.keys(m).length, 0);
});

test('mergeMstEntry: 같은 이름·같은 코드는 충돌 아님', () => {
  const map = {};
  mergeMstEntry(map, '삼성전자', '005930');
  mergeMstEntry(map, '삼성전자', '005930');
  assert.equal(map['삼성전자'], '005930');
});

test('mergeMstEntry: 같은 이름·다른 코드는 null 고착(파일 간 병합 시나리오 — KOSPI·KOSDAQ 동명 충돌)', () => {
  const map = {};
  mergeMstEntry(map, '테스트종목', '111111');   // KOSPI에서 옴
  mergeMstEntry(map, '테스트종목', '222222');   // KOSDAQ에서 다른 코드로 또 옴 — 조용히 덮어쓰면 안 됨
  assert.equal(map['테스트종목'], null);
});

test('mergeMstEntry: 이미 null인 항목은 그대로 null 유지(리셋 안 됨)', () => {
  const map = { '모호종목': null };
  mergeMstEntry(map, '모호종목', '333333');
  assert.equal(map['모호종목'], null);
});
