import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setCooldown, parseResetTime, LIMIT_RE } from './quota-cooldown.mjs';

export const HEADLESS_NOTE = `

[⚙️ 실행환경: 헤드리스 자동화 — MCP 도구 사용 불가. 모든 데이터는 Bash로 직접 조회할 것]
- HTTPS 호출은 python urllib 말고 반드시 curl 사용 (이 환경 python은 SSL 인증서 검증 실패함)
- KR 재무지표: OpenDart REST를 curl로 호출 (API 키는 환경변수 $DART_API_KEY 사용)
  · 재무비율: curl "https://opendart.fss.or.kr/api/fnlttSinglIndx.json?crtfc_key=$DART_API_KEY&corp_code={고유번호8자리}&bsns_year={연도}&reprt_code={사업11011·1Q11013·반기11012·3Q11014}&idx_cl_code={수익성M210000·안정성M220000·성장성M230000·활동성M240000}"
  · 단일회사 전체재무제표: .../fnlttSinglAcntAll.json (동일 파라미터 + fs_div=CFS)
  · 고유번호(corp_code) 모르면 종목코드로 매핑 (pykrx 또는 알려진 값 사용; 삼성전자=00126380)
- KR 시세/RSI(14)/52주: python3 pykrx 또는 curl Naver JSON (api.finance.naver.com/siseJson.naver?symbol={코드}&requestType=1&timeframe=day)
- US 재무/시세: python3 yfinance (yf.Ticker("AAPL").info / .quarterly_financials / .history)
- 거시지표: USDKRW=yf "KRW=X", 미10년물=yf "^TNX", VIX=yf "^VIX", KOSPI=yf "^KS11", S&P500=yf "^GSPC"
- 데이터를 못 구하면 추정 금지, 해당 항목에 "(데이터 부족: 소스)" 표기`;

// argv 조립 — 순수함수(spawn 없이 단위 테스트 가능). appendSystemPrompt 는 에이전트 정의
// (agent-loader.mjs)의 본문을 시스템 프롬프트에 '추가'한다 — --system-prompt(전체 교체)가
// 아니라 --append-system-prompt 를 쓰는 이유: 기본 시스템 프롬프트의 동작을 보존하고
// 도메인 페르소나만 보태기 위함. 잡의 -p 태스크 프롬프트(결정론 사실·출력 계약)는 불변.
// tools(선택): 사용 가능한 내장 도구 목록 자체를 정한다. ''이면 도구를 모두 끈다(요약처럼 도구가 필요 없는 호출용 —
// bypassPermissions에서는 allowedTools가 제한 효과가 없을 수 있어, 읽기·실행을 확실히 막으려면 이걸 쓴다).
export function buildArgs(prompt, model, allowedTools, {
  appendSystemPrompt, tools, outputFormat = 'text', permissionMode = 'bypassPermissions',
  disallowedTools, addDir, restricted = false, strictMcpConfig = false, mcpConfig, maxTurns,
  lean = false, effort,
} = {}) {
  // --restricted 환경에서는 --allowedTools만으로 Bash/WebFetch 등을 노출할 수 없다.
  // 실제 필요한 도구 이름을 --tools에도 전달한다. 경로 제한은 --allowedTools가 맡는다.
  const permittedTools = allowedTools ?? (lean ? '' : 'Bash,Read,Glob,Grep,WebFetch');
  const leanTools = permittedTools.split(',').map(tool => tool.trim().split('(')[0]).filter(Boolean).join(',');
  const args = [
    '-p', prompt,
    '--permission-mode', lean ? 'dontAsk' : permissionMode,
    '--allowedTools', permittedTools,
    '--model', model,
    '--output-format', lean ? 'json' : outputFormat,
  ];
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  if (lean || tools !== undefined) args.push('--tools', tools ?? leanTools);
  if (lean || disallowedTools) args.push('--disallowedTools', disallowedTools ?? 'mcp__*');
  if (addDir) args.push('--add-dir', addDir);
  if (lean || restricted) args.push('--restricted');
  if (lean || effort !== undefined) args.push('--effort', effort ?? 'high');
  if (lean || strictMcpConfig) args.push('--strict-mcp-config');
  if (lean || mcpConfig) args.push('--mcp-config', mcpConfig ?? '{"mcpServers":{}}');
  if (maxTurns) args.push('--max-turns', String(maxTurns));
  return args;
}

// 출력 계약은 기존처럼 raw 문자열이다. text였던 호출부만 이 함수로 envelope를 벗긴다.
export function headlessResult(output) {
  const envelope = JSON.parse(output);
  if (typeof envelope?.result !== 'string' || !envelope.result.trim()) throw new Error('claude 빈 출력');
  return envelope.result;
}

