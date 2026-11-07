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
  ARGOS_DOC_PREFIX, argosInboxDocs, buildShadowReport, countAgingArgosDocs, createArgosLedgerWriter,
  crossSourceContextFromState, findCrossSourceTwin, isInvestmentAlertSender, loadArgosState, parseArgosMode,
  readRecentArgosEvents, saveArgosState, settleArgosProcessed, shadowLogLine,
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

// ── 크래시 안전(2026-11-07, primary 전환 전 재리뷰 MEDIUM) ──
// 불변식: 아르고스 문서로 장부에 쓴 파일은 상태 파일에서 반드시 아르고스 것으로 보인다(written 또는 쓰기 전 의도 pending).
// 그래야 장부를 쓴 뒤 상태 저장 전에 잡이 죽고 shadow로 되돌려도 Firestore 쪽 같은 기록이 짝을 찾아 두 번 쓰지 않는다.
function primaryRun(file) {
  const state = loadArgosState(file);
  const records = {};
  const ctx = crossSourceContextFromState(state);
  return { state, records, ctx };
}

test('크래시(배당): 장부를 쓴 뒤 상태 저장 전에 죽어도, shadow로 되돌린 Firestore 문서는 그 파일을 짝으로 찾는다', () => {
  const dirs = freshDirs();
  const file = join(mkdtempSync(join(VAULT, 'state-')), 'state.json');
  const nowMs = at('2026-08-04 12:00:00');
  const { state, records, ctx } = primaryRun(file);
  const doc = { id: 'argos-d', ts: '2026-08-04 09:00:04', body: DIVIDEND };
  const record = buildDividendRecord(parseDividend(doc.body, doc.ts));
  const argosPath = join(dirs.배당, record.filename);
  const crashAfterWrite = (path, content) => { writeFileSync(path, content); throw new Error('잡 강제 종료'); };
  const writeLedger = createArgosLedgerWriter({ stateFile: file, state, records, argosWritten: ctx.argosWritten, nowMs, write: crashAfterWrite });
  assert.throws(() => writeLedger(doc.id, argosPath, record.content), /강제 종료/);
  assert.ok(existsSync(argosPath), '장부 파일은 써짐');
  // 마지막 상태 저장(settle)은 일어나지 않았다. 다음 실행: shadow로 되돌림, 카카오 알림 앱이 받은 같은 배당.
  const after = loadArgosState(file);
  const fsDoc = { id: 'fs-d', ts: '2026-08-04 09:00:07', body: DIVIDEND };
  const shadowCtx = { ...crossSourceContextFromState(after), dirs, confirmations: [] };
  assert.equal(findCrossSourceTwin(fsDoc, shadowCtx).twin, argosPath, 'Firestore 쪽은 쓰지 않음(중복 없음)');
});

test('크래시 뒤 primary 재실행: 같은 문서가 다시 읽히고 기존 파일로 건너뛰어도 written이 남는다. 쓰기 전에 죽었으면 written 없음', () => {
  const dirs = freshDirs();
  const file = join(mkdtempSync(join(VAULT, 'state-')), 'state.json');
  const nowMs = at('2026-08-04 12:00:00');
  const record = buildDividendRecord(parseDividend(DIVIDEND, '2026-08-04 09:00:04'));
  const argosPath = join(dirs.배당, record.filename);
  const first = primaryRun(file);
  const crash = (path, content) => { writeFileSync(path, content); throw new Error('죽음'); };
  assert.throws(() => createArgosLedgerWriter({ stateFile: file, ...first, argosWritten: first.ctx.argosWritten, nowMs, write: crash })('argos-d', argosPath, record.content));
  // 쓰기 직전에 죽은 다른 문서(파일 없음)
  const crashBefore = () => { throw new Error('쓰기 전 죽음'); };
  const missingPath = join(dirs.예수금, '2026-08-04-090100-없음.md');
  const s2 = loadArgosState(file);
  assert.throws(() => createArgosLedgerWriter({ stateFile: file, state: s2, records: {}, argosWritten: new Set(), nowMs, write: crashBefore })('argos-c', missingPath, 'x'));
  // 재실행: 두 문서 모두 미처리라 다시 읽힌다(primary 필터는 processed만 본다).
  const again = loadArgosState(file);
  assert.equal(again.processed['argos-d'], undefined);
  assert.equal(again.processed['argos-c'], undefined);
  // argos-d는 파일이 이미 있어 건너뜀(기록 없이 처리), argos-c는 이번엔 안 쓰고 처리됐다고 치자.
  settleArgosProcessed(again, ['argos-d', 'argos-c'], {}, nowMs);
  saveArgosState(file, again, nowMs);
  const final = loadArgosState(file);
  assert.equal(final.processed['argos-d'].written, argosPath, '의도 기록이 written으로 이어짐');
  assert.equal(final.processed['argos-c'].written, undefined, '파일이 없으면 written 아님');
  assert.deepEqual(final.pending ?? {}, {}, '정리된 의도는 지움');
  assert.ok(crossSourceContextFromState(final).argosWritten.has(argosPath));
});

