#!/usr/bin/env node
/**
 * 리스크 모니터 — AI 리스크 엔진 Phase 4
 *
 * 두 모드로 동작, 결과를 `리스크모니터` 탭에 적재한다.
 *   --mode=B (주1회): 보유종목별 펀더멘털을 재조회해 저장된 기준선/매수논리 대비 "논리 훼손" 판단.
 *                     가드레일: 영업이익 YoY 2분기 연속 감소·가이던스 하향·FCF 적자전환·부채 급증은
 *                     강제 🟡 이상. 단순 가격 과열(52주/RSI)은 단독 신호로 쓰지 않음(Frank 철학).
 *   --mode=D (매일): USDKRW·미10년물·VIX·KOSPI·S&P 조회 → profile/investor-profile.md §4 거시 트리거 대조
 *                    → Frank 보유 포지션/자산군에 연결된 영향만 산출.
 *
 * `리스크모니터` 스키마(8열):
 *   날짜 | 유형(B/D) | 대상 | 신호(🟢🟡🔴) | 요약 | 상세 | 근거데이터(JSON) | 기준선참조
 *
 * 사용법:
 *   node scripts/jobs/risk-monitor.mjs --mode=D            # 거시 리스크 (매일)
 *   node scripts/jobs/risk-monitor.mjs --mode=B            # 논리 훼손 (주1회)
 *   node scripts/jobs/risk-monitor.mjs --mode=D --dry-run  # 프롬프트만 출력
 *   node scripts/jobs/risk-monitor.mjs --mode=B --model=opus
 *   node scripts/jobs/risk-monitor.mjs --mode=D <TOKEN>    # OAuth 대신 토큰 직접 전달
 *   node scripts/jobs/risk-monitor.mjs --mode=B --no-push  # 🔴 텔레그램 푸시 끔
 *
 * 🔴 신호는 텔레그램으로 즉시 푸시(신규만 — 같은 유형·대상의 직전 🔴 는 중복 발송 안 함).
 * 🟡🟢 는 푸시하지 않음(시트 기록만).
 */

import {
  loadEnv, getToken, hasServiceAccount, getRange, appendValues, ensureSheet,
  readHoldings, runHeadlessClaude, parseJsonBlock, nowKST,
  sendTelegram, setValues, clearValues, cooldownActive,
} from '../lib/sheets-common.mjs';
import { renderPrefRows, prefBlock, PREF_SHEET } from '../lib/preferences.mjs';
import { fetchKrFundamentals, fetchUsFundamentals, checkGuardrails, fetchMacroIndicators, fetchMarketData, fetchKrMarketData } from '../lib/fundamentals.mjs';
import { krCorpCode, usTicker, krStockCode } from '../lib/instruments.mjs';
import { extractSignal, clampLen } from '../lib/llm-guard.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';

const RISK_SHEET = '리스크모니터';
const RISK_HEADER = ['날짜', '유형', '대상', '신호', '요약', '상세', '근거데이터', '기준선참조'];
const BASELINE_SHEET = '리스크기준선';
// 투자 성향 정본 — Trading Agent Hub에서 이전(2026-06-14). 거시 트리거(§4)·계좌배분(§2)이 여기 있음.
const HUB_CLAUDE = new URL('../../profile/investor-profile.md', import.meta.url).pathname;
const KOSPI_CRASH_PCT = -10;  // KOSPI 5일 고점 대비 낙폭 임계 — 이하면 LLM 판단 무관 🔴 강제 푸시
const USDKRW_SURGE_PCT = 3;   // USDKRW 5일 저점 대비 상승 임계 — KRW 급약세 결정론 경보
const SP500_CRASH_PCT = -7;   // SP500 5일 고점 대비 낙폭 임계 — 미증시 급락 결정론 경보

// §4 개별 종목 가격 트리거 임계 (결정론) — 급락 매수 기회만.
// ⚠️ 급등 차익실현(52주/RSI 고점) 트리거는 제거됨: Frank 철학상 가격 상승은 매도 신호가 아니다
//    (과열 익절은 본인 재량). 매도 검토는 펀더멘털 훼손(B 모드)에서만 나온다.
const OPP_BUY_DROP_PCT = -10; // 단기(5거래일) 등락 ≤ -10% → 급락 매수 기회
const OPP_RSI_LOW = 30;       // RSI ≤ 30 → 과매도(급락 매수 기회)

const args = process.argv.slice(2);
const explicitToken = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');
const NO_PUSH = args.includes('--no-push');
const modeArg = args.find(a => a.startsWith('--mode='));
const MODE = modeArg ? modeArg.split('=')[1].toUpperCase() : '';
// 리스크 감시(거시 D·논리훼손 B 모두)는 리스크관리실(Themis) 소관 — 에이전트 정의가 모델·
// 판단원칙의 단일 진실 소스. 우선순위: CLI --model= > frontmatter > 폴백. 손상 시 경고는
// 로그로 표면화(run.sh가 로그 꼬리를 잡상태 detail에 넣음 — 이 잡은 job-alerts 미사용).
const AGENT = loadAgent('themis', { fallbackModel: 'sonnet' });
if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
const modelArg = args.find(a => a.startsWith('--model='));
const MODEL = modelArg ? modelArg.split('=')[1] : AGENT.model;
// 특정 종목만 재점검(예: 계산 로직 수정 후 해당 종목만 재계산) — 전체 배치 재실행으로 인한
// 불필요한 LLM 호출 낭비를 피한다. mode=B 전용.
const onlyArg = args.find(a => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1] : null;

