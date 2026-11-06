// 데이터 출처 표 정합성(2026-11-03). 새 원천 경로를 vault-paths에 넣고 분류·감시 표를 빠뜨리면 여기서 실패한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENT_IDS } from './agent-registry.mjs';
import { EXPECTED_INTERVALS_MS, JOB_FIRST_HEARTBEAT_BY } from './job-schedule.mjs';
import { VAULT_REL } from './vault-paths.mjs';
import { DATA_SOURCES, DATA_SOURCE_KINDS, ETNA_PATH_CLASSES, PHONE_PRODUCERS } from './data-sources.mjs';

const ETNA_PREFIX = '95_Etna/';

test('data-sources.mjs는 import가 없다(대시보드·감시가 그대로 읽는 순수 표)', () => {
  const IMPORT_RE = /^\s*import[\s{]|^\s*export\s[^;]*\sfrom\s|\bimport\s*\(/m;
  assert.equal(IMPORT_RE.test(readFileSync(new URL('./data-sources.mjs', import.meta.url), 'utf8')), false);
});

test('(a) VAULT_REL의 95_Etna/ 키는 전부 원천·파생·상태 중 하나로 분류돼 있다', () => {
  const etnaKeys = Object.keys(VAULT_REL).filter((key) => VAULT_REL[key].startsWith(ETNA_PREFIX));
  assert.ok(etnaKeys.length > 30, '95_Etna 키 추출이 깨졌을 가능성');
  const missing = etnaKeys.filter((key) => !(key in ETNA_PATH_CLASSES));
  assert.deepEqual(missing, [], `분류 없는 95_Etna 경로 키: ${missing.join(', ')} — scripts/lib/data-sources.mjs ETNA_PATH_CLASSES에 추가하고, 원천이면 DATA_SOURCES 감시도 검토할 것`);
  for (const [key, cls] of Object.entries(ETNA_PATH_CLASSES)) {
    assert.ok(['source', 'derived', 'state'].includes(cls), `${key}: 분류값 ${cls}`);
    assert.ok(VAULT_REL[key]?.startsWith(ETNA_PREFIX), `${key}: VAULT_REL에 없거나 95_Etna 밖 — 분류표에서 지울 것`);
  }
});

test('(b) producer는 기대 주기 표의 잡 이름이거나 phone:* 이다', () => {
  for (const source of DATA_SOURCES) {
    const ok = Object.hasOwn(EXPECTED_INTERVALS_MS, source.producer) || PHONE_PRODUCERS.includes(source.producer);
    assert.ok(ok, `${source.id}: 알 수 없는 producer ${source.producer}`);
  }
  for (const producer of PHONE_PRODUCERS) assert.match(producer, /^phone:[a-z-]+$/);
});

test('(c) owner는 판테온 6인 중 하나다', () => {
  for (const source of DATA_SOURCES) assert.ok(AGENT_IDS.includes(source.owner), `${source.id}: 6인 밖 담당 ${source.owner}`);
});

test('(d) liveness가 가리키는 출처가 실제로 있고 순환하지 않는다', () => {
  const byId = new Map(DATA_SOURCES.map((source) => [source.id, source]));
  for (const source of DATA_SOURCES) {
    if (source.liveness === null) continue;
    assert.ok(byId.has(source.liveness), `${source.id}: 없는 상위 출처 ${source.liveness}`);
    const seen = new Set([source.id]);
    for (let up = byId.get(source.liveness); up; up = up.liveness ? byId.get(up.liveness) : null) {
      assert.ok(!seen.has(up.id), `${source.id}: liveness 순환`);
      seen.add(up.id);
    }
  }
});

test('출처 표 형식: id 유일, kind·probe·threshold가 서로 맞고 경로 키는 VAULT_REL에 있다', () => {
  const ids = DATA_SOURCES.map((source) => source.id);
  assert.equal(new Set(ids).size, ids.length, 'id 중복');
  for (const source of DATA_SOURCES) {
    assert.match(source.id, /^[a-z0-9-]+$/, source.id);
    assert.ok(DATA_SOURCE_KINDS.includes(source.kind), `${source.id}: kind ${source.kind}`);
    assert.equal(typeof source.urgent, 'boolean', source.id);
    assert.ok(source.label && typeof source.label === 'string', source.id);
    if (source.probe.type !== 'not-collected') {
      assert.ok(VAULT_REL[source.probe.pathKey], `${source.id}: VAULT_REL에 없는 경로 키 ${source.probe.pathKey}`);
    }
    if (source.kind === 'continuous') assert.ok(source.threshold.maxAgeMs > 0, source.id);
    if (source.kind === 'market-day') assert.ok(source.threshold.graceHoursKst > 0, source.id);
    if (source.kind === 'daily-rhythm') {
      assert.ok(source.threshold.zeroDays > 0 || (source.threshold.dueHourNextDayKst >= 0 && source.threshold.lookbackDays > 0), source.id);
    }
    if (['bursty', 'display-only'].includes(source.kind)) {
      assert.equal(source.threshold, null, `${source.id}: 표시만 하는 출처에 임계값`);
      assert.equal(source.urgent, false, `${source.id}: 표시만 하는 출처가 긴급`);
    }
  }
});

test('오너 결정 반영: 상태 신호·데일리 노트만 긴급, 통화는 상태 신호에 묶이고 녹음은 미수집 표시', () => {
  const byId = new Map(DATA_SOURCES.map((source) => [source.id, source]));
  assert.deepEqual(DATA_SOURCES.filter((source) => source.urgent).map((source) => source.id).sort(), ['argos-heartbeat', 'daily-note']);
  assert.equal(byId.get('argos-heartbeat').threshold.maxAgeMs, EXPECTED_INTERVALS_MS['argos-ingest'] * 2);
  assert.equal(byId.get('argos-calls').liveness, 'argos-heartbeat');
  assert.equal(byId.get('argos-calls').threshold.zeroDays, 2);
  assert.equal(byId.get('spending').threshold.zeroDays, 3);
  assert.equal(byId.get('argos-recordings').probe.type, 'not-collected');
  assert.equal(byId.get('argos-camera').kind, 'bursty');
  assert.equal(byId.get('executions').kind, 'display-only');
  // 알림 접근 감시(2026-11-06): 상태 신호에 묶이고, 권한 칸을 먼저 보며, 18시간(밤 최대 공백 16시간 + 여유).
  const notif = byId.get('argos-notifications');
  assert.equal(notif.liveness, 'argos-heartbeat');
  assert.equal(notif.producer, 'phone:argos');
  assert.deepEqual(notif.probe.accessField, { eventType: 'core.heartbeat', field: 'notifListener' });
  assert.equal(notif.threshold.maxAgeMs, 18 * 3600_000);
});

test('JOB_FIRST_HEARTBEAT_BY: 기대 주기 표에 있는 잡만, 날짜는 YYYY-MM-DD', () => {
  for (const [job, date] of Object.entries(JOB_FIRST_HEARTBEAT_BY)) {
    assert.ok(Object.hasOwn(EXPECTED_INTERVALS_MS, job), `${job}: 기대 주기 표에 없는 잡`);
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, job);
  }
});
