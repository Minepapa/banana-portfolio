import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ymd, fetchKrx, fetchTradingDaySeries, fetchIndexCloses, fetchGoldClose } from './krx.mjs';

test('ymd: YYYYMMDD 포맷(월·일 0패딩)', () => {
  assert.equal(ymd(new Date(2026, 0, 5)), '20260105');
  assert.equal(ymd(new Date(2026, 11, 31)), '20261231');
});

test('fetchKrx: apiKey 없으면 즉시 실패(추정 안 함)', async () => {
  await assert.rejects(
    () => fetchKrx('idx', 'kospi_dd_trd', { basDd: '20260818' }, { apiKey: '' }),
    /KRX_API_KEY 미설정/,
  );
});

test('fetchKrx: 정상 응답 — URL·헤더 구성 확인 + OutBlock_1 반환', async () => {
  let capturedUrl, capturedHeaders;
  const fetchImpl = async (url, init) => {
    capturedUrl = url; capturedHeaders = init.headers;
    return { ok: true, status: 200, text: async () => JSON.stringify({ OutBlock_1: [{ a: 1 }] }) };
  };
  const rows = await fetchKrx('idx', 'kospi_dd_trd', { basDd: '20260818' }, { apiKey: 'K', fetchImpl });
  assert.deepEqual(rows, [{ a: 1 }]);
  assert.match(capturedUrl, /\/svc\/apis\/idx\/kospi_dd_trd\?basDd=20260818/);
  assert.equal(capturedHeaders.AUTH_KEY, 'K');
});

test('fetchKrx: HTTP 비정상 응답이면 respMsg 포함해 에러', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ respMsg: 'Unauthorized API Call' }) });
  await assert.rejects(
    () => fetchKrx('idx', 'kospi_dd_trd', {}, { apiKey: 'K', fetchImpl }),
    /401.*Unauthorized API Call/s,
  );
});

test('fetchKrx: 응답이 JSON이 아니면 에러(HTML 에러페이지 등)', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '<html>Error</html>' });
  await assert.rejects(() => fetchKrx('idx', 'kospi_dd_trd', {}, { apiKey: 'K', fetchImpl }), /파싱 실패/);
});

test('fetchKrx: OutBlock_1 없는 정상 JSON은 에러(응답 이상)', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ foo: 1 }) });
  await assert.rejects(() => fetchKrx('idx', 'kospi_dd_trd', {}, { apiKey: 'K', fetchImpl }), /OutBlock_1/);
});

test('fetchTradingDaySeries: 주말엔 API를 아예 호출하지 않음', async () => {
  const calledDates = [];
  const fetchOneDay = async (basDd) => { calledDates.push(basDd); return [{ v: basDd }]; };
  await fetchTradingDaySeries(fetchOneDay, 5, { startDate: new Date(2026, 7, 19), delayMs: 0 });
  for (const bd of calledDates) {
    const d = new Date(`${bd.slice(0, 4)}-${bd.slice(4, 6)}-${bd.slice(6, 8)}T00:00:00`);
    assert.notEqual(d.getDay(), 0, `${bd}는 일요일이면 안 됨`);
    assert.notEqual(d.getDay(), 6, `${bd}는 토요일이면 안 됨`);
  }
});

test('fetchTradingDaySeries: 재시도해도 계속 빈 배열(진짜 휴장일)이면 건너뛰고 목표 개수엔 안 셈', async () => {
  let n = 0;
  // 평일1(n=1,데이터)·평일2(n=2,데이터)·평일3(진짜 휴장 — 최초 호출 n=3, 재시도 n=4
  // 둘 다 빈 배열)·평일4(n=5,데이터) → 목표 3건은 평일1·2·4로 채워짐.
  const fetchOneDay = async () => { n++; return (n === 3 || n === 4) ? [] : [{ x: n }]; };
  const out = await fetchTradingDaySeries(fetchOneDay, 3, { startDate: new Date(2026, 7, 19), delayMs: 0, emptyRetryDelayMs: 0 });
  assert.equal(out.length, 3);
});

