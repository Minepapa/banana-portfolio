#!/usr/bin/env node
/**
 * 주간 리포트 발행 — banana 직접 발행(2026-06-14 Trading Agent Cowork에서 이전)
 *
 * 원칙(risk-monitor.mjs와 동일): raw 숫자는 LLM이 만들지 않는다.
 *   ① Node가 모든 수치를 결정론적으로 조회(yfinance/OpenDart/시트) → report-facts로 조립
 *   ② claude -p 는 profile/investor-profile.md + 주입된 facts만으로 "서술·해석·처방"만 생성
 *      (가격·지수·환율·재무 수치 재조회 금지. WebSearch는 정성적 뉴스 맥락에만)
 *   ③ reports/weekly_report_YYYYMMDD.md 저장 + 주간리포트 시트 append + (선택)텔레그램 푸시
 *
 * 사용법:
 *   node scripts/jobs/weekly-report.mjs                 # 발행(OAuth/SA)
 *   node scripts/jobs/weekly-report.mjs --dry-run       # facts·프롬프트만 출력(시트/파일 미기록)
 *   node scripts/jobs/weekly-report.mjs --model=opus    # 서술 품질용(기본 opus)
 *   node scripts/jobs/weekly-report.mjs --no-push       # 텔레그램 요약 푸시 끔
 *   node scripts/jobs/weekly-report.mjs <TOKEN>         # launchd run.sh 무인 토큰 주입
 */

import {
  loadEnv, getToken, hasServiceAccount, getRange, appendValues, ensureSheet,
  readHoldings, runHeadlessClaude, nowKST, todayKST, sendTelegram, setValues, parseJsonBlock,
} from '../lib/sheets-common.mjs';
import {
  fetchKrFundamentals, fetchUsFundamentals, fetchKrMarketData, fetchMarketData, fetchMacroIndicators,
} from '../lib/fundamentals.mjs';
import { krCorpCode, usTicker, krStockCode } from '../lib/instruments.mjs';
import { buildReportFacts } from '../lib/report-facts.mjs';
import { buildBehaviorSignals } from '../lib/behavior-signals.mjs';
import { renderPrefRows, PREF_SHEET, findExpiredPromotions } from '../lib/preferences.mjs';
import { RISK_COL as R } from '../lib/sheet-contracts.mjs';
import { filterObservations, claimViolations } from '../lib/llm-guard.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { extractSummary } from './sync-reports.mjs';
import { writeFileSync, readdirSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE = new URL('../../profile/investor-profile.md', import.meta.url).pathname;
const PREF_HEADER = ['날짜', '신호유형', '관찰', '증거', '§3대비', '신뢰도', '상태', '갱신시각'];
const REPORTS_DIR = new URL('../../reports/', import.meta.url).pathname;
const REPORT_SHEET = '주간리포트';
const REPORT_HEADER = ['날짜', '요약', '본문'];
const STOCK_TYPES = new Set(['국내주식', '해외주식']);  // 라이브 펀더멘털 조회 대상(나머진 시트 현재가)
const ACCOUNTS = ['위탁', '연금저축', 'ISA', 'IRP'];
const FILE_RE = /^weekly_report_(\d{4})(\d{2})(\d{2})\.md$/;

const args = process.argv.slice(2);
const explicitToken = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');
const NO_PUSH = args.includes('--no-push');
const FORCE = args.includes('--force');  // 같은 날짜 시트 행이 있으면 덮어씀(재발행)
// 리포트 서사·성향 추출 모두 비서실(Apollo) 소관 — 에이전트 정의가 모델·원칙의 단일 진실 소스.
// 폴백은 호출부별 현행값 보존(본문 opus·성향 sonnet — 파일 손상 시 기존 동작 그대로).
// 우선순위: CLI --model= (리포트 본문에만 적용, 종전과 동일) > frontmatter > 폴백.
const APOLLO_REPORT = loadAgent('apollo', { fallbackModel: 'opus' });
const APOLLO_PREFS = loadAgent('apollo', { fallbackModel: 'sonnet' });
if (APOLLO_REPORT.warning) collectWarning(APOLLO_REPORT.warning);
const modelArg = args.find(a => a.startsWith('--model='));
const MODEL = modelArg ? modelArg.split('=')[1] : APOLLO_REPORT.model;

loadEnv();

// asof 기준 직전 7일(월~일 주간)을 커버하는 시작일.
function weekStartOf(asofYmd) {
  const d = new Date(`${asofYmd}T00:00:00+09:00`);
  d.setDate(d.getDate() - 6);
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

// reports/ 중 가장 최신(오늘 제외) 리포트 요약 → 직전 맥락.
function loadPrevReport(asofYmd) {
  let names;
  try { names = readdirSync(REPORTS_DIR); } catch { return null; }  // 디렉토리 미존재 등
  const files = names
    .map(n => { const m = n.match(FILE_RE); return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, file: n } : null; })
    .filter(Boolean).filter(f => f.date < asofYmd)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!files.length) return null;
  const md = readFileSync(join(REPORTS_DIR, files[0].file), 'utf8');
  return { date: files[0].date, summary: extractSummary(md) };
}

