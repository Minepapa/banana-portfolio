// 텔레그램 관문 결정론 처리기 — 라우터가 정한 route를 기존 운영 도구로 처리하고 결과를 발송 관문으로 답한다
// (2026-10-30, 관문 1단계. 설계 5절).
// - 기존 CLI를 자식 프로세스로 부른다(셸 없음, JSON은 표준입력). 도구 안의 안전장치·기록 방식이 그대로 유지된다.
// - 자식 환경은 buildGateSpawnEnv에서만 만든다(CLAUDE_TELEGRAM_GATE=1, 상시 세션 변수·봇 토큰 없음).
// - 답은 sendAgentMessage(kind 정보)로만 보낸다. 스크립트가 만든 사실이라 가는 선(─)이다(결정 `텔레그램-메시지-구분`).
// - 도구가 실패하면 원인을 그대로 알리고 다시 시도하지 않는다(입력 규칙 3절).
// LLM이 필요한 route('llm')는 2단계 전까지 고정 안내만 한다.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGateSpawnEnv } from './telegram-gate-config.mjs';
import { factsCatalog } from './facts-catalog.mjs';
import { escapeHtml } from './telegram.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL_TIMEOUT_MS = 2 * 60 * 1000;
const VOICE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 64 * 1024;

// 관문이 결정론으로 부를 수 있는 도구 전부. 여기에 없는 이름은 실행하지 않는다(라우터 버그가 다른 도구를 부르지 않게).
export const GATE_TOOLS = Object.freeze([
  'kill-switch-cli.mjs',
  'execution-mode-cli.mjs',
  'proposal-mode-cli.mjs',
  'inbox-memo.mjs',
  'daily-owner-input.mjs',
  'place-register.mjs',
  'resolve-execution-confirmation.mjs',
]);

// 실행 중인 도구 프로세스(그룹). 관문이 멈출 때 손자(whisper 등)까지 함께 끝낸다(1단계 리뷰 MEDIUM).
const RUNNING = new Set();

function killGroup(child, signal) {
  // detached로 띄운 자식은 자기 프로세스 그룹의 리더다. 음수 pid로 그룹 전체에 보낸다.
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* 이미 끝남 */ } }
}

// group을 주면 그 줄의 도구만 끝낸다. 관문 종료 때는 media(음성 전사 — 노트는 전사가 끝난 뒤에만 생겨 끊어도 중복이 없다)만 끝내고,
// main 줄 도구(기록·스위치)는 끝날 때까지 기다려 "기록은 됐는데 확인필요"가 생기지 않게 한다(1단계 리뷰 MEDIUM-5).
export function killRunningGateTools(signal = 'SIGTERM', { group = null } = {}) {
  let killed = 0;
  for (const child of RUNNING) {
    if (group && child.gateGroup !== group) continue;
    killGroup(child, signal);
    killed += 1;
  }
  return killed;
}

export function runningGateToolCount() {
  return RUNNING.size;
}

// 2단계 LLM이 관문 MCP 도구(telegram-gate-mcp)를 거쳐 부를 수 있는 운영 도구. 돈 도구(주문·정정취소·손절·제안 체결)는
// 여기에도 없다 — 그것들은 확인 대기(telegram-gate-confirm) 뒤 관문만 실행한다. 사실 도구(*-facts.mjs)는 각 도구의 자기 선언
// (facts-catalog)으로 허용한다(규칙에 고정 목록을 적지 않는다).
export const LLM_GATE_TOOLS = Object.freeze([
  'calendar-add-event.mjs',
  'tasks-add.mjs',
  'tasks-delete.mjs',
  'place-register.mjs',
  'inbox-memo.mjs',
  'process-telegram-reply.mjs',
  'wiki-question-cli.mjs',
  'department-call-facts.mjs',
]);

export function isGateToolAllowed(tool, { factsFiles = () => factsCatalog().filter((e) => !e.deprecated).map((e) => e.filename) } = {}) {
  if (GATE_TOOLS.includes(tool) || LLM_GATE_TOOLS.includes(tool)) return true;
  return /^[a-z0-9-]+-facts\.mjs$/.test(tool) && factsFiles().includes(tool);
}

