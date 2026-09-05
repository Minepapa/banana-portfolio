import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTRUMENT_TYPE, PHYSICAL_GOLD_IEM_CD, classifyAssetAllocationInstrument, buildHoldingsIndex,
} from './asset-allocation-instrument-router.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// krStockCodeFn/usTickerFn을 항상 주입해 네트워크(DART/KIS 마스터파일) 없이 검증한다.
const neverCalled = (label) => () => { throw new Error(`${label}은 이 테스트에서 호출되면 안 됨`); };

test('보유 중(ticker 필드 있음, assetKey가 code) — registry로 이름 해석 후 그 ticker를 그대로 KR_STOCK으로', () => {
  const holdingsIndex = new Map([['삼성전자', { account: '위탁', assetClass: '국내주식', name: '삼성전자', ticker: '005930', isCashLike: false }]]);
  // 실제 운영에서는 stock-registry.mjs의 getCodeRegistry()가 Holdings.ticker로부터
  // 이 code→name 매핑을 자동 구축한다 — 여기선 그 결과를 직접 주입해 재현.
  const registry = new Map([['005930', '삼성전자']]);
  const r = classifyAssetAllocationInstrument({
    assetKey: '005930', holdingsIndex, registry,
    krStockCodeFn: neverCalled('krStockCodeFn'), usTickerFn: neverCalled('usTickerFn'),
  });
  assert.deepEqual(r, { type: INSTRUMENT_TYPE.KR_STOCK, iemCd: '005930', nhAccountLabel: '위탁', resolvedName: '삼성전자' });
});

test('보유 중(ticker 필드 없음) — krStockCodeFn으로 해석', () => {
  const holdingsIndex = new Map([['sk하이닉스', { account: '위탁', assetClass: '국내주식', name: 'SK하이닉스', ticker: '', isCashLike: false }]]);
  const r = classifyAssetAllocationInstrument({
    assetKey: 'SK하이닉스', holdingsIndex, registry: new Map(),
    krStockCodeFn: (name) => (name === 'SK하이닉스' ? '000660' : null),
  });
  assert.deepEqual(r, { type: INSTRUMENT_TYPE.KR_STOCK, iemCd: '000660', nhAccountLabel: '위탁', resolvedName: 'SK하이닉스' });
});

test('보유 중(채권, 직접채권이라 krStockCodeFn 실패) — UNSUPPORTED, 추측 안 함', () => {
  const holdingsIndex = new Map([['삼척블루파워12', { account: '위탁', assetClass: '채권', name: '삼척블루파워12', ticker: '', isCashLike: false }]]);
  const r = classifyAssetAllocationInstrument({
    assetKey: '삼척블루파워12', holdingsIndex, registry: new Map(),
    krStockCodeFn: () => null,
  });
  assert.equal(r.type, INSTRUMENT_TYPE.UNSUPPORTED);
  assert.match(r.reason, /국내 종목코드 해석 실패/);
});

test('실물금(account=금현물) — GOLD, iemCd 고정값', () => {
  const holdingsIndex = new Map([['금 99.99k', { account: '금현물', assetClass: '금', name: '금 99.99K', ticker: '', isCashLike: false }]]);
  const r = classifyAssetAllocationInstrument({
    assetKey: '금 99.99K', holdingsIndex, registry: new Map(),
    krStockCodeFn: neverCalled('krStockCodeFn'), usTickerFn: neverCalled('usTickerFn'),
  });
  assert.deepEqual(r, { type: INSTRUMENT_TYPE.GOLD, iemCd: PHYSICAL_GOLD_IEM_CD, nhAccountLabel: '금현물', resolvedName: '금 99.99K' });
});

test('"금" 자산군이지만 금현물 계좌 아님(TIGER KRX금현물류 ETF) — GOLD로 오분류하지 않고 KR_STOCK 폴스루', () => {
  const holdingsIndex = new Map([
    ['tiger krx금현물', { account: '위탁', assetClass: '금', name: 'TIGER KRX금현물', ticker: '', isCashLike: false }],
  ]);
  const r = classifyAssetAllocationInstrument({
    assetKey: 'TIGER KRX금현물', holdingsIndex, registry: new Map(),
    krStockCodeFn: (name) => (name === 'TIGER KRX금현물' ? '411060' : null),
  });
  assert.deepEqual(r, { type: INSTRUMENT_TYPE.KR_STOCK, iemCd: '411060', nhAccountLabel: '위탁', resolvedName: 'TIGER KRX금현물' });
});