// 계좌 시트에서 종목명→{현재가(F·5), 평가액(H·7), 수량(D·3)} 맵.
// 자산 값의 정본 — 추정·재계산 금지(시트가 항상 최신 유지). 앱 parseSheetData와 동일 컬럼.
// 한 종목이 여러 계좌(예: 삼성전자 위탁+연금)에 걸치면 평가액·수량을 합산(readHoldings와 일치).
async function sheetValueMap(token) {
  const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[,%]/g, '')); return Number.isFinite(n) ? n : null; };
  const m = new Map();
  for (const acct of ACCOUNTS) {
    const rows = await getRange(token, `${acct}!A2:I`).catch(() => []);
    for (const r of rows) {
      const name = String(r[1] ?? '').trim();
      if (!name) continue;
      const price = num(r[5]), ev = num(r[7]), qty = num(r[3]);
      if (price == null && ev == null) continue;
      const cur = m.get(name) || { price: null, eval: null, qty: null };
      if (cur.price == null && price != null) cur.price = price;     // 현재가는 첫 유효값(계좌 무관 동일)
      if (ev != null) cur.eval = (cur.eval || 0) + ev;               // 평가액 합산
      if (qty != null) cur.qty = (cur.qty || 0) + qty;               // 수량 합산
      m.set(name, cur);
    }
  }
  return m;
}