loadEnv();

if (!['B', 'D'].includes(MODE)) {
  console.error('❌ --mode=B 또는 --mode=D 를 지정하세요.');
  process.exit(1);
}

// 보유 포지션 요약 텍스트 (헤드리스 프롬프트용)
function holdingsSummary(holdings) {
  if (!holdings.length) return '(보유종목 없음)';
  // 자산군별 집계
  const byType = {};
  let krInvest = 0, usInvest = 0;
  for (const h of holdings) {
    const invest = h.accounts.reduce((s, a) => s + (a.invest || 0), 0);
    byType[h.type || '기타'] = (byType[h.type || '기타'] || 0) + invest;
    if (h.market === 'US') usInvest += invest; else krInvest += invest;
  }
  const total = krInvest + usInvest || 1;
  const typeLines = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, v]) => `  - ${t}: ${Math.round(v / total * 100)}%`)
    .join('\n');
  const names = holdings.map(h => h.name).join(', ');
  return `자산군 비중:\n${typeLines}\n  - 국내 ${Math.round(krInvest / total * 100)}% / 해외 ${Math.round(usInvest / total * 100)}%\n보유종목: ${names}`;
}

// ── D 모드: 거시 리스크 프롬프트 ────────────────────────
// 거시지표 숫자는 Node(fetchMacroIndicators)가 yfinance에서 직접 조회·계산해 주입한다.
// LLM은 재조회 금지 — 주입된 수치를 Hub 트리거 기준과 비교해 "판단만". (mode B와 동일 원칙)
// 개별 종목 시세(md) → §4 급락 매수 기회만 판정. 결정론(LLM 무관). 트리거 없으면 🟢(자가 치유용).
// 가격 상승(52주/RSI 고점)은 매도/차익 신호로 쓰지 않는다(Frank 철학 — 펀더멘털 우선).
function scanOpportunity(md) {
  if (!md) return null;
  const { rsi14, pos52w, weekChange, currentPrice } = md;
  const ev = JSON.stringify({ rsi14, pos52w, weekChange, currentPrice });
  // 급락 매수 기회 — 성향(급락매수 선호) 부합 → 🔴
  const dropHit = weekChange != null && weekChange <= OPP_BUY_DROP_PCT;
  const rsiLow = rsi14 != null && rsi14 <= OPP_RSI_LOW;
  if (dropHit || rsiLow) {
    const why = [dropHit ? `5일 ${weekChange}%` : null, rsiLow ? `RSI ${rsi14}` : null].filter(Boolean).join(' · ');
    return { signal: '🔴', summary: `급락 매수 기회 — ${why}`,
      detail: '§4 급락 매수 기회 트리거(단기 -10% 또는 RSI 30↓). Frank 급락매수 선호와 부합 — 펀더멘털 유효 시 적극 매수 검토(1회 500만원 이하).', ev };
  }
  // 트리거 없음 — 🟢(이전 기회 신호 자가 해소용). 앱은 🟢 기회는 숨김.
  return { signal: '🟢', summary: '가격 트리거 없음',
    detail: '', ev: JSON.stringify({ rsi14, pos52w, weekChange }) };
}

function buildMacroPrompt(holdings, indicators, confirmedPrefsText) {
  return `[거시 리스크 점검 — 매일] Frank 포트폴리오에 대한 거시 충격(D 유형) 리스크를 "판단만" 해줘.

먼저 \`${HUB_CLAUDE}\` 파일을 Read 로 읽고 거시 트리거 기준(환율/금리/VIX 임계값 등)을 확인해.

[검증된 거시지표 — 시스템이 yfinance에서 직접 조회·계산한 값. 이 수치만 사용할 것.
 절대 재조회·재계산·추정하지 말 것. null 은 "데이터 없음"이며 불리하게 해석하지 말 것]
${JSON.stringify(indicators, null, 1)}

[Frank 포트폴리오]
${holdingsSummary(holdings)}

${prefBlock(confirmedPrefsText)}

판단 규칙:
- 위 검증된 수치를 Hub CLAUDE.md 거시 트리거 기준과 비교해, 해당하면 그 자산군/종목 대상으로 신호 생성.
- 일반적 지표 나열 금지 — 반드시 "Frank의 어느 자산군/포지션에 어떻게" 영향인지 매핑.
- 신호 없으면(트리거 미발동) signals 빈 배열로.
- 가격 과열 단독은 리스크로 쓰지 않음(펀더멘털 우선 철학).
- summary·detail에 쓰는 모든 숫자는 위 JSON 값 그대로 인용(단위·부호 변형 금지).
- signal 값은 🟢|🟡|🔴 셋 중 하나만(그 외 값은 시스템이 🟡로 강등). target은 위 [Frank 포트폴리오]에
  실존하는 자산군/종목명만 — 새 이름 금지.

출력: 설명 없이 \`\`\`json 블록 하나만. (지표 숫자는 시스템이 이미 기록하므로 다시 적지 말 것)
\`\`\`json
{
  "date": "${nowKST()}",
  "signals": [
    {"target":"해외주식(US 익스포저)","signal":"🟡","summary":"한줄 요약","detail":"무엇이 어떻게 바뀌어 어느 포지션에 영향"}
  ]
}
\`\`\``;
}