test('해외주식(한글명) — usTickerFn으로 해석', () => {
  const holdingsIndex = new Map([['테슬라', { account: '위탁', assetClass: '해외주식', name: '테슬라', ticker: '', isCashLike: false }]]);
  const r = classifyAssetAllocationInstrument({
    assetKey: '테슬라', holdingsIndex, registry: new Map(),
    usTickerFn: (name) => (name === '테슬라' ? 'TSLA' : null),
  });
  assert.deepEqual(r, { type: INSTRUMENT_TYPE.OVERSEAS_STOCK, iemCd: 'TSLA', nhAccountLabel: '위탁', resolvedName: '테슬라' });
});

test('해외주식(assetKey 자체가 이미 티커 형태, Holdings는 이름으로만 색인돼 있어 매칭 안 됨) — 미보유 경로로 폴스루해도 티커 그대로 정상 해석', () => {
  // holdingsIndex는 canonName(name) 키만 쓴다(ticker 별도 색인 없음) — assetKey가
  // 이미 티커("GOOGL")면 Holdings의 한글 표시명("알파벳 Class A")과 안 겹쳐 "미보유
  // 신규종목" 경로로 자연히 폴스루한다. 그래도 LOOKS_LIKE_TICKER 판정으로 usTickerFn
  // 호출 없이 올바른 티커로 분류되므로 실행에는 지장 없다(resolvedName만 한글명
  // 대신 티커가 됨 — 화면표시용이 아니라 주문용이라 문제 아님).
  const holdingsIndex = new Map([['알파벳 class a', { account: '위탁', assetClass: '해외주식', name: '알파벳 Class A', ticker: '', isCashLike: false }]]);
  const r = classifyAssetAllocationInstrument({
    assetKey: 'GOOGL', holdingsIndex, registry: new Map(),
    krStockCodeFn: () => null, usTickerFn: neverCalled('usTickerFn'),
  });
  assert.deepEqual(r, { type: INSTRUMENT_TYPE.OVERSEAS_STOCK, iemCd: 'GOOGL', nhAccountLabel: '위탁', resolvedName: 'GOOGL' });
});

test('해외주식인데 티커 해석 실패 — UNSUPPORTED, 추측 안 함', () => {
  const holdingsIndex = new Map([['전혀모르는종목', { account: '위탁', assetClass: '해외주식', name: '전혀모르는종목', ticker: '', isCashLike: false }]]);
  const r = classifyAssetAllocationInstrument({
    assetKey: '전혀모르는종목', holdingsIndex, registry: new Map(),
    usTickerFn: () => null,
  });
  assert.equal(r.type, INSTRUMENT_TYPE.UNSUPPORTED);
  assert.match(r.reason, /해외주식 티커 해석 실패/);
});

test('현금(예수금) — UNSUPPORTED', () => {
  const holdingsIndex = new Map([['예수금', { account: '위탁', assetClass: '현금', name: '예수금', ticker: '', isCashLike: true }]]);
  const r = classifyAssetAllocationInstrument({
    assetKey: '예수금', holdingsIndex, registry: new Map(),
    krStockCodeFn: neverCalled('krStockCodeFn'), usTickerFn: neverCalled('usTickerFn'),
  });
  assert.equal(r.type, INSTRUMENT_TYPE.UNSUPPORTED);
});

test('외화 RP(달러, isCashLike) — UNSUPPORTED, NH 자동스윕 사유 명시', () => {
  const holdingsIndex = new Map([['외화 rp', { account: '위탁', assetClass: '달러', name: '외화 RP', ticker: '', isCashLike: true }]]);
  const r = classifyAssetAllocationInstrument({
    assetKey: '외화 RP', holdingsIndex, registry: new Map(),
    krStockCodeFn: neverCalled('krStockCodeFn'), usTickerFn: neverCalled('usTickerFn'),
  });
  assert.equal(r.type, INSTRUMENT_TYPE.UNSUPPORTED);
  assert.match(r.reason, /자동스윕/);
});

test('미보유 신규종목 — 티커 형태면 usTickerFn 호출 없이 해외주식으로', () => {
  const r = classifyAssetAllocationInstrument({
    assetKey: 'VOO', holdingsIndex: new Map(), registry: new Map(),
    krStockCodeFn: () => null, usTickerFn: neverCalled('usTickerFn'),
  });
  assert.deepEqual(r, { type: INSTRUMENT_TYPE.OVERSEAS_STOCK, iemCd: 'VOO', nhAccountLabel: '위탁', resolvedName: 'VOO' });
});