function buildReportPrompt(factsText, asof, confirmedPrefsText) {
  return `[주간 자산 리포트 작성 — ${asof}] Frank를 위한 **맞춤형** 주간 자산 분석 리포트를 작성해줘.

먼저 \`${PROFILE}\` 파일(명시 성향)을 Read 로 읽어.
이 리포트는 그냥 시장 요약이 아니라 **Frank의 성향·계좌 구조를 아는 분석가가 쓰는 1:1 코칭 리포트**다.

[확정된 학습 성향 — 실제 행동에서 학습돼 Frank가 확인한 성향. §3와 함께 분석 기준으로 쓸 것.
 명시 성향(§3)과 학습 성향이 다르면 **드러난 행동(학습 성향)을 우선**.]
${confirmedPrefsText || '(아직 확정된 학습 성향 없음 — §3만 사용)'}

[검증된 facts — 시스템이 yfinance·OpenDart·시트에서 직접 조회·계산한 값. 이 수치만 사용.
 재조회·재계산·추정 금지. "데이터 부족"은 그대로 두고 지어내지 말 것.]
${factsText}

━━━ 이 리포트가 지켜야 할 4원칙 ━━━

【1. 가독성 — 스캔되는 글】
- 한 불릿에 수치 6~7개를 욱여넣지 말 것. **결론 먼저, 근거는 짧게.**
- 자산군 진단은 \`**🟢 국내주식 — (한 줄 결론)**\` 헤더 → 그 아래 짧은 근거 1줄 + \`내 판단:\` 1줄 구조.
- 긴 만연체 금지. 문장은 짧게 끊고, 핵심 수치만 굵게. 표는 그대로 활용하되 본문은 간결히.

【2. 정확한 수치 + 너의 시선】
- 모든 수치는 facts 값 그대로(가격·평가액·비중·등락·재무). 단위·부호 변형 금지.
- 그러나 **데이터 나열로 끝내지 말 것.** 각 섹션에 분석가로서의 \`내 판단:\` 또는 \`내 시선:\`을 명시적으로 넣어 — "이 수치가 Frank에게 뜻하는 바"와 분명한 입장(좋다/주의/행동)을 밝혀라. 애매한 양비론 금지.
- 리스크/포지션/평가 탭의 단순 재요약이 아니라, 그것들을 **종합·해석**해 한 주를 읽어내는 글.
- 리스크 신호 인용 시 facts의 유형 표기를 그대로: 논리(B)=매수논리 훼손, 거시(D)=거시 충격.
  facts에 없는 신호·종목 상태(예: "논리훼손", "미매도 지속")를 만들어 붙이지 말 것.

【3. Frank 성향·계좌 맞춤 (profile 적용)】
- 매수: 단기 급락 시 저점매수 선호 · 1회 500만원 미만 적립식 · 추격매수 비선호.
- 매도: 급락 후 빠른 반등 시 차익실현 · 과열 구간 일부 익절 패턴.
- 보유: 펀더멘털 훼손 없으면 단기 변동성 무시하고 장기 보유.
- 계좌 목적: 위탁=수비형 분산(리밸런싱 대상) / 연금저축·IRP=월 자동매수 적립(리밸런싱 비대상) / ISA=배당주 적립.
- 권고는 반드시 이 패턴에 맞춰라. 예: "Frank의 차익실현 성향상 …", "급락매수 선호에 부합 …", "추격매수는 성향과 안 맞으니 …".

【4. 맞춤형 — 내 포트폴리오 관점】
- 일반론 시장 코멘트 금지. 모든 시장 관찰을 **Frank의 특정 보유·계좌·목표에 연결**하라.
  (예: "USDKRW 1,517 → 환율 트리거상 해외주식 추가 확대 비우호 → 너의 차익실현 성향과 맞물려 테슬라 일부 익절 적기")
- WebSearch는 정성적 맥락(무슨 일이 있었나·일정)에만. 거기서 가져온 가격·지수·수치는 리포트에 쓰지 말 것(facts가 유일 수치 출처).

━━━ 구조 (마크다운) ━━━
# 주간 자산 종합 점검 — ${asof}

> 요약: (3줄·200자 이내, 이 라인 형식 그대로 제목 바로 아래)

## 🎯 이번 주 한눈에
- **가장 큰 변화**: (한 줄)
- **잘 가고 있는 것**: (한 줄)
- **주의·행동 필요**: (한 줄)

## 📊 자산 현황
- 총 평가액·총손익(원금 대비) + 계좌별 표 + 자산군 비중 표(목표 대비). 표는 간결히, 종목 전수 나열 금지.
- **내 판단:** 이번 주 자산 상태를 한두 줄로 평가(Frank 목표 대비 어디인지).

## 🌍 이번 주 시장 환경 (내 포트폴리오 관점)
- 핵심 이슈 1~2개 — 각 이슈를 "내 어느 자산/계좌에 어떻게"로 연결(일반론 금지).
- 지표 표: KOSPI·KOSDAQ·S&P500·나스닥·미10년물·USDKRW·금·WTI·VIX (facts 값 + 5일 변화).

## 🔍 자산군별 진단
국내주식·해외주식·채권·배당주·리츠·금·달러·현금성을 각각 아래 형식으로:
**🟢/🟡/🔴 {자산군} — (한 줄 결론)**
- 근거: 핵심 종목·수치 1줄(facts·리스크 신호·매수 논리). 전수 나열 금지.
- 내 판단: Frank 성향에 비춘 입장 1줄.

## ⚡ 이번 주 체결·배당
- facts의 체결·배당 정리(없으면 "없음") + 각 체결이 Frank 성향에 부합했는지 짧은 코멘트.

## 💡 다음 주 행동 (Frank 맞춤 처방)
- **⚠️ 즉시**: "지금 당장 X — [종목/금액/조건]". 근거 = 배분 갭 + 밸류 + 현금 여력 + **성향 적합성**. 없으면 "현 포지션 유지" + 이유.
- **🔵 조건부**: 가격/이벤트 트리거별 액션.
- **📅 다음 주 일정**: 실적·FOMC·지표(WebSearch 가능).
- **🟢 유지·관망**: 손대지 않을 자산군 + 이유 한 줄.

---
*결정론 데이터(시트·yfinance·OpenDart) 기반 자동 생성. 최종 결정은 Frank님이 직접.*

설명·머리말 없이 위 마크다운 리포트 본문만 출력. 첫 줄은 반드시 \`# 주간 자산 종합 점검\`.`;
}

