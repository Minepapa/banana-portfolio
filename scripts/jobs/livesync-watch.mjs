#!/usr/bin/env node
/**
 * 볼트 동기화(LiveSync) 멈춤 감시·자동 복구 — 2026-10-31 오너 승인("알림 + 자동 재시작").
 *
 * 왜: 2026-10-30 23시쯤부터 Mac Obsidian(LiveSync)이 CouchDB로 올리기를 멈췄는데, 프로세스는 살아 있어
 * 아무도 몰랐다. 약 15시간 뒤 오너가 폰에서 데일리 노트·동선 지도가 안 보여 발견했다. Mac Obsidian을
 * 다시 켜자 밀린 변경이 바로 올라갔다(Obsidian은 10-07부터 24일째 켜져 있었다).
 *
 * 판정(결정론적, 로그 파싱 없음):
 *   - CouchDB 변경 번호(update_seq)가 마지막으로 바뀐 시각을 볼트 밖 상태 파일에 기억한다.
 *   - 번호가 STALL_MS(30분) 넘게 그대로인데, 그 뒤에 볼트 파일이 바뀌었으면(잡들이 10분마다 쓰므로
 *     정상이면 번호가 계속 오른다) "Mac → 서버 업로드 멈춤"으로 본다. 볼트도 조용하면 멈춤이 아니다.
 *   - 한계(리뷰 MEDIUM): update_seq는 DB 전체 번호라 폰이 쓴 변경도 올린다. 폰을 30분보다 자주 쓰면 감지가
 *     늦어질 수 있고, 재시작 뒤 "업로드 재개"(번호 증가) 판정도 근사치다. 문서 경로가 암호화돼 있어
 *     Mac 쪽 문서만 따로 확인할 수 없다.
 *   - 번호 조회 실패(CouchDB·Docker 장애)는 Obsidian 문제가 아니므로 재시작하지 않고 잡 FAIL로 끝낸다
 *     (health-watcher가 알린다).
 * 복구(볼트 헌법 §6 — LiveSync 재개 전 스냅숏, 끝난 뒤 되돌아간 파일 전수 검사):
 *   1) 볼트 git 기준점 커밋 → 실패하면 재시작하지 않고 알림(6시간에 한 번)
 *   2) Obsidian 종료(AppleScript quit → 안 되면 SIGTERM) → 다시 실행(창을 앞으로 가져오지 않음)
 *      launchd에서는 AppleScript에 자동화 권한이 없을 수 있어 SIGTERM이 주 경로일 수 있다.
 *   3) 번호가 다시 오르는지 최대 3분 확인
 *   4) 기준점 이후 옛 버전(기준점 이전 이력)과 같아진 파일·사라진 파일을 검사해 알린다.
 *      밀린 내려받기가 늦게 올 수 있어 1시간 동안 다음 회차마다 같은 기준점으로 다시 검사하고 새로 나온 것만 알린다.
 *   재시작은 24시간에 MAX_RESTARTS_PER_DAY(2)회까지. 넘으면 6시간에 한 번 "수동 확인 필요" 알림만.
 *   볼트 git이 잠겨 있으면(23:50 스냅숏 등) 이번 회차는 건너뛴다.
 *
 * CouchDB 자격증명은 코드·볼트에 두지 않는다 — 컨테이너 안 환경변수로 컨테이너 안에서 조회한다.
 * 금고(99_)는 열지도 훑지도 않는다.
 *
 * 사용법: node scripts/jobs/livesync-watch.mjs [--dry-run]   (--dry-run: 판정만 출력, 재시작·발송·상태 저장 없음)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { MOUSEION_TOP_FOLDERS } from '../lib/vault-layout.mjs';
import { sendAgentMessage } from '../lib/pantheon-send.mjs';
import { createDirectWarningSender } from '../lib/direct-warning-delivery.mjs';

const JOB = 'livesync-watch';
const SENDER_AGENT = 'clio'; // 볼트·동기화는 클리오 담당
const sendWarning = createDirectWarningSender(sendAgentMessage, {
  jobName: JOB, warningCode: 'LIVESYNC_STALLED', subjectKey: 'livesync', kind: 'operational', severity: 'high',
});

export const STALL_MS = 30 * 60_000;
export const MAX_RESTARTS_PER_DAY = 2;
const DAY_MS = 24 * 60 * 60_000;
export const ESCALATE_REPEAT_MS = 6 * 60 * 60_000;
// 번호가 멈춘 직후 같은 순간에 쓰인 파일은 세지 않는다(업로드가 몇 초 늦을 수 있음).
const VAULT_CHANGE_GRACE_MS = 2 * 60_000;
const RECOVERY_WAIT_MS = 3 * 60_000;
const RECOVERY_POLL_MS = 15_000;
const QUIT_WAIT_MS = 30_000;
const REVERT_RECHECK_MS = 60 * 60_000;
const STATE_FILE = join(homedir(), '.cache', 'banana-portfolio-v2', 'livesync-watch.json');
const COUCH_CONTAINER = 'livesync-couchdb';
const COUCH_DB = 'obsidiannotes';
// 금고는 훑지 않는다(이름은 vault-layout 상수에서 번호로 찾는다). 점으로 시작하는 항목은 LiveSync가 올리지 않는다
// (syncInternalFiles 꺼짐) — 변경 근거로 세지 않는다. 쓰는 중 임시 파일·잠금 파일도 뺀다.
const SKIP_TOP = new Set([MOUSEION_TOP_FOLDERS.find((f) => f.startsWith('99_'))]);
const isIgnoredName = (name) => name.startsWith('.') || name.endsWith('.lock') || name.includes('.tmp-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 순수함수 — 이번 회차의 번호와 직전 상태로 판정한다.
// 반환: { state(다음 상태), stalled, reason }
export function evaluate(prev, { seq, now, vaultChangedAfter }) {
  const nowMs = now.getTime();
  if (!prev || prev.seq !== seq) {
    return { state: { ...prev, seq, seqChangedAt: now.toISOString() }, stalled: false, reason: prev ? '번호 증가' : '첫 기록' };
  }
  const since = Date.parse(prev.seqChangedAt);
  if (nowMs - since < STALL_MS) return { state: prev, stalled: false, reason: '번호 그대로(30분 안)' };
  const changed = vaultChangedAfter(since + VAULT_CHANGE_GRACE_MS);
  if (!changed) return { state: prev, stalled: false, reason: '번호 그대로지만 볼트도 조용함' };
  return { state: prev, stalled: true, reason: `번호 ${seq}가 ${Math.round((nowMs - since) / 60_000)}분째 그대로인데 볼트는 바뀜` };
}

// 순수함수 — 24시간 안 재시작 횟수로 재시작할지, 수동 확인 알림만 할지 정한다.
export function planAction(state, now) {
  const recent = (state.restarts ?? []).filter((t) => now.getTime() - Date.parse(t) < DAY_MS);
  if (recent.length < MAX_RESTARTS_PER_DAY) return { action: 'restart', recent };
  return { action: dueAgain(state.lastEscalatedAt, now) ? 'escalate' : 'quiet', recent };
}

// 같은 종류 알림을 6시간에 한 번만 보내기 위한 판정.
export function dueAgain(lastIso, now) {
  return !lastIso || now.getTime() - Date.parse(lastIso) >= ESCALATE_REPEAT_MS;
}

// 볼트에서 afterMs보다 늦게 바뀐 파일이 하나라도 있으면 true(찾는 즉시 멈춤).
export function vaultChangedAfter(root, afterMs) {
  const visit = (dir, top) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (isIgnoredName(e.name) || (top && SKIP_TOP.has(e.name))) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) { if (visit(abs, false)) return true; continue; }
      try { if (statSync(abs).mtimeMs > afterMs) return true; } catch { /* 사이에 지워짐 */ }
    }
    return false;
  };
  return visit(root, true);
}

