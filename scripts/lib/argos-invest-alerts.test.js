// 아르고스 투자 알림 어댑터·출처 간 중복 판정·shadow 보고서. 값은 모두 가짜다(공개 저장소).
// ⚠️ ledger-vault-writer·vault-frontmatter가 vault-paths를 읽으므로 VAULT_PATH를 임시 폴더로 먼저 잡고 동적 import한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VAULT = mkdtempSync(join(tmpdir(), 'argos-invest-vault-'));
process.env.VAULT_PATH = VAULT;
const {
  ARGOS_DOC_PREFIX, argosInboxDocs, buildShadowReport, crossSourceContextFromState, findCrossSourceTwin,
  isInvestmentAlertSender, loadArgosState, parseArgosMode, readRecentArgosEvents, saveArgosState, shadowLogLine,
} = await import('./argos-invest-alerts.mjs');
const { INVESTMENT_ALERT_BROKERS, parseExecution, parseDividend } = await import('./notification-parsers.mjs');
const { buildDividendRecord, buildExecutionRecord, buildKakaoExecutionRecord } = await import('./ledger-vault-writer.mjs');

const at = (kst) => Date.parse(`${kst.replace(' ', 'T')}+09:00`);
const EXEC = '[삼성증권]<주식체결안내>\n체결 안내\n테스트ETF\n매수10주 10,000원';
const EXEC_OTHER_PRICE = '[삼성증권]<주식체결안내>\n체결 안내\n테스트ETF\n매수10주 10,005원';
const DIVIDEND = '[NH투자증권] 배당금 입금 안내\n종목명 : 테스트리츠\n세후금액 : 1,234원\n입금일 : 2026.08.04';
const AD = '[NH투자증권] 이번 주 투자 정보 안내';

function freshDirs() {
  const root = mkdtempSync(join(VAULT, 'ledger-'));
  const dirs = { executions: join(root, 'Executions'), 배당: join(root, 'Dividends'), 예수금: join(root, 'Cash'),
    펀드적립: join(root, 'Fund'), 펀드평가: join(root, 'FundVal'), 환전: join(root, 'Fx') };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return dirs;
}
const ctxFor = (dirs, extra = {}) => ({ dirs, confirmations: [], argosWritten: new Set(), used: new Set(), ...extra });
// 카카오 알림 앱(Firestore) 경로가 쓴 체결 장부 한 건.
function writeFirestoreExecution(dirs, body, ts, docId) {
  const record = buildKakaoExecutionRecord(parseExecution(body, ts), '연금저축', docId);
  writeFileSync(join(dirs.executions, record.filename), record.content);
  return join(dirs.executions, record.filename);
}
const argosDoc = (id, ts, body) => ({ id: `${ARGOS_DOC_PREFIX}${id}`, ts, body, sender: '삼성증권' });

test('parseArgosMode: 기본 shadow, primary 전환, 모르는 값·중복은 거부', () => {
  assert.equal(parseArgosMode([]), 'shadow');
  assert.equal(parseArgosMode(['--dry-run']), 'shadow');
  assert.equal(parseArgosMode(['--argos-mode=primary']), 'primary');
  assert.equal(parseArgosMode(['--argos-mode=shadow']), 'shadow');
  assert.throws(() => parseArgosMode(['--argos-mode=Primary']));
  assert.throws(() => parseArgosMode(['--argos-mode']));
  assert.throws(() => parseArgosMode(['--argos-mode=shadow', '--argos-mode=primary']));
});

test('발신 증권사는 체결 파서가 아는 증권사에서 뽑고, 채널 이름(증권사 + 공백 + …)도 받는다', () => {
  assert.deepEqual([...INVESTMENT_ALERT_BROKERS].sort(), ['NH투자증권', '삼성증권', '한국투자증권']);
  assert.equal(isInvestmentAlertSender('한국투자증권 퇴직연금'), true);
  assert.equal(isInvestmentAlertSender(' 삼성증권 '), true);
  assert.equal(isInvestmentAlertSender('NH투자증권사칭'), false);
  assert.equal(isInvestmentAlertSender('친구'), false);
});

