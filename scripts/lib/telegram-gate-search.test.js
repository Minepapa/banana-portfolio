import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callSearch, locationSearch, mediaSearch, searchRange, spendingSearch } from './telegram-gate-search.mjs';
import { gateMcpToolsFor } from './telegram-gate-tool-table.mjs';
import { createGateMcpTools } from './telegram-gate-mcp-tools.mjs';

// 가짜 정본(실제 가게·금액 아님).
const NOW = new Date('2026-11-06T03:00:00Z');

test('기간: 기본값·형식·순서·한도', () => {
  assert.deepEqual(searchRange({}, { now: NOW, defaultDays: 30, maxDays: 62 }), { from: '2026-10-08', to: '2026-11-06', days: 30 });
  assert.throws(() => searchRange({ from: '2026-01-01', to: '2026-11-06' }, { now: NOW, defaultDays: 30, maxDays: 62 }), /62일/);
  assert.throws(() => searchRange({ from: '11/01' }, { now: NOW, defaultDays: 30, maxDays: 62 }), /YYYY-MM-DD/);
  assert.throws(() => searchRange({ from: '2026-11-06', to: '2026-11-01' }, { now: NOW, defaultDays: 30, maxDays: 62 }), /앞/);
});

test('spending_search: 알림 요약 + 뱅크샐러드, 가게 일부 일치, 지출만, 같은 건은 한 줄(출처 합침), 최근 순, 줄 수 제한', () => {
  const summaries = { '2026-11-05': { entries: [{ status: 'expense', merchant: '시험 미용실', amount: 20000, at: '2026-11-05T02:00:00Z' }, { status: 'excluded', merchant: '시험 미용실', amount: 1 }] } };
  const reports = () => [{ transactions: [
    { date: '2026-11-05', time: '11:00', description: '시험 미용실', signed_amount: -20000 },
    { date: '2026-09-01', time: '10:00', description: '시험미용실', original_subcategory: '미용', signed_amount: -15000 },
    { date: '2026-09-02', description: '시험 미용실', signed_amount: 5000 },
    { date: '2026-09-03', description: '다른 가게', signed_amount: -1000 },
  ] }];
  const out = spendingSearch({ query: '미용실' }, { now: NOW, readSummary: (d) => summaries[d] ?? null, banksaladReports: reports });
  const lines = out.split('\n');
  assert.match(lines[0], /소비 검색 2025-11-07~2026-11-06 "미용실": 2건/);
  assert.match(lines[1], /^2026-11-05 11:00 20,000원 시험 미용실 \(알림·뱅크샐러드\)$/);
  assert.match(lines[2], /^2026-09-01 10:00 15,000원 시험미용실 · 미용 \(뱅크샐러드\)$/);
  const many = spendingSearch({ limit: 1 }, { now: NOW, readSummary: (d) => summaries[d] ?? null, banksaladReports: reports });
  assert.match(many, /… 외 2건/);
  assert.match(spendingSearch({ query: '없는곳' }, { now: NOW, readSummary: () => null, banksaladReports: () => [] }), /찾은 지출 없음/);
});

test('location_search: 체류만, 장소 이름 일부, 파일 없는 날 수', () => {
  const days = { '2026-11-06': { entries: [{ kind: 'stay', start: '08:10', end: '09:00', placeName: '시험 회사', minutes: 50 }, { kind: 'move', start: '07:30', end: '08:10' }] } };
  const out = locationSearch({ query: '회사', from: '2026-11-05', to: '2026-11-06' }, { now: NOW, readDay: (d) => days[d] ?? null });
  assert.match(out, /동선 검색 2026-11-05~2026-11-06 "회사": 1건\(동선 파일 없는 날 1일\)\n2026-11-06 08:10~09:00 시험 회사 50분/);
});

test('call_search·media_search: 제목·설명·사람으로 찾고 최근 순', () => {
  const listNotes = () => [
    { date: '2026-11-04', title: '미네 통화 숙제', front: { description: '학원 끝나는 시각', people: ['미네'] } },
    { date: '2026-11-05', title: '통화 회사', front: { description: '회의', people: ['동료'] } },
    { date: '2026-11-05', title: '저녁 통화', front: { description: '저녁', people: ['미네'] } },
  ];
  const out = callSearch({ query: '미네' }, { now: NOW, listNotes });
  assert.deepEqual(out.split('\n').slice(1), ['2026-11-05 저녁 통화 — 저녁', '2026-11-04 미네 통화 숙제 — 학원 끝나는 시각']);
  assert.match(mediaSearch({ query: '없음' }, { now: NOW, listNotes }), /찾은 사진·영상 순간 없음/);
});

test('도구 표: 조회 도구는 헤르메스(소비·동선)·아테나·클리오(통화·사진)·제우스(전부), 플루토스·테미스는 없음', () => {
  const names = createGateMcpTools().map((t) => t.name);
  for (const t of ['spending_search', 'location_search', 'call_search', 'media_search']) {
    assert.ok(names.includes(t));
    assert.ok(gateMcpToolsFor('zeus').includes(t));
    assert.equal(gateMcpToolsFor('plutus').includes(t), false);
    assert.equal(gateMcpToolsFor('themis').includes(t), false);
  }
  assert.ok(gateMcpToolsFor('hermes').includes('spending_search') && gateMcpToolsFor('hermes').includes('location_search'));
  assert.ok(gateMcpToolsFor('athena').includes('call_search') && gateMcpToolsFor('athena').includes('media_search'));
});
