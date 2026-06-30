import { spawn } from 'child_process';
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

export function runHeadlessClaude(prompt, model = 'sonnet', allowedTools = 'Bash,Read,Glob,Grep,WebFetch') {
  return new Promise((resolve, reject) => {
    const cp = spawn('claude', [
      '-p', prompt,
      '--permission-mode', 'bypassPermissions',
      '--allowedTools', allowedTools,
      '--model', model,
      '--output-format', 'text',
    ], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { cp.kill('SIGKILL'); reject(new Error('헤드리스 타임아웃 (12분 초과)')); }, 12 * 60 * 1000);
    cp.stdout.on('data', d => { out += d; });
    cp.stderr.on('data', d => { err += d; });
    cp.on('error', e => { clearTimeout(timer); reject(e); });
    cp.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const clean = err.split('\n').filter(l => !/no stdin data received/i.test(l)).join('\n').trim();
        const detail = ((clean || out).trim().slice(-300)) || '(stderr/stdout 비어있음)';
        const e = new Error(`claude 종료코드 ${code}: ${detail}`);
        if (LIMIT_RE.test(detail)) {
          e.isLimit = true;
          setCooldown(parseResetTime(detail) ?? Date.now() + 3600_000, detail);
        }
        return reject(e);
      }
      if (!out.trim()) return reject(new Error('claude 빈 출력'));
      resolve(out);
    });
  });
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