// 성향 관찰 추출 프롬프트 — 결정론 행동 신호를 §3·직전 관찰과 대조해 관찰(JSON)만 뽑는다.
function buildObservationPrompt(signalsText, priorPrefsText) {
  return `[성향 관찰 추출] Frank의 이번 주 실제 행동 신호를 보고, 명시 성향과 비교해 "드러난 성향 관찰"을 뽑아줘.

먼저 \`${PROFILE}\` (§3 명시 성향)를 Read.

[직전까지 누적된 성향관찰 — 같은 관찰이 반복되는지 판단용]
${priorPrefsText || '(없음)'}

[결정론 행동 신호 — 시스템이 체결·평가·저널에서 산출. 이 사실만 근거로 쓸 것. 추정·날조 금지.]
${signalsText}

규칙:
- **증거가 있는 관찰만**. 신호에 없는 내용은 만들지 말 것. 뚜렷한 게 없으면 빈 배열.
- 각 관찰은 명시 성향(§3)과 대조: "일치(보강)" / "신규" / "상충".
- 직전 관찰에 같은 내용이 이미 있으면 promote=true(§3 승격 후보).
- 최대 3개. 사소한 건 버리고 의미 있는 것만.

금지(위반한 관찰은 시스템이 자동 폐기함):
- 신호유형 혼동 금지: B(논리)=매수 논리 훼손, O(가격)=급락 "매수 기회"(리스크 아님), D(거시)=거시 충격.
  O🔴을 리스크·미련·미매도로 해석하지 말 것.
- evidence에는 위 [결정론 행동 신호] 텍스트에 그대로 있는 문장·수치만 인용. 서로 다른 신호 줄을
  합쳐 새로운 인과(예: "원칙 위반 + 🔴 → 논리훼손 후 미매도")를 만들지 말 것.
- confidence는 높음|보통|낮음, vsProfile은 일치(보강)|신규|상충 만 사용.

출력: 설명 없이 \`\`\`json 배열 하나만.
\`\`\`json
[
  {"type":"매도 타이밍","observation":"과열 구간 부분 익절 실행","evidence":"체결 2026-06-12 SK하이닉스 5주 @2,280,000 +14%","vsProfile":"일치(보강)","confidence":"높음","promote":false}
]
\`\`\``;
}


// 관찰 JSON → 성향관찰 시트 행으로 append. 상충/promote면 상태=승격후보, 아니면 관찰.
async function appendObservations(token, asof, observations) {
  if (!observations?.length) return 0;
  const now = nowKST();
  const rows = observations.map(o => {
    const promote = o.promote || /상충/.test(o.vsProfile || '');
    return [
      asof, o.type || '기타', o.observation || '', o.evidence || '',
      o.vsProfile || '신규', o.confidence || '보통',
      promote ? '승격후보' : '관찰', now,
    ];
  });
  await appendValues(token, `${PREF_SHEET}!A2`, rows);
  return rows.length;
}

