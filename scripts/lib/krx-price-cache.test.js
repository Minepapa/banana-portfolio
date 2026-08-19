import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSeries, ensurePriceHistory } from './krx-price-cache.mjs';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'krx-daily');
// 실제 캐시와 절대 안 겹치는 테스트 전용 과거 날짜대(1999년) — 진짜 거래일 캐시를
// 오염시키지 않는다(ocf-history-cache.test.js의 TEST- 접두 코드와 동일한 격리 관례).
const cleanup = (basDds) => basDds.forEach((b) => rmSync(join(CACHE_DIR, `${b}.json`), { force: true }));

test('extractSeries: 정상 추출 — 날짜·종가·고저·거래량·거래대금·시총 정렬', () => {
  const history = [
    { basDd: '20260101', KOSPI: [{ ISU_CD: 'X', TDD_CLSPRC: '100', TDD_HGPRC: '110', TDD_LWPRC: '90', ACC_TRDVOL: '5', ACC_TRDVAL: '500', MKTCAP: '1000' }], KOSDAQ: [] },
    { basDd: '20260102', KOSPI: [{ ISU_CD: 'X', TDD_CLSPRC: '105', TDD_HGPRC: '112', TDD_LWPRC: '95', ACC_TRDVOL: '7', ACC_TRDVAL: '700', MKTCAP: '1050' }], KOSDAQ: [] },
  ];
  const s = extractSeries(history, 'X');
  assert.deepEqual(s.basDds, ['20260101', '20260102']);
  assert.deepEqual(s.closes, [100, 105]);
  assert.deepEqual(s.highs, [110, 112]);
  assert.deepEqual(s.lows, [90, 95]);
  assert.deepEqual(s.volumes, [5, 7]);
  assert.deepEqual(s.values, [500, 700]);
  assert.deepEqual(s.marketCaps, [1000, 1050]);
});

test('extractSeries: KOSDAQ 쪽에서도 찾음, 없는 날은 건너뜀(추정 안 함)', () => {
  const history = [
    { basDd: '1', KOSPI: [], KOSDAQ: [{ ISU_CD: 'Q', TDD_CLSPRC: '50', TDD_HGPRC: '55', TDD_LWPRC: '45', ACC_TRDVOL: '1', ACC_TRDVAL: '50', MKTCAP: '10' }] },
    { basDd: '2', KOSPI: [], KOSDAQ: [] }, // 그 종목이 안 보이는 날
  ];
  const s = extractSeries(history, 'Q');
  assert.deepEqual(s.basDds, ['1']);
  assert.equal(s.closes.length, 1);
});

test('extractSeries: ETF도 찾음(유가증권/코스닥 일별매매정보에 안 섞여 있어 별도 조회 필요, 2026-08-19 실측 버그 수정)', () => {
  const history = [
    { basDd: '1', KOSPI: [], KOSDAQ: [], ETF: [{ ISU_CD: 'E', TDD_CLSPRC: '12000', TDD_HGPRC: '12100', TDD_LWPRC: '11900', ACC_TRDVOL: '3', ACC_TRDVAL: '36000', MKTCAP: '500000' }] },
  ];
  const s = extractSeries(history, 'E');
  assert.deepEqual(s.closes, [12000]);
  assert.deepEqual(s.marketCaps, [500000]);
});

test('extractSeries: 종가 없는 행(거래정지 등)은 스킵', () => {
  const history = [{ basDd: '1', KOSPI: [{ ISU_CD: 'X', TDD_CLSPRC: '' }], KOSDAQ: [] }];
  const s = extractSeries(history, 'X');
  assert.deepEqual(s.basDds, []);
});