export function runGateTool(tool, args = [], { input = null, timeoutMs = TOOL_TIMEOUT_MS, env = buildGateSpawnEnv(), spawnImpl = spawn, group = 'main', allowed = isGateToolAllowed } = {}) {
  if (!allowed(tool)) return Promise.reject(new Error(`관문 허용 목록에 없는 도구: ${tool}`));
  return new Promise((resolvePromise, reject) => {
    const child = spawnImpl(process.execPath, [join(REPO_ROOT, 'scripts', 'tools', tool), ...args], {
      cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    child.gateGroup = group;
    RUNNING.add(child);
    let out = '';
    let err = '';
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); RUNNING.delete(child); fn(value); } };
    const timer = setTimeout(() => {
      killGroup(child, 'SIGKILL');
      finish(reject, new Error(`${tool} 시간 초과(${Math.round(timeoutMs / 1000)}초)`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < MAX_OUTPUT) out += d; });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUTPUT) err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (code === 0) finish(resolvePromise, out.trim());
      else finish(reject, new Error((err.trim() || out.trim() || `${tool} 종료코드 ${code}`).split('\n').slice(-3).join('\n')));
    });
    child.stdin.on('error', () => { /* 도구가 표준입력을 안 읽고 끝나도 무시 */ });
    child.stdin.end(input === null ? '' : input);
  });
}

function formatDuration(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days) return `${days}일 ${hours}시간`;
  if (hours) return `${hours}시간 ${mins}분`;
  return `${mins}분`;
}