function readCouchSeq() {
  const out = execFileSync('docker', ['exec', COUCH_CONTAINER, 'sh', '-c',
    `curl -sf -u "$COUCHDB_USER:$COUCHDB_PASSWORD" http://127.0.0.1:5984/${COUCH_DB}`],
  { encoding: 'utf8', timeout: 20_000 });
  const seq = String(JSON.parse(out).update_seq ?? '').split('-')[0];
  if (!/^\d+$/.test(seq)) throw new Error('CouchDB 응답에 update_seq 없음');
  return Number(seq);
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
// 쓰다 죽어도 재시작 이력이 날아가지 않게 임시 파일에 쓴 뒤 바꿔 끼운다.
function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, STATE_FILE);
}

const git = (args) => execFileSync('git', ['-C', VAULT_PATHS.root, ...args], { encoding: 'utf8', timeout: 120_000 });
const gitLocked = () => existsSync(join(VAULT_PATHS.root, '.git', 'index.lock'));

function commitBaseline(now) {
  git(['add', '-A']);
  if (git(['status', '--porcelain']).trim()) git(['commit', '-q', '-m', `livesync-watch 재시작 전 기준점 ${now.toISOString()}`]);
  return git(['rev-parse', 'HEAD']).trim();
}

// 기준점 이후 바뀐 파일 중 내용이 기준점 이전의 옛 버전과 같아진 것(= 되돌림 의심)과 사라진 것을 찾는다.
// entries: [{ status: 'M'|'D'|…, file }]
export function findReverted(entries, { hashOf, historyOf }) {
  const reverted = [];
  const deleted = [];
  for (const { status, file } of entries) {
    if (status.startsWith('D')) { deleted.push(file); continue; }
    const now = hashOf(file);
    if (now && historyOf(file).includes(now)) reverted.push(file);
  }
  return { reverted, deleted };
}