// 거시지표 {value, change5d} → 표시 문자열. 금리(TNX)는 %, 나머지는 콤마+소수 2자리.
function fmtMacro(key, o) {
  if (!o || o.value == null) return '데이터 없음';
  const v = key === 'TNX'
    ? `${o.value.toFixed(3)}%`
    : o.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const c = o.change5d == null ? '' : ` (5d ${o.change5d >= 0 ? '+' : ''}${o.change5d}%)`;
  // 인트라-윈도우 낙폭/급등도 표기 — 가드레일과 LLM이 같은 수치를 보게 함.
  const dd = key === 'KOSPI' && o.drawdown5d != null ? ` [고점대비 ${o.drawdown5d}%]` : '';
  const sp = key === 'SP500' && o.drawdown5d != null ? ` [고점대비 ${o.drawdown5d}%]` : '';
  const fx = key === 'USDKRW' && o.rally5d != null ? ` [저점대비 +${o.rally5d}%]` : '';
  const band = key === 'USDKRW' && o.bands ? ` [밴드 ${o.bands.lower}~${o.bands.upper}, z=${o.bands.zscore}]` : '';
  return v + c + dd + sp + fx + band;
}

// ── B 모드: 논리 훼손 프롬프트 (종목별) — 판단 전용 ─────────────────
// 숫자는 Node가 OpenDart/yfinance에서 조회·계산해 주입한다. LLM은 재조회·재계산 금지,
// 주입된 수치로 "전제가 깨졌는가"만 판단. (환각 차단의 핵심: raw 숫자는 LLM이 만들지 않음)
function buildLogicPrompt(h, facts, guardrails, baseline, buyCard, confirmedPrefsText) {
  const baseLine = baseline
    ? `[저장된 기준선 (${baseline.date})]
매출총이익률 ${baseline.gross_margin} · 영업이익률 ${baseline.operating_margin} · ROE ${baseline.roe} · 부채비율 ${baseline.debt_ratio} · EPS ${baseline.eps} · PBR ${baseline.pbr || '데이터 부족'}
(${baseline.note || ''})`
    : '[저장된 기준선] 없음 — 주입된 펀더멘털만으로 절대 평가';
  const cardLine = buyCard
    ? `[매수 논리 (${buyCard.date})]
결론: ${buyCard.conclusion}
근거: ${(buyCard.reasons || []).join(' / ') || '(미기록)'}
리스크: ${(buyCard.risks || []).join(' / ') || '(미기록)'}`
    : '[매수 논리] 종목투자노트에 없음 — 기준선 대비 변화만 판단';

  return `[논리 훼손 점검 — 주간] 보유종목의 매수 논리가 펀더멘털상 훼손됐는지 "판단만" 해줘.

종목: ${h.name} (${h.market})

[검증된 펀더멘털 — 시스템이 ${facts.source}에서 직접 조회·계산한 값. 이 수치만 사용할 것.
 절대 재조회·재계산·추정하지 말 것. null 은 "데이터 없음"이며 불리하게 해석하지 말 것]
${JSON.stringify(facts, null, 1)}

[가드레일 사전판정(시스템 계산)] ${guardrails.length ? guardrails.join(' · ') + ' → 신호는 최소 🟡' : '트리거 없음'}

${baseLine}

${cardLine}

${prefBlock(confirmedPrefsText)}

판단 규칙:
- 위 검증된 수치와 기준선/매수논리를 비교해 "매수 근거의 핵심 전제가 깨졌는가"만 판단.
- 신호: 🟢 논리 유효 / 🟡 약화·주의 / 🔴 훼손(매도 평가 필요)
- 단순 주가 하락·52주/RSI 과열은 단독 신호 금지(펀더멘털 우선).
- summary·detail에 쓰는 모든 숫자는 위 JSON 값 그대로 인용(단위·부호 변형 금지).
- signal 값은 🟢|🟡|🔴 셋 중 하나만 출력(그 외 값은 시스템이 🟡로 강등).

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{"signal":"🟢","summary":"한줄","detail":"무엇이 어떻게 바뀌었나(기준선 대비)"}
\`\`\``;
}

