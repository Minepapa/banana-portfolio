import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchVipFundPrice } from './vip-fund.mjs';

test('fetchVipFundPrice: 정상 — 날짜 오름차순 배열의 마지막 요소를 최신 기준가로 반올림', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [
      { date: '20260818', standardPrice: '1989.230000' },
      { date: '20260819', standardPrice: '2006.330000' },
      { date: '20260820', standardPrice: '1950.140000' },
    ],
  });
  const r = await fetchVipFundPrice({ fetchImpl });
  assert.deepEqual(r, { price: 1950, date: '20260820' });
});

test('fetchVipFundPrice: HTTP 오류면 throw(다른 소스로 폴백 없음)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => fetchVipFundPrice({ fetchImpl }), /HTTP 500/);
});

test('fetchVipFundPrice: 응답이 빈 배열이면 throw', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [] });
  await assert.rejects(() => fetchVipFundPrice({ fetchImpl }), /비어있음/);
});

test('fetchVipFundPrice: standardPrice가 이상값(비정상적으로 작음)이면 throw(추정 안 함)', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [{ date: '20260820', standardPrice: '0' }] });
  await assert.rejects(() => fetchVipFundPrice({ fetchImpl }), /이상/);
});
