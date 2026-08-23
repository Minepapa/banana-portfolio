#!/usr/bin/env node
/**
 * 주간 리포트 발행 v2 (Vault 네이티브, MVP 범위)
 *
 * ⚠️ 2026-08-20 전면 재작성 — v1(구글시트 기반)은 v1 무인 잡 전체 중단(2026-08-14)
 * 이후 죽어있었다(마지막 발행 8/09). 전체 진단 중 발견: "성향관찰"(Apollo가 쓰는
 * 학습된 투자성향)은 별도 파이프라인이 아니라 **이 잡의 하위 단계(⑦)**라, 이 잡을
 * 살리지 않으면 성향관찰도 영원히 새로 안 생긴다.
 *
 * MVP 범위 — 아직 Vault 네이티브 쓰기 주체가 없는 입력은 뺐다(있는 척 빈 섹션을
 * 채우지 않는다, feedback-no-silent-fallback 원칙):
 *   - 리스크모니터(B/D 신호 재인용) — risk-b 대체 설계 전까지 보류
 *   - 리스크기준선(baseline) — 리프레셔 미포팅, risk-b 작업과 함께 처리 예정
 *   - 종목투자노트(매수논리) — Vault 경로 자체가 없음
 *   - 포지션저널(청산 교훈) — v1 sync-position-journal.mjs 미이관
 *   - 라이브 시장지표(52주위치·RSI·PER·PBR)·펀더멘털 — 종목별 yfinance/OpenDart 추가
 *     조회 필요, 스코프 축소를 위해 이번엔 뺌(나중에 필요해지면 되살리기 쉬운 구조)
 * 대신 이번엔 확실히 살아있는 4개(보유·거시·체결·배당)만으로 리포트+성향학습을 부활시킨다.
 *
 * 원칙(risk-monitor.mjs와 동일): raw 숫자는 LLM이 만들지 않는다.
 *   ① Node가 Vault에서 결정론 조회 → report-facts로 조립
 *   ② claude -p 는 profile/investor-profile.md + 주입된 facts만으로 "서술·해석·처방"만 생성
 *   ③ Knowledge/Reports/{asof}.md 저장 + (선택)텔레그램 푸시
 *   ④ 행동 신호(체결 기반)를 §3와 대조해 성향 관찰 추출(sonnet) →
 *      Knowledge/Profile/PreferenceObservations/*.md 신규 파일
 *
 * 사용법:
 *   node scripts/jobs/weekly-report.mjs                 # 발행
 *   node scripts/jobs/weekly-report.mjs --dry-run       # facts·프롬프트만 출력(쓰기 없음)
 *   node scripts/jobs/weekly-report.mjs --model=opus    # 서술 품질용(기본 opus)
 *   node scripts/jobs/weekly-report.mjs --no-push       # 텔레그램 요약 푸시 끔
 *   node scripts/jobs/weekly-report.mjs --force         # 같은 날짜 리포트 있어도 덮어씀
 */
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { fetchMacroIndicators } from '../lib/fundamentals.mjs';
import { buildReportFacts } from '../lib/report-facts.mjs';
import { buildBehaviorSignals } from '../lib/behavior-signals.mjs';
import { renderPrefRows, findExpiredPromotions } from '../lib/preferences.mjs';
import { filterObservations, claimViolationsInDoc } from '../lib/llm-guard.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { runHeadlessClaude, parseJsonBlock } from '../lib/headless-claude.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';

// 2026-08-23 — 이 발송도 부서 라벨이 없었다(오너 지시로 전체 텔레그램 메시지 구조
// 재점검 중 발견) — 주간리포트·KPI는 비서실(Apollo) 소관(위 APOLLO_REPORT/APOLLO_PREFS
// 로 이미 이 잡 전체가 Apollo 에이전트 정의를 쓰고 있는 것과 일관).
const DEPARTMENT_LABEL = '비서실 Apollo';

loadEnv(); // KRX_API_KEY(거시지표) — 다른 v2 잡과 동일 관례