test('미보유 신규종목 — krStockCodeFn이 해석하면 KR_STOCK(위탁 기본값)', () => {
  const r = classifyAssetAllocationInstrument({
    assetKey: 'KODEX 골드선물(H)', holdingsIndex: new Map(), registry: new Map(),
    krStockCodeFn: (name) => (name === 'KODEX 골드선물(H)' ? '132030' : null),
  });
  assert.deepEqual(r, { type: INSTRUMENT_TYPE.KR_STOCK, iemCd: '132030', nhAccountLabel: '위탁', resolvedName: 'KODEX 골드선물(H)' });
});

test('미보유 신규종목 — 국내·해외 둘 다 실패하면 UNSUPPORTED, 추측 안 함', () => {
  const r = classifyAssetAllocationInstrument({
    assetKey: '완전히 새로운 오탈자종목', holdingsIndex: new Map(), registry: new Map(),
    krStockCodeFn: () => null, usTickerFn: () => null,
  });
  assert.equal(r.type, INSTRUMENT_TYPE.UNSUPPORTED);
  assert.match(r.reason, /미보유 신규종목/);
});

test('별칭표 경유 — assetKey가 별칭이면 registry의 canonical name으로 Holdings를 찾는다', () => {
  const holdingsIndex = new Map([['sk하이닉스', { account: '위탁', assetClass: '국내주식', name: 'SK하이닉스', ticker: '', isCashLike: false }]]);
  // registry는 code→name 맵(stock-registry.mjs 관례) — 여기선 별칭표 자체가
  // resolveCanonicalStockName 내부에서 처리되므로, 이미 알려진 실제 별칭("하이닉스")으로 검증.
  const r = classifyAssetAllocationInstrument({
    assetKey: '하이닉스', holdingsIndex, registry: new Map(),
    krStockCodeFn: () => '000660',
  });
  assert.equal(r.type, INSTRUMENT_TYPE.KR_STOCK);
  assert.equal(r.resolvedName, 'SK하이닉스');
});

// ── 2026-09-06 코드리뷰 지적(M1·M4) 회귀 방지 ──────────────────────────

test('금현물 계좌인데 알려진 실물금 표시명이 아니면 GOLD로 추정하지 않고 UNSUPPORTED', () => {
  const holdingsIndex = new Map([['미니금100g', { account: '금현물', assetClass: '금', name: '미니금100g', ticker: '', isCashLike: false }]]);
  const r = classifyAssetAllocationInstrument({
    assetKey: '미니금100g', holdingsIndex, registry: new Map(),
    krStockCodeFn: neverCalled('krStockCodeFn'), usTickerFn: neverCalled('usTickerFn'),
  });
  assert.equal(r.type, INSTRUMENT_TYPE.UNSUPPORTED);
  assert.match(r.reason, /알 수 없는 실물금 상품명/);
});

test('buildHoldingsIndex: 같은 이름이 서로 다른 계좌에 있으면 ambiguousAccounts로 표시', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdings-idx-'));
  writeFileSync(join(dir, '위탁-TIGER-KRX금현물.md'), '---\naccount: "위탁"\nassetClass: "금"\nname: "TIGER KRX금현물"\nticker: ""\n---\n');
  writeFileSync(join(dir, '연금저축-TIGER-KRX금현물.md'), '---\naccount: "연금저축"\nassetClass: "금"\nname: "TIGER KRX금현물"\nticker: ""\n---\n');
  const index = buildHoldingsIndex({ holdingsDir: dir });
  const entry = index.get('tiger krx금현물');
  assert.ok(Array.isArray(entry.ambiguousAccounts));
  assert.deepEqual(new Set(entry.ambiguousAccounts), new Set(['위탁', '연금저축']));
});

test('같은 이름이 여러 계좌에 있으면(ambiguousAccounts) 계좌 추정 안 하고 UNSUPPORTED', () => {
  const holdingsIndex = new Map([[
    'tiger krx금현물',
    { account: '연금저축', assetClass: '금', name: 'TIGER KRX금현물', ticker: '', isCashLike: false, ambiguousAccounts: ['위탁', '연금저축'] },
  ]]);
  const r = classifyAssetAllocationInstrument({
    assetKey: 'TIGER KRX금현물', holdingsIndex, registry: new Map(),
    krStockCodeFn: neverCalled('krStockCodeFn'), usTickerFn: neverCalled('usTickerFn'),
  });
  assert.equal(r.type, INSTRUMENT_TYPE.UNSUPPORTED);
  assert.match(r.reason, /여러 계좌/);
});