async function main() {
  console.log('📰 주간 리포트 발행 (결정론 facts → claude -p 서술)');
  if (DRY_RUN) console.log('   (--dry-run: facts·프롬프트만 출력)');

  let token = explicitToken?.trim() || null;
  if (!DRY_RUN || token || hasServiceAccount()) {
    console.log(token ? '✓ 토큰 인수 사용' : (hasServiceAccount() ? '\n🤖 서비스 계정 인증(무인)...' : '\n🔑 Google 인증 중...'));
    token = await getToken(token);
    console.log('✅ 토큰 준비');
    if (!DRY_RUN) await ensureSheet(token, REPORT_SHEET, REPORT_HEADER);
  }
  if (!token) { console.error('❌ 토큰 없이는 보유·시트 데이터를 읽을 수 없습니다.'); process.exit(1); }

  const asof = todayKST();
  const weekStart = weekStartOf(asof);

  // ① 거시지표 (결정론)
  console.log('\n⏳ 거시지표 조회(yfinance/네이버)...');
  const macro = fetchMacroIndicators();

  // ② 보유 종목 + 시트 자산 값(현재가·평가액·수량 정본)
  const holdings = await readHoldings(token);
  const sheetByName = await sheetValueMap(token);

  // ③ 개별주식만 분석 지표(52주위치·RSI·밸류에이션·펀더멘털) 조회. 자산 값(가격·평가액)은
  //    시트가 정본이라 여기서 재계산하지 않는다(추정 금지). ETF·채권·펀드·현금성은 시트값만 사용.
  console.log(`\n⏳ 개별주식 분석 지표 조회 (자산 값은 시트, 지표만 라이브)...`);
  const marketByName = new Map();
  const fundByName = new Map();
  for (const h of holdings) {
    const isStock = h.accounts.some(a => STOCK_TYPES.has(a.type));
    if (!isStock) continue;
    try {
      if (h.market === 'KR') {
        const sc = krStockCode(h.name);
        const mkt = sc ? fetchKrMarketData(sc) : null;
        if (mkt) marketByName.set(h.name, mkt);
        const cc = krCorpCode(h.name);
        if (cc) fundByName.set(h.name, await fetchKrFundamentals(cc, undefined, undefined, sc));
      } else {
        const tk = usTicker(h.name);
        if (tk) {
          marketByName.set(h.name, fetchMarketData(tk));
          fundByName.set(h.name, fetchUsFundamentals(tk));
        }
      }
      const s = sheetByName.get(h.name);
      console.log(`   · ${h.name}: 시트 현재가 ${s?.price ?? '없음'} · 평가액 ${s?.eval ?? '없음'} (지표 ${marketByName.has(h.name) ? 'OK' : '미조회'})`);
    } catch (e) {
      console.error(`   ⚠️ ${h.name} 지표 조회 실패: ${e.message}`);
    }
  }

  // ④ 시트 데이터 (리스크·기준선·노트·체결·배당·포지션저널)
  const [riskRows, baselineRows, noteRows, tradeRows, dividendRows, journalRows, prefRows] = await Promise.all([
    getRange(token, '리스크모니터!A2:H').catch(() => []),
    getRange(token, '리스크기준선!A2:J').catch(() => []),
    getRange(token, '종목투자노트!A2:U').catch(() => []),
    getRange(token, '체결내역!A2:M').catch(() => []),
    getRange(token, '배당금!A2:C').catch(() => []),
    getRange(token, '포지션저널!A2:P').catch(() => []),
    getRange(token, `${PREF_SHEET}!A2:H`).catch(() => []),
  ]);
  const prevReport = loadPrevReport(asof);

  // ⑤ facts 조립 + 행동 신호(성향 학습용) 산출 + 성향관찰 텍스트(소비/추출용)
  const { facts, factsText } = buildReportFacts({
    asof, weekStart, holdings, macro, sheetByName, marketByName, fundByName,
    riskRows, baselineRows, noteRows, tradeRows, dividendRows, prevReport,
  });
  const { signalsText } = buildBehaviorSignals({ asof, weekStart, tradeRows, noteRows, journalRows, riskRows });
  const confirmedPrefsText = renderPrefRows(prefRows, { confirmedOnly: true });  // 리포트에 주입(확정만)
  const priorPrefsText = renderPrefRows(prefRows);                               // 관찰 추출에 주입(기각 제외 전체)

  // ⑤-b LLM 환각 하네스용 결정론 집합(2026-07 성향관찰 사고 대응) — "이 텍스트에 없는 걸
  // 지어내지 말 것"을 코드로 검증하기 위한 실존 종목 화이트리스트 + B🔴(진짜 논리훼손) 목록.
  const universe = [...new Set([
    ...holdings.map(h => h.name),
    ...noteRows.map(r => String(r[1] ?? '').trim()),
    ...riskRows.map(r => String(r[R.TARGET] ?? '').trim()),
  ])].filter(Boolean);
  const bBreachNames = [...new Set(riskRows
    .filter(r => String(r[R.TYPE] ?? '').trim() === 'B' && String(r[R.SIGNAL] ?? '').includes('🔴'))
    .map(r => String(r[R.TARGET] ?? '').trim()))].filter(Boolean);
  const priorObsTexts = prefRows
    .filter(r => String(r[6] ?? '').trim() !== '기각')
    .map(r => String(r[2] ?? '').trim())
    .filter(Boolean);

  const prompt = buildReportPrompt(factsText, asof, confirmedPrefsText);
  if (DRY_RUN) {
    console.log('\n┌─── FACTS ───┐\n' + factsText + '\n└─────────────┘');
    console.log('\n┌─── 행동 신호(성향 학습) ───┐\n' + signalsText + '\n└─────────────┘');
    console.log('\n┌─── 확정 성향(리포트 주입) ───┐\n' + (confirmedPrefsText || '(없음)') + '\n└─────────────┘');
    console.log('\n┌─── PROMPT ───┐\n' + prompt + '\n└──────────────┘');
    console.log(`\n총 평가액: ${facts.totalEval != null ? Math.round(facts.totalEval).toLocaleString('en-US') + '원' : '데이터 부족'}`);
    return;
  }

  // ⑥ claude -p 서술 생성 (Read=프로필/직전리포트, WebSearch=정성 뉴스. Bash 제외 — 수치 재조회 차단)
  // 주1회 최고가치 산출물이라 쿨다운 사전 skip은 하지 않음(빈번한 저우선 잡이 막지 않도록).
  // 단 자신이 한도를 만나면 쿨다운은 설정되고, 이번 발행만 보류(정상 종료 — 한도 해제 후 수동/다음 재실행).
  console.log(`\n⏳ 리포트 작성 중 (claude -p ${MODEL}, 수 분)...`);
  let md;
  try {
    md = (await runHeadlessClaude(prompt, MODEL, 'Read,WebSearch', { appendSystemPrompt: APOLLO_REPORT.systemPrompt })).trim();
  } catch (e) {
    if (e.isLimit) { console.log(`   ⏳ 사용량 한도 → 이번 리포트 발행 보류(쿨다운 설정). 한도 해제 후 재실행하세요.`); process.exit(0); }
    throw e;
  }
  // LLM이 "이제 작성하겠습니다" 같은 머리말을 붙이는 경우 첫 H1(# ) 앞을 제거.
  const h1 = md.search(/^# /m);
  if (h1 > 0) { md = md.slice(h1); console.log('   ✂️ 머리말 제거(첫 # 제목 앞 잘라냄)'); }
  else if (h1 < 0) console.warn('   ⚠️ 마크다운 H1(#)을 찾지 못함 — 그대로 저장');

  // ⑥-b 경고성 사후검증(2026-07 사고 대응) — 리포트가 "논리훼손"을 언급한 종목이 실제
  // B🔴 목록에 없으면 텔레그램 경고만(리포트 차단·수정은 안 함 — 산문 자체를 고치는 건
  // 과도하고, facts는 이미 결정론 주입이라 이 검증은 최후의 안전망일 뿐).
  const reportClaims = claimViolations(md, /논리\s*훼손/, universe, bBreachNames);
  if (reportClaims.length) collectWarning(`주간리포트 자동검증: "논리훼손" 언급이 B🔴 신호와 불일치 — ${reportClaims.join(', ')}`);

  // ⑦ 파일 저장
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const fileName = `weekly_report_${asof.replace(/-/g, '')}.md`;
  writeFileSync(join(REPORTS_DIR, fileName), md, 'utf8');
  console.log(`   💾 저장: reports/${fileName}`);

  // ⑧ 시트 적재 (멱등 — 같은 날짜 있으면 건너뜀, --force면 그 행을 덮어씀)
  const colA = (await getRange(token, `${REPORT_SHEET}!A2:A`)).map(r => String(r[0] ?? '').trim());
  const summary = extractSummary(md);
  const existIdx = colA.indexOf(asof);
  if (existIdx >= 0 && !FORCE) {
    console.log(`   ℹ️ 시트에 ${asof} 이미 존재 — 적재 건너뜀 (재발행하려면 --force)`);
  } else if (existIdx >= 0 && FORCE) {
    const row = existIdx + 2;  // A2 기준
    await setValues(token, `${REPORT_SHEET}!A${row}:C${row}`, [[asof, summary, md]]);
    console.log(`   📊 주간리포트 시트 ${row}행 덮어씀 (--force 재발행)`);
  } else {
    await appendValues(token, `${REPORT_SHEET}!A2`, [[asof, summary, md]]);
    console.log(`   📊 주간리포트 시트 적재 완료`);
  }

  // ⑨ 텔레그램 요약 푸시
  if (!NO_PUSH) {
    try {
      await sendTelegram(`📰 <b>주간 리포트</b> · ${asof}\n\n${summary}\n\n<i>앱 리포트 탭에서 전문 확인</i>`);
      console.log('   📲 텔레그램 요약 푸시');
    } catch (e) { console.error(`   ⚠️ 텔레그램 실패: ${e.message}`); }
  }

  // ⑩ 성향 학습 — 행동 신호를 §3·직전 관찰과 대조해 관찰 추출(sonnet) → 성향관찰 시트 append.
  //    리포트 본문과 분리. 실패해도 리포트 발행은 성공 처리. 앱 성향 탭이 확정/기각.
  //    2026-07 사고(O🔴를 논리훼손으로 날조) 대응: LLM 응답을 그대로 안 쓰고 filterObservations로
  //    검증 — 사실 텍스트에 없는 종목 인용·논리훼손 오주장·중복은 시트에 절대 안 쓰고 DROP+경고.
  try {
    console.log(`\n⏳ 성향 관찰 추출 중 (claude -p ${APOLLO_PREFS.model})...`);
    await ensureSheet(token, PREF_SHEET, PREF_HEADER);  // 시트 없으면 생성(seed 미실행 대비)
    const obsRaw = parseJsonBlock(await runHeadlessClaude(buildObservationPrompt(signalsText, priorPrefsText), APOLLO_PREFS.model, 'Read', { appendSystemPrompt: APOLLO_PREFS.systemPrompt }));
    const { kept, dropped } = filterObservations(Array.isArray(obsRaw) ? obsRaw : [], {
      universe, factsText: signalsText, claimAllowed: bBreachNames, priorTexts: priorObsTexts, maxRows: 3,
    });
    dropped.forEach(d => collectWarning(`성향관찰 자동폐기: "${String(d.obs?.observation ?? '').slice(0, 60)}" — ${d.reason}`));
    const n = await appendObservations(token, asof, kept);
    console.log(n ? `   🧠 성향 관찰 ${n}건 기록 (성향관찰 시트 → 앱 성향 탭에서 확인)` : '   🧠 이번 주 뚜렷한 성향 관찰 없음');
    if (dropped.length) console.log(`   🛡 자동 검증 실패로 폐기 ${dropped.length}건(텔레그램 경고)`);
  } catch (e) { console.error(`   ⚠️ 성향 관찰 단계 실패(리포트는 정상): ${e.message}`); }

  // ⑩-b 승격후보 TTL(구조조정 안건5, 2026-07-19) — 4주 무응답이면 자동으로 관찰 보류.
  //     Zeus/Frank 확인 없이 무한정 대기 상태로 쌓이는 걸 방지. ⑩과 분리된 독립 단계 —
  //     관찰 추출이 실패해도 이 정리는 별개로 시도한다.
  //     경합 방지(code-reviewer 지적): prefRows는 main() 상단 스냅샷이라 ⑩(LLM 호출, 수 분 소요)
  //     사이 Frank가 앱에서 막 확정/기각했을 수 있다. 그 사이 변경을 놓치지 않도록 이 시점에
  //     시트를 다시 읽어 만료 판정한다 — 방금 확정된 행을 되돌려버리는 TOCTOU 방지.
  try {
    const freshPrefRows = await getRange(token, `${PREF_SHEET}!A2:H`).catch(() => prefRows);
    const expired = findExpiredPromotions(freshPrefRows, { now: new Date() });
    if (expired.length) {
      const results = await Promise.allSettled(
        expired.map(e => setValues(token, `${PREF_SHEET}!G${e.rowNum}:H${e.rowNum}`, [['관찰', nowKST()]])),
      );
      const ok = expired.filter((_, i) => results[i].status === 'fulfilled');
      const failed = expired.filter((_, i) => results[i].status === 'rejected');
      if (ok.length) console.log(`   ⏳ 승격후보 TTL 만료 ${ok.length}건 → 관찰로 자동 보류: ${ok.map(e => `"${e.obs.slice(0, 20)}"(${e.ageWeeks}주)`).join(', ')}`);
      if (failed.length) console.error(`   ⚠️ TTL 되돌리기 실패 ${failed.length}건(행: ${failed.map(e => e.rowNum).join(',')}) — 다음 주 재시도`);
      collectWarning(`성향관찰 승격후보 TTL 만료 ${ok.length}건 → 관찰 보류(4주 무응답)${failed.length ? `, 되돌리기 실패 ${failed.length}건` : ''}`);
    }
  } catch (e) { console.error(`   ⚠️ 승격후보 TTL 정리 실패(리포트는 정상): ${e.message}`); }

  await flushWarnings('weekly-report');
  console.log('\n🏁 주간 리포트 발행 완료');
}

main().catch(async (e) => {
  console.error('\n❌ 오류:', e.message);
  await flushWarnings('weekly-report').catch(() => {});
  process.exit(1);
});