export function headlessJsonFailure(output) {
  const parsed = JSON.parse(output);
  if (!parsed.is_error) return null;
  const fullDetail = typeof parsed.result === 'string' && parsed.result.trim()
    ? parsed.result : [parsed.subtype, ...(Array.isArray(parsed.errors) ? parsed.errors : [])]
      .filter(Boolean).map(String).join(': ') || 'claude JSON 오류';
  const error = new Error(fullDetail.slice(-300));
  if (parsed.subtype) error.subtype = parsed.subtype;
  if (parsed.usage && typeof parsed.usage === 'object') error.usage = parsed.usage;
  if (parsed.num_turns !== undefined) error.num_turns = parsed.num_turns;
  if (parsed.total_cost_usd !== undefined) error.total_cost_usd = parsed.total_cost_usd;
  if (LIMIT_RE.test(fullDetail)) {
    error.isLimit = true;
    error.limitDetail = fullDetail;
  }
  return error;
}

export function headlessExitFailure(code, output, stderr, json = false) {
  if (json && output.trim()) {
    try {
      const failure = headlessJsonFailure(output);
      if (failure) return failure;
    } catch { /* stdout가 JSON이 아니면 기존 stderr 오류를 사용한다. */ }
  }
  const clean = stderr.split('\n').filter(line => !/no stdin data received/i.test(line)).join('\n').trim();
  const fullDetail = (clean || output).trim() || '(stderr/stdout 비어있음)';
  const error = new Error(`claude 종료코드 ${code}: ${fullDetail.slice(-300)}`);
  if (LIMIT_RE.test(fullDetail)) {
    error.isLimit = true;
    error.limitDetail = fullDetail;
  }
  return error;
}

export function runHeadlessClaude(prompt, model = 'sonnet', allowedTools, opts = {}) {
  // timeoutMs(선택) — 기본 12분 그대로 유지. 여러 호출을 순차로 거는 잡(예:
  // intraday-market-move-monitor.mjs의 Call A/B/C)은 기본값이면 최악의 경우 36분까지
  // 감시가 완전히 멈출 수 있어 더 짧은 값을 넘길 수 있게 열어둠(2026-09-01, 코드리뷰 지적).
  const timeoutMs = opts.timeoutMs ?? 12 * 60 * 1000;
  const temporaryCwd = opts.lean && !opts.cwd ? mkdtempSync(join(tmpdir(), 'headless-claude-')) : null;
  const cwd = opts.cwd ?? temporaryCwd;
  const invoke = opts.spawnImpl ?? spawn;
  return new Promise((resolve, reject) => {
    let cp;
    try {
      cp = invoke('claude', buildArgs(prompt, model, allowedTools, opts),
        { cwd, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { reject(error); return; }
    let out = '', err = '';
    const timer = setTimeout(() => { cp.kill('SIGKILL'); reject(new Error(`헤드리스 타임아웃 (${Math.round(timeoutMs / 60000)}분 초과)`)); }, timeoutMs);
    cp.stdout.on('data', d => { out += d; });
    cp.stderr.on('data', d => { err += d; });
    cp.on('error', e => { clearTimeout(timer); reject(e); });
    cp.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const e = headlessExitFailure(code, out, err, opts.lean || opts.outputFormat === 'json');
        if (e.isLimit) setCooldown(parseResetTime(e.limitDetail ?? e.message) ?? Date.now() + 3600_000, e.limitDetail ?? e.message);
        return reject(e);
      }
      if (!out.trim()) return reject(new Error('claude 빈 출력'));
      if (opts.lean || opts.outputFormat === 'json') {
        let failure;
        try { failure = headlessJsonFailure(out); }
        catch { return reject(new Error('claude JSON 출력 오류')); }
        if (failure) {
          if (failure.isLimit) setCooldown(parseResetTime(failure.limitDetail ?? failure.message) ?? Date.now() + 3600_000, failure.limitDetail ?? failure.message);
          return reject(failure);
        }
        if (opts.lean) {
          const { usage, num_turns, total_cost_usd } = JSON.parse(out);
          (opts.usageLogger ?? console.log)(`[headless-claude] usage ${JSON.stringify({ usage, num_turns, total_cost_usd })}`);
        }
      }
      resolve(out);
    });
  }).finally(() => { if (temporaryCwd) rmSync(temporaryCwd, { recursive: true, force: true }); });
}

export function parseJsonBlock(text) {
  const fence = text.match(/```json\s*([\s\S]*?)\s*```/i) || text.match(/```\s*([\s\S]*?)\s*```/);
  let candidate = fence ? fence[1] : text;
  const first = candidate.search(/[[{]/);
  if (first < 0) throw new Error('JSON 블록을 찾지 못했습니다.');
  const openCh = candidate[first];
  const closeCh = openCh === '[' ? ']' : '}';
  const last = candidate.lastIndexOf(closeCh);
  if (last < 0) throw new Error('JSON 닫는 괄호를 찾지 못했습니다.');
  return JSON.parse(candidate.slice(first, last + 1));
}