// 2026-09-06 신설 — 실사고 회귀 방지(Log/DevRequests/2026-09-06-weekly-report-facts-
// 불일치-버그.md). 첫 호출은 비어있어도(일시적 KRX 미발행 추정) 재시도에서 데이터가
// 오면 그 거래일을 "휴장"으로 잘못 건너뛰지 않고 정상 포함해야 한다.
test('fetchTradingDaySeries: 첫 응답이 비어도 재시도에서 데이터가 오면 그 날을 포함(일시적 조회 실패 구제)', async () => {
  const calls = {};
  const fetchOneDay = async (basDd) => {
    calls[basDd] = (calls[basDd] || 0) + 1;
    // 각 날짜의 "첫 호출"만 비우고, 재시도(2번째 호출)부터는 데이터를 준다.
    return calls[basDd] === 1 ? [] : [{ basDd }];
  };
  const out = await fetchTradingDaySeries(fetchOneDay, 3, { startDate: new Date(2026, 7, 19), delayMs: 0, emptyRetryDelayMs: 0 });
  assert.equal(out.length, 3); // 재시도로 전부 구제됨 — 하나도 "진짜 휴장"으로 안 빠짐
  for (const basDd of out.map((o) => o.basDd)) assert.equal(calls[basDd], 2, `${basDd}는 재시도까지 정확히 2번 호출돼야 함`);
});

test('fetchTradingDaySeries: 과거→현재 오름차순으로 반환', async () => {
  const fetchOneDay = async (basDd) => [{ basDd }];
  const out = await fetchTradingDaySeries(fetchOneDay, 3, { startDate: new Date(2026, 7, 19), delayMs: 0 });
  const nums = out.map((o) => Number(o.basDd));
  assert.deepEqual(nums, [...nums].sort((a, b) => a - b));
});

test('fetchTradingDaySeries: maxScanDays 예산 소진되면 목표 미달이어도 중단', async () => {
  const fetchOneDay = async () => []; // 전부 휴장 취급
  const out = await fetchTradingDaySeries(fetchOneDay, 5, { startDate: new Date(2026, 7, 19), delayMs: 0, emptyRetryDelayMs: 0, maxScanDays: 3 });
  assert.equal(out.length, 0);
});

test('fetchIndexCloses: 지수명 정확매칭 + 빈 문자열(값없음) 스킵', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      OutBlock_1: [
        { IDX_NM: '코스피 (외국주포함)', CLSPRC_IDX: '' }, // 값없음 — 스킵돼야 함
        { IDX_NM: '코스피', CLSPRC_IDX: '2500.55' },
        { IDX_NM: '코스피 200', CLSPRC_IDX: '350.10' }, // 다른 지수 — 매칭 안 돼야 함
      ],
    }),
  });
  const closes = await fetchIndexCloses('KOSPI', '코스피', 2, { apiKey: 'K', fetchImpl, delayMs: 0, startDate: new Date(2026, 7, 19) });
  assert.deepEqual(closes, [2500.55, 2500.55]); // 두 거래일 모두 같은 mock 응답
});

test('fetchGoldClose: 정상 — "금 99.99_1kg" 종가만 정확매칭(미니금 등 다른 상품 배제)', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      OutBlock_1: [
        { ISU_NM: '미니금 99.99_100g', TDD_CLSPRC: '200000' },
        { ISU_NM: '금 99.99_1kg', TDD_CLSPRC: '199950' },
      ],
    }),
  });
  const r = await fetchGoldClose({ apiKey: 'K', fetchImpl, delayMs: 0, startDate: new Date(2026, 7, 19) });
  assert.equal(r.price, 199950);
});

test('fetchGoldClose: 당일 미발행(빈 배열)이면 과거로 물러나 최근 거래일 값을 찾음', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call++;
    const rows = call < 3 ? [] : [{ ISU_NM: '금 99.99_1kg', TDD_CLSPRC: '150000' }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ OutBlock_1: rows }) };
  };
  const r = await fetchGoldClose({ apiKey: 'K', fetchImpl, delayMs: 0, emptyRetryDelayMs: 0, startDate: new Date(2026, 7, 19) });
  assert.equal(r.price, 150000);
});

test('fetchGoldClose: 최근 거래일 전부 데이터 없으면 throw(다른 소스로 폴백 없음)', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ OutBlock_1: [] }) });
  await assert.rejects(
    () => fetchGoldClose({ apiKey: 'K', fetchImpl, delayMs: 0, emptyRetryDelayMs: 0, startDate: new Date(2026, 7, 19), maxScanDays: 3 }),
    /KRX 금 시세 조회 실패/,
  );
});