// 종목투자노트에서 최신 매수 카드 조회 (status 매도 제외)
function findBuyCard(noteRows, name) {
  const matches = [];
  (noteRows || []).forEach((r) => {
    if (String(r[1] ?? '').trim() !== name) return;
    if (String(r[14] ?? '').trim() === '매도') return;
    matches.push({
      date: String(r[0] ?? '').trim(),
      conclusion: String(r[4] ?? '').trim(),
      reasons: String(r[10] ?? '').split(/\d+\)\s*/).filter(Boolean).map(s => s.trim()),
      risks: String(r[11] ?? '').split(/\d+\)\s*/).filter(Boolean).map(s => s.trim()),
    });
  });
  matches.sort((a, b) => b.date.localeCompare(a.date)); // 최신 우선
  return matches[0] || null;
}

function baselineMap(rows) {
  const m = new Map();
  for (const r of (rows || [])) {
    const name = String(r[0] ?? '').trim();
    if (!name) continue;
    m.set(name, {
      name, ticker: r[1], market: r[2], date: r[3],
      gross_margin: r[4], operating_margin: r[5], roe: r[6],
      debt_ratio: r[7], eps: r[8], pbr: r[9], note: r[10],
    });
  }
  return m;
}

// 기존 리스크모니터 행에서 직전 🔴 (유형|대상) 키 수집 → 신규 🔴 만 푸시
function redKeysFromRows(rows) {
  const s = new Set();
  for (const r of (rows || [])) {
    if (String(r[3] ?? '').includes('🔴')) s.add(`${r[1]}|${r[2]}`);
  }
  return s;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 신규 🔴 행만 텔레그램 푸시. priorRedKeys 를 변형해 같은 실행 내 중복도 차단.
async function pushNewReds(rows, priorRedKeys) {
  if (NO_PUSH) return;
  for (const row of rows) {
    const [date, type, target, signal, summary, detail] = row;
    if (!String(signal).includes('🔴')) continue;
    const key = `${type}|${target}`;
    if (priorRedKeys.has(key)) continue;
    priorRedKeys.add(key);
    const typeLabel = type === 'D' ? '거시 충격' : '논리 훼손';
    const text = `🔴 <b>리스크 경보</b> · ${typeLabel}\n`
      + `<b>${escapeHtml(target)}</b>\n`
      + `${escapeHtml(summary || '')}\n`
      + (detail ? `\n${escapeHtml(String(detail).slice(0, 300))}\n` : '')
      + `\n<i>${date}</i>`;
    try { await sendTelegram(text); console.log(`      📲 텔레그램 푸시: ${target}`); }
    catch (e) { console.error(`      ⚠️ 텔레그램 실패: ${e.message}`); }
  }
}

// Sheets 날짜 시리얼(USER_ENTERED로 저장된 숫자) 또는 날짜 문자열 → YYYY-MM-DD.
// 문자열 비교에서 시리얼 "4xxxx" > "2026-..." 오판을 방지.
function normDate(v) {
  const s = String(v ?? '').trim();
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    return new Date((parseFloat(s) - 25569) * 86400 * 1000).toISOString().slice(0, 10);
  }
  return s.slice(0, 10);
}

// 시트는 append-only 라 매 실행 누적된다. 리스크 탭 표시 기준과 동일하게 정리:
// 가장 최근 날짜의 거시(D) + 위탁 개별주식 B 최신 1건만 남기고 오래된 D·중복 행 제거.
// (D·B 어느 모드가 돌든 양쪽 유효분을 보존하므로 멱등.)
async function pruneRiskSheet(token, monitoredNames) {
  const rows = await getRange(token, `${RISK_SHEET}!A2:H`);
  if (rows.length === 0) return;
  // 가드: 보유목록이 비어 읽혔으면(일시적 under-read) B행 전량이 "미보유"로 보여 몽땅
  // 프루닝된다 — 펀드 축소 사고(2026-07)와 동일 패턴. 이번 실행은 정리 스킵.
  if (!monitoredNames || monitoredNames.size === 0) {
    console.log('  ⚠ 보유종목 0건으로 읽힘 — under-read 의심, 시트 정리 스킵');
    return;
  }
  const maxDDate = rows.reduce((mx, r) => {
    if (String(r[1] ?? '').trim() !== 'D') return mx;
    const d = normDate(r[0]); return d > mx ? d : mx;
  }, '');
  const keepIdx = new Set();
  const seen = new Set();
  for (let i = rows.length - 1; i >= 0; i--) {   // 최신(아래)부터
    const date = normDate(rows[i][0]);
    const type = String(rows[i][1] ?? '').trim();
    const target = String(rows[i][2] ?? '').trim();
    if (type === 'D') { if (date !== maxDDate) continue; }
    else if (type === 'B') { if (!monitoredNames.has(target)) continue; }
    else if (type === 'O') { /* 종목당 최신 O 1개 유지(아래 seen 디듀프). 🟢 포함 — 자가 치유 */ }
    else continue;
    const k = `${type}|${target}`;
    if (seen.has(k)) continue;
    seen.add(k); keepIdx.add(i);
  }
  if (keepIdx.size === rows.length) return;   // 정리할 것 없음
  // 서킷브레이커(재앙 규모만): monitoredNames가 검증된 비어있지 않은 보유(readHoldings가
  // 0건이면 throw)에서 왔으므로 정상 대량 프루닝은 정당하다 — 고정 카운트로 막으면 대량
  // 매도 후 프루닝이 영구 스킵됨(리뷰 지적). 최신 D행은 항상 유지되므로 kept=0으로 채워진
  // 시트를 비우는 경우만 이상 신호로 본다.
  const removed = rows.length - keepIdx.size;
  if (keepIdx.size === 0 && rows.length > 5) {
    console.log(`  ⚠ 정리 결과 0행(기존 ${rows.length}행 전체 제거) — 이상 신호, 정리 스킵`);
    return;
  }
  const kept = rows.filter((_, i) => keepIdx.has(i))
    .map(r => { const x = r.slice(0, 8); while (x.length < 8) x.push(''); return x; });
  // kept를 먼저 쓰고 남는 꼬리만 clear — clear→set 순서였을 때 set 실패 시 시트가 통째로
  // 비어버리는 파괴적 실패 제거(완전 원자성은 아니나 잔여 실패는 다음 실행이 자가 치유).
  if (kept.length) await setValues(token, `${RISK_SHEET}!A2`, kept);
  await clearValues(token, `${RISK_SHEET}!A${2 + kept.length}:H`);
  console.log(`🧹 시트 정리: ${rows.length} → ${kept.length}행 (-${removed})`);
}

