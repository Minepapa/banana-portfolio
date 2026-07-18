import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, assemblePreferences, renderPreferenceFacts } from './preference-facts.mjs';

// preference-facts.mjs — 비서실 Apollo 대화형 보고용 Node 결정론 사실 조립기.
// Apollo의 KPI(profile/kpi_baseline.md)·주간리포트(reports/*.md)는 이미 로컬 파일이라
// Read 도구가 리터럴 원문을 그대로 보여준다 — 그 자체로 무결성 하드 보장(fetch 아님, 지어낼 수 없음).
// 성향관찰만 실시간 구글시트 조회가 필요해 이 CLI가 담당한다.

test('parseArgs — 기본은 전체, --status/--json', () => {
  assert.deepEqual(parseArgs([]), { status: null, json: false });
  assert.deepEqual(parseArgs(['--status', '확정']), { status: '확정', json: false });
  assert.deepEqual(parseArgs(['--status', 'pending', '--json']), { status: 'pending', json: true });
});

test('parseArgs — 잘못된 status 거부', () => {
  assert.throws(() => parseArgs(['--status', 'x']), /status/i);
});

// 성향관찰!A2:H = 날짜0 신호유형1 관찰2 증거3 §3대비4 신뢰도5 상태6 갱신시각7
const prefFixture = () => [
  ['2026-07-10', '매수패턴', '분할매수 선호', '체결이력 3건', '일치(보강)', '높음', '확정', ''],
  ['2026-07-15', '보유심리', '급락 시 관망', '평가요청 지연', '신규', '보통', '관찰', ''],
  ['2026-07-16', '리스크', '손절 주저', '체결이력', '상충', '보통', '승격후보', ''],
  ['2026-07-05', '매도패턴', '추격매도 성향', '', '', '낮음', '기각', ''],
];

test('assemblePreferences — 상태별 카운트 집계', () => {
  const { counts } = assemblePreferences(prefFixture(), {});
  assert.equal(counts.확정, 1);
  assert.equal(counts.관찰, 1);
  assert.equal(counts.승격후보, 1);
  assert.equal(counts.기각, 1);
  assert.equal(counts.total, 4);
});

test('assemblePreferences — status="pending"은 관찰+승격후보 별칭', () => {
  const { rows, text } = assemblePreferences(prefFixture(), { status: 'pending' });
  assert.equal(rows.length, 2);
  assert.match(text, /급락 시 관망/);
  assert.match(text, /손절 주저/);
  assert.doesNotMatch(text, /분할매수 선호/);
});

test('assemblePreferences — status="확정"은 정확 필터', () => {
  const { rows } = assemblePreferences(prefFixture(), { status: '확정' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][2], '분할매수 선호');
});

test('assemblePreferences — status="기각"도 조회 가능(번복 이력 추적용, renderPrefRows와 달리 배제 안 함)', () => {
  const { rows } = assemblePreferences(prefFixture(), { status: '기각' });
  assert.equal(rows.length, 1);
  assert.match(rows[0][2], /추격매도/);
});

test('assemblePreferences — 상태 미기입 행은 preferences.mjs renderPrefRows 관례대로 관찰로 집계(리뷰 지적: 버킷 합이 total과 어긋나지 않게)', () => {
  const rows = [...prefFixture(), ['2026-07-18', '테스트', '상태없음', '', '', '보통', '', '']];
  const { counts } = assemblePreferences(rows, {});
  assert.equal(counts.관찰, 2);   // 기존 1 + 상태없음 1
  assert.equal(counts.total, 5);
});

test('assemblePreferences — 빈 응답 정직하게', () => {
  const { text, counts } = assemblePreferences([], {});
  assert.match(text, /데이터 부족|없음/);
  assert.equal(counts.total, 0);
});

test('renderPreferenceFacts — 재조회 금지 가드 + --json 구조 보존', () => {
  const facts = assemblePreferences(prefFixture(), {});
  const human = renderPreferenceFacts(facts, { json: false });
  assert.match(human, /재조회|Node/);
  assert.match(human, /확정 1/);
  const json = JSON.parse(renderPreferenceFacts(facts, { json: true }));
  assert.equal(json.counts.total, 4);
});
