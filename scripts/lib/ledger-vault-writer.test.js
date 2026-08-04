// ledger-vault-writer.mjs 테스트 — 파일명이 멱등키 역할을 하는지, frontmatter가 올바른
// YAML 형태인지 확인.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionRecord, buildDividendRecord } from './ledger-vault-writer.mjs';
import { VAULT_PATHS } from './vault-paths.mjs';

const exec = (overrides = {}) => ({
  tradeDate: '2026-08-04 09:12:33',
  tradeType: '매수',
  stockCode: '005930',
  stockName: '삼성전자',
  quantity: 10,
  price: 71000,
  currency: 'KRW',
  broker: 'NH투자증권',
  ...overrides,
});

test('buildExecutionRecord: 파일명에 날짜·시각·구분·종목명이 들어간다(종류 접두사 없음 — 폴더가 이미 말해줌)', () => {
  const { filename } = buildExecutionRecord(exec());
  assert.equal(filename, '2026-08-04-091233-매수-삼성전자.md');
});

test('buildExecutionRecord: Executions 하위폴더를 가리킨다', () => {
  const { dir } = buildExecutionRecord(exec());
  assert.equal(dir, VAULT_PATHS.facts.ledger.executions);
});

test('buildExecutionRecord: 같은 이벤트는 항상 같은 파일명(멱등키 역할)', () => {
  const a = buildExecutionRecord(exec());
  const b = buildExecutionRecord(exec());
  assert.equal(a.filename, b.filename);
  assert.equal(a.dedupKey, b.dedupKey);
});

test('buildExecutionRecord: 수량이 다르면 다른 dedupKey(분할체결 구분)', () => {
  const a = buildExecutionRecord(exec({ quantity: 10 }));
  const b = buildExecutionRecord(exec({ quantity: 5 }));
  assert.notEqual(a.dedupKey, b.dedupKey);
});

test('buildExecutionRecord: frontmatter에 필수 필드와 account=null(사유 명시) 포함', () => {
  const { content } = buildExecutionRecord(exec());
  assert.match(content, /^---\n/);
  assert.match(content, /type: "execution"/);
  assert.match(content, /tradeType: "매수"/);
  assert.match(content, /stockName: "삼성전자"/);
  assert.match(content, /quantity: 10/);
  assert.match(content, /price: 71000/);
  assert.match(content, /account: null/);
  assert.match(content, /accountNote: ".*Phase 8·9.*"/);
  assert.match(content, /dedupKey: "2026-08-04 09:12:33\|매수\|삼성전자\|10"/);
});

test('buildExecutionRecord: 종목명에 슬래시·콜론 등이 있어도 안전한 파일명', () => {
  const { filename } = buildExecutionRecord(exec({ stockName: 'TIGER 미국:나스닥/100' }));
  assert.doesNotMatch(filename, /[:/]/);
});

test('buildExecutionRecord: 문자열 값의 큰따옴표는 이스케이프된다', () => {
  const { content } = buildExecutionRecord(exec({ stockName: '종목"이상한"이름' }));
  assert.match(content, /stockName: "종목\\"이상한\\"이름"/);
});

const div = (overrides = {}) => ({
  date: '2026-08-04',
  afterTaxAmount: 15000,
  stockName: 'TIGER 리츠부동산인프라',
  acctRaw: '',
  broker: 'NH투자증권',
  receivedTime: '09:00:00',
  uniqueKey: '09:00:00_15000',
  ...overrides,
});

test('buildDividendRecord: 파일명·dedupKey가 결정론적(파일명도 종류 접두사 없음)', () => {
  const a = buildDividendRecord(div());
  const b = buildDividendRecord(div());
  assert.equal(a.filename, b.filename);
  assert.equal(a.filename, '2026-08-04-090000-TIGER-리츠부동산인프라.md');
  assert.equal(a.dedupKey, '2026-08-04|TIGER 리츠부동산인프라|09:00:00_15000');
});

test('buildDividendRecord: Dividends 하위폴더를 가리킨다(Executions와 다른 폴더)', () => {
  const { dir } = buildDividendRecord(div());
  assert.equal(dir, VAULT_PATHS.facts.ledger.dividends);
  assert.notEqual(dir, VAULT_PATHS.facts.ledger.executions);
});

test('buildDividendRecord: 금액이 다르면(같은 시각) uniqueKey가 달라 dedupKey도 달라짐', () => {
  const a = buildDividendRecord(div({ afterTaxAmount: 15000, uniqueKey: '09:00:00_15000' }));
  const b = buildDividendRecord(div({ afterTaxAmount: 20000, uniqueKey: '09:00:00_20000' }));
  assert.notEqual(a.dedupKey, b.dedupKey);
});

test('buildDividendRecord: frontmatter에 배당 필드 포함', () => {
  const { content } = buildDividendRecord(div());
  assert.match(content, /type: "dividend"/);
  assert.match(content, /afterTaxAmount: 15000/);
  assert.match(content, /uniqueKey: "09:00:00_15000"/);
  assert.match(content, /account: null/);
});
