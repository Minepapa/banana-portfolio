#!/usr/bin/env node
/**
 * 투자전략실 Athena 분기별 목표비중 적정성 점검 — 2026-08-23 오너 지시(자산분배 트랙
 * 최소개입 자동화 계획 Part 2). 지금 확정한 목표비중(rebalance-gap.mjs
 * TARGET_ALLOCATION: 채권20·금10·달러10·국내주식30·해외주식30) 자체가 여전히
 * 적절한지, 분기마다 Athena가 재검토해 의견을 보낸다.
 *
 * ⚠️ 역할 경계 — 이 잡은 목표비중을 자동으로 바꾸지 않는다. TARGET_ALLOCATION은 코드
 * 상수라 실시간 Zeus 세션은 정책상 코드 수정이 금지돼 있고(이런 개발 세션에서만 가능),
 * 이 잡의 결과는 순수 의견 보고([안내] 태그, [제안] 아님)다 — Athena가 "여전히
 * 적절하다" 또는 "이런 이유로 재검토가 필요해 보인다"고 서술하면, 실제 숫자 변경은
 * 오너가 이 판단을 보고 별도 개발 세션에서 요청하는 흐름.
 *
 * 데이터: 현재 TARGET_ALLOCATION(코드 상수, Node가 그대로 주입) + 최근 분기(약 95일)
 * 생성된 자산분배 트랙 제안 이력(Decisions/Proposals, Node가 나열만) + 거시 5신호
 * 최신 상태(macro-overlay-facts.mjs --json 재사용, morning-briefing.mjs와 동일 패턴).
 *
 * 스케줄 — 진짜 "분기 1일" launchd 트리거는 없다(달력상 매번 다른 요일). 대신 분기
 * 시작월(1·4·7·10월) 1~3일에 매번 이 잡을 걸어두고, 이 파일이 직접 "이번 분기에 아직
 * 안 돌았고 오늘이 평일인가"를 판정한다 — State/QuarterlyAllocationReview/
 * last-quarter.md에 마지막으로 실행한 분기를 기록해 같은 분기에 중복 실행을 막는다
 * (1일이 주말이면 2일·3일 중 첫 평일에 자연히 넘어감, new-cash-allocation.mjs의
 * CashAccumulator dedup과 동일 원리).
 *
 * 사용법:
 *   node scripts/jobs/quarterly-allocation-review.mjs            # 실제 실행 + 발송
 *   node scripts/jobs/quarterly-allocation-review.mjs --dry-run  # 판정·프롬프트까지, 발송 없음
 *   node scripts/jobs/quarterly-allocation-review.mjs --force    # 분기 dedup 무시하고 강제 실행(수동 테스트용)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { TARGET_ALLOCATION } from '../lib/rebalance-gap.mjs';
import { fetchMacroIndicators } from '../lib/fundamentals.mjs';
import { assembleMacro } from '../tools/risk-facts.mjs';
import { runHeadlessClaude } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DEPARTMENT_LABEL = '투자전략실 Athena';
const LOOKBACK_MS = 95 * 24 * 3600_000; // 약 1분기
const STATE_DIR = join(VAULT_PATHS.root, 'State', 'QuarterlyAllocationReview');
const STATE_FILE = join(STATE_DIR, 'last-quarter.md');
const QUARTER_START_MONTHS = new Set([1, 4, 7, 10]);

// 순수함수 — KST 기준 "YYYY-Q{1-4}" 라벨. 테스트 가능.
export function getQuarterLabel(date) {
  const month = date.getMonth() + 1;
  const quarter = Math.ceil(month / 3);
  return `${date.getFullYear()}-Q${quarter}`;
}

// 순수함수 — 오늘 이 잡을 실제로 돌려야 하는지: 분기 시작월(1·4·7·10월)의 1~3일 중
// 평일이고, 이번 분기엔 아직 실행 기록이 없을 때만. 주말이면 다음 날(2일·3일)로
// 자연히 넘어간다 — 별도 "다음 평일 찾기" 계산 없이 dedup만으로 해결.
export function shouldRunToday(date, lastQuarterLabel) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const dow = date.getDay(); // 0=일, 6=토
  if (!QUARTER_START_MONTHS.has(month) || day > 3) return false;
  if (dow === 0 || dow === 6) return false;
  return getQuarterLabel(date) !== lastQuarterLabel;
}

function readVaultDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

function readLastQuarter() {
  if (!existsSync(STATE_FILE)) return null;
  const fm = parseFrontmatter(readFileSync(STATE_FILE, 'utf8'));
  return fm.quarter ?? null;
}

function writeLastQuarter(quarter) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeAtomic(STATE_FILE, buildFrontmatter({ type: 'quarterly-allocation-review-state', quarter, updatedAt: new Date().toISOString() }));
}

// 순수함수 — 최근 1분기 생성된 자산분배 트랙 제안만 텍스트로. 판단은 안 함(사실 나열만).
export function buildRecentAllocationProposalsSummary(proposals, now = new Date()) {
  const cutoff = now.getTime() - LOOKBACK_MS;
  const recent = (proposals || []).filter(
    (p) => p.track === '자산분배' && p.createdAt && new Date(p.createdAt).getTime() >= cutoff,
  );
  if (!recent.length) return '(최근 1분기 생성된 자산분배 트랙 제안 없음)';
  return recent
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((p) => `  · ${p.side} ${p.assetKey} — 상태:${p.status}${p.reason ? ` — 사유: ${p.reason}` : ''}`)
    .join('\n');
}

// 순수함수 — Athena에게 줄 프롬프트. 목표비중·최근 제안이력·거시신호 전부 주입된
// 사실만 쓰게 강제(재조회·추정 금지), 판단(비중 자체가 적절한지)만 시킨다.
export function buildQuarterlyReviewPrompt({ targetAllocation, recentProposalsText, macro }) {
  const targetLines = Object.entries(targetAllocation).map(([k, v]) => `  ${k}: ${v}%`).join('\n');
  return `[분기별 목표비중 적정성 점검] 아래는 검증된 사실이다(재조회·추정 금지, 이 숫자만 사용).

[현재 목표비중 — 위탁+연금저축 합산]
${targetLines}

[최근 1분기 생성된 자산분배 트랙 제안 이력]
${recentProposalsText}

[거시지표]
${macro}

판단 요청:
1. 위 목표비중이 지금도 적절해 보이는지 네(아테나) 성격대로 판단해라 — 특정 자산군이
   분기 내내 계속 이탈·재이탈을 반복했다면 목표 자체가 현실과 안 맞을 수 있다는 신호다.
   거시환경 변화(금리·환율·주식시장 국면)도 참고해라.
2. 만약 재검토가 필요하다고 판단되면 어느 자산군을 어느 방향으로 조정해볼 만한지
   방향성만 제시해라(구체적 %는 오너와 개발 세션에서 정할 문제이지 여기서 확정하지
   마라) — 이 잡은 목표비중을 직접 바꾸지 않는다.
3. 특별한 문제가 없으면 "지금 비중이 여전히 적절하다"고 명확히 말해라 — 억지로 지적
   하지 마라.
4. 형식: 설명 없이 3~6문장, 서술형. JSON·마크다운 없이 순수 텍스트만 출력.`;
}

async function main() {
  const now = new Date();
  const lastQuarter = readLastQuarter();

  if (!FORCE && !shouldRunToday(now, lastQuarter)) {
    console.log(`ℹ️ 오늘은 분기 점검 대상 아님(이번 분기 이미 실행됐거나 평일/분기시작월 아님) — 건너뜀`);
    return;
  }

  loadEnv();
  const AGENT = loadAgent('athena', { fallbackModel: 'sonnet' });
  if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
  const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;

  const proposals = readVaultDir(VAULT_PATHS.decisions.proposals);
  const recentProposalsText = buildRecentAllocationProposalsSummary(proposals, now);

  const macroData = await fetchMacroIndicators().catch((e) => {
    console.error(`⚠️ 거시지표 조회 실패: ${e.message}`);
    return null;
  });
  const macro = macroData ? assembleMacro(macroData) : '(거시지표 데이터 부족: 조회 실패)';

  const prompt = buildQuarterlyReviewPrompt({ targetAllocation: TARGET_ALLOCATION, recentProposalsText, macro });

  if (DRY_RUN) {
    console.log('(드라이런 — 텔레그램 발송·상태갱신 없음)\n');
    console.log(prompt);
    return;
  }

  let judgment;
  try {
    judgment = (await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt })).trim();
  } catch (e) {
    console.error(`❌ Athena 헤드리스 판단 실패: ${e.message}`);
    process.exit(1);
  }

  console.log(judgment);

  try {
    await sendTelegram(formatDepartmentMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '안내', body: judgment }));
    writeLastQuarter(getQuarterLabel(now));
  } catch (e) {
    // 발송 실패 시 분기 마커를 안 갱신 — 다음 날(2일·3일)에 재시도되게 한다
    // (morning-briefing.mjs와 동일 원칙, "발송 성공 후에만 워터마크 전진").
    console.error('텔레그램 알림 실패(분기 마커 미전진, 다음 실행에서 재시도):', e.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ quarterly-allocation-review 오류:', e.message); process.exit(1); });
}