export function parseNameStatus(z) {
  const parts = z.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i];
    // 이름 바뀜·복사(R/C)는 옛 이름·새 이름 두 칸이 따른다 — 새 이름만 본다.
    if (/^[RC]/.test(status)) { out.push({ status, file: parts[i + 2] }); i += 2; } else { out.push({ status, file: parts[i + 1] }); i += 1; }
  }
  return out;
}

function checkReverts(base) {
  const entries = parseNameStatus(git(['diff', '--name-status', '-z', base]));
  return findReverted(entries, {
    hashOf: (f) => { try { return git(['hash-object', '--', f]).trim(); } catch { return null; } },
    // 기준점 버전은 빼고(base^부터) 최근 20개 버전의 blob을 본다.
    historyOf: (f) => git(['log', '-n', '20', '--format=%H', `${base}^`, '--', f]).split('\n').filter(Boolean)
      .map((c) => { try { return git(['rev-parse', `${c}:${f}`]).trim(); } catch { return null; } }).filter(Boolean),
  });
}

const fileList = (files) => `${files.slice(0, 8).join(', ')}${files.length > 8 ? ' 외' : ''}`;

function obsidianRunning() {
  try { execFileSync('pgrep', ['-x', 'Obsidian'], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function restartObsidian() {
  if (obsidianRunning()) {
    try { execFileSync('osascript', ['-e', 'quit app "Obsidian"'], { stdio: 'ignore', timeout: 20_000 }); } catch { /* 아래 SIGTERM으로 */ }
    for (let waited = 0; obsidianRunning() && waited < QUIT_WAIT_MS; waited += 1000) await sleep(1000);
    if (obsidianRunning()) {
      try { execFileSync('pkill', ['-TERM', '-x', 'Obsidian'], { stdio: 'ignore' }); } catch { /* 이미 끝남 */ }
      for (let waited = 0; obsidianRunning() && waited < QUIT_WAIT_MS; waited += 1000) await sleep(1000);
    }
    if (obsidianRunning()) throw new Error('Obsidian이 종료되지 않음');
  }
  execFileSync('open', ['-g', '-a', 'Obsidian'], { stdio: 'ignore', timeout: 20_000 });
}

async function waitForSeqAdvance(fromSeq) {
  for (let waited = 0; waited < RECOVERY_WAIT_MS; waited += RECOVERY_POLL_MS) {
    await sleep(RECOVERY_POLL_MS);
    try { const seq = readCouchSeq(); if (seq > fromSeq) return seq; } catch { /* 다음 회차 */ }
  }
  return null;
}

async function notify(lines) {
  await sendWarning({ agent: SENDER_AGENT, kind: '정보', topic: '동기화', body: lines.join('\n') });
}

// 재시작 뒤 1시간 동안 같은 기준점으로 다시 검사해, 처음 알린 것 말고 새로 나온 되돌림·삭제만 알린다.
async function recheckPendingReverts(state, now) {
  const pending = state.pendingRevertCheck;
  if (!pending) return;
  if (now.getTime() > Date.parse(pending.until)) { delete state.pendingRevertCheck; return; }
  if (gitLocked()) return;
  let found;
  try { found = checkReverts(pending.base); } catch (e) { console.error(`[${JOB}] 되돌림 재검사 실패: ${e.message}`); return; }
  const seen = new Set(pending.reported ?? []);
  const fresh = { reverted: found.reverted.filter((f) => !seen.has(f)), deleted: found.deleted.filter((f) => !seen.has(f)) };
  if (!fresh.reverted.length && !fresh.deleted.length) return;
  pending.reported = [...seen, ...fresh.reverted, ...fresh.deleted];
  await notify([
    `재시작 뒤 늦게 들어온 변경을 다시 검사했습니다(기준점 ${pending.base.slice(0, 8)}).`,
    ...(fresh.reverted.length ? [`옛 버전으로 되돌아간 것으로 의심되는 파일 ${fresh.reverted.length}개: ${fileList(fresh.reverted)}`] : []),
    ...(fresh.deleted.length ? [`기준점 이후 사라진 파일 ${fresh.deleted.length}개: ${fileList(fresh.deleted)}`] : []),
    '기준점 커밋에서 되살릴 수 있습니다.',
  ]);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const now = new Date();
  const seq = readCouchSeq();
  const prev = readState();
  const result = evaluate(prev, { seq, now, vaultChangedAfter: (ms) => vaultChangedAfter(VAULT_PATHS.root, ms) });
  const running = obsidianRunning();
  console.log(`[${JOB}] seq ${seq} · ${result.reason}${running ? '' : ' · Obsidian 꺼짐'}`);
  if (dryRun) {
    if (result.stalled) console.log(`[${JOB}] 멈춤 — ${planAction(result.state, now).action}`);
    return;
  }
  const state = { ...result.state };
  await recheckPendingReverts(state, now);
  if (!result.stalled) { writeState(state); return; }

  const plan = planAction(state, now);
  console.log(`[${JOB}] 멈춤 — ${plan.action} (24시간 재시작 ${plan.recent.length}회)`);
  if (plan.action === 'quiet') { writeState(state); return; }
  if (plan.action === 'escalate') {
    state.lastEscalatedAt = now.toISOString();
    writeState(state);
    await notify([
      `Mac → 동기화 서버 업로드가 멈췄습니다(${result.reason}).`,
      `24시간 안에 이미 ${plan.recent.length}번 다시 켰는데 또 멈춰 자동 재시작을 멈췄습니다.`,
      '폰에 새 노트가 안 들어옵니다. Mac Obsidian의 LiveSync 로그를 직접 확인해 주세요.',
    ]);
    return;
  }
  if (gitLocked()) { console.log(`[${JOB}] 볼트 git 잠김(스냅숏 중일 수 있음) — 이번 회차는 건너뜀`); writeState(state); return; }

  let base;
  try { base = commitBaseline(now); } catch (e) {
    console.error(`[${JOB}] 기준점 커밋 실패: ${e.message}`);
    const due = dueAgain(state.lastBaselineFailAt, now);
    if (due) state.lastBaselineFailAt = now.toISOString();
    writeState(state);
    if (due) {
      await notify([`Mac → 동기화 서버 업로드가 멈췄습니다(${result.reason}).`,
        '재시작 전 볼트 기준점 커밋에 실패해 다시 켜지 않았습니다. 자세한 오류는 livesync-watch 로그에 있습니다.']);
    }
    throw e;
  }
  state.restarts = [...plan.recent, now.toISOString()];
  writeState(state); // 재시작 도중 죽어도 횟수는 남긴다
  try { await restartObsidian(); } catch (e) {
    console.error(`[${JOB}] Obsidian 재시작 실패: ${e.message}`);
    await notify(['Mac → 동기화 서버 업로드가 멈춰 Obsidian을 다시 켜려 했지만 실패했습니다(자세한 오류는 livesync-watch 로그).',
      `Obsidian 상태를 직접 확인해 주세요(볼트 기준점 ${base.slice(0, 8)}).`]);
    throw e;
  }
  const newSeq = await waitForSeqAdvance(seq);
  let found = null;
  try { found = checkReverts(base); } catch (e) { console.error(`[${JOB}] 되돌림 검사 실패: ${e.message}`); }
  if (newSeq) { state.seq = newSeq; state.seqChangedAt = new Date().toISOString(); }
  state.pendingRevertCheck = { base, until: new Date(now.getTime() + REVERT_RECHECK_MS).toISOString(),
    reported: found ? [...found.reverted, ...found.deleted] : [] };
  writeState(state);
  const lines = [
    running ? `Mac → 동기화 서버 업로드가 멈춰 Obsidian을 다시 켰습니다(${result.reason}).`
      : `Mac Obsidian이 꺼져 있어 업로드가 멈춰 있었습니다. Obsidian을 켰습니다(${result.reason}).`,
    newSeq ? `다시 켠 뒤 서버 번호 증가: ${seq} → ${newSeq}` : '다시 켠 뒤 3분 동안 서버 번호가 오르지 않았습니다 — 다음 회차에 다시 봅니다.',
    `볼트 기준점: ${base.slice(0, 8)}(1시간 동안 늦게 들어오는 변경도 다시 검사)`,
    ...(found === null ? ['되돌림 검사 실패 — 로그 확인 필요'] : [
      found.reverted.length ? `옛 버전으로 되돌아간 것으로 의심되는 파일 ${found.reverted.length}개: ${fileList(found.reverted)}` : '옛 버전으로 되돌아간 파일 없음',
      ...(found.deleted.length ? [`기준점 이후 사라진 파일 ${found.deleted.length}개: ${fileList(found.deleted)}`] : []),
    ]),
  ];
  await notify(lines);
  if (!newSeq) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(`[${JOB}] 실패: ${e.message}`); process.exitCode = 1; });
}