test('argosInboxDocs: 카톡·증권사 발신 알림만 {id, ts(KST), body}로 바꾸고 시각순으로 둔다', () => {
  const ev = (id, payload, type = 'notification.received') => ({ id, type, occurred_at: payload.postedAt ?? 0, payload });
  const docs = argosInboxDocs([
    ev('b', { packageName: 'com.kakao.talk', sender: '삼성증권', body: EXEC, postedAt: at('2026-08-04 10:00:05') }),
    ev('a', { packageName: 'com.kakao.talk', sender: '한국투자증권 퇴직연금', body: AD, postedAt: at('2026-08-04 09:00:00') }),
    ev('app', { packageName: 'com.example.broker', sender: '삼성증권', body: EXEC, postedAt: at('2026-08-04 10:00:06') }),
    ev('friend', { packageName: 'com.kakao.talk', sender: '친구', body: EXEC, postedAt: at('2026-08-04 10:00:07') }),
    ev('empty', { packageName: 'com.kakao.talk', sender: '삼성증권', body: '  ', postedAt: at('2026-08-04 10:00:08') }),
    ev('hb', { packageName: 'com.kakao.talk', sender: '삼성증권', body: EXEC, postedAt: at('2026-08-04 10:00:09') }, 'core.heartbeat'),
  ]);
  assert.deepEqual(docs.map((d) => [d.eventId, d.ts, d.sender]), [
    ['a', '2026-08-04 09:00:00', '한국투자증권 퇴직연금'], ['b', '2026-08-04 10:00:05', '삼성증권']]);
  assert.ok(docs.every((d) => d.id.startsWith(ARGOS_DOC_PREFIX)));
  assert.equal(docs[1].body, EXEC);
});

test('argosInboxDocs: 앱 재시작으로 같은 알림이 새 이벤트 id로 다시 와도 문서 id가 같아 한 번만 남는다', () => {
  const payload = { packageName: 'com.kakao.talk', sender: '삼성증권', body: EXEC, postedAt: at('2026-08-04 10:00:05') };
  const first = argosInboxDocs([{ id: 'uuid-1', type: 'notification.received', payload }]);
  const again = argosInboxDocs([{ id: 'uuid-1', type: 'notification.received', payload },
    { id: 'uuid-2', type: 'notification.received', payload }]);
  assert.equal(again.length, 1);
  assert.equal(again[0].id, first[0].id, '다음 실행에서도 같은 id → 처리 기록·sourceEventId로 걸러짐');
  // 분할 체결처럼 본문이 같아도 알림 시각이 다르면 다른 문서다.
  const split = argosInboxDocs([{ id: 'uuid-3', type: 'notification.received', payload: { ...payload, postedAt: payload.postedAt + 2000 } }]);
  assert.notEqual(split[0].id, first[0].id);
});

test('readRecentArgosEvents: 최근 2일치 날짜 파일만, 깨진 줄은 건너뛴다', () => {
  const dir = mkdtempSync(join(VAULT, 'events-'));
  mkdirSync(join(dir, '2026'));
  const line = (id, kst) => JSON.stringify({ id, type: 'notification.received', occurred_at: at(kst), payload: { postedAt: at(kst) } });
  writeFileSync(join(dir, '2026', '2026-08-01.jsonl'), `${line('old', '2026-08-01 12:00:00')}\n`);
  writeFileSync(join(dir, '2026', '2026-08-02.jsonl'), `${line('edge-out', '2026-08-02 11:59:00')}\n${line('edge-in', '2026-08-02 12:01:00')}\n`);
  const late = JSON.stringify({ id: 'late', type: 'notification.received', occurred_at: at('2026-07-30 09:00:00'),
    received_at: '2026-08-04T00:00:00.000Z', payload: { postedAt: at('2026-07-30 09:00:00') } });
  writeFileSync(join(dir, '2026', '2026-08-04.jsonl'), `{깨진 줄\n${line('today', '2026-08-04 09:00:00')}\n${late}\n`);
  const ids = readRecentArgosEvents(dir, at('2026-08-04 12:00:00')).map((e) => e.id);
  assert.deepEqual(ids, ['edge-in', 'today', 'late'], '폰이 늦게 올린 알림도 수신 시각이 기간 안이면 넣는다');
});

test('중복 방지(체결): 카카오 알림 앱이 쓴 같은 체결은 짝, 몇 초 차이도 같은 체결로 본다', () => {
  const dirs = freshDirs();
  const path = writeFirestoreExecution(dirs, EXEC, '2026-08-04 10:00:00', 'fs-1');
  const ctx = ctxFor(dirs);
  assert.equal(findCrossSourceTwin(argosDoc('x1', '2026-08-04 10:00:05', EXEC), ctx).twin, path);
});