const PROFILE = new URL('../../profile/investor-profile.md', import.meta.url).pathname;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_PUSH = args.includes('--no-push');
const FORCE = args.includes('--force');
// 리포트 서사·성향 추출 모두 비서실(Apollo) 소관 — 에이전트 정의가 모델·원칙의 단일 진실 소스.
const APOLLO_REPORT = loadAgent('apollo', { fallbackModel: 'opus' });
const APOLLO_PREFS = loadAgent('apollo', { fallbackModel: 'sonnet' });
if (APOLLO_REPORT.warning) collectWarning(APOLLO_REPORT.warning);
const modelArg = args.find(a => a.startsWith('--model='));
const MODEL = modelArg ? modelArg.split('=')[1] : APOLLO_REPORT.model;

// asof 기준 직전 7일(월~일 주간)을 커버하는 시작일.
function weekStartOf(asofYmd) {
  const d = new Date(`${asofYmd}T00:00:00+09:00`);
  d.setDate(d.getDate() - 6);
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function todayKST() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function readVaultDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) =>
    ({ filepath: join(dir, f), ...parseFrontmatter(readFileSync(join(dir, f), 'utf8')) }));
}

// Facts/Ledger/Executions 객체 → EXEC_COL 인덱스 row-array. behavior-signals.mjs·
// report-facts.mjs의 매입평균 기반 실현손익 로직(2026-07 현대차·삼성바이오로직스
// 회귀방지)을 안 건드리고 그대로 재사용하기 위한 어댑터.
function executionsToTradeRows(executions) {
  return executions.map((e) => [
    e.tradeDate ?? '', e.tradeType ?? '', e.account ?? '', e.stockCode ?? '',
    '', e.stockName ?? '', String(e.price ?? ''), String(e.quantity ?? ''),
    String((Number(e.quantity) || 0) * (Number(e.price) || 0)),
  ]);
}
// Facts/Ledger/Dividends 객체 → [날짜, 금액, 종목명] row-array.
function dividendsToRows(dividends) {
  return dividends.map((d) => [d.date ?? '', String(d.afterTaxAmount ?? ''), d.stockName ?? '']);
}

// Knowledge/Reports/{date}.md 중 asof 이전 가장 최신 리포트 요약 → 직전 맥락.
function loadPrevReport(asof) {
  const dir = VAULT_PATHS.knowledge.reports;
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => ({ date: f.slice(0, 10), file: f }))
    .filter((f) => f.date < asof)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!files.length) return null;
  const parsed = parseFrontmatter(readFileSync(join(dir, files[0].file), 'utf8'));
  return { date: files[0].date, summary: parsed.summary || '' };
}

