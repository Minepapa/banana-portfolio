#!/usr/bin/env node
/**
 * 논리훼손(B) 월간 판정 — v1 risk-monitor.mjs --mode=B의 Vault-native 대체
 * (2026-08-14, project-v2-redesign.md의 "최우선 미해결" 항목 해소).
 *
 * 대상: State/Holdings 중 위탁계좌 개별주식(assetClass 국내주식·해외주식)만. ETF·채권·
 * 현금성·연금저축/ISA/IRP는 제외 — 이 종목들은 자산분배 트랙 설계상 "신규 매수 없이 ETF로
 * 전환 대상인 레거시 보유"일 뿐(project-two-track-structure 메모) 능동적 매매 판단 대상이
 * 아니다.
 *
 * ⚠️ 빈도 — v1(주1회)이 아니라 월 1회다(오너 확인, 2026-08-14). 이 잡이 비교하는 기준선
 * (State/Baselines) 자체가 분기 실적 발표 때만 바뀌는 데이터라, 그보다 훨씬 자주 재확인해도
 * "지난달과 똑같음"만 반복하는 낭비다 — 월 1회면 분기 안에도 재확인 기회가 3번 있어 충분히
 * 촘촘하다.
 *
 * 흐름 (v1과 동일한 판단 아키텍처, 소스만 시트→Vault 치환):
 *   1. State/Holdings에서 위탁 개별주식만 필터
 *   2. State/Baselines/{종목명}.md(기준선) + Decisions/PositionJournal(매수 논리, thesis·
 *      exitCondition 필드 — v1 "종목투자노트" 매수카드의 Vault 대응)를 읽는다
 *   3. fundamentals.mjs로 펀더멘털을 재조회(Node 결정론, LLM은 이 숫자를 재계산 못함)
 *   4. checkGuardrails(영업이익 2분기 연속 감소·부채비율 고위험·FCF 적자전환)가 걸리면
 *      LLM 판단과 무관하게 최소 🟡 강제
 *   5. Themis 페르소나로 헤드리스 LLM 호출 — "전제가 깨졌는가"만 판단(숫자 재조회·추정 금지)
 *   6. Decisions/RiskMonitor에 판정 1건=파일 1개로 기록. 🔴만 텔레그램 즉시 푸시.
 *
 * ⚠️ 알려진 축소범위(v1 대비 의도적 생략, 필요해지면 별도 확장) — 이번 구현은 "논리훼손
 * 판정" 핵심만 다룬다. v1에 있던 증권사 투자의견 컨센서스(참고정보)·수급(외국인/기관)
 * 조회는 판정 신호에 관여하지 않는 부가정보였을 뿐이라 우선 생략. 가격 급락 매수기회(O신호)
 * 스캔은 애초에 B모드가 아니라 D모드 소관 — daily-asset-allocation-check.mjs 쪽 확장 과제.
 *
 * 사용법:
 *   node scripts/jobs/risk-b-monitor.mjs                # 전체 대상 판정
 *   node scripts/jobs/risk-b-monitor.mjs --dry-run       # 기록·텔레그램 없이 판정 로그만
 *   node scripts/jobs/risk-b-monitor.mjs --only=삼성전자 # 특정 종목만(로직 수정 후 재확인용)
 *   node scripts/jobs/risk-b-monitor.mjs --model=opus
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { fetchKrFundamentals, fetchUsFundamentals, checkGuardrails } from '../lib/fundamentals.mjs';
import { krCorpCode, usTicker, krStockCode } from '../lib/instruments.mjs';
import { runHeadlessClaude, parseJsonBlock } from '../lib/headless-claude.mjs';
import { extractSignal, clampLen } from '../lib/llm-guard.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';

loadEnv(); // .env(DART_API_KEY 등) — launchd는 인터랙티브 셸 rc를 안 읽어 자체 로딩 필요

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] || null;
// 논리훼손 판정은 리스크관리실(Themis) 소관 — 에이전트 정의가 모델·판단원칙의 단일 진실
// 소스(다른 헤드리스 잡과 동일 우선순위: CLI --model= > frontmatter > 폴백).
const AGENT = loadAgent('themis', { fallbackModel: 'sonnet' });
if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;
const DEPARTMENT_LABEL = '리스크관리실 Themis';

const STOCK_ASSET_CLASSES = new Set(['국내주식', '해외주식']);

function readMdDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, ...parseFrontmatter(readFileSync(join(dir, f), 'utf8')) }));
}

function findBaseline(name) {
  const p = join(VAULT_PATHS.state.baselines, `${name}.md`);
  if (!existsSync(p)) return null;
  return parseFrontmatter(readFileSync(p, 'utf8'));
}

// PositionJournal 파일명은 "{계좌}-{종목명}(-r##)?.md" 규칙이지만 결합계좌("위탁_연금저축-...")
// 같은 예외가 있어 파일명 파싱 대신 frontmatter(stockName+account)로 매칭한다. 동일 종목·계좌에
// 여러 개정 기록이 있을 수 있어 updatedAt 최신 것을 취한다(v1 findBuyCard와 동일 원칙).
function findPositionJournal(name, account) {
  const rows = readMdDir(VAULT_PATHS.decisions.positionJournal)
    .filter((r) => r.stockName === name && r.account === account);
  if (!rows.length) return null;
  rows.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return rows[0];
}

function sanitizeSegment(s) {
  return String(s ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 숫자는 전부 Node가 조회한 facts/가드레일에서만 오고, LLM은 "전제가 깨졌는가"만 판단한다
// (v1 buildLogicPrompt와 동일 원칙 — 환각 차단의 핵심은 raw 숫자를 LLM이 만들지 않는 것).
function buildLogicPrompt(h, facts, guardrails, baseline, journal) {
  const baseLine = baseline
    ? `[저장된 기준선 (${baseline.baselineDate})]
매출총이익률 ${baseline.grossMargin} · 영업이익률 ${baseline.operatingMargin} · ROE ${baseline.roe} · 부채비율 ${baseline.debtRatio} · EPS ${baseline.eps} · PBR ${baseline.pbr || '데이터 부족'}
(${baseline.note || ''})`
    : '[저장된 기준선] 없음 — 주입된 펀더멘털만으로 절대 평가';
  const journalLine = journal
    ? `[매수 논리 (${journal.updatedAt || '날짜 미상'})]
결론: ${journal.kind || '(미기록)'}
근거: ${journal.thesis || '(미기록)'}
매도 조건(전제 파괴 기준): ${journal.exitCondition || '(미기록)'}`
    : '[매수 논리] PositionJournal에 없음 — 기준선 대비 변화만 판단';

  return `[논리 훼손 점검 — 월간] 보유종목의 매수 논리가 펀더멘털상 훼손됐는지 "판단만" 해줘.

종목: ${h.name} (${h.market})

[검증된 펀더멘털 — 시스템이 ${facts.source}에서 직접 조회·계산한 값. 이 수치만 사용할 것.
 절대 재조회·재계산·추정하지 말 것. null 은 "데이터 없음"이며 불리하게 해석하지 말 것]
${JSON.stringify(facts, null, 1)}

[가드레일 사전판정(시스템 계산)] ${guardrails.length ? guardrails.join(' · ') + ' → 신호는 최소 🟡' : '트리거 없음'}

${baseLine}

${journalLine}

판단 규칙:
- 위 검증된 수치와 기준선/매수논리를 비교해 "매수 근거의 핵심 전제가 깨졌는가"만 판단.
- 신호: 🟢 논리 유효 / 🟡 약화·주의 / 🔴 훼손(매도 평가 필요)
- 단순 주가 하락·52주/RSI 과열은 단독 신호 금지(펀더멘털 우선 철학).
- summary·detail에 쓰는 모든 숫자는 위 JSON 값 그대로 인용(단위·부호 변형 금지).
- signal 값은 🟢|🟡|🔴 셋 중 하나만 출력(그 외 값은 시스템이 🟡로 강등).

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{"signal":"🟢","summary":"한줄","detail":"무엇이 어떻게 바뀌었나(기준선 대비)"}
\`\`\``;
}

async function judgeOne(h) {
  const market = h.assetClass === '국내주식' ? 'KR' : 'US';
  const baseline = findBaseline(h.name);
  const journal = findPositionJournal(h.name, h.account);

  let facts = null, fetchErr = null;
  try {
    if (market === 'KR') {
      const code = krCorpCode(h.name);
      if (!code) throw new Error(`corp_code 미해결: ${h.name}`);
      const stockCode = krStockCode(h.name);
      facts = await fetchKrFundamentals(code, undefined, undefined, stockCode);
    } else {
      const tk = usTicker(h.name);
      if (!tk) throw new Error(`US 티커 미등록: ${h.name} — instruments.mjs US_MAP에 추가 필요`);
      facts = fetchUsFundamentals(tk);
    }
  } catch (e) { fetchErr = e; }

  if (fetchErr) {
    return {
      name: h.name, signal: '🟡', summary: '데이터 조회 실패 — 수동 확인 필요',
      detail: fetchErr.message, facts: {}, baselineRef: baseline?.baselineDate || '없음',
    };
  }

  // 현금흐름 필드명이 시장별로 다르다(fundamentals.mjs 계약) — KR은 operCf/operCfPrev(영업활동
  // 현금흐름 누적, CAPEX 미보유라 FCF 프록시), US는 fcfCurr/fcfPrev(yfinance 실제 FCF).
  const cfCurr = market === 'KR' ? facts.operCf : facts.fcfCurr;
  const cfPrev = market === 'KR' ? facts.operCfPrev : facts.fcfPrev;
  const guardrails = checkGuardrails({
    opYoYCurr: facts.opYoYCurr, opYoYPrev: facts.opYoYPrev,
    debtRatio: facts.debtRatio, cfCurr, cfPrev,
  });

  const prompt = buildLogicPrompt({ name: h.name, market }, facts, guardrails, baseline, journal);
  const r = parseJsonBlock(await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt }));

  // LLM 출력 하네스: signal enum 밖 값은 🟡로 강등 + 가드레일 발동인데 🟢면 강제 🟡
  // (v1과 동일 원칙 — 근거데이터는 항상 Node 계산값이지 LLM 산출물이 아니다).
  const extracted = extractSignal(r.signal);
  let signal = extracted || '🟡';
  let summary = extracted ? (r.summary || '') : `[자동보정: 신호값 불명] ${r.summary || ''}`;
  if (guardrails.length && signal === '🟢') {
    signal = '🟡';
    summary = `[가드레일 강제🟡: ${guardrails.join('·')}] ${summary}`;
  }
  return {
    name: h.name, signal, summary: clampLen(summary, 200), detail: clampLen(r.detail || '', 400),
    facts, baselineRef: r.baseline_ref || baseline?.baselineDate || '없음',
  };
}

function buildRiskRecord(result, now = new Date()) {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const filename = `${sanitizeSegment(result.name)}-${ts}.md`;
  const content = buildFrontmatter({
    type: 'risk-judgment',
    riskType: 'B',
    target: result.name,
    signal: result.signal,
    summary: result.summary,
    detail: result.detail,
    evidenceJson: JSON.stringify(result.facts),
    baselineRef: result.baselineRef,
    recordedAt: now.toISOString(),
  });
  return { filename, content };
}

async function main() {
  console.log('🛡️  risk-b-monitor — 논리훼손 월간 점검(Vault-native)');
  if (DRY_RUN) console.log('   (--dry-run: 기록·텔레그램 없이 판정만)');

  const holdings = readMdDir(VAULT_PATHS.state.holdings)
    .filter((h) => h.type === 'holding' && h.account === '위탁' && STOCK_ASSET_CLASSES.has(h.assetClass));
  const targets = ONLY ? holdings.filter((h) => h.name === ONLY) : holdings;

  if (ONLY && !targets.length) {
    console.error(`❌ --only=${ONLY} — 위탁 개별주식 보유종목 중 일치하는 이름 없음`);
    process.exit(1);
  }
  console.log(`\n📊 위탁 개별주식 ${targets.length}개 논리 점검 시작`);

  if (!DRY_RUN) mkdirSync(VAULT_PATHS.decisions.riskMonitor, { recursive: true });

  let ok = 0, fail = 0, alerts = 0;
  for (const h of targets) {
    console.log(`\n⏳ ${h.name} 논리 판단 중... (수 분)`);
    let result;
    try {
      result = await judgeOne(h);
    } catch (e) {
      console.error(`   ❌ ${h.name} 실패: ${e.message}`);
      fail++;
      continue;
    }
    console.log(`   ${result.signal} ${h.name}: ${result.summary}`);
    if (result.signal !== '🟢') alerts++;
    ok++;

    if (DRY_RUN) continue;

    const { filename, content } = buildRiskRecord(result);
    await writeStateFile(join(VAULT_PATHS.decisions.riskMonitor, filename), content);

    if (result.signal === '🔴') {
      try {
        await sendTelegram(formatDepartmentMessage({
          departmentLabel: DEPARTMENT_LABEL,
          body: `🔴 <b>논리 훼손 경보</b>\n<b>${escapeHtml(result.name)}</b>\n${escapeHtml(result.summary)}\n\n${escapeHtml(result.detail)}`,
        }));
      } catch (e) {
        console.error(`   ⚠️ 텔레그램 실패: ${e.message}`);
      }
    }
  }

  console.log(`\n🏁 완료 — 점검 ${ok} · 경보(🟡🔴) ${alerts} · 실패 ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ risk-b-monitor 오류:', e.message); process.exit(1); });
}

export { judgeOne, buildLogicPrompt, buildRiskRecord, findBaseline, findPositionJournal };
