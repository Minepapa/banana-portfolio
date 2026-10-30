// 텔레그램 관문 LLM이 쓸 수 있는 도구 전부 — 관문 MCP 서버(scripts/tools/telegram-gate-mcp.mjs)가 이 목록만 내보낸다
// (2026-10-30, 관문 2단계).
//
// 왜 Bash 대신 MCP인가(실측, 설계 1-2 E1·E3):
// - Bash 허용 규칙은 작은따옴표 heredoc(`--json=- <<'JSON'`) 명령을 dontAsk 모드에서 거부했다. 오너 원문을 셸에 넣지 않고
//   넘길 방법이 없다.
// - `Agent(clio)` 같은 허용 규칙은 하위 에이전트 종류를 제한하지 못했다. 대신 하위 에이전트는 부모의 --tools 집합을 넘지 못했다.
// 그래서 관문 LLM의 --tools는 Read·Grep·Glob·Agent만 두고(Bash·Write·Edit 없음), 실행은 이 MCP 도구로만 한다.
// 인자는 JSON으로 와서 기존 CLI의 표준입력·인자로 그대로 넘어간다(셸 해석 없음). 구현 금지가 도구 집합으로 강제된다.
//
// 돈 도구는 없다. 직접 주문·정정·취소·손절 재시도는 order_stage로 "접수 대기"만 만들고, 관문이 오너에게 다시 묻는다.
import { join } from 'node:path';
import { runGateTool } from './telegram-gate-handlers.mjs';
import { createConfirmStore, ORDER_ACTIONS } from './telegram-gate-confirm.mjs';
import { factsCatalog } from './facts-catalog.mjs';
import { AGENT_IDS } from './agent-registry.mjs';
import { buildFrontmatter } from './vault-frontmatter.mjs';
import { checkNote, parseRegistry } from './vault-registry.mjs';
import { VAULT_PATHS, VAULT_REL, vaultAbs } from './vault-paths.mjs';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeAtomic } from './state-writer.mjs';
import { createPromiseStore, describeTrigger, MAX_PENDING, validatePromiseInput, TRIGGER_TYPES } from './telegram-gate-promises.mjs';
import { JOB_LABELS } from './job-labels.mjs';
import { randomUUID } from 'node:crypto';

