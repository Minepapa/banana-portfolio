#!/usr/bin/env node
/**
 * ISA 3년 만기 시 연금계좌 일괄이전 제안 — athena.md 책임목록("3년 만기 시 ISA→연금계좌
 * 일괄이전 제안, 1회성")을 실제로 구현(2026-08-29, 자산분배 트랙 감사에서 발견된
 * 미구현 항목).
 *
 * ⚠️ ISA 계좌 개설일은 므네모시네 어디에도 기록돼 있지 않다(가장 오래된 ISA
 * CashEvent는 2026-06-05지만 이건 이 앱이 추적을 시작한 시점일 뿐, 실제 개설일과
 * 다르다) — 오너에게 직접 확인(2026-08-29): **2025-04-06**. 이 값은 실물 계좌 개설일
 * 이라는 사실이지 투자 판단이 아니므로 코드 상수로 고정한다("판단에 하드코딩 금지"는
 * 무엇을 살지 팔지의 판단을 가리키지, 계좌 개설일 같은 결정론적 사실을 가리키지 않는다
 * — cash-allocation-candidates.mjs 세금규칙 상수와 같은 원칙).
 *
 * ⚠️ Proposal 스키마를 안 쓴다 — createAndSendProposal(proposal-flow.mjs)은 단일
 * 종목의 매수/매도(assetKey·side·quantity)를 전제로 order-gate 검문소·체결리마인더
 * 매칭까지 이어지는 파이프라인인데, "ISA→연금계좌 일괄이전"은 브로커 서류상 계좌이전
 * 절차(오너가 증권사에서 직접 신청)라 이 스키마에 맞지 않는다. quarterly-allocation-
 * review.mjs와 같은 패턴(Node 사실계산 → Athena 헤드리스 판단 → sendTelegram 안내)을
 * 쓰되, tag는 "제안"(athena.md 원문 표현 그대로) — 실행할 주문이 아니라 오너가 판단할
 * 권고이기 때문.
 *
 * 1회성 트리거 — 만기일 이후 처음 실행될 때 한 번만 발송하고 State 마커를 남겨 재발송
 * 안 함(quarterly-allocation-review.mjs의 분기 dedup과 같은 원리, 다만 이건 영구
 * 1회뿐이라 "지난 분기 라벨"이 아니라 단순 불리언 마커).
 *
 * ⚠️ 코드리뷰 지적(2026-08-29, 커밋 전) — `--force`가 발송까지는 강제해도 마커까지
 * 영구 기록해버리면, 수동 테스트로 한 번 --force한 순간 2028-04-06 진짜 만기가 와도
 * 영원히 스킵된다(quarterly-allocation-review.mjs의 분기라벨 마커는 다음 분기에
 * 자연히 무효화되지만, 이 마커는 불리언이라 그 안전장치가 없다). 그래서 마커 기록은
 * `--force` 여부와 무관하게 **실제로 만기에 도달했을 때만** 한다 — `--force --dry-run`
 * 조합(발송·마커 둘 다 없음, 프롬프트만 확인)이 안전한 수동 테스트 방법.
 *
 * 사용법:
 *   node scripts/jobs/isa-maturity-check.mjs            # 실제 판단+발송(만기 도달 시만)
 *   node scripts/jobs/isa-maturity-check.mjs --dry-run  # 프롬프트까지, 발송·마커 없음
 *   node scripts/jobs/isa-maturity-check.mjs --force --dry-run  # 만기 전이어도 프롬프트만 강제로 확인(발송·마커 없음, 안전)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { summarizeIsaHoldings } from '../lib/isa-exposure.mjs';
import { runHeadlessClaude } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatFactsMessage } from '../lib/telegram-messages.mjs';
import { isProposalBlocked } from '../lib/proposal-mode.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DEPARTMENT_LABEL = '투자전략실 Athena';
const ISA_OPEN_DATE = '2025-04-06'; // 오너 확정(2026-08-29) — 실물 계좌 개설일, 추정 아님
const MATURITY_YEARS = 3;
const STATE_DIR = join(VAULT_PATHS.root, 'State', 'IsaMaturity');
const STATE_FILE = join(STATE_DIR, 'triggered.md');

// 순수함수 — 개설일 + 3년 = 만기일. Date 생성자의 월 넘김 처리에 맡긴다(2/29 개설 같은
// 극단적 윤년 케이스도 JS Date가 알아서 3/1로 넘겨준다 — 이 앱 범위에서 별도 처리 불필요).
export function computeMaturityDate(openDateStr, years = MATURITY_YEARS) {
  const d = new Date(`${openDateStr}T00:00:00+09:00`); // KST 자정 기준
  d.setFullYear(d.getFullYear() + years);
  return d;
}

// 순수함수 — 오늘이 만기일 이후인가(당일 포함).
export function hasReachedMaturity(now, maturityDate) {
  return now.getTime() >= maturityDate.getTime();
}

// 순수함수 — 이번 실행에서 실제로 판단·발송까지 진행할지. force는 "만기 미도달·이미
// 발송됨" 게이트만 우회한다(수동 테스트용) — 마커를 쓸지 말지는 이 함수가 아니라
// main()이 hasReachedMaturity를 별도로 다시 확인해서 결정한다(코드리뷰 지적: force로
// 강제 발송해도 실제 만기가 아니면 마커를 영구 기록하면 안 됨 — 아래 main() 참고).
export function shouldSend({ now, maturityDate, alreadyTriggered, force = false }) {
  if (force) return true;
  return !alreadyTriggered && hasReachedMaturity(now, maturityDate);
}

// KST 기준 YYYY-MM-DD — toISOString()은 UTC로 변환해 KST 자정 날짜가 하루 밀려 보일 수
// 있다(예: 2028-04-06T00:00+09:00 → toISOString()은 '2028-04-05'). proposal-execution-
// reminder.mjs의 kstDateStr 패턴과 동일(en-CA 로케일이 YYYY-MM-DD로 포맷).
const kstDateStr = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);

// 순수함수 — Node가 계산한 ISA 보유내역을 텔레그램용 개조식 불릿으로. 텔레그램 메시지
// 표준 구조(2026-08-17 오너 확정, formatFactsMessage 헤더 주석 참고)를 이 잡에도 적용
// (2026-08-30 — themis-risk-review.mjs에서 먼저 발견·수정된 결함과 동일 패턴이라 신설
// 당일이지만 같이 적용, 뒤늦게 같은 문제로 다시 지적받지 않기 위해).
export function buildIsaMaturityFacts({ isaSummary, maturityDate }) {
  const itemLines = isaSummary.items.map((it) => `${it.name}(${it.assetClass}) 평가액 ${Math.round(it.evalAmount).toLocaleString('ko-KR')}원, 비중 ${it.weightPct.toFixed(1)}%${it.profitPct != null ? `, 손익 ${it.profitPct.toFixed(1)}%` : ''}`);
  return [
    `만기일: ${kstDateStr(maturityDate)}`,
    `ISA 총 평가액: ${Math.round(isaSummary.totalEval).toLocaleString('ko-KR')}원`,
    ...(itemLines.length ? itemLines : ['보유 없음']),
  ];
}

// 순수함수 — Athena에게 줄 프롬프트. ISA 보유내역(사실)만 주고 이전 여부·유의사항
// 판단은 시킨다(다른 자산분배 잡과 동일 경계 — 무엇을 할지는 Node가 정하지 않음).
// ⚠️ 만기일·보유내역은 이제 위 buildIsaMaturityFacts로 별도 불릿 처리돼 먼저 나가므로
// (formatFactsMessage), LLM 출력은 숫자 재나열이 아니라 판단에 집중한다.
export function buildIsaMaturityPrompt({ isaSummary, maturityDate }) {
  const maturityLabel = kstDateStr(maturityDate);
  const lines = isaSummary.items.length
    ? isaSummary.items.map((it) => `  - ${it.name}(${it.assetClass}) 평가액 ${Math.round(it.evalAmount).toLocaleString('ko-KR')}원, 비중 ${it.weightPct.toFixed(1)}%${it.profitPct != null ? `, 손익 ${it.profitPct.toFixed(1)}%` : ''}`).join('\n')
    : '  (보유 없음)';

  return `[ISA 3년 만기 도달] ISA 계좌가 만기일(${maturityLabel})에 도달했다(재조회·추정 금지, 이 사실만 사용).
만기일·보유내역은 텔레그램 메시지에 이미 불릿으로 따로 나간다 — 아래 출력에서 다시 나열하지 마라.

[ISA 현재 보유내역 — 총 평가액 ${Math.round(isaSummary.totalEval).toLocaleString('ko-KR')}원]
${lines}

판단 요청(아테나 성격대로 서술):
1. 한국 ISA 제도상 만기 시 "연금계좌로 전환 납입"하면 추가 세액공제 혜택이 있다는
   일반 제도 지식을 근거로, 이번 만기 이전을 오너에게 권고할지 판단해라 — 무조건
   이전이 정답은 아니다(당장 현금이 필요하면 일반 인출도 선택지).
2. 이전을 권고한다면 위 보유내역 중 어떤 걸 먼저 정리(매도 후 현금이전)하고 어떤 건
   실물이전이 유리할지 방향성만 제시해라 — 구체적 세액·수수료 계산은 오너가 증권사에서
   직접 확인해야 한다는 점을 명시해라(이 시스템은 세무 계산기가 아니다).
3. 이건 이 시스템이 대신 실행할 수 있는 주문이 아니라 오너가 증권사에서 직접 신청해야
   하는 계좌이전 절차임을 분명히 밝혀라.
4. 형식: 결론 문장 하나 + 근거 3~6문장, 합쳐서 4~7문장. 문장 사이는 줄바꿈으로
   분리해라 — 한 문단에 몰아쓰지 마라. JSON·마크다운 없이 순수 텍스트만 출력.`;
}

function readVaultDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

function readTriggered() {
  if (!existsSync(STATE_FILE)) return false;
  const fm = parseFrontmatter(readFileSync(STATE_FILE, 'utf8'));
  return fm.triggered === true || fm.triggered === 'true';
}

function writeTriggered(now) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeAtomic(STATE_FILE, buildFrontmatter({ type: 'isa-maturity-check-state', triggered: true, triggeredAt: now.toISOString() }));
}

async function main() {
  const now = new Date();
  const maturityDate = computeMaturityDate(ISA_OPEN_DATE);
  const alreadyTriggered = readTriggered();

  if (!shouldSend({ now, maturityDate, alreadyTriggered, force: FORCE })) {
    console.log(`ℹ️ 아직 만기 전이거나(만기일 ${kstDateStr(maturityDate)}) 이미 발송됨(triggered=${alreadyTriggered}) — 건너뜀`);
    return;
  }

  const proposalModePath = VAULT_PATHS.state.proposalMode;
  const proposalsBlocked = isProposalBlocked(existsSync(proposalModePath) ? readFileSync(proposalModePath, 'utf8') : null);
  if (proposalsBlocked && !DRY_RUN) {
    console.log('🚫 제안금지 모드 — 이 잡도 건너뜀("제안요청"으로 해제 전까지, 마커도 안 건드림 — 다음 주에 재시도)');
    return;
  }

  loadEnv();
  const AGENT = loadAgent('athena', { fallbackModel: 'sonnet' });
  if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
  const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;

  const holdings = readVaultDir(VAULT_PATHS.state.holdings);
  const isaSummary = summarizeIsaHoldings(holdings);
  const prompt = buildIsaMaturityPrompt({ isaSummary, maturityDate });
  const facts = buildIsaMaturityFacts({ isaSummary, maturityDate });

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
    await sendTelegram(formatFactsMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '제안', facts, interpretation: judgment }));
    // hasReachedMaturity를 여기서 다시 확인 — --force로 만기 전에 강제 발송한 경우까지
    // 마커를 영구 기록하면 진짜 만기(2028-04-06)가 와도 이 잡이 평생 스킵된다(코드리뷰
    // 지적). force 테스트는 위에서 이미 --dry-run과만 조합하도록 안내했지만, 혹시라도
    // --force만 단독 실행되는 경우까지 이 두 번째 확인으로 방어한다.
    if (hasReachedMaturity(now, maturityDate)) writeTriggered(now);
  } catch (e) {
    // 발송 실패 시 마커를 안 남겨 다음 실행에서 재시도되게 한다(quarterly-allocation-
    // review.mjs와 동일 원칙 — "발송 성공 후에만 워터마크 전진").
    console.error('텔레그램 알림 실패(마커 미기록, 다음 실행에서 재시도):', e.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ isa-maturity-check 오류:', e.message); process.exit(1); });
}