async function main() {
  console.log(`🛡️  리스크 모니터 — 모드 ${MODE} (${MODE === 'D' ? '거시/일간' : '논리훼손/주간'})`);
  if (DRY_RUN) console.log('   (--dry-run: 프롬프트만 출력)');

  let token = explicitToken?.trim() || null;
  if (!DRY_RUN) {
    if (token) console.log('✓ 토큰 인수 사용');
    else console.log(hasServiceAccount() ? '\n🤖 서비스 계정 인증(무인)...' : '\n🔑 Google 인증 중...');
    token = await getToken(token);
    console.log('✅ 토큰 준비');
    await ensureSheet(token, RISK_SHEET, RISK_HEADER);
  }

  // dry-run 이면서 토큰 없으면 보유종목을 읽을 수 없음 → 빈 목록으로 프롬프트 형태만 확인
  const holdings = (token) ? await readHoldings(token) : [];

  // 확정 성향 — 거시(D)·논리(B) 판단 모두에 주입("Frank 맞춤 판단"). 명시 성향과 함께 기준.
  // sheets-common getRange 는 배열을 직접 반환(drain 의 {values} 와 다름).
  const prefRows = token ? await getRange(token, `${PREF_SHEET}!A2:H`).catch(() => []) : [];
  const confirmedPrefsText = renderPrefRows(prefRows, { confirmedOnly: true });

  // 논리훼손(B) 점검·시트 정리 대상 = 위탁계좌 개별주식(국내/해외).
  const STOCK_TYPES = new Set(['국내주식', '해외주식']);
  const monitoredNames = new Set(
    holdings.filter(h => h.accounts.some(a => a.acct === '위탁' && STOCK_TYPES.has(a.type))).map(h => h.name),
  );

  // 기존 리스크모니터의 직전 행 + 🔴 키
  const priorRows = (token && !NO_PUSH)
    ? await getRange(token, `${RISK_SHEET}!A2:H`) : [];
  const priorRedKeys = redKeysFromRows(priorRows);

  if (MODE === 'D') {
    // ① Node가 거시지표를 yfinance에서 직접 조회·계산(결정론). LLM은 이 숫자만 보고 판단.
    console.log(`\n⏳ 거시지표 조회 중 (yfinance — 결정론)...`);
    const macro = fetchMacroIndicators();
    const indicators = Object.fromEntries(Object.entries(macro).map(([k, o]) => [k, fmtMacro(k, o)]));
    Object.entries(indicators).forEach(([k, v]) => console.log(`   · ${k}: ${v}`));
    const evidenceBase = JSON.stringify(indicators);  // 근거데이터 = Node 숫자(LLM 아님)

    // 결정론 가드레일: KOSPI 5일 고점 대비 낙폭이 임계 이하면 LLM 판단을 거치지 않고 🔴 강제.
    // LLM 호출 실패·완화 판정에 무관하게 급락 경보가 반드시 나가도록 보장(끝점비교 누락도 방지).
    const dd = macro.KOSPI?.drawdown5d;
    if (!DRY_RUN && dd != null && dd <= KOSPI_CRASH_PCT) {
      const crashRow = [
        nowKST(), 'D', '국내주식(KOSPI)', '🔴',
        `KOSPI 5일 고점 대비 ${dd}% 급락 (현재 ${macro.KOSPI.value?.toLocaleString('en-US') ?? macro.KOSPI.value})`,
        `결정론 가드레일: 최근 5거래일 고점 대비 낙폭 ${dd}% ≤ ${KOSPI_CRASH_PCT}% — LLM 판단 무관 강제 경보. 급락 매수 기회 점검 필요.`,
        evidenceBase, '',
      ];
      console.log(`   ⚑ KOSPI 급락 가드레일 발동: ${dd}% → 🔴 강제`);
      await appendValues(token, `${RISK_SHEET}!A2`, [crashRow]);
      await pushNewReds([crashRow], priorRedKeys);
    }

    const fx5d = macro.USDKRW?.rally5d;
    if (!DRY_RUN && fx5d != null && fx5d >= USDKRW_SURGE_PCT) {
      const fxRow = [
        nowKST(), 'D', '환율(USDKRW)', '🔴',
        `USDKRW 5일 저점 대비 +${fx5d}% 급등 — KRW 급약세 (현재 ${macro.USDKRW.value?.toFixed(2) ?? macro.USDKRW.value})`,
        `결정론 가드레일: 최근 5거래일 저점 대비 상승폭 ${fx5d}% ≥ ${USDKRW_SURGE_PCT}% — KRW 약세 급등 경보. 환노출 포지션 점검 필요.`,
        evidenceBase, '',
      ];
      console.log(`   ⚑ USDKRW 급등 가드레일 발동: +${fx5d}% → 🔴 강제`);
      await appendValues(token, `${RISK_SHEET}!A2`, [fxRow]);
      await pushNewReds([fxRow], priorRedKeys);
    }

    // 볼린저 밴드 가드레일: 12개월 MA ± 2σ 돌파 시 결정론 경보 (고정 임계값 대체)
    const fxBands = macro.USDKRW?.bands;
    const todayDate = nowKST().slice(0, 10);
    const hasBandRowToday = priorRows.some(r => normDate(r[0]) === todayDate && String(r[1]) === 'D' && String(r[2]).includes('USDKRW') && String(r[4]).includes('밴드'));
    if (!DRY_RUN && fxBands && fxBands.sigma > 0 && !hasBandRowToday) {
      const fxVal = macro.USDKRW.value;
      if (fxVal > fxBands.upper) {
        const bandRow = [
          nowKST(), 'D', '환율(USDKRW)', '🔴',
          `USDKRW ${fxVal?.toFixed(0)} — 12개월 상단밴드(${fxBands.upper}) 돌파 (z=${fxBands.zscore})`,
          `결정론 가드레일: 12개월 MA ${fxBands.ma} + 2σ(${fxBands.sigma}) = ${fxBands.upper} 상회. 달러 자산 축소 검토.`,
          evidenceBase, '',
        ];
        console.log(`   ⚑ USDKRW 볼린저 상단 돌파: ${fxVal?.toFixed(0)} > ${fxBands.upper} (z=${fxBands.zscore}) → 🔴`);
        await appendValues(token, `${RISK_SHEET}!A2`, [bandRow]);
        await pushNewReds([bandRow], priorRedKeys);
      } else if (fxVal < fxBands.lower) {
        const bandRow = [
          nowKST(), 'D', '환율(USDKRW)', '🟡',
          `USDKRW ${fxVal?.toFixed(0)} — 12개월 하단밴드(${fxBands.lower}) 하회 (z=${fxBands.zscore})`,
          `결정론 가드레일: 12개월 MA ${fxBands.ma} - 2σ(${fxBands.sigma}) = ${fxBands.lower} 하회. 달러 자산 확대 기회.`,
          evidenceBase, '',
        ];
        console.log(`   ⚑ USDKRW 볼린저 하단 이탈: ${fxVal?.toFixed(0)} < ${fxBands.lower} (z=${fxBands.zscore}) → 🟡`);
        await appendValues(token, `${RISK_SHEET}!A2`, [bandRow]);
      }
    }

    const sp5d = macro.SP500?.drawdown5d;
    if (!DRY_RUN && sp5d != null && sp5d <= SP500_CRASH_PCT) {
      const spRow = [
        nowKST(), 'D', '미증시(SP500)', '🔴',
        `SP500 5일 고점 대비 ${sp5d}% 급락 (현재 ${macro.SP500.value?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? macro.SP500.value})`,
        `결정론 가드레일: 최근 5거래일 고점 대비 낙폭 ${sp5d}% ≤ ${SP500_CRASH_PCT}% — LLM 판단 무관 강제 경보. 미증시 급락 포지션 점검 필요.`,
        evidenceBase, '',
      ];
      console.log(`   ⚑ SP500 급락 가드레일 발동: ${sp5d}% → 🔴 강제`);
      await appendValues(token, `${RISK_SHEET}!A2`, [spRow]);
      await pushNewReds([spRow], priorRedKeys);
    }

    // ② 개별 종목 가격 기회 트리거 (§4) — 결정론·LLM 무관(쿨다운·dry-run 무관하게 실행).
    //    위탁·ISA의 주식·ETF만. 종목당 O행 1개(🔴 급락매수 / 🟡 차익검토 / 🟢 해당없음 — 자가 치유).
    const OPP_ACCTS = new Set(['위탁', 'ISA']);
    const OPP_TYPES = new Set(['국내주식', '해외주식']);
    const oppTargets = holdings.filter(h => h.accounts.some(a => OPP_ACCTS.has(a.acct) && OPP_TYPES.has(a.type)));
    console.log(`\n💡 가격 기회 트리거 스캔 — 위탁·ISA 주식·ETF ${oppTargets.length}개`);
    const oppRows = [];
    for (const h of oppTargets) {
      let md = null;
      try {
        if (h.market === 'KR') { const c = krStockCode(h.name); if (c) md = fetchKrMarketData(c); }
        else { const t = usTicker(h.name); if (t) md = fetchMarketData(t); }
      } catch { md = null; }
      if (!md) { console.log(`   · ${h.name}: 시세 미해결 — skip`); continue; }
      const opp = scanOpportunity(md);
      const row = [nowKST(), 'O', h.name, opp.signal, opp.summary, opp.detail, opp.ev, ''];
      oppRows.push(row);
      if (opp.signal !== '🟢') console.log(`   ${opp.signal} ${h.name}: ${opp.summary}`);
    }
    const oppHits = oppRows.filter(r => r[3] !== '🟢').length;
    console.log(`   기회 신호 ${oppHits}건 (스캔 ${oppRows.length}개)`);
    if (!DRY_RUN && oppRows.length) {
      await appendValues(token, `${RISK_SHEET}!A2`, oppRows);
      await pushNewReds(oppRows, priorRedKeys);   // 🔴 급락 매수 기회만 신규 푸시
    }

    const prompt = buildMacroPrompt(holdings, indicators, confirmedPrefsText);
    if (DRY_RUN) { console.log('\n┌─── D 프롬프트 ───┐\n' + prompt + '\n└──────────────────┘'); return; }
    // 결정론 가드레일(급락 경보)은 위에서 이미 실행됨. LLM 판단만 쿨다운 시 skip.
    if (cooldownActive()) { console.log('   거시 LLM 판단 skip — 가드레일 경보는 위에서 적재됨.'); return; }
    console.log(`\n⏳ 거시 리스크 판단 중... (LLM은 Read 전용)`);
    try {
      const res = parseJsonBlock(await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt }));
      const sigs = res.signals || [];
      if (!sigs.length) {
        console.log('   ✅ 거시 트리거 미발동 — 신호 없음. (기록은 남김: 🟢 정상)');
        await appendValues(token, `${RISK_SHEET}!A2`, [[
          res.date || nowKST(), 'D', '포트폴리오 전체', '🟢',
          '거시 트리거 미발동', '환율·금리·VIX·지수 정상 범위', evidenceBase, '',
        ]]);
      } else {
        // LLM 출력 하네스(2026-07): signal enum 강제 — 목록 밖 값이면 🟡로 강등하고 이유를 남긴다.
        const rows = sigs.map(s => {
          const sig = extractSignal(s.signal);
          const summary = sig ? (s.summary || '') : `[자동보정: 신호값 불명] ${s.summary || ''}`;
          return [
            res.date || nowKST(), 'D', clampLen(s.target || '포트폴리오', 40), sig || '🟡',
            clampLen(summary, 200), clampLen(s.detail || '', 400), evidenceBase, '',
          ];
        });
        await appendValues(token, `${RISK_SHEET}!A2`, rows);
        console.log(`   ✅ 거시 신호 ${rows.length}건 적재`);
        sigs.forEach(s => console.log(`      ${s.signal} ${s.target}: ${s.summary}`));
        await pushNewReds(rows, priorRedKeys);
      }
    } catch (e) {
      // 한도면 쿨다운은 runHeadlessClaude 가 이미 설정 → 정상 종료(FAIL 알림 노이즈 방지).
      if (e.isLimit) { console.log(`   ⏳ 사용량 한도 → 거시 판단 보류(쿨다운 설정).`); return; }
      console.error(`   ❌ 실패: ${e.message}`);
      process.exit(1);
    }
    await pruneRiskSheet(token, monitoredNames);
    return;
  }

  // MODE === 'B'
  const [noteRows, baseRows] = await Promise.all([
    getRange(token, '종목투자노트!A2:U'),
    getRange(token, `${BASELINE_SHEET}!A2:J`),
  ]);
  const bMap = baselineMap(baseRows);

  // 위탁계좌의 개별주식(국내주식·해외주식)만 논리훼손 점검 대상.
  // ETF·펀드·현금성(MMF·RP·CD금리·TDF·금현물 등, 연금/ISA/IRP 포함)은 펀더멘털 가드레일
  // 판단 대상이 아니고 매번 trivial 통과하면서 무거운 claude 호출로 사용량 한도만 소진 →
  // 점검에서 제외하고 필요 시 수동 평가 요청으로 처리. (사용량 한도 회피)
  const targets = holdings.filter(h => monitoredNames.has(h.name) && (!ONLY || h.name === ONLY));
  const skipped = holdings.length - targets.length;

  if (ONLY && !targets.length) {
    console.error(`❌ --only=${ONLY} — 위탁 개별주식 보유종목 중 일치하는 이름 없음`);
    process.exit(1);
  }
  const skipLabel = ONLY ? `--only=${ONLY} 외 ${skipped}개 제외` : `ETF·펀드·현금성 ${skipped}개 제외`;
  console.log(`\n📊 위탁 개별주식 ${targets.length}개 논리 점검 시작 (전체 ${holdings.length}개 중 ${skipLabel})`);
  // 종목당 claude 1회 — 가장 무거운 배치. 쿨다운 중이면 호출 안 함(시트 정리만 하고 종료).
  if (!DRY_RUN && cooldownActive()) { await pruneRiskSheet(token, monitoredNames); return; }
  let ok = 0, fail = 0, alerts = 0;
  for (const h of targets) {
    const baseline = bMap.get(h.name) || null;
    const buyCard = findBuyCard(noteRows, h.name);

    // ① 결정론 데이터 조회 — 실패 시 LLM 호출 없이 '데이터 부족' 행(침묵 실패 방지)
    let facts = null, fetchErr = null;
    try {
      if (h.market === 'KR') {
        const code = krCorpCode(h.name);
        if (!code) throw new Error(`corp_code 미해결: ${h.name}`);
        const sc = krStockCode(h.name);
        facts = await fetchKrFundamentals(code, undefined, undefined, sc);
      } else {
        const tk = usTicker(h.name);
        if (!tk) throw new Error(`US 티커 미등록: ${h.name} — instruments.mjs US_MAP에 추가 필요`);
        facts = fetchUsFundamentals(tk);
      }
    } catch (e) { fetchErr = e; }

    if (fetchErr) {
      const row = [nowKST(), 'B', h.name, '🟡', '데이터 조회 실패 — 수동 확인 필요',
        fetchErr.message, '{}', baseline ? baseline.date : '없음'];
      if (DRY_RUN) { console.log(`   🟡 ${h.name} 데이터 부족(dry-run): ${fetchErr.message}`); continue; }
      await appendValues(token, `${RISK_SHEET}!A2`, [row]);
      console.error(`   🟡 ${h.name} 데이터 부족: ${fetchErr.message}`);
      fail++;
      continue;
    }

    // ② 가드레일 사전판정(결정론)
    const guardrails = checkGuardrails({
      opYoYCurr: facts.opYoYCurr, opYoYPrev: facts.opYoYPrev,
      debtRatio: facts.debtRatio,
      baselineDebtRatio: baseline ? parseFloat(String(baseline.debt_ratio).replace(/[%,]/g, '')) || null : null,
    });

    const prompt = buildLogicPrompt(h, facts, guardrails, baseline, buyCard, confirmedPrefsText);
    if (DRY_RUN) { console.log(`\n┌─── B 프롬프트 [${h.name}] ───┐\n` + prompt + '\n└──────────────────┘'); continue; }
    console.log(`\n⏳ ${h.name} 논리 판단 중... (수 분)`);
    try {
      const r = parseJsonBlock(await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt }));
      // ② LLM 출력 하네스(2026-07): signal enum 강제 — 목록 밖 값이면 🟡로 강등.
      // ③ 가드레일 발동인데 🟢이면 🟡로 강제. 근거데이터는 LLM 아닌 Node 계산값.
      const extracted = extractSignal(r.signal);
      let signal = extracted || '🟡';
      let summary = extracted ? (r.summary || '') : `[자동보정: 신호값 불명] ${r.summary || ''}`;
      if (guardrails.length && signal === '🟢') {
        signal = '🟡';
        summary = `[가드레일 강제🟡: ${guardrails.join('·')}] ${summary}`;
      }
      const row = [nowKST(), 'B', h.name, signal, clampLen(summary, 200), clampLen(r.detail || '', 400),
        JSON.stringify(facts), r.baseline_ref || (baseline ? baseline.date : '없음')];
      await appendValues(token, `${RISK_SHEET}!A2`, [row]);
      console.log(`   ${signal} ${h.name}: ${summary}`);
      await pushNewReds([row], priorRedKeys);
      if (signal !== '🟢') alerts++;
      ok++;
    } catch (e) {
      // 한도면 남은 종목도 모두 막히므로 루프 중단(쿨다운은 이미 설정됨). 불필요한 호출·노이즈 방지.
      if (e.isLimit) { console.error(`   ⏳ ${h.name} 사용량 한도 → 남은 종목 점검 중단.`); break; }
      console.error(`   ❌ ${h.name} 실패: ${e.message}`);
      fail++;
    }
  }
  if (!DRY_RUN) {
    await pruneRiskSheet(token, monitoredNames);
    console.log(`\n🏁 완료 — 점검 ${ok} · 경보(🟡🔴) ${alerts} · 실패 ${fail}`);
    // 종목별 실패(fail++)는 지금까지 개별 행에만 남고 잡 종료코드는 항상 0이었다 — run.sh가
    // 종료코드만으로 OK/FAIL을 판정하므로(record-heartbeat) 401 등 티커 단위 실패가 잡상태
    // OK·failStreak=0으로 은폐됨(2026-07-17 Themis 자체평가 적발). Mode D는 이미 실패 시
    // exit(1)하므로 정상 반영됐던 것과 대칭 맞춤 — 종목 1개라도 실패하면 잡 자체를 FAIL로.
    if (fail > 0) process.exitCode = 1;
  }
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
