#!/usr/bin/env node
/**
 * 장중 시장 급변 실시간 감시 — 텔레그램 메시지 2단계(2026-09-01, 오너 지시).
 *
 * 소관: 리스크관리실 Themis. 자산분배(Athena)·퀀트(Kairos, 월간 리컨스티튜션이라 매일
 * 반응하는 설계가 아님) 어느 한쪽 전용이 아니라, 오너가 필요시 대응할 수 있도록 시장
 * 상황 전반을 점검하는 범용 감시라 리스크관리실 소관으로 확정(오너 확인: "이 일일 리스크
 * 관리는 꼭 자산분배만을 위함이 아닌 것을 밝힌다").
 *
 * 동적 부서 자문(PANTHEON.md "동적 부서 자문" 절, 이 잡이 첫 구현 사례) — 서브에이전트는
 * 서로 직접 못 부르고 헤드리스 잡엔 Zeus가 없으므로, 이 잡의 Node 코드가 순차 호출로 그
 * 중계 역할을 대신한다: Call A(항상, Themis) → 자문 필요시만 Call B(요청받은 부서) →
 * Call C(Themis 재종합). 부서명이 정확일치 아니거나 모호하면 자문 없이 Call A 결과를
 * 그대로 쓴다(안전 폴백).
 *
 * 데이터소스: 코스피는 KIS 실시간 지수조회(getKrIndexQuote, tr_id FHPUP02100000) — 이
 * 코드베이스는 코스피 일별 종가를 KRX 전용으로 확정해뒀지만(2026-08-19, 조용한 폴백
 * 방지 원칙) KRX 지수 엔드포인트는 장마감 후 발행이라 장중 감시엔 못 쓴다. KIS는 이미
 * 이 코드베이스의 국내 실시간 시세 정본이라 원칙 위반이 아니다 — "일별 종가=KRX,
 * 실시간=KIS"로 자연 분업(getKrIndexQuote 헤더 주석 참고). S&P500·VIX·DXY·USD/KRW·
 * 미국 10Y수익률은 yfinance(yf-macro.py 재사용) — KIS 해외주식 조회는 이 앱에 권한이
 * 비활성 상태로 확인됨(2026-09-01 라이브 테스트, 개발자포털 권한 문제로 추정).
 *
 * 임계값(관심/경계/심각, 코스피·S&P500·USD/KRW는 3단계, DXY·10Y는 2단계까지만 — 정책상
 * 3단계 없음, 버그 아님): 상세 근거는 Vault Log/Implementation 참고. 코드가 정본.
 *
 * 중복방지: State/MarketMoveMonitor/{신호}.md에 {date, tier} 기록 — 같은 날 같은/더
 * 낮은 단계 재발송 안 함, 악화되거나 날짜가 바뀌면 재발송. "날짜"는 신호 원천의 실제
 * 거래일 기준(코스피=KST, 나머지 5종의 yfinance 일봉은 America/New_York — 미국장
 * 종가로 움직이는 데이터를 KST로 dedup하면 미국 장중에 자정을 넘나들며 중복 알림이
 * 나가거나, 반대로 전날 미국 종가를 "오늘"로 저장해뒀다가 그날 저녁 진짜 새 미국
 * 세션 급락을 조용히 억제할 수 있다 — 2026-09-01 코드리뷰 지적, 라이브로 재현 확인).
 *
 * 사용법:
 *   node scripts/jobs/intraday-market-move-monitor.mjs            # 실제 실행 + 텔레그램 발송
 *   node scripts/jobs/intraday-market-move-monitor.mjs --dry-run  # 프롬프트까지 계산, 발송·상태갱신 없음
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import {
  hasKisCredentials, loadKisCredentials, getKisToken, getKrIndexQuote,
  isKrMarketOpen, isUsMarketOpen,
} from '../lib/kis.mjs';
import { cooldownActive } from '../lib/quota-cooldown.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { runHeadlessClaude } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import {
  formatFactsMessage, parseDepartmentResponse,
  CONCLUSION_MARKER, CONTEXT_MARKER, DECISIONS_MARKER,
} from '../lib/telegram-messages.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const DEPARTMENT_LABEL = '리스크관리실 Themis';

// telegram-messages.mjs가 아는 마커는 [결론]·[사실]·[맥락]·[의사결정] 셋뿐이다(그 파서를
// 공용으로 쓰는 다른 8개 잡과 계약이 다르면 회귀 위험) — 이 잡만 쓰는 5번째 마커라 여기
// 로컬 상수로 둔다(telegram-messages.mjs export 아님, pending-tasks 설계 그대로).
const CONSULTATION_MARKER = '[자문요청]';

// LLM 응답의 한글 부서명(정확일치) → agent-loader.mjs 파일명. 오타·모호한 표현은
// parseConsultationRequest가 안전하게 자문 없음(null)으로 폴백한다.
const CONSULT_AGENTS = { 아테나: 'athena', 카이로스: 'kairos', 헤르메스: 'hermes', 아폴로: 'apollo' };

const SIGNAL_LABELS = {
  KOSPI: '코스피', SP500: 'S&P500', VIX: 'VIX', DXY: 'DXY', USDKRW: 'USD/KRW', TNX: '미국 10Y수익률',
};

// 관심/경계/심각 임계값. 코스피·S&P500: KRX 사이드카(선물 ±5%, 1분 지속)·서킷브레이커1단계
// (지수 -8%, 1분 지속) 실제 발동기준을 관심·심각 경계로 재사용. VIX: 절대수준(시장
// 컨센서스 <20 평온·20-30 상승·>30 고조·>40 위기급). DXY·USD/KRW: 통상 일일 변동성
// 참고(DXY <0.5%, 원화는 코스피보다 타이트하게). 미국10Y: 통상 하루 변동 한 자릿수bp.
// DXY·TNX는 t3 없음(3단계는 다른 신호가 이미 잡아준다고 판단, 정책적 결정).
const TIERS = {
  KOSPI: { t1: 3, t2: 5, t3: 8 },
  SP500: { t1: 3, t2: 5, t3: 8 },
  VIX: { t1: 25, t2: 30, t3: 40 },
  DXY: { t1: 1, t2: 2 },
  USDKRW: { t1: 1, t2: 2, t3: 3 },
  TNX: { t1: 15, t2: 25 },
};

const TIER_RANK = { 관심: 1, 경계: 2, 심각: 3 };

// 순수함수 — 절대값이 tiers(t1<t2<t3) 임계값을 넘었는지 판정, 가장 높은 단계를 반환.
// t3 없는 신호(DXY·TNX)는 t2에서 멈춘다(위 TIERS 주석 — 정책, 버그 아님).
export function classifyTier(absValue, tiers) {
  if (!Number.isFinite(absValue)) return null;
  if (tiers.t3 != null && absValue >= tiers.t3) return '심각';
  if (absValue >= tiers.t2) return '경계';
  if (absValue >= tiers.t1) return '관심';
  return null;
}

// 순수함수 — breach 객체(key/label/tier/detailText) 배열 → 텔레그램용 개조식 불릿.
// Node가 계산한 사실만 나열(판단은 LLM), 다른 잡들과 동일한 formatFactsMessage 관례.
export function buildMoveFacts(breaches) {
  return (breaches || []).map((b) => `${b.label} ${b.detailText}(${b.tier})`);
}

// 순수함수 — 세 프롬프트 빌더(Call A·B·C)가 전부 같은 "- 불릿" 블록을 반복 조립하던 걸
// 하나로(2026-09-01 코드리뷰 지적 — 세 곳에 흩어져 있으면 형식 변경 시 한 곳만 고치는
// 회귀 위험).
function factsBlock(breaches) {
  return buildMoveFacts(breaches).map((f) => `- ${f}`).join('\n');
}

// 순수함수 — Themis에게 줄 1차(Call A) 프롬프트. 사실은 이미 불릿으로 나가므로 LLM
// 출력은 판정·자문필요여부에 집중. [자문요청] 마커로 다른 부서가 필요한지 함께 받는다.
export function buildThemisPrompt(breaches) {
  const factsText = factsBlock(breaches);
  return `[장중 시장 급변 감시] 아래 신호가 방금 임계값을 넘었다(재조회·추정 금지, 이
숫자만 사용). 이 숫자는 텔레그램 메시지에 이미 불릿으로 따로 나간다 — 아래 출력에서
다시 나열하지 마라. 이 감시는 자산분배 전용이 아니라 오너가 필요시 대응할 수 있도록
시장 상황 전반을 점검하는 차원이라 리스크관리실(너) 소관이다.

[임계 돌파 신호]
${factsText}

판단 요청:
1. 지금 이 움직임이 오너가 실제로 신경 써야 할 수준인지, 흔한 변동성 범위인지 네
   (테미스) 성격대로 판정해라 — 과잉반응하지 마라, 노이즈일 가능성도 솔직히 인정해라.
2. 이 신호가 투자전략실(아테나)·퀀트전략실(카이로스)·운영실(헤르메스)·비서실(아폴로)
   중 한 곳의 추가 의견이 필요할 정도로 그 부서 소관과 직접 관련돼 있으면(예: 코스피
   급락이 리밸런싱 판단에 영향, 특정 계좌·전략에 관련된 움직임 등) 그 부서 이름을
   ${CONSULTATION_MARKER}에 정확히 적어라. 필요 없으면 그냥 "없음"이라고만 적어라 —
   항상 자문을 구할 필요는 없다, 대부분은 자문 없이 끝나는 게 정상이다.

형식(반드시 정확히 이 네 마커로 응답을 나눠라, 다른 마커·JSON·마크다운·이모지·
이모티콘·긴 하이픈(—) 없이 순수 텍스트만 — 문장은 마침표로 끊어라):
${CONCLUSION_MARKER}
판정 결론을 한 문장으로.

${CONTEXT_MARKER}
왜 그 결론인지 근거 문장 1~3개. 문장 사이는 줄바꿈으로 분리해라 — 한 문단에 몰아쓰지 마라.

${DECISIONS_MARKER}
오너가 지금 판단할 수 있는 선택지를 "- "로 시작하는 줄로 0~3개. 없으면 이 섹션은
빈 채로 둬라(억지로 만들지 마라).

${CONSULTATION_MARKER}
"아테나"·"카이로스"·"헤르메스"·"아폴로" 중 정확히 하나, 또는 "없음"(둘 중 하나만 첫
줄에). 자문이 필요하다고 판단한 경우에만 다음 줄에 이유를 한 문장 적어라.`;
}

// 줄 맨 앞(line-start)에 오는 마커만 진짜 마커로 인정 — telegram-messages.mjs의
// findMarkerIndex와 동일 원칙(LLM 프리앰블이 마커 이름을 문장 중에 언급해도 오인하지
// 않도록). 이 잡 전용 5번째 마커([자문요청])는 그 파일이 모르므로 여기서 직접 처리.
function findLineAnchoredIndex(text, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(text ?? '').match(new RegExp(`^${escaped}`, 'm'));
  return m ? m.index : -1;
}

// 순수함수 — [자문요청] 섹션을 본문에서 먼저 떼어낸다. 안 떼면 telegram-messages.mjs의
// parseDepartmentResponse가 이 마커를 모르는 채로 [의사결정] 섹션을 텍스트 끝까지
// 그대로 삼켜, [자문요청] 블록째로 "의사결정" 항목처럼 잘못 파싱된다.
export function splitOffConsultation(text) {
  const idx = findLineAnchoredIndex(text, CONSULTATION_MARKER);
  if (idx < 0) return { mainText: String(text).trim(), consultationText: '' };
  return {
    mainText: String(text).slice(0, idx).trim(),
    consultationText: String(text).slice(idx + CONSULTATION_MARKER.length).trim(),
  };
}

// 순수함수 — 흔한 LLM 장식(불릿 접두 "- "·"* ", 마크다운 볼드 "**", 끝맺음 "."·":",
// 끝에 붙는 괄호 설명)만 벗겨낸다. 오타나 의미가 다른 값("아테나일 수도")은 여전히
// 안 걸러진다 — 그건 parseConsultationRequest가 exact-match로 안전하게 거른다
// (2026-09-01 코드리뷰 지적 — "아테나."·"**아테나**"처럼 장식만 붙어도 전부 자문
// 누락으로 떨어지던 걸 실측 확인).
function normalizeDeptToken(s) {
  return String(s ?? '')
    // 볼드(**)를 먼저 벗겨야 한다 — 순서를 바꾸면("- " 등 불릿 제거를 먼저 하면)
    // "**아테나**"에서 앞쪽 "**" 중 한 글자만 불릿으로 오인·제거되고 나머지 한 글자가
    // 안 지워져 "*아테나"로 남는 버그가 생긴다(2026-09-01, 테스트로 실측 재현).
    .replace(/\*\*/g, '')
    .replace(/^[-*·]\s*/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[.:]+$/, '')
    .trim();
}

