import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, assemblePreferences, renderPreferenceFacts } from './preference-facts.mjs';

// preference-facts.mjs — 비서실 Apollo 대화형 보고용 Node 결정론 사실 조립기.
// 2026-08-20 Vault 네이티브 전환 — 입력이 구글시트 row-array에서
// Knowledge/Profile/*.md frontmatter 객체로 바뀌었다.

test('parseArgs — 기본은 전체, --status/--json', () => {
  assert.deepEqual(parseArgs([]), { status: null, json: false });
  assert.deepEqual(parseArgs(['--status', '확정']), { status: '확정', json: false });
  assert.deepEqual(parseArgs(['--status', 'pending', '--json']), { status: 'pending', json: true });
});

test('parseArgs — 잘못된 status 거부', () => {
  assert.throws(() => parseArgs(['--status', 'x']), /status/i);
});

const prefFixture = () => [
  { date: '2026-07-10', signalType: '매수패턴', observation: '분할매수 선호', evidence: '체결이력 3건', vsProfile: '일치(보강)', confidence: '높음', status: '확정' },
  { date: '2026-07-15', signalType: '보유심리', observation: '급락 시 관망', evidence: '평가요청 지연', vsProfile: '신규', confidence: '보통', status: '관찰' },
  { date: '2026-07-16', signalType: '리스크', observation: '손절 주저', evidence: '체결이력', vsProfile: '상충', confidence: '보통', status: '승격후보' },
  { date: '2026-07-05', signalType: '매도패턴', observation: '추격매도 성향', evidence: '', vsProfile: '', confidence: '낮음', status: '기각' },
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
  assert.equal(rows[0].observation, '분할매수 선호');
});

test('assemblePreferences — status="기각"도 조회 가능(번복 이력 추적용, renderPrefRows와 달리 배제 안 함)', () => {
  const { rows } = assemblePreferences(prefFixture(), { status: '기각' });
  assert.equal(rows.length, 1);
  assert.match(rows[0].observation, /추격매도/);
});

test('assemblePreferences — 상태 미기입 레코드는 preferences.mjs renderPrefRows 관례대로 관찰로 집계(버킷 합이 total과 어긋나지 않게)', () => {
  const records = [...prefFixture(), { date: '2026-07-18', signalType: '테스트', observation: '상태없음', evidence: '', vsProfile: '', confidence: '보통', status: '' }];
  const { counts } = assemblePreferences(records, {});
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