test('중복 방지(체결): 짝은 1:1 — 같은 종목·수량·단가 분할 체결이 하나 더 오면 별개 체결로 쓴다', () => {
  const dirs = freshDirs();
  writeFirestoreExecution(dirs, EXEC, '2026-08-04 10:00:00', 'fs-1');
  const ctx = ctxFor(dirs);
  assert.ok(findCrossSourceTwin(argosDoc('x1', '2026-08-04 10:00:02', EXEC), ctx).twin);
  assert.equal(findCrossSourceTwin(argosDoc('x2', '2026-08-04 10:00:04', EXEC), ctx).twin, null);
});

test('중복 방지(체결): 단가가 다르거나 시각이 3분 넘게 다르면 짝이 아니다', () => {
  const dirs = freshDirs();
  writeFirestoreExecution(dirs, EXEC, '2026-08-04 10:00:00', 'fs-1');
  assert.equal(findCrossSourceTwin(argosDoc('p', '2026-08-04 10:00:01', EXEC_OTHER_PRICE), ctxFor(dirs)).twin, null);
  assert.equal(findCrossSourceTwin(argosDoc('t', '2026-08-04 10:03:01', EXEC), ctxFor(dirs)).twin, null);
});

test('중복 방지(체결): 수동(manual-) 문서도 카카오 알림 앱 쪽 출처로 짝이 된다', () => {
  const dirs = freshDirs();
  const path = writeFirestoreExecution(dirs, EXEC, '2026-08-04 10:00:00', 'manual-1');
  assert.equal(findCrossSourceTwin(argosDoc('m', '2026-08-04 10:00:03', EXEC), ctxFor(dirs)).twin, path);
});

test('중복 방지(체결): 같은 출처끼리·API 정본 체결은 짝 후보가 아니다', () => {
  const dirs = freshDirs();
  writeFirestoreExecution(dirs, EXEC, '2026-08-04 10:00:00', `${ARGOS_DOC_PREFIX}earlier`);
  const api = buildExecutionRecord({ ...parseExecution(EXEC, '2026-08-04 10:00:01'), account: '연금저축', source: 'NH_API', orderNo: '1' });
  writeFileSync(join(dirs.executions, api.filename), api.content);
  assert.equal(findCrossSourceTwin(argosDoc('x', '2026-08-04 10:00:02', EXEC), ctxFor(dirs)).twin, null);
});

test('중복 방지(되돌림): Firestore 문서도 아르고스가 쓴 체결과 짝이면 쓰지 않는다 — 아르고스 기록이 없으면 기존 동작', () => {
  const dirs = freshDirs();
  const fsDoc = { id: 'fs-9', ts: '2026-08-04 10:00:04', body: EXEC };
  assert.equal(findCrossSourceTwin(fsDoc, ctxFor(dirs)).twin, null);
  writeFirestoreExecution(dirs, EXEC, '2026-08-04 10:00:00', 'fs-1');
  assert.equal(findCrossSourceTwin(fsDoc, ctxFor(dirs)).twin, null, '카카오끼리는 짝 판정 대상이 아님(기존 dedup 몫)');
  const argosPath = writeFirestoreExecution(dirs, EXEC, '2026-08-04 10:00:01', `${ARGOS_DOC_PREFIX}a1`);
  assert.equal(findCrossSourceTwin(fsDoc, ctxFor(dirs)).twin, argosPath);
});

test('중복 방지(체결): 다른 출처의 계좌 확인 대기 건도 짝이다. 장부까지 쓴 확인 건은 장부 파일이 짝', () => {
  const dirs = freshDirs();
  const event = parseExecution(EXEC, '2026-08-04 10:00:00');
  const pending = { id: 'EC-1', firestoreDocId: 'fs-1', receivedAt: '2026-08-04 10:00:00', ...event, ledgerFile: null };
  const done = { ...pending, id: 'EC-2', ledgerFile: 'x.md' };
  assert.equal(findCrossSourceTwin(argosDoc('c', '2026-08-04 10:00:03', EXEC), ctxFor(dirs, { confirmations: [done, pending] })).twin,
    'confirmation:EC-1');
  assert.equal(findCrossSourceTwin(argosDoc('c', '2026-08-04 10:00:03', EXEC), ctxFor(dirs, { confirmations: [done] })).twin, null);
});