test('ensurePriceHistory: 첫 호출은 네트워크, 같은 범위 재호출은 캐시만 사용(호출횟수 0)', async () => {
  const startDate = new Date(1999, 0, 6); // 테스트 전용 과거 날짜대(1999-01-06, 실캐시와 무관)
  let networkCalls = 0;
  const fetchImpl = async (url) => {
    networkCalls++;
    const m = url.match(/basDd=(\d+)/);
    const rows = [{ ISU_CD: 'Z', TDD_CLSPRC: '1', TDD_HGPRC: '1', TDD_LWPRC: '1', ACC_TRDVOL: '1', ACC_TRDVAL: '1', MKTCAP: '1', _basDd: m[1] }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ OutBlock_1: rows }) };
  };
  try {
    const first = await ensurePriceHistory(3, { apiKey: 'K', fetchImpl, delayMs: 0, startDate });
    assert.equal(first.length, 3);
    const callsAfterFirst = networkCalls;
    assert.ok(callsAfterFirst > 0);

    const second = await ensurePriceHistory(3, { apiKey: 'K', fetchImpl, delayMs: 0, startDate });
    assert.equal(second.length, 3);
    assert.equal(networkCalls, callsAfterFirst, '캐시가 있으면 네트워크를 다시 타면 안 됨');
    assert.deepEqual(second.map((d) => d.basDd), first.map((d) => d.basDd));
  } finally {
    cleanup(['19990104', '19990105', '19990106']);
  }
});

test('ensurePriceHistory: 캐시 파일이 실제로 KOSPI+KOSDAQ+ETF 구조로 디스크에 저장됨(ETF 별도조회 포함)', async () => {
  const startDate = new Date(1998, 5, 2); // 다른 테스트 전용 과거 날짜대(1998년) — 격리
  const fetchImpl = async (url) => {
    let rows = [];
    if (/stk_bydd_trd/.test(url)) rows = [{ ISU_CD: 'A', TDD_CLSPRC: '9' }];
    else if (/etf_bydd_trd/.test(url)) rows = [{ ISU_CD: 'E', TDD_CLSPRC: '99' }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ OutBlock_1: rows }) };
  };
  try {
    const out = await ensurePriceHistory(1, { apiKey: 'K', fetchImpl, delayMs: 0, startDate });
    assert.equal(out.length, 1);
    const path = join(CACHE_DIR, `${out[0].basDd}.json`);
    assert.equal(existsSync(path), true);
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(saved.KOSPI, [{ ISU_CD: 'A', TDD_CLSPRC: '9' }]);
    assert.deepEqual(saved.KOSDAQ, []);
    assert.deepEqual(saved.ETF, [{ ISU_CD: 'E', TDD_CLSPRC: '99' }]);
  } finally {
    cleanup(['19980601', '19980602']);
  }
});

test('ensurePriceHistory: ETF 키 없는 구버전 캐시(ETF 지원 추가 전 스키마)는 신뢰하지 않고 재조회함(코드리뷰 지적, 2026-08-19)', async () => {
  const startDate = new Date(1997, 3, 7); // 또 다른 테스트 전용 과거 날짜대(1997년 4월) — 격리
  const basDd = '19970407';
  mkdirSync(CACHE_DIR, { recursive: true });
  // ETF 지원 추가 전 스키마를 흉내낸 캐시 파일을 미리 심어둔다(KOSPI/KOSDAQ만 있고 ETF 없음).
  writeFileSync(join(CACHE_DIR, `${basDd}.json`), JSON.stringify({ KOSPI: [{ ISU_CD: 'OLD', TDD_CLSPRC: '1' }], KOSDAQ: [] }));

  let networkCalls = 0;
  const fetchImpl = async (url) => {
    networkCalls++;
    const rows = /etf_bydd_trd/.test(url) ? [{ ISU_CD: 'E', TDD_CLSPRC: '77' }] : [{ ISU_CD: 'NEW', TDD_CLSPRC: '2' }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ OutBlock_1: rows }) };
  };
  try {
    const out = await ensurePriceHistory(1, { apiKey: 'K', fetchImpl, delayMs: 0, startDate });
    assert.equal(out.length, 1);
    assert.ok(networkCalls > 0, '구버전 캐시를 그대로 믿었다면 네트워크 호출이 0이었을 것');
    const saved = JSON.parse(readFileSync(join(CACHE_DIR, `${basDd}.json`), 'utf8'));
    assert.ok('ETF' in saved, '재조회 후엔 ETF 키가 있어야 함');
    assert.deepEqual(saved.ETF, [{ ISU_CD: 'E', TDD_CLSPRC: '77' }]);
  } finally {
    cleanup([basDd]);
  }
});