// 순수함수 — splitOffConsultation이 떼어낸 consultationText의 첫 줄(장식 제거 후)만
// 부서 한글명과 정확일치로 인정한다. 오타·모호한 표현("아테나일 수도 있음")·"없음"은
// 전부 안전하게 자문 없음(agentKey null)으로 폴백 — 오판으로 불필요한 2·3차 호출을
// 만들지 않는다. rawFirst는 매칭 실패 시 호출측이 "없음이라 안 한 건지, 파싱이
// 깨져서 못 한 건지"를 구분해 로그로 남길 수 있게 그대로 반환(2026-09-01 코드리뷰
// 지적 — 이 관찰가능성이 없으면 신규 기능이 프로덕션에서 조용히 죽어도 아무도 모른다).
export function parseConsultationRequest(consultationText) {
  const lines = String(consultationText ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const rawFirst = lines[0] ?? null;
  const normalized = normalizeDeptToken(rawFirst);
  if (!normalized || !CONSULT_AGENTS[normalized]) return { department: null, agentKey: null, reason: null, rawFirst };
  return { department: normalized, agentKey: CONSULT_AGENTS[normalized], reason: lines.slice(1).join(' ') || null, rawFirst };
}

// 순수함수 — Call B(자문 대상 부서) 프롬프트. 형식 마커 없이 자유 서술(그 부서 소관
// 관점의 의견 하나면 충분, 재종합은 Call C의 Themis 몫).
export function buildConsultationPrompt(breaches, reason) {
  const factsText = factsBlock(breaches);
  return `[리스크관리실 테미스의 자문 요청] 지금 아래 시장 신호가 임계값을 넘어 테미스가
너의 의견이 필요하다고 판단했다(재조회·추정 금지, 이 숫자만 사용).

[임계 돌파 신호]
${factsText}

[테미스가 자문을 요청한 이유]
${reason || '(사유 미기재)'}

네 소관 관점에서 자유롭게 의견을 서술해라(마커·형식 없이 순수 텍스트, 이모지·
이모티콘·긴 하이픈(—) 없이. 문장은 마침표로 끊고 문장 사이는 줄바꿈으로 분리해라).`;
}

// 순수함수 — Call C(Themis 재종합) 프롬프트. 원본 사실 + Call B 의견을 다시 주고
// 최종 [결론]·[맥락]·[의사결정]을 재작성시킨다(Call A의 초안은 이걸로 대체됨).
export function buildFinalSynthesisPrompt(breaches, department, deptOpinion) {
  const factsText = factsBlock(breaches);
  return `[장중 시장 급변 감시 — 자문 반영 재종합] 아래는 임계 돌파 신호와, 네가 자문을
요청한 ${department}의 답변이다. 이걸 반영해 최종 판단을 다시 정리해라(숫자 재나열
금지, 이미 불릿으로 따로 나간다).

[임계 돌파 신호]
${factsText}

[${department}의 답변]
${deptOpinion}

형식(반드시 정확히 이 세 마커로 응답을 나눠라, 다른 마커·JSON·마크다운·이모지·
이모티콘·긴 하이픈(—) 없이 순수 텍스트만 — 문장은 마침표로 끊어라):
${CONCLUSION_MARKER}
${department}의 답변을 반영한 최종 결론을 한 문장으로.

${CONTEXT_MARKER}
왜 그 결론인지(자문 내용 포함) 근거 문장 1~3개. 문장 사이는 줄바꿈으로 분리해라.

${DECISIONS_MARKER}
오너가 지금 판단할 수 있는 선택지를 "- "로 시작하는 줄로 0~3개. 없으면 빈 채로 둬라.`;
}

// 순수함수 — 신호별 중복방지 판정. 같은 날 같은/더 낮은 단계로 계속 잡히면 재발송하지
// 않고, 악화되거나(tier 상승) 날짜가 바뀌면(당일 첫 감지) 재발송한다.
export function shouldAlert({ today, tier, storedDate, storedTier }) {
  if (!tier) return false;
  if (storedDate !== today) return true;
  return (TIER_RANK[tier] ?? 0) > (TIER_RANK[storedTier] ?? 0);
}

// 신호별 "오늘" — 코스피는 KIS 실시간이라 KST 당일 그대로. 나머지 5종(yfinance 일봉)은
// 미국장 기준으로 움직이므로 America/New_York 날짜로 dedup한다(위 헤더 주석 참고).
const US_SOURCED_SIGNALS = new Set(['SP500', 'VIX', 'DXY', 'USDKRW', 'TNX']);
export function todayForSignal(signalKey) {
  const tz = US_SOURCED_SIGNALS.has(signalKey) ? 'America/New_York' : 'Asia/Seoul';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

function stateFilePath(signalKey) {
  return join(VAULT_PATHS.state.marketMoveMonitor, `${signalKey}.md`);
}

function readSignalState(signalKey) {
  const fp = stateFilePath(signalKey);
  if (!existsSync(fp)) return { date: null, tier: null };
  const fm = parseFrontmatter(readFileSync(fp, 'utf8'));
  return { date: fm.date ?? null, tier: fm.tier ?? null };
}

// 같은 날 안에서는 이미 기록된 단계보다 낮은 값으로 절대 덮어쓰지 않는다(2026-09-01
// 코드리뷰 지적 — 안 이러면 무관한 다른 신호 때문에 이 함수가 다시 호출될 때 "심각"이
// "경계"로 조용히 다운그레이드돼, 그다음 실제 "심각" 재발이 shouldAlert 기준으로
// 새 악화처럼 보여 중복 알림이 나가거나 반대로 최고단계 기록이 사라지는 비결정적
// 동작이 생겼다).
async function writeSignalState(signalKey, date, tier) {
  const prior = readSignalState(signalKey);
  const effectiveTier = (prior.date === date && (TIER_RANK[prior.tier] ?? 0) > (TIER_RANK[tier] ?? 0))
    ? prior.tier : tier;
  mkdirSync(VAULT_PATHS.state.marketMoveMonitor, { recursive: true });
  const content = buildFrontmatter({
    type: 'market-move-monitor-state', signal: signalKey, date, tier: effectiveTier, checkedAt: new Date().toISOString(),
  });
  await writeStateFile(stateFilePath(signalKey), content);
}

// 순수함수 — 종가 배열에서 전일 대비 등락률(끝 두 점 비교, KIS bstp_nmix_prdy_ctrt와
// 같은 정의). 배열이 짧으면(신규상장·데이터 부족) null.
function dayOverDayPct(closes) {
  const a = (closes || []).filter(Number.isFinite);
  if (a.length < 2) return null;
  const last = a[a.length - 1];
  const prev = a[a.length - 2];
  if (prev === 0) return null;
  return { last, prev, pct: (last - prev) / Math.abs(prev) * 100 };
}

async function fetchKospiBreach() {
  if (!isKrMarketOpen()) return null;
  if (!hasKisCredentials()) {
    collectWarning('코스피 감시 skip: KIS 크리덴셜 없음');
    console.error('⚠️ KIS 크리덴셜 없음 — 코스피 감시 skip');
    return null;
  }
  try {
    const { appkey, appsecret } = loadKisCredentials();
    const token = await getKisToken({ appkey, appsecret });
    const { price, changePct } = await getKrIndexQuote({ token, appkey, appsecret, iscd: '0001' });
    if (changePct == null) return null;
    const tier = classifyTier(Math.abs(changePct), TIERS.KOSPI);
    if (!tier) return null;
    return {
      key: 'KOSPI', label: SIGNAL_LABELS.KOSPI, tier,
      detailText: `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%(현재 ${price})`,
    };
  } catch (e) {
    collectWarning(`코스피 실시간 조회 실패: ${e.message}`);
    console.error(`⚠️ 코스피 실시간 조회 실패: ${e.message}`);
    return null;
  }
}

// S&P500·VIX·DXY·USD/KRW·미국10Y — yf-macro.py 한 번 호출로 5종 동시 조회(fundamentals.mjs
// fetchMacroIndicators와 동일 spawnSync 패턴, MACRO_TICKERS는 안 건드리고 이 잡 전용
// 티커 목록으로 별도 호출 — 회귀 위험 차단).
function fetchMacroBreaches() {
  if (!(isKrMarketOpen() || isUsMarketOpen())) return [];
  const py = new URL('../lib/yf-macro.py', import.meta.url).pathname;
  const tickers = { SP500: '^GSPC', VIX: '^VIX', DXY: 'DX-Y.NYB', USDKRW: 'KRW=X', TNX: '^TNX' };
  const r = spawnSync('python3', [py, ...Object.values(tickers)], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) {
    collectWarning(`yfinance 거시 조회 실패: ${(r.stderr || '').slice(-200)}`);
    console.error(`⚠️ yfinance 거시 조회 실패: ${(r.stderr || '').slice(-200)}`);
    return [];
  }
  let raw;
  try { raw = JSON.parse(r.stdout); } catch (e) {
    collectWarning(`yfinance 응답 파싱 실패: ${e.message}`);
    console.error(`⚠️ yfinance 응답 파싱 실패: ${e.message}`);
    return [];
  }

  const breaches = [];

  const sp = dayOverDayPct(raw[tickers.SP500]);
  if (sp) {
    const tier = classifyTier(Math.abs(sp.pct), TIERS.SP500);
    if (tier) breaches.push({ key: 'SP500', label: SIGNAL_LABELS.SP500, tier, detailText: `${sp.pct >= 0 ? '+' : ''}${sp.pct.toFixed(2)}%` });
  }

  const vixCloses = (raw[tickers.VIX] || []).filter(Number.isFinite);
  if (vixCloses.length) {
    const level = vixCloses[vixCloses.length - 1];
    const tier = classifyTier(level, TIERS.VIX);
    if (tier) breaches.push({ key: 'VIX', label: SIGNAL_LABELS.VIX, tier, detailText: level.toFixed(1) });
  }

  const dxy = dayOverDayPct(raw[tickers.DXY]);
  if (dxy) {
    const tier = classifyTier(Math.abs(dxy.pct), TIERS.DXY);
    if (tier) breaches.push({ key: 'DXY', label: SIGNAL_LABELS.DXY, tier, detailText: `${dxy.pct >= 0 ? '+' : ''}${dxy.pct.toFixed(2)}%` });
  }

  const usdkrw = dayOverDayPct(raw[tickers.USDKRW]);
  if (usdkrw) {
    const tier = classifyTier(Math.abs(usdkrw.pct), TIERS.USDKRW);
    if (tier) breaches.push({ key: 'USDKRW', label: SIGNAL_LABELS.USDKRW, tier, detailText: `${usdkrw.pct >= 0 ? '+' : ''}${usdkrw.pct.toFixed(2)}%` });
  }

  // ⚠️ ^TNX는 수익률(%) 값을 직접 반환한다(2026-09-01 라이브 확인 — 실측 4.6~4.8대,
  // "구식 Yahoo 표시 관례상 ×10 단위"라는 흔한 가정과 달리 이 yfinance 티커는 이미
  // 퍼센트 그대로다). 1퍼센트포인트 = 100bp이므로 끝 두 점의 퍼센트포인트차 × 100 = bp.
  const tnx = dayOverDayPct(raw[tickers.TNX]);
  if (tnx) {
    const bpDiff = (tnx.last - tnx.prev) * 100;
    const tier = classifyTier(Math.abs(bpDiff), TIERS.TNX);
    if (tier) breaches.push({ key: 'TNX', label: SIGNAL_LABELS.TNX, tier, detailText: `${bpDiff >= 0 ? '+' : ''}${bpDiff.toFixed(1)}bp` });
  }

  return breaches;
}

// 헤드리스 LLM 호출 1건당 타임아웃 — 이 잡은 최악의 경우 Call A→B→C 3연쇄라 기본값
// (12분)을 그대로 쓰면 감시가 최대 36분 통째로 멈춘다(10분 간격 감시인데). 3콜 총합을
// 기본 1콜 예산 안에 맞춘다(2026-09-01 코드리뷰 지적).
const LLM_CALL_TIMEOUT_MS = 4 * 60 * 1000;

async function main() {
  loadEnv(); // update-holdings-prices.mjs와 동일 원칙 — KIS 크리덴셜 조회보다 먼저(2026-09-01 코드리뷰 지적).

  if (!(isKrMarketOpen() || isUsMarketOpen())) {
    console.log('장 시간 아님(국내·해외 모두 폐장) — 조회 자체를 생략.');
    return;
  }

  const kospiBreach = await fetchKospiBreach();
  const macroBreaches = fetchMacroBreaches();
  // 데이터 조회 실패는 breaches가 비어도(=조용히 "정상"으로 보여도) 놓치면 안 되는
  // 신호다 — 여기서 무조건 flush한다(2026-09-01 코드리뷰 지적, "조용한 실패" 방지).
  await flushWarnings('intraday-market-move-monitor');

  const breaches = [kospiBreach, ...macroBreaches].filter(Boolean);

  if (!breaches.length) {
    console.log('모든 신호 정상 범위 — 조용함, 알림 생략.');
    return;
  }

  const triggering = breaches.filter((b) => {
    const state = readSignalState(b.key);
    return shouldAlert({ today: todayForSignal(b.key), tier: b.tier, storedDate: state.date, storedTier: state.tier });
  });

  if (!triggering.length) {
    console.log('임계 돌파 신호 있으나 이미 같은/더 낮은 단계로 발송됨 — 중복 억제.');
    return;
  }

  console.log(`🔔 intraday-market-move-monitor: ${breaches.length}개 신호 임계 돌파(신규/악화 ${triggering.length}건)`);

  const facts = buildMoveFacts(breaches);
  const prompt = buildThemisPrompt(breaches);

  if (DRY_RUN) {
    console.log('(드라이런 — 텔레그램 발송·상태갱신 없음)\n');
    console.log(prompt);
    return;
  }

  const AGENT = loadAgent('themis', { fallbackModel: 'sonnet' });
  if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
  const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;

  // ⚠️ HIGH 원칙(daily-asset-allocation-check.mjs·morning-briefing.mjs와 동일) — LLM
  // 실패해도 사실(facts)만이라도 발송한다. 통째로 유실보다 낫다.
  let conclusion = null;
  let context = null;
  let decisions = null;
  // AGENTS.md "claude 호출 규칙" — 새 claude 호출 잡은 호출 전 cooldownActive() 가드 필수.
  if (cooldownActive()) {
    console.log('⏳ 쿨다운 중 — Themis 판단 생략, 사실만 발송');
  } else {
    try {
      const raw = (await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt, timeoutMs: LLM_CALL_TIMEOUT_MS })).trim();
      console.log(raw);
      const { mainText, consultationText } = splitOffConsultation(raw);
      ({ conclusion, context, decisions } = parseDepartmentResponse(mainText));

      const { agentKey, department, reason, rawFirst } = parseConsultationRequest(consultationText);
      if (agentKey) {
        console.log(`→ 자문 요청: ${department} (${reason || '사유 미기재'})`);
        const consultAgent = loadAgent(agentKey, { fallbackModel: 'sonnet' });
        if (consultAgent.warning) console.log(`⚠ ${consultAgent.warning}`);
        const consultRaw = (await runHeadlessClaude(
          buildConsultationPrompt(breaches, reason), consultAgent.model, 'Read', { appendSystemPrompt: consultAgent.systemPrompt, timeoutMs: LLM_CALL_TIMEOUT_MS },
        )).trim();
        console.log(consultRaw);

        const synthRaw = (await runHeadlessClaude(
          buildFinalSynthesisPrompt(breaches, department, consultRaw), MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt, timeoutMs: LLM_CALL_TIMEOUT_MS },
        )).trim();
        console.log(synthRaw);
        // ⚠️ Call C도 Call A와 같은 이유로 splitOffConsultation을 거쳐야 한다 — 프롬프트가
        // [자문요청] 재사용을 금지하지 않아 Themis가 다시 그 마커를 붙이면(실측 재현
        // 확인) parseDepartmentResponse가 그걸 모르는 채로 [의사결정] 끝까지 삼켜
        // "· ...의사결정 [자문요청] 없음"처럼 오염된다(2026-09-01 코드리뷰 HIGH 지적).
        ({ conclusion, context, decisions } = parseDepartmentResponse(splitOffConsultation(synthRaw).mainText));
      } else if (rawFirst && rawFirst !== '없음') {
        // 자문 요청 파싱이 실패한 건지("없음"이 아닌데도 안 걸림) 정말 자문이 없다고
        // 답한 건지 로그로 구분되게 남긴다 — 안 남기면 이 기능 전체가 프로덕션에서
        // 조용히 죽어도 아무도 못 알아챈다(2026-09-01 코드리뷰 MEDIUM 지적).
        console.log(`⚠ 자문요청 파싱 실패(자문 생략): ${rawFirst}`);
      }
    } catch (e) {
      console.error(`⚠ Themis 헤드리스 판단 실패(사실만 발송): ${e.message}`);
    }
  }

  // ⚠️ 발송 성공 시에만 상태를 갱신한다 — 실패한 채로 기록하면(2026-09-01 코드리뷰
  // HIGH 지적) 오너는 이 경보를 영영 못 받았는데 다음 실행부턴 "이미 같은/더 낮은
  // 단계로 발송됨"으로 조용히 억제된다. 발송 실패 시 상태를 안 건드려야 다음 10분
  // 주기에서 다시 시도(재발송)된다.
  let sent = false;
  try {
    await sendTelegram(formatFactsMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '경고', facts, conclusion, context, decisions }));
    sent = true;
  } catch (e) {
    console.error('텔레그램 알림 실패:', e.message);
  }

  if (!sent) {
    console.log('텔레그램 발송 실패 — 상태 갱신도 건너뜀(다음 실행에서 재시도되도록)');
    return;
  }

  for (const b of breaches) {
    try { await writeSignalState(b.key, todayForSignal(b.key), b.tier); }
    catch (e) { console.error(`⚠️ 상태 기록 실패(${b.key}): ${e.message}`); }
  }
}

// import.meta.url 가드 — 이 파일의 순수함수를 intraday-market-move-monitor.test.js가
// 직접 import한다. 가드 없이 최상위에서 main()을 부르면 테스트 import만으로 실제 KIS
// 조회·yfinance 서브프로세스·텔레그램 발송까지 실행돼 버린다(daily-asset-allocation-check.mjs
// 헤더 주석의 동일 사고 사례 참고).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ intraday-market-move-monitor 오류:', e.message); process.exit(1); });
}