test('중복 방지(배당): 수신 초가 다른 같은 배당은 짝, 아르고스가 쓴 파일은 아르고스 문서의 짝이 아니다', () => {
  const dirs = freshDirs();
  const fsRecord = buildDividendRecord(parseDividend(DIVIDEND, '2026-08-04 09:00:00'));
  writeFileSync(join(dirs.배당, fsRecord.filename), fsRecord.content);
  const twinPath = join(dirs.배당, fsRecord.filename);
  const doc = { id: 'argos-d', ts: '2026-08-04 09:00:04', body: DIVIDEND };
  assert.equal(findCrossSourceTwin(doc, ctxFor(dirs)).twin, twinPath);
  assert.equal(findCrossSourceTwin(doc, ctxFor(dirs, { argosWritten: new Set([twinPath]) })).twin, null);
  assert.equal(findCrossSourceTwin({ ...doc, ts: '2026-08-04 09:05:00' }, ctxFor(dirs)).twin, null);
  // 되돌림: Firestore 문서는 아르고스가 쓴 파일과만 짝
  const fsDoc = { id: 'fs-d', ts: '2026-08-04 09:00:06', body: DIVIDEND };
  assert.equal(findCrossSourceTwin(fsDoc, ctxFor(dirs)).twin, null);
  assert.equal(findCrossSourceTwin(fsDoc, ctxFor(dirs, { argosWritten: new Set([twinPath]) })).twin, twinPath);
});

test('상태 파일: 짝·쓴 파일이 다음 실행 판정에 이어지고, 오래된 기록은 지운다. 깨진 파일은 던진다', () => {
  const dirs = freshDirs();
  const path = writeFirestoreExecution(dirs, EXEC, '2026-08-04 10:00:00', 'fs-1');
  const file = join(mkdtempSync(join(VAULT, 'state-')), 'state.json');
  assert.deepEqual(loadArgosState(file).processed, {});
  const nowMs = at('2026-08-04 12:00:00');
  saveArgosState(file, { processed: {
    'argos-x1': { at: new Date(nowMs).toISOString(), twin: path },
    'argos-w': { at: new Date(nowMs).toISOString(), written: '/w.md' },
    'argos-old': { at: new Date(nowMs - 15 * 86400_000).toISOString() },
    'argos-old-written': { at: new Date(nowMs - 15 * 86400_000).toISOString(), written: '/old.md' },
  } }, nowMs);
  const state = loadArgosState(file);
  assert.deepEqual(Object.keys(state.processed).sort(), ['argos-old-written', 'argos-w', 'argos-x1'], '쓴 기록은 오래돼도 남김');
  const ctx = { ...crossSourceContextFromState(state), dirs, confirmations: [] };
  assert.ok(ctx.argosWritten.has('/w.md'));
  // 지난 실행에서 짝지은 기록은 다른 아르고스 알림의 짝이 되지 않는다(분할 체결 2번째가 사라지지 않게).
  assert.equal(findCrossSourceTwin(argosDoc('x2', '2026-08-04 10:00:04', EXEC), ctx).twin, null);
  writeFileSync(file, '{깨짐');
  assert.throws(() => loadArgosState(file));
});

test('shadow 보고서: 일치·아르고스만·걸러냄을 세고, 원문은 남기지 않는다', () => {
  const dirs = freshDirs();
  const fsRecord = buildDividendRecord(parseDividend(DIVIDEND, '2026-08-04 09:00:00'));
  writeFileSync(join(dirs.배당, fsRecord.filename), fsRecord.content);
  writeFirestoreExecution(dirs, EXEC, '2026-08-04 10:00:00', 'fs-1');
  const docs = [
    { id: 'argos-d', ts: '2026-08-04 09:00:03', body: DIVIDEND, sender: 'NH투자증권' },
    { id: 'argos-ad', ts: '2026-08-04 09:30:00', body: AD, sender: 'NH투자증권' },
    argosDoc('e1', '2026-08-04 10:00:02', EXEC),
    argosDoc('e2', '2026-08-04 10:00:04', EXEC),
  ];
  const report = buildShadowReport(docs, ctxFor(dirs, { holdings: [], cashApiExcluded: new Set() }), at('2026-08-04 12:00:00'));
  assert.deepEqual(report.counts, { matched: 2, filtered: 1, 'argos-only': 1 });
  assert.deepEqual(report.items.map((i) => [i.id, i.type, i.verdict]), [
    ['argos-d', '배당', 'matched'], ['argos-e1', '체결', 'matched'], ['argos-e2', '체결', 'argos-only']]);
  assert.equal(report.items[0].twin, fsRecord.filename);
  assert.ok(!JSON.stringify(report).includes('세후금액'), '원문 미포함');
  assert.match(shadowLogLine(report), /일치 2 · 아르고스만 1 · API 정본 0 · 걸러냄 1/);
  assert.ok(!existsSync(join(dirs.배당, 'argos')), '보고서는 장부에 쓰지 않음');
  assert.equal(readFileSync(join(dirs.배당, fsRecord.filename), 'utf8'), fsRecord.content);
});