function kstTime(iso) {
  if (!iso) return '없음';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

// 순수 함수: 상태 표(<pre>, 폰 한 줄 44칸 안). 2단계 전이라 LLM 줄은 준비 중으로 표시한다.
function llmLine(llm) {
  if (!llm) return '대화 처리 꺼짐';
  const parts = [llm.running ? '처리 중' : '쉬는 중'];
  if (llm.queued) parts.push(`대기 ${llm.queued}`);
  if (llm.lastRun?.status && llm.lastRun.status !== '완료') parts.push(`최근 ${llm.lastRun.status}`);
  return parts.join(' · ');
}

function usageLine(cooldown, rateLimit) {
  if (cooldown) return `한도 쿨다운 ~${kstTime(new Date(cooldown.resetAt).toISOString())}`;
  const w = rateLimit?.unifiedWindows;
  if (w?.five_hour || w?.seven_day) {
    const pct = (x) => (Number.isFinite(x?.utilization) ? `${Math.round(x.utilization * 100)}%` : '?');
    return `5시간 ${pct(w.five_hour)} · 7일 ${pct(w.seven_day)}`;
  }
  return '쿨다운 없음';
}

function promiseLine(promises, nowMs) {
  if (!promises) return '꺼짐';
  if (!promises.pending) return '대기 없음';
  // 다음 시각이 이미 지났으면(다음 1분 점검에서 바로 이행·만료) '곧'으로 보인다(리뷰 L4).
  const next = promises.nextAt ? (Date.parse(promises.nextAt) <= nowMs ? '곧' : kstTime(promises.nextAt)) : null;
  return `대기 ${promises.pending}${promises.inflight ? `(반영 중 ${promises.inflight})` : ''}${next ? ` · 다음 ${next}` : ''}`;
}

export function buildStatusBody({ startedAt, now, lastPollOkAt, counts, cooldown, freeMemPct, mode, llm = null, promises = null }) {
  const pending = (counts['받음'] ?? 0) + (counts['처리중'] ?? 0);
  const rows = [
    ['관문', `정상 · 가동 ${formatDuration(now - startedAt)}${mode === 'test' ? ' · 시험' : ''}`],
    ['수신', `마지막 ${kstTime(lastPollOkAt)} · 밀린 것 ${pending}`],
    ['확인', `끊긴 메시지 ${counts['확인필요'] ?? 0}`],
    ['LLM', llmLine(llm)],
    ['사용량', usageLine(cooldown, llm?.rateLimit)],
    ['약속', promiseLine(promises, now)],
    ['메모리', `여유 ${freeMemPct}%`],
  ];
  // 폰 고정폭 글꼴에서 한글은 2칸 — 칸 너비로 맞춰 값 열이 한 줄로 서게 한다.
  const width = (s) => [...s].reduce((w, ch) => w + (/[\u1100-\uFFDC]/.test(ch) ? 2 : 1), 0);
  const pad = (s) => s + ' '.repeat(Math.max(0, 6 - width(s)));
  return `<pre>${rows.map(([k, v]) => `${escapeHtml(pad(k))} ${escapeHtml(v)}`).join('\n')}</pre>`;
}

// 순수 함수: 위키 질문 처리 결과 → 오너에게 보낼 한 줄(현 wiki-question-intake 훅의 분기와 같은 기준).
export function describeWikiResult(questionId, result, applied = null, applyError = null) {
  if (applyError) return `${questionId}: 승인은 기록했으나 자동 반영이 실패했습니다(${applyError.message}). 원인 점검 뒤 반영합니다.`;
  if (applied) return `${questionId}: 승인을 기록하고 반영했습니다(상태 ${applied.status}).`;
  if (result.action === 'clarify') return `${questionId}: 선택이 분명하지 않아 바꾸지 않았습니다. 등록·보류·제외 중 하나로 다시 답해 주세요.`;
  if (result.action === 'already-processed' || result.action === 'expired') return `${questionId}: 기록하지 않았습니다(이미 처리됐거나 만료된 질문, 상태 ${result.status ?? result.action}).`;
  if (result.kind === 'manual-change' && result.action === 'approve') return `${questionId}: 승인을 기록했습니다(반영대기). 승인한 변경은 이어서 반영합니다.`;
  return `${questionId}: 답을 ${result.status ?? result.action} 상태로 기록했습니다.`;
}

// deps: { reply(agent, topic, body), react(emoji), runTool, telegram: { getFile, download }, wiki: { resolve, apply },
//         status(): {...buildStatusBody 입력}, selfCheck(): { ok, problems[] }, mediaDir, now }
// deps.testMode: 시험 봇 모드. 볼트 쓰기(스위치·기록·질문 큐·장부)는 데몬이 시험 전용 볼트(VAULT_PATH)로 다시 떠서
// 구조적으로 격리된다(telegram-gate.mjs assertTestIsolation). 볼트 밖 외부 쓰기가 있는 처리(체결확인 → Firestore 원문 삭제)만
// 시험 모드에서 실행하지 않는다(1단계 리뷰 MEDIUM, 제우스 방향: 오너 확인이 아니라 구조로 격리).
// deps.lane: 'media'면 도구를 media 그룹으로 띄워 관문이 멈출 때 그 줄만 끝낸다(main 줄 도구는 끝날 때까지 기다린다).
export function createGateHandlers(deps) {
  const baseRun = deps.runTool ?? runGateTool;
  const run = (tool, args, opts = {}) => baseRun(tool, args, { ...opts, group: deps.lane ?? 'main' });
  const log = deps.log ?? ((line) => console.log(line));
  async function refuseInTestMode(agent, topic, what) {
    await deps.reply(agent, topic, `시험 모드라 실행하지 않았습니다(${what}은 볼트 밖 외부 기록을 바꿉니다).`);
    return { status: '완료', detail: `시험 모드 — ${what} 실행 안 함` };
  }

  async function saveMedia(fileId, ext) {
    const file = await deps.telegram.getFile(fileId);
    const buffer = await deps.telegram.download(file.file_path);
    mkdirSync(deps.mediaDir, { recursive: true, mode: 0o700 });
    const safeId = String(file.file_unique_id ?? 'file').replace(/[^A-Za-z0-9_-]/g, '_');
    const path = join(deps.mediaDir, `${deps.now().getTime()}-${safeId}.${ext}`);
    writeFileSync(path, buffer, { mode: 0o600 });
    return path;
  }

  const handlers = {
    async greeting() {
      await deps.react('😎');
      const check = await deps.selfCheck();
      if (check.ok) {
        await deps.react('😘');
        return { status: '완료', detail: '안녕 점검 통과' };
      }
      await deps.reply('zeus', '생존 확인', ['관문은 받았지만 아래가 정상이 아닙니다.', ...check.problems.map((p) => `· ${escapeHtml(p)}`)].join('\n'));
      return { status: '완료', detail: `안녕 점검 실패: ${check.problems.join(', ')}` };
    },

    async status() {
      await deps.reply('zeus', '상태', buildStatusBody(await deps.status()));
      return { status: '완료' };
    },

    async cancel() {
      await deps.reply('zeus', '취소', '지금 취소할 대화 작업이 없습니다.');
      return { status: '완료' };
    },

    async switch({ tool, text, live }) {
      const out = await run(tool, [`--text=${text}`]);
      // 이미 실전이었으면 도구가 "이미"라고 답한다 — 그때는 경고를 덧붙이지 않는다.
      const warn = live && !out.includes('이미') ? '\n\n승인된 제안은 이제 실제 KIS 주문으로 나갑니다.' : '';
      await deps.reply('zeus', '스위치', `${escapeHtml(out)}${warn}`);
      return { status: '완료', detail: out.slice(0, 120) };
    },

    async memo({ text }) {
      const out = await run('inbox-memo.mjs', ['--json=-'], { input: JSON.stringify({ text }) });
      await deps.reply('clio', '기록', escapeHtml(out));
      return { status: '완료', detail: out.slice(0, 120) };
    },

    async photoMemo({ fileId, text }) {
      const photoPath = await saveMedia(fileId, 'jpg');
      const out = await run('inbox-memo.mjs', ['--json=-'], { input: JSON.stringify({ kind: '사진메모', text, photoPath }) });
      await deps.reply('clio', '기록', escapeHtml(out));
      return { status: '완료', detail: out.slice(0, 120) };
    },

    async voice({ fileId, caption }) {
      const audioPath = await saveMedia(fileId, 'oga');
      const out = await run('inbox-memo.mjs', ['--json=-', '--json-out'], {
        input: JSON.stringify({ kind: '음성', audioPath, ...(caption ? { caption } : {}) }),
        timeoutMs: VOICE_TIMEOUT_MS,
      });
      const result = JSON.parse(out.split('\n').at(-1));
      const lines = [`음성 기록함: ${escapeHtml(result.note ?? '')}`];
      if (result.error) lines.push(`전사 실패: ${escapeHtml(result.error)}`);
      else if (result.text) lines.push('', '이렇게 들었습니다:', escapeHtml(result.text));
      await deps.reply('clio', '기록', lines.join('\n'));
      return { status: '완료', detail: `음성 ${result.note ?? ''}` };
    },

    async oneLine({ text }) {
      const out = await run('daily-owner-input.mjs', ['--json=-'], { input: JSON.stringify({ kind: '한줄', text }) });
      // 도구 출력(진행 로그·파일 경로)을 그대로 보내지 않고 고정 문구로 답한다(2026-10-31 시험 봇 실측). 같은 날 두 번째면
      // 도구가 " — 이전 한 줄을 바꿈"을 붙이니 그 알림은 살린다(리뷰 M1). 원문 핵심 줄은 기록 detail에.
      const saved = /오늘 한 줄 저장\((\d{4}-\d{2}-\d{2})\)( — 이전 한 줄을 바꿈)?/.exec(out);
      if (!saved) log(`[gate] 🪶 도구 출력 형식이 예상과 다름(고정 문구로 답함): ${out.split('\n').filter(Boolean).at(-1)?.slice(0, 80) ?? ''}`);
      const body = saved
        ? `🪶 오늘 한 줄을 저장했습니다(${saved[1]}).${saved[2] ? ' (이전 한 줄을 바꿨습니다)' : ''}`
        : '🪶 오늘 한 줄을 저장했습니다.';
      await deps.reply('clio', '데일리', body);
      return { status: '완료', detail: (saved?.[0] ?? out.split('\n').filter(Boolean).at(-1) ?? '').slice(0, 120) };
    },

    async wiki({ answers }) {
      const lines = [];
      for (const answer of answers) {
        const result = await deps.wiki.resolve(answer.questionId, answer.answer, { rawText: answer.rawText });
        let applied = null;
        let applyError = null;
        if (result.action === 'approve' && ['keyword-registration', 'close-work-doc'].includes(result.kind)) {
          try { applied = await deps.wiki.apply(answer.questionId); } catch (error) { applyError = error; }
        }
        lines.push(escapeHtml(describeWikiResult(answer.questionId, result, applied, applyError)));
      }
      await deps.reply('clio', '질문 답', lines.join('\n'));
      return { status: '완료', detail: `위키 답 ${answers.length}건` };
    },

    async execConfirm({ id, account }) {
      if (deps.testMode) return refuseInTestMode('plutus', '체결 확인', '체결확인');
      const out = await run('resolve-execution-confirmation.mjs', [`--id=${id}`, `--account=${account}`]);
      await deps.reply('plutus', '체결 확인', escapeHtml(out));
      return { status: '완료', detail: out.slice(0, 120) };
    },

    async place(args) {
      const out = await run('place-register.mjs', ['--json=-'], { input: JSON.stringify(args) });
      await deps.reply('hermes', '장소 등록', escapeHtml(out));
      return { status: '완료', detail: out.slice(0, 120) };
    },

    async llm() {
      await deps.reply('zeus', '안내', '대화 처리(관문 2단계)는 아직 준비 중입니다. 기호 입력·스위치·장소·체결확인·위키 답은 지금 처리됩니다.');
      return { status: '완료', detail: 'llm 2단계 전' };
    },
  };

  // 실패 답장까지 실패하면(네트워크 등) 호출부가 상태를 실패로 남긴다. 실패 원인은 도구가 낸 문구 그대로다.
  return async function handle(route, args) {
    const handler = handlers[route];
    if (!handler) throw new Error(`처리기 없음: ${route}`);
    try {
      return await handler(args ?? {});
    } catch (error) {
      // 관문 종료 중에 도구가 끊긴 경우: 답장하지 않는다. 호출부가 상태를 '처리중'으로 남겨 두면 재시작 때
      // recoverInterrupted가 '확인필요'로 바꿔 한 번에 안내한다(1단계 재리뷰 LOW-N1).
      if (deps.isStopping?.()) return { status: '중단', detail: '관문 종료 중 끊김', interruptedByShutdown: true };
      const agent = route === 'execConfirm' ? 'plutus' : route === 'place' ? 'hermes' : ['memo', 'photoMemo', 'voice', 'oneLine', 'wiki'].includes(route) ? 'clio' : 'zeus';
      // 도구가 오너에게 보여 주려고 출력한 사유(예: "처리하지 않음: 대기 건 없음")를 첫 줄만 전한다(입력 규칙 3절:
      // 원인을 그대로 알림). 스택·여러 줄 원문은 보내지 않고 상태 기록에만 남긴다.
      const reason = String(error.message ?? '').split('\n')[0].slice(0, 200);
      await deps.reply(agent, '처리 실패', `처리하지 못했습니다. 다시 시도하지 않았습니다.\n· 원인: ${escapeHtml(reason)}`);
      return { status: '실패', detail: error.message };
    }
  };
}

export function gateMediaDir(stateDir) {
  return join(stateDir, 'media');
}

// 내려받은 사진·음성은 도구에 넘긴 뒤에는 필요 없다(사진 원본은 Syncthing, 음성 전사본은 Inbox 노트). 7일 지난 것을 지운다.
const MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export function pruneGateMedia(dir, { now = new Date(), retentionMs = MEDIA_RETENTION_MS } = {}) {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      const stat = statSync(path);
      if (stat.isFile() && now.getTime() - stat.mtimeMs > retentionMs) { unlinkSync(path); removed += 1; }
    } catch { /* 지우는 중 사라진 파일 */ }
  }
  return removed;
}