test('정상 실행: 쓰기 성공 뒤 settle하면 written·twin이 남고 의도는 지워진다. 카카오 문서는 의도를 남기지 않는다', () => {
  const dirs = freshDirs();
  const file = join(mkdtempSync(join(VAULT, 'state-')), 'state.json');
  const nowMs = at('2026-08-04 12:00:00');
  const { state, records, ctx } = primaryRun(file);
  const writeLedger = createArgosLedgerWriter({ stateFile: file, state, records, argosWritten: ctx.argosWritten, nowMs, write: writeFileSync });
  const record = buildDividendRecord(parseDividend(DIVIDEND, '2026-08-04 09:00:04'));
  const p = join(dirs.배당, record.filename);
  writeLedger('argos-d', p, record.content);
  assert.ok(ctx.argosWritten.has(p));
  assert.equal(loadArgosState(file).pending['argos-d'].path, p, '쓰기 전에 의도가 디스크에 있음');
  writeLedger('fs-x', join(dirs.배당, '2026-08-04-090500-다른.md'), 'x');
  assert.equal(loadArgosState(file).pending['fs-x'], undefined);
  records['argos-t'] = { twin: '/twin.md' };
  settleArgosProcessed(state, ['argos-d', 'argos-t'], records, nowMs);
  saveArgosState(file, state, nowMs);
  const final = loadArgosState(file);
  assert.equal(final.processed['argos-d'].written, p);
  assert.equal(final.processed['argos-t'].twin, '/twin.md');
  assert.deepEqual(final.pending, {});
});

test('primary→shadow→primary 왕복: 어느 쪽도 같은 배당을 두 번 쓰지 않는다', () => {
  const dirs = freshDirs();
  const file = join(mkdtempSync(join(VAULT, 'state-')), 'state.json');
  const nowMs = at('2026-08-04 12:00:00');
  // primary: 아르고스가 배당을 쓰고 상태 저장 전에 죽음
  const r = primaryRun(file);
  const rec = buildDividendRecord(parseDividend(DIVIDEND, '2026-08-04 09:00:04'));
  const argosPath = join(dirs.배당, rec.filename);
  assert.throws(() => createArgosLedgerWriter({ stateFile: file, ...r, argosWritten: r.ctx.argosWritten, nowMs,
    write: (p, c) => { writeFileSync(p, c); throw new Error('죽음'); } })('argos-d', argosPath, rec.content));
  // shadow: Firestore 문서는 짝 → 쓰지 않음
  const shadowCtx = { ...crossSourceContextFromState(loadArgosState(file)), dirs, confirmations: [] };
  assert.equal(findCrossSourceTwin({ id: 'fs-d', ts: '2026-08-04 09:00:01', body: DIVIDEND }, shadowCtx).twin, argosPath);
  // 다시 primary: 같은 아르고스 문서는 자기 파일(같은 이름)이라 짝이 아니고 기존 존재 검사로 건너뛴다
  const back = loadArgosState(file);
  const primaryCtx = { ...crossSourceContextFromState(back), dirs, confirmations: [] };
  assert.equal(findCrossSourceTwin({ id: 'argos-d', ts: '2026-08-04 09:00:04', body: DIVIDEND }, primaryCtx).twin, null);
  assert.ok(existsSync(argosPath));
});

test('보류 경고: 확인 대기 건은 빼고, 폰이 늦게 올린 알림은 맥 수신 시각부터 센다', () => {
  const nowMs = at('2026-08-04 12:00:00');
  const old = at('2026-08-03 09:00:00');
  const docs = [
    { id: 'argos-a', ts: '2026-08-03 09:00:00', at: old, body: EXEC },
    { id: 'argos-conf', ts: '2026-08-03 09:00:00', at: old, body: EXEC },
    { id: 'argos-late', ts: '2026-08-03 09:00:00', at: old, receivedAt: at('2026-08-04 11:50:00'), body: EXEC },
    { id: 'argos-done', ts: '2026-08-03 09:00:00', at: old, body: EXEC },
    { id: 'argos-ad', ts: '2026-08-03 09:00:00', at: old, body: AD },
    { id: 'argos-new', ts: '2026-08-04 11:00:00', at: at('2026-08-04 11:00:00'), body: EXEC },
  ];
  const n = countAgingArgosDocs({ docs, done: new Set(['argos-done']), nowMs, hasConfirmation: (id) => id === 'argos-conf' });
  assert.equal(n, 1, 'argos-a만');
});

test('argosInboxDocs: 맥 수신 시각(received_at)을 receivedAt으로 남긴다', () => {
  const payload = { packageName: 'com.kakao.talk', sender: '삼성증권', body: EXEC, postedAt: at('2026-08-01 10:00:00') };
  const [doc] = argosInboxDocs([{ id: 'u', type: 'notification.received', received_at: '2026-08-04T00:00:00.000Z', payload }]);
  assert.equal(doc.receivedAt, Date.parse('2026-08-04T00:00:00.000Z'));
});