function extractSummary(md) {
  const explicit = md.match(/^[>\s]*\*{0,2}\s*요약\s*[:：]\s*(.+)$/m);
  if (explicit) return explicit[1].trim().slice(0, 200);
  const body = md.split('\n')
    .filter(l => !/^\s*#/.test(l) && !/^\s*>/.test(l) && !/^[\s\-=*_]*$/.test(l) && !/^\s*\|/.test(l))
    .join(' ').replace(/\s+/g, ' ').trim();
  return body.slice(0, 200);
}

function buildReportPrompt(factsText, asof, confirmedPrefsText) {
  return `[주간 자산 리포트 작성 — ${asof}] Frank를 위한 **맞춤형** 주간 자산 분석 리포트를 작성해줘.

먼저 \`${PROFILE}\` 파일(명시 성향)을 Read 로 읽어.
이 리포트는 그냥 시장 요약이 아니라 **Frank의 성향·계좌 구조를 아는 분석가가 쓰는 1:1 코칭 리포트**다.

[확정된 학습 성향 — 실제 행동에서 학습돼 Frank가 확인한 성향. §3와 함께 분석 기준으로 쓸 것.
 명시 성향(§3)과 학습 성향이 다르면 **드러난 행동(학습 성향)을 우선**.]
${confirmedPrefsText || '(아직 확정된 학습 성향 없음 — §3만 사용)'}

[검증된 facts — 시스템이 Vault(State/Holdings·Facts/Ledger)·KRX·yfinance에서 직접 조회·
 계산한 값. 이 수치만 사용. 재조회·재계산·추정 금지. "데이터 부족"은 그대로 두고 지어내지 말 것.]
${factsText}

━━━ 이 리포트가 지켜야 할 4원칙 ━━━

【1. 가독성 — 스캔되는 글】
- 한 불릿에 수치 6~7개를 욱여넣지 말 것. **결론 먼저, 근거는 짧게.**
- 자산군 진단은 \`**[국내주식] (한 줄 결론)**\` 헤더 → 그 아래 짧은 근거 1줄 + \`내 판단:\` 1줄 구조.
- 긴 만연체 금지. 문장은 짧게 끊고, 핵심 수치만 굵게.

【2. 정확한 수치 + 너의 시선】
- 모든 수치는 facts 값 그대로(평가액·비중·수익률). 단위·부호 변형 금지.
- 그러나 **데이터 나열로 끝내지 말 것.** 각 섹션에 분석가로서의 \`내 판단:\`을 명시적으로 넣어 —
  "이 수치가 Frank에게 뜻하는 바"와 분명한 입장(좋다/주의/행동)을 밝혀라. 애매한 양비론 금지.
- 이번 버전엔 리스크신호·매수논리·라이브 시장지표(RSI·PER 등)가 아직 없다 — 있는 척 언급하지
  말고, facts에 있는 것(평가액·수익률·체결·배당·거시)만으로 판단하라.

【3. Frank 성향·계좌 맞춤 (profile 적용)】
- 매수: 단기 급락 시 저점매수 선호 · 1회 500만원 미만 적립식 · 추격매수 비선호.
- 매도: 급락 후 빠른 반등 시 차익실현 · 과열 구간 일부 익절 패턴.
- 보유: 펀더멘털 훼손 없으면 단기 변동성 무시하고 장기 보유.
- 계좌 목적: 위탁=수비형 분산(리밸런싱 대상) / 연금저축·IRP=월 자동매수 적립(리밸런싱 비대상) / ISA=배당주 적립.
- 권고는 반드시 이 패턴에 맞춰라.

【4. 맞춤형 — 내 포트폴리오 관점】
- 일반론 시장 코멘트 금지. 모든 시장 관찰을 **Frank의 특정 보유·계좌·목표에 연결**하라.
- WebSearch는 정성적 맥락(무슨 일이 있었나·일정)에만. 거기서 가져온 수치는 리포트에 쓰지 말 것(facts가 유일 수치 출처).

━━━ 구조 (마크다운) ━━━
# 주간 자산 종합 점검 — ${asof}

> 요약: (3줄·200자 이내, 이 라인 형식 그대로 제목 바로 아래)

## [한눈에] 이번 주 요약
- **가장 큰 변화**: (한 줄)
- **잘 가고 있는 것**: (한 줄)
- **주의·행동 필요**: (한 줄)

## [자산현황]
- 총 평가액·총손익(원금 대비) + 계좌별 표 + 자산군 비중 표. 표는 간결히, 종목 전수 나열 금지.
- **내 판단:** 이번 주 자산 상태를 한두 줄로 평가(Frank 목표 대비 어디인지).

## [시장환경] 이번 주 시장 환경 (내 포트폴리오 관점)
- 핵심 이슈 1~2개 — 각 이슈를 "내 어느 자산/계좌에 어떻게"로 연결(일반론 금지).
- 지표 표: facts에 있는 거시지표(값 + 5일 변화).

## [체결·배당] 이번 주 체결·배당
- facts의 체결·배당 정리(없으면 "없음") + 각 체결이 Frank 성향에 부합했는지 짧은 코멘트.
- **매도의 익절/손절은 facts에 표시된 실현손익(매입평균 대비) 부호만 근거로 쓸 것.** 그 숫자가
  없거나 일부만 추적된 경우 익절/손절을 단정하지 말고 "손익 미확정"으로 쓸 것.

## [행동] 다음 주 행동 (Frank 맞춤 처방)
- **[즉시]**: 근거 = 밸류·현금 여력·**성향 적합성**. 없으면 "현 포지션 유지" + 이유.
- **[조건부]**: 가격/이벤트 트리거별 액션.
- **[일정]**: 실적·FOMC·지표(WebSearch 가능).
- **[유지·관망]**: 손대지 않을 자산군 + 이유 한 줄.

---
*결정론 데이터(Vault·KRX·yfinance) 기반 자동 생성. 최종 결정은 Frank님이 직접.*

설명·머리말 없이 위 마크다운 리포트 본문만 출력. 첫 줄은 반드시 \`# 주간 자산 종합 점검\`.`;
}

// 성향 관찰 추출 프롬프트 — 결정론 행동 신호를 §3·직전 관찰과 대조해 관찰(JSON)만 뽑는다.
function buildObservationPrompt(signalsText, priorPrefsText) {
  return `[성향 관찰 추출] Frank의 이번 주 실제 행동 신호를 보고, 명시 성향과 비교해 "드러난 성향 관찰"을 뽑아줘.

먼저 \`${PROFILE}\` (§3 명시 성향)를 Read.

[직전까지 누적된 성향관찰 — 같은 관찰이 반복되는지 판단용]
${priorPrefsText || '(없음)'}

[결정론 행동 신호 — 시스템이 체결에서 산출. 이 사실만 근거로 쓸 것. 추정·날조 금지.
 이번 버전엔 리스크신호·매수논리·포지션저널 기반 신호가 아직 없다 — 여기 없는 유형(논리훼손
 미매도 등)은 절대 만들어내지 말 것.]
${signalsText}

규칙:
- **증거가 있는 관찰만**. 신호에 없는 내용은 만들지 말 것. 뚜렷한 게 없으면 빈 배열.
- 각 관찰은 명시 성향(§3)과 대조: "일치(보강)" / "신규" / "상충".
- 직전 관찰에 같은 내용이 이미 있으면 promote=true(§3 승격 후보).
- 최대 3개. 사소한 건 버리고 의미 있는 것만.

금지(위반한 관찰은 시스템이 자동 폐기함):
- evidence에는 위 [결정론 행동 신호] 텍스트에 그대로 있는 문장·수치만 인용. 서로 다른 신호 줄을
  합쳐 새로운 인과를 만들지 말 것.
- confidence는 높음|보통|낮음, vsProfile은 일치(보강)|신규|상충 만 사용.

출력: 설명 없이 \`\`\`json 배열 하나만.
\`\`\`json
[
  {"type":"매도 타이밍","observation":"과열 구간 부분 익절 실행","evidence":"체결 2026-06-12 SK하이닉스 5주 @2,280,000 +14%","vsProfile":"일치(보강)","confidence":"높음","promote":false}
]
\`\`\``;
}

// 관찰 JSON → Knowledge/Profile/PreferenceObservations/*.md 신규 파일. 상충/promote면
// 상태=승격후보, 아니면 관찰. 한 관찰당 파일 하나(다른 Vault 레코드와 동일 관례).
function writeObservations(asof, observations) {
  const dir = VAULT_PATHS.knowledge.preferenceObservations;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const now = new Date();
  const nowIso = now.toISOString();
  const timeSlug = nowIso.replace(/[-:]/g, '').replace(/\..+/, '');
  let n = 0;
  observations.forEach((o, i) => {
    const promote = o.promote || /상충/.test(o.vsProfile || '');
    const record = {
      type: 'preference-observation',
      date: asof, signalType: o.type || '기타', observation: o.observation || '',
      evidence: o.evidence || '', vsProfile: o.vsProfile || '신규', confidence: o.confidence || '보통',
      status: promote ? '승격후보' : '관찰', updatedAt: nowIso,
    };
    const filename = `${asof}-${timeSlug}-${i + 1}.md`;
    writeAtomic(join(dir, filename), buildFrontmatter(record) + '\n');
    n++;
  });
  return n;
}

async function main() {
  console.log('📰 주간 리포트 발행 v2 (Vault → claude -p 서술)');
  if (DRY_RUN) console.log('   (--dry-run: facts·프롬프트만 출력)');

  const asof = todayKST();
  const weekStart = weekStartOf(asof);

  // ① 거시지표 (결정론)
  console.log('\n⏳ 거시지표 조회(KRX/yfinance)...');
  const macro = await fetchMacroIndicators();

  // ② Vault 원본 읽기
  const holdings = readVaultDir(VAULT_PATHS.state.holdings); // 현금성 포함(자산 현황엔 필요)
  const executions = readVaultDir(VAULT_PATHS.facts.ledger.executions);
  const dividends = readVaultDir(VAULT_PATHS.facts.ledger.dividends);
  const prefRecords = readVaultDir(VAULT_PATHS.knowledge.preferenceObservations);
  const prevReport = loadPrevReport(asof);

  const tradeRows = executionsToTradeRows(executions);
  const dividendRows = dividendsToRows(dividends);

  // ③ facts 조립 + 행동 신호(체결만 — MVP 범위, 노트·리스크·저널 신호는 아직 없음)
  const { facts, factsText } = buildReportFacts({ asof, weekStart, holdings, macro, tradeRows, dividendRows, prevReport });
  const { signalsText } = buildBehaviorSignals({ asof, weekStart, tradeRows, noteRows: [], journalRows: [], riskRows: [] });
  const confirmedPrefsText = renderPrefRows(prefRecords, { confirmedOnly: true });
  const priorPrefsText = renderPrefRows(prefRecords);

  const prompt = buildReportPrompt(factsText, asof, confirmedPrefsText);
  if (DRY_RUN) {
    console.log('\n┌─── FACTS ───┐\n' + factsText + '\n└─────────────┘');
    console.log('\n┌─── 행동 신호(성향 학습) ───┐\n' + signalsText + '\n└─────────────┘');
    console.log('\n┌─── 확정 성향(리포트 주입) ───┐\n' + (confirmedPrefsText || '(없음)') + '\n└─────────────┘');
    console.log('\n┌─── PROMPT ───┐\n' + prompt + '\n└──────────────┘');
    console.log(`\n총 평가액: ${facts.totalEval != null ? Math.round(facts.totalEval).toLocaleString('en-US') + '원' : '데이터 부족'}`);
    return;
  }

  // ④ Knowledge/Reports 중복 체크(멱등 — 같은 날짜 있으면 건너뜀, --force면 덮어씀)
  const reportPath = join(VAULT_PATHS.knowledge.reports, `${asof}.md`);
  if (existsSync(reportPath) && !FORCE) {
    console.log(`   ℹ️ Knowledge/Reports/${asof}.md 이미 존재 — 발행 건너뜀(재발행하려면 --force)`);
    await flushWarnings('weekly-report');
    return;
  }

  // ⑤ claude -p 서술 생성 (Read=프로필/직전리포트, WebSearch=정성 뉴스. Bash 제외 — 수치 재조회 차단)
  console.log(`\n⏳ 리포트 작성 중 (claude -p ${MODEL}, 수 분)...`);
  let md;
  try {
    md = (await runHeadlessClaude(prompt, MODEL, 'Read,WebSearch', { appendSystemPrompt: APOLLO_REPORT.systemPrompt })).trim();
  } catch (e) {
    if (e.isLimit) { console.log(`   ⏳ 사용량 한도 → 이번 리포트 발행 보류. 한도 해제 후 재실행하세요.`); return; }
    throw e;
  }
  const h1 = md.search(/^# /m);
  if (h1 > 0) { md = md.slice(h1); console.log('   ✂️ 머리말 제거(첫 # 제목 앞 잘라냄)'); }
  else if (h1 < 0) console.warn('   ⚠️ 마크다운 H1(#)을 찾지 못함 — 그대로 저장');

  // ⑤-b 경고성 사후검증 — 리포트가 "논리훼손"을 언급하면 항상 위반 취급한다(MVP엔 B🔴
  // 소스가 아예 없어 allowedForClaim이 항상 빈 배열 — 그 어떤 논리훼손 주장도 근거가 없다).
  const universe = holdings.map((h) => h.name).filter(Boolean);
  const reportClaims = claimViolationsInDoc(md, /논리\s*훼손/, universe, []);
  if (reportClaims.length) collectWarning(`주간리포트 자동검증: "논리훼손" 언급 — 이번 버전엔 근거 소스가 없어 전부 미확인 주장: ${reportClaims.join(', ')}`);

  // ⑥ Vault 저장
  const summary = extractSummary(md);
  const headline = md.match(/^# (.+)$/m)?.[1] ?? `주간 자산 종합 점검 — ${asof}`;
  const record = buildFrontmatter({ type: 'weekly-report', date: asof, headline, summary }) + '\n' + md;
  writeAtomic(reportPath, record);
  console.log(`   💾 저장: Knowledge/Reports/${asof}.md`);

  // ⑦ 텔레그램 요약 푸시
  if (!NO_PUSH) {
    try {
      await sendTelegram(formatDepartmentMessage({
        departmentLabel: DEPARTMENT_LABEL,
        tag: '안내',
        body: `<b>주간 리포트</b> · ${asof}\n\n${summary}\n\n<i>앱 리포트 탭에서 전문 확인</i>`,
      }));
      console.log('   📲 텔레그램 요약 푸시');
    } catch (e) { console.error(`   ⚠️ 텔레그램 실패: ${e.message}`); }
  }

  // ⑧ 성향 학습 — 행동 신호를 §3·직전 관찰과 대조해 관찰 추출(sonnet) → Vault 신규 파일.
  //    리포트 발행과 분리 — 실패해도 리포트 발행은 성공 처리.
  try {
    console.log(`\n⏳ 성향 관찰 추출 중 (claude -p ${APOLLO_PREFS.model})...`);
    const obsRaw = parseJsonBlock(await runHeadlessClaude(buildObservationPrompt(signalsText, priorPrefsText), APOLLO_PREFS.model, 'Read', { appendSystemPrompt: APOLLO_PREFS.systemPrompt }));
    const priorObsTexts = prefRecords.filter((r) => r.status !== '기각').map((r) => r.observation).filter(Boolean);
    const { kept, dropped } = filterObservations(Array.isArray(obsRaw) ? obsRaw : [], {
      universe, factsText: signalsText, claimAllowed: [], priorTexts: priorObsTexts, maxRows: 3,
    });
    dropped.forEach(d => collectWarning(`성향관찰 자동폐기: "${String(d.obs?.observation ?? '').slice(0, 60)}" — ${d.reason}`));
    const n = writeObservations(asof, kept);
    console.log(n ? `   🧠 성향 관찰 ${n}건 기록 (Knowledge/Profile/PreferenceObservations)` : '   🧠 이번 주 뚜렷한 성향 관찰 없음');
    if (dropped.length) console.log(`   🛡 자동 검증 실패로 폐기 ${dropped.length}건(텔레그램 경고)`);
  } catch (e) { console.error(`   ⚠️ 성향 관찰 단계 실패(리포트는 정상): ${e.message}`); }

  // ⑧-b 승격후보 TTL(4주 무응답이면 자동으로 관찰 보류) — ⑧과 분리된 독립 단계.
  try {
    const freshPrefRecords = readVaultDir(VAULT_PATHS.knowledge.preferenceObservations);
    const expired = findExpiredPromotions(freshPrefRecords, { now: new Date() });
    if (expired.length) {
      for (const e of expired) {
        const content = readFileSync(e.filepath, 'utf8');
        writeAtomic(e.filepath, updateFrontmatter(content, { status: '관찰', updatedAt: new Date().toISOString() }));
      }
      console.log(`   ⏳ 승격후보 TTL 만료 ${expired.length}건 → 관찰로 자동 보류: ${expired.map(e => `"${e.obs.slice(0, 20)}"(${e.ageWeeks}주)`).join(', ')}`);
      collectWarning(`성향관찰 승격후보 TTL 만료 ${expired.length}건 → 관찰 보류(4주 무응답)`);
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