export function promiseRequestDir(stateDir) {
  return join(stateDir, 'promise-requests');
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

function kstDate(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// 순수 함수: 개발 요청 노트(dev-request) 본문·머리말. 텔레그램에서 "구현해줘"를 받으면 구현 대신 이것만 남긴다(운영 규칙 2절).
export function buildRequestNote({ title, what, why, ownerText, background = '', priority = '' }, { now = new Date() } = {}) {
  const date = kstDate(now);
  const next = kstDate(new Date(now.getTime() + 7 * 86_400_000));
  const cleanTitle = String(title ?? '').replace(/[\\/:*?"<>|#^[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!cleanTitle) throw new Error('요청 제목이 필요합니다');
  for (const [k, v] of Object.entries({ what, why, ownerText })) if (!String(v ?? '').trim()) throw new Error(`${k}가 필요합니다`);
  const name = `${date} ${cleanTitle}`;
  const content = `${buildFrontmatter({
    type: 'dev-request', category: [`[[${VAULT_REL.homeDir}/500 기술]]`], description: String(what).replace(/[\r\n]+/g, ' ').slice(0, 150),
    sensitivity: '일반', created: date, modified: date, requestedVia: '텔레그램 관문', status: '예정', waitingOn: '착수 대기', nextCheck: next,
  })}\n# ${cleanTitle}\n\n## 무엇이 필요한가\n${what}\n\n## 왜(오너 원문)\n${why}\n\n> ${String(ownerText).replace(/\n/g, '\n> ')}\n`
    + (background ? `\n## 배경\n${background}\n` : '') + (priority ? `\n## 우선순위\n${priority}\n` : '')
    + '\n텔레그램 관문에서 받은 구현 요청이다. 구현은 개발 세션에서 한다.\n';
  return { name, content, relPath: `${VAULT_REL.logDevRequests}/${name}.md` };
}

// deps: { run(tool, args, opts), stateDir, now, registryRules() }
export function createGateMcpTools(deps = {}) {
  const run = deps.run ?? ((tool, args, opts) => runGateTool(tool, args, opts));
  const now = deps.now ?? (() => new Date());
  const json = (value) => JSON.stringify(value);
  const registryRules = deps.registryRules ?? (() => parseRegistry(readFileSync(vaultAbs(VAULT_REL.registryFile), 'utf8')));

  // 시험 모드: 볼트는 시험 볼트로 격리되지만 구글 캘린더·할 일은 실제 계정이다 — 외부에 쓰는 도구는 실행하지 않는다.
  const externalGuard = (name, handler) => async (a) => {
    if (deps.testMode) return `시험 모드라 ${name}을 실행하지 않았습니다(실제 외부 계정에 씀).`;
    return handler(a);
  };
  // 약속 저장소: MCP는 요청 파일만 쓰고, 볼트 대기열은 읽기만 한다(쓰는 주체는 관문 데몬, 경로 등록부).
  const promiseStoreFor = (stateDir) => createPromiseStore({ vaultFile: deps.promiseVaultFile ?? vaultAbs(VAULT_REL.telegramGatePromises), requestDir: promiseRequestDir(stateDir), now });
  const tools = [
    {
      name: 'calendar_add_event',
      description: '오너 본인 일정을 기본 캘린더에 등록한다(입력 규칙 4-12). 날짜·시각이 분명할 때만. 종일은 date·endDate.',
      inputSchema: { type: 'object', properties: { title: str('제목'), start: str('YYYY-MM-DDTHH:MM'), end: str('YYYY-MM-DDTHH:MM'), location: str('장소'), description: str('설명'), date: str('종일 YYYY-MM-DD'), endDate: str('종일 끝 YYYY-MM-DD') }, required: ['title'], additionalProperties: false },
      handler: externalGuard('일정 등록', (a) => run('calendar-add-event.mjs', ['--json=-'], { input: json(a) })),
    },
    {
      name: 'tasks_add',
      description: '날짜·시각이 없는 오너 할 일을 Google Tasks에 등록한다(4-13). 마감 날짜만 있으면 due.',
      inputSchema: { type: 'object', properties: { title: str('할 일'), notes: str('메모'), due: str('YYYY-MM-DD') }, required: ['title'], additionalProperties: false },
      handler: externalGuard('할 일 등록', (a) => run('tasks-add.mjs', ['--json=-'], { input: json(a) })),
    },
    {
      name: 'tasks_delete',
      description: '관문·세션이 만든 할 일을 지운다. 오너가 지우라고 확인한 뒤에만.',
      inputSchema: { type: 'object', properties: { id: str('할 일 ID') }, required: ['id'], additionalProperties: false },
      handler: externalGuard('할 일 삭제', (a) => run('tasks-delete.mjs', [`--id=${a.id}`])),
    },
    {
      name: 'place_register',
      description: '장소 등록(4-6): 후보 {candidate,name}·{candidate,exclude:true}, 현재 위치 {here:true,name}, 지난 체류 {correct:{date,time},name}. 날짜·시각은 오늘 KST 기준으로 계산해 넘긴다.',
      inputSchema: { type: 'object', properties: { candidate: str('C3 같은 후보 번호'), name: str('장소 이름'), exclude: { type: 'boolean' }, here: { type: 'boolean' }, correct: { type: 'object', properties: { date: str('YYYY-MM-DD'), time: str('HH:MM') }, required: ['date', 'time'], additionalProperties: false } }, additionalProperties: false },
      handler: (a) => run('place-register.mjs', ['--json=-'], { input: json(a) }),
    },
    {
      name: 'photo_record',
      description: '기호 없는 사진의 판독 기록(입력 규칙 4-3, D97): 사진에 보이는 글자·숫자·핵심 정보를 빠짐없이 옮긴 decoded와 캡션 원문.',
      inputSchema: { type: 'object', properties: { decoded: str('판독 내용'), caption: str('캡션 원문') }, required: ['decoded'], additionalProperties: false },
      handler: (a) => run('inbox-memo.mjs', ['--json=-'], { input: json({ kind: '사진판독', decoded: a.decoded, ...(a.caption ? { caption: a.caption } : {}) }) }),
    },
    {
      name: 'proposal_reply',
      description: '담당 제안 승인·거부 답장 기록(4-7). 상태만 바뀐다(실제 체결은 하지 않음). sourceMessageId는 오너가 승인·거부를 직접 친 원본 메시지 — 답장 원문과 답장 대상(reply_to)은 관문이 그 메시지에서 그대로 가져온다(LLM이 승인 문구를 만들지 못함).',
      inputSchema: { type: 'object', properties: { sourceMessageId: { type: 'integer' } }, required: ['sourceMessageId'], additionalProperties: false },
      handler: async (a) => {
        if (!deps.stateDir) throw new Error('관문 상태 폴더가 없어 처리할 수 없습니다');
        const source = createConfirmStore({ stateDir: deps.stateDir, now }).source(a.sourceMessageId);
        return run('process-telegram-reply.mjs', [source.replyTo ? `--reply-to=${source.replyTo}` : '--infer-pending', `--text=${source.text}`]);
      },
    },
    {
      name: 'wiki_question_resolve',
      description: 'ID 없이 온 위키 질문 답을 기록(4-4). 직전 대화의 질문 하나를 분명히 가리킬 때만.',
      inputSchema: { type: 'object', properties: { id: str('WQ-YYYYMMDD-xxxxxxxx'), text: str('등록|보류|제외') }, required: ['id', 'text'], additionalProperties: false },
      handler: (a) => run('wiki-question-cli.mjs', ['resolve', `--id=${a.id}`, `--text=${a.text}`]),
    },
    {
      name: 'department_facts',
      description: '담당 기본 사실(헌장 decisionDocs에 연결된 "호출 때 항상" 사실 도구)을 조회한다. 담당을 부르기 전에 붙일 사실.',
      inputSchema: { type: 'object', properties: { agent: { type: 'string', enum: AGENT_IDS } }, required: ['agent'], additionalProperties: false },
      handler: (a) => run('department-call-facts.mjs', [a.agent], { timeoutMs: 3 * 60 * 1000 }),
    },
    {
      name: 'facts_tool',
      description: '사실 도구 하나를 실행한다(각 도구가 스스로 선언한 목록만). input은 그 도구가 입력을 받는다고 선언했을 때만(예: 종목명).',
      inputSchema: { type: 'object', properties: { filename: str('예: stock-facts.mjs'), input: str('도구 입력값') }, required: ['filename'], additionalProperties: false },
      handler: async (a) => {
        const entry = factsCatalog().find((e) => e.filename === a.filename && !e.deprecated);
        if (!entry) throw new Error(`사실 도구 목록에 없음: ${a.filename}`);
        if (a.input !== undefined && (!entry.input || /^-/.test(a.input) || a.input.length > 80)) throw new Error('이 도구는 그 입력을 받지 않습니다');
        return run(entry.filename, [...entry.args, ...(a.input !== undefined ? [a.input] : [])], { timeoutMs: 3 * 60 * 1000 });
      },
    },
    {
      name: 'order_stage',
      description: '직접 매수·매도·정정·취소·돌파매매 손절 재시도를 "접수 대기"로 넘긴다. 실행하지 않는다 — 관문이 오너에게 고정 문구로 다시 묻고, 오너가 글로 "응"이라고 답할 때만 실행한다. sourceMessageId는 주문을 지시한 오너 원본 메시지의 message_id.',
      inputSchema: { type: 'object', properties: {
        action: { type: 'string', enum: ORDER_ACTIONS },
        sourceMessageId: { type: 'integer' },
        params: { type: 'object', description: '매수·매도 {asset,quantity,price?} / 정정·취소 {orderNo,account(위탁|금현물),code,name,side(매수|매도),price(정정)} / 손절재시도 {code}|{positionId}' },
      }, required: ['action', 'sourceMessageId', 'params'], additionalProperties: false },
      handler: async (a) => {
        if (!deps.stateDir) throw new Error('관문 상태 폴더가 없어 접수할 수 없습니다');
        const store = createConfirmStore({ stateDir: deps.stateDir, now });
        const confirm = store.stage({ action: a.action, params: a.params, sourceMessageId: a.sourceMessageId });
        return `접수 대기로 넘김(${confirm.id}): ${confirm.summary}. 관문이 오너에게 다시 묻는다. 너는 실행됐다고 말하지 말고 "확인 질문을 보냈다"고만 답한다.`;
      },
    },
    {
      name: 'promise_add',
      description: '"끝나면 알려줄게" 같은 약속을 관문에 맡긴다(설계 9-1). 약속은 말로만 하지 말고 반드시 이 도구로 남긴다. 조건: time {at: ISO 시각} · job {job: 잡 이름, status: ok|fail|any} · file {path: 볼트 상대 경로}, 둘 중 하나면 or. action은 기본 notify(고정 문구), 맥락 설명이 필요할 때만 llm. 기한 7일.',
      inputSchema: { type: 'object', properties: {
        text: str('이행할 때 오너에게 알릴 내용(무엇을 알려 주기로 했는지)'),
        trigger: { type: 'object', properties: { type: { type: 'string', enum: TRIGGER_TYPES }, at: str('ISO 시각'), job: str('잡 이름'), status: { type: 'string', enum: ['ok', 'fail', 'any'] }, path: str('볼트 상대 경로') }, required: ['type'] },
        or: { type: 'object', properties: { type: { type: 'string', enum: TRIGGER_TYPES }, at: str('ISO 시각'), job: str('잡 이름'), status: { type: 'string', enum: ['ok', 'fail', 'any'] }, path: str('볼트 상대 경로') }, required: ['type'] },
        action: { type: 'string', enum: ['notify', 'llm'] },
        agent: { type: 'string', enum: AGENT_IDS },
        sourceMessageId: { type: 'integer' },
      }, required: ['text', 'trigger'], additionalProperties: false },
      handler: async (a) => {
        if (!deps.stateDir) throw new Error('관문 상태 폴더가 없어 약속을 남길 수 없습니다');
        const store = promiseStoreFor(deps.stateDir);
        // 대기 20건 한도를 맡기기 전에 본다(맡겼다고 답한 뒤 거절되지 않게, 리뷰 L3).
        if (store.pending().length + store.pendingRequestCount() >= MAX_PENDING) throw new Error(`대기 약속이 ${MAX_PENDING}건이라 더 받을 수 없습니다`);
        // uuid·요청 시각을 여기서 정해 최종 id를 미리 계산한다 — 데몬도 같은 값으로 같은 id를 만든다(리뷰 M3).
        const uuid = randomUUID();
        const requestedAt = now().toISOString();
        const promise = validatePromiseInput(a, { now: new Date(requestedAt), knownJobs: Object.keys(JOB_LABELS), uuid: () => uuid });
        store.request({ kind: 'add', input: a }, { uuid, requestedAt });
        return `약속을 관문에 맡겼다(id ${promise.id}, 1분 안에 대기열에 오름): ${promise.text}. 기한 ${promise.expiresAt.slice(0, 10)}. 오너에게 "조건이 되면 관문이 알려 준다"고 말하고, 취소는 이 id로 한다.`;
      },
    },
    {
      name: 'promise_cancel',
      description: '대기 중인 약속을 취소한다(오너가 그만 알려 달라고 할 때). id는 P-YYYYMMDD-xxxxxx.',
      inputSchema: { type: 'object', properties: { id: str('약속 ID') }, required: ['id'], additionalProperties: false },
      handler: async (a) => {
        if (!deps.stateDir) throw new Error('관문 상태 폴더가 없어 취소할 수 없습니다');
        if (!/^P-\d{8}-[0-9a-f]{6}$/.test(String(a.id))) throw new Error('약속 ID 형식이 올바르지 않습니다');
        promiseStoreFor(deps.stateDir).request({ kind: 'cancel', id: a.id });
        return `약속 취소를 관문에 넘겼다: ${a.id}`;
      },
    },
    {
      name: 'promise_list',
      description: '대기 중인 약속 목록(id·문구·조건·기한)과 아직 대기열에 오르기 전인 요청 수. 오너가 약속을 묻거나 취소할 때 먼저 본다.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        if (!deps.stateDir) throw new Error('관문 상태 폴더가 없습니다');
        const store = promiseStoreFor(deps.stateDir);
        const lines = store.pending().map(({ promise: p }) => `${p.id}: ${p.text} — ${describeTrigger(p.trigger)}${p.or ? ` 또는 ${describeTrigger(p.or)}` : ''}, 기한 ${p.expiresAt.slice(0, 10)}`);
        const waiting = store.pendingRequestCount();
        return [lines.length ? lines.join('\n') : '대기 중인 약속 없음', ...(waiting ? [`대기열에 오르기 전 요청 ${waiting}건`] : [])].join('\n');
      },
    },
    {
      name: 'request_record',
      description: '구현(코드·설정 변경) 요청을 개발 요청 노트로 기록한다. 텔레그램 관문은 구현하지 않는다(운영 규칙 2절) — 구현 요청은 이것만 하고 "개발 세션에서 이어서 구현한다"고 답한다.',
      inputSchema: { type: 'object', properties: { title: str('짧은 설명(파일 제목)'), what: str('무엇이 필요한지'), why: str('왜 필요한지'), ownerText: str('오너 원문'), background: str('관련 배경'), priority: str('우선순위') }, required: ['title', 'what', 'why', 'ownerText'], additionalProperties: false },
      handler: async (a) => {
        const note = buildRequestNote(a, { now: now() });
        const problems = checkNote(note.relPath, note.content, registryRules());
        if (problems.length) throw new Error(`볼트 등록부 검사 실패: ${problems.join('; ')}`);
        const abs = join(VAULT_PATHS.root, note.relPath);
        if (existsSync(abs)) throw new Error('같은 제목의 요청이 이미 있습니다');
        mkdirSync(join(VAULT_PATHS.root, VAULT_REL.logDevRequests), { recursive: true });
        writeAtomic(abs, note.content);
        return `개발 요청 기록함: ${note.relPath}`;
      },
    },
  ];
  return tools;
}

export const GATE_MCP_SERVER_NAME = 'gate';
export function gateMcpToolNames(tools = createGateMcpTools()) {
  return tools.map((t) => `mcp__${GATE_MCP_SERVER_NAME}__${t.name}`);
}
