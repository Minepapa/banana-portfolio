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
 *   node scripts/weekly-report.mjs                 # 발행(OAuth/SA)
 *   node scripts/weekly-report.mjs --dry-run       # facts·프롬프트만 출력(시트/파일 미기록)
 *   node scripts/weekly-report.mjs --model=opus    # 서술 품질용(기본 opus)
 *   node scripts/weekly-report.mjs --no-push       # 텔레그램 요약 푸시 끔
 *   node scripts/weekly-report.mjs <TOKEN>         # launchd run.sh 무인 토큰 주입
 */

import {
  loadEnv, getToken, hasServiceAccount, getRange, appendValues, ensureSheet,
  readHoldings, runHeadlessClaude, nowKST, todayKST, sendTelegram, setValues,
} from './lib/sheets-common.mjs';
import {
  fetchKrFundamentals, fetchUsFundamentals, fetchKrMarketData, fetchMarketData, fetchMacroIndicators,
} from './lib/fundamentals.mjs';
import { krCorpCode, usTicker, krStockCode } from './lib/instruments.mjs';
import { buildReportFacts } from './lib/report-facts.mjs';
import { extractSummary } from './sync-reports.mjs';
import { writeFileSync, readdirSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROFILE = new URL('../profile/investor-profile.md', import.meta.url).pathname;
const REPORTS_DIR = new URL('../reports/', import.meta.url).pathname;
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
const modelArg = args.find(a => a.startsWith('--model='));
const MODEL = modelArg ? modelArg.split('=')[1] : 'opus';

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

function buildReportPrompt(factsText, asof) {
  return `[주간 포트폴리오 리포트 작성 — ${asof}] Frank의 주간 자산 종합 점검 리포트를 작성해줘.

먼저 \`${PROFILE}\` 파일을 Read 로 읽고 투자 프로필·계좌 구조·목표 배분·투자 성향·리밸런싱 트리거를 숙지해.

[검증된 facts — 시스템이 yfinance·OpenDart·시트에서 직접 조회·계산한 값. 이 수치만 사용할 것.
 절대 재조회·재계산·추정하지 말 것. "데이터 부족"은 그대로 두고 추정 금지.]
${factsText}

이 리포트의 목적은 리스크/포지션/평가 탭과 다르다. **이번 주 시장 환경 해석 · 자산군별 진단 · 다음 주 나의 행동 요약**이 핵심이다.
종목을 일일이 나열하지 말고 **자산군 단위로 진단**하되 핵심 종목만 근거로 언급한다. 자산 현황은 전체 나열 금지 — 주요 지표만 요약한다.

작성 규칙(엄수):
- 가격·지수·환율·금리·재무·평가액·수익률 등 **모든 수치는 위 facts 값 그대로 인용**. 단위·부호 변형 금지.
- WebSearch 는 **정성적 시장 맥락에만** 허용(예: 브로드컴 쇼크·FOMC 결과·실적 발표 일정·섹터 뉴스의 "무슨 일이 있었나").
  WebSearch 로 가져온 **가격·지수·환율·재무 수치는 리포트에 쓰지 말 것**(facts가 유일한 수치 출처).
- 리스크 신호(B/D)는 facts의 "리스크 신호" 값을 재인용. 가드레일 재계산 금지.
- 잔고·평가액은 facts의 평가액(시트 정본값) 그대로 사용. "추정" 표현 금지.

리포트 구조(마크다운 — 2026-06-07 발행 형식 준수):
# 주간 자산 종합 점검 — ${asof}

> 요약: (이번 주 핵심 2~3줄, 200자 이내 — 이 라인 형식 그대로 제목 바로 아래에 반드시 포함)

## 📊 자산 현황 요약
- **주요 지표만** 요약(전체 종목 나열 금지): 총 평가액·총수익(원금 대비)·계좌별 잔고(평가액) 한 표, 자산군별 비중 표(목표 대비).

## 🌍 이번 주 시장 환경
- 핵심 이슈 1~2개(정성, WebSearch 가능 — 무슨 일이 있었나)
- 지수(KOSPI·KOSDAQ·S&P500·나스닥)·금리(미10년물)·환율(USDKRW)·원자재(금·WTI)·VIX → facts 수치 + 5일 변화로 간결히

## 🔍 자산군별 진단
- 국내주식·해외주식·채권·배당주·리츠·금·달러·현금성을 **각각 🟢/🟡/🔴 + 1~3줄 진단**.
- 자산군 내 핵심 종목만 근거로 인용(facts 보유종목 값·리스크 신호·매수 논리 활용). 종목 전수 나열 금지.

## ⚡ 이번 주 체결 및 배당
- facts의 "이번 주 체결"·"이번 주 배당" 그대로 정리(없으면 "없음").

## 💡 다음 주 액션 포인트 (나의 행동 요약)
- **⚠️ 즉시 검토**: "지금 당장 X — [구체적 종목/금액/조건]" 1~2개. 배분 갭+밸류에이션+현금 여력 근거. 없으면 "현 포지션 유지" + 이유.
- **🔵 조건부 검토**: 가격/이벤트 조건부 액션.
- **📅 다음 주 일정**: 실적·FOMC·경제지표(WebSearch 가능).
- **🟢 유지·관망**: 손대지 않을 자산군 요약.

---
*본 리포트는 결정론 데이터(시트·yfinance·OpenDart) 기반 자동 생성. 투자 최종 결정은 Frank님이 직접.*

설명·머리말 없이 위 마크다운 리포트 본문만 출력할 것.`;
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

  // ④ 시트 데이터 (리스크·기준선·노트·체결·배당)
  const [riskRows, baselineRows, noteRows, tradeRows, dividendRows] = await Promise.all([
    getRange(token, '리스크모니터!A2:H').catch(() => []),
    getRange(token, '리스크기준선!A2:J').catch(() => []),
    getRange(token, '종목투자노트!A2:U').catch(() => []),
    getRange(token, '체결내역!A2:M').catch(() => []),
    getRange(token, '배당금!A2:C').catch(() => []),
  ]);
  const prevReport = loadPrevReport(asof);

  // ⑤ facts 조립
  const { facts, factsText } = buildReportFacts({
    asof, weekStart, holdings, macro, sheetByName, marketByName, fundByName,
    riskRows, baselineRows, noteRows, tradeRows, dividendRows, prevReport,
  });

  const prompt = buildReportPrompt(factsText, asof);
  if (DRY_RUN) {
    console.log('\n┌─── FACTS ───┐\n' + factsText + '\n└─────────────┘');
    console.log('\n┌─── PROMPT ───┐\n' + prompt + '\n└──────────────┘');
    console.log(`\n총 평가액: ${facts.totalEval != null ? Math.round(facts.totalEval).toLocaleString('en-US') + '원' : '데이터 부족'}`);
    return;
  }

  // ⑥ claude -p 서술 생성 (Read=프로필/직전리포트, WebSearch=정성 뉴스. Bash 제외 — 수치 재조회 차단)
  console.log(`\n⏳ 리포트 작성 중 (claude -p ${MODEL}, 수 분)...`);
  let md = (await runHeadlessClaude(prompt, MODEL, 'Read,WebSearch')).trim();
  // LLM이 "이제 작성하겠습니다" 같은 머리말을 붙이는 경우 첫 H1(# ) 앞을 제거.
  const h1 = md.search(/^# /m);
  if (h1 > 0) { md = md.slice(h1); console.log('   ✂️ 머리말 제거(첫 # 제목 앞 잘라냄)'); }
  else if (h1 < 0) console.warn('   ⚠️ 마크다운 H1(#)을 찾지 못함 — 그대로 저장');

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

  console.log('\n🏁 주간 리포트 발행 완료');
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
