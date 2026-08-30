#!/usr/bin/env node
/**
 * 리스크관리실 Themis 주간 위험 재검토 — Themis가 지금까지 자동발송 잡을 하나도 갖지
 * 못했던 공백을 메운다(2026-08-23, 오너 지시).
 *
 * 배경: Themis 헌장상 역할은 "제안 2차검증"(§2 게이트 파이프라인)인데, 실제로 이 역할이
 * 발동하는 유일한 경로는 **살아있는 Zeus 세션이 동기적으로 Themis를 스폰**할 때뿐이다
 * (create-quant-proposal.mjs가 --zeus-comment를 받는 것도 이 경로 — Zeus가 Athena/Kairos+
 * Themis 의견을 종합한 뒤에만 채워짐). 반면 무인 헤드리스 잡 두 곳
 * (watch-price-and-propose.mjs — 가격워치 자동 제안, new-cash-allocation.mjs — 신규현금
 * 자동배분 제안)은 라이브 Zeus 세션이 없어 이 게이트를 아예 거치지 않고 곧장 오너에게
 * 승인/거부만 묻는다 — Themis도 Zeus도 그 시점엔 관여하지 않는다. 이 구조적 공백을
 * 실시간으로 메우려면(모든 자동 제안 생성 시점에 Themis를 동기 호출) 그 두 잡의 지연시간·
 * 비용·복잡도가 늘어나는 트레이드오프가 있어 이번 작업 범위에 넣지 않았다(오너 확인 필요
 * — Vault 기록 참고). 대신 **주간 회고형 재검토**로 부분 보완한다: 매주 실제 위험 그림을
 * Themis 본인 목소리로 판정하고, 그 주 생성된 제안들을 사후에 훑어 우려되는 게 있으면
 * 짚는다.
 *
 * 데이터: risk-facts.mjs가 이미 조립하는 거시지표+감시잡상태(Node 결정론, 재사용) + 최근
 * 7일 생성된 제안 목록(Decisions/Proposals, Node가 그대로 나열 — 판단하지 않음). Themis
 * 판단은 이 사실들만으로 headless-claude.mjs(new-cash-allocation.mjs와 동일 패턴, Athena
 * 헤드리스 판단과 같은 인프라)를 통해 받는다 — 숫자 재조회·추정 금지.
 *
 * 사용법:
 *   node scripts/jobs/themis-risk-review.mjs            # 실제 실행 + 텔레그램 발송
 *   node scripts/jobs/themis-risk-review.mjs --dry-run  # 프롬프트·판단까지 계산, 발송 없음
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { fetchMacroIndicators } from '../lib/fundamentals.mjs';
import { assembleMacro } from '../tools/risk-facts.mjs';
import { assembleJobs } from '../tools/ledger-facts.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { runHeadlessClaude } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatFactsMessage } from '../lib/telegram-messages.mjs';

// loadEnv()·loadAgent()는 main() 안에서만 부른다(2026-08-23, 독립 코드리뷰 MEDIUM 지적) —
// 최상위에서 부르면 이 파일의 순수함수(buildRecentProposalsSummary 등)만 가져다 쓰려는
// 테스트가 import하는 순간 파일 읽기·.env 파싱이 실행돼버린다(.env나 themis.md가 없는
// 환경, 예: CI에서는 여기서 그냥 죽는다) — morning-briefing.mjs 사고와 같은 클래스의
// "import 자체가 부작용을 낸다" 문제라 실행 여부와 무관하게 미리 방지.
const DRY_RUN = process.argv.includes('--dry-run');
const DEPARTMENT_LABEL = '리스크관리실 Themis';
const RISK_JOBS = ['daily-asset-allocation-check', 'health-watcher'];
const LOOKBACK_MS = 7 * 24 * 3600_000;

function readVaultDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

// 최근 7일 생성분 필터 — buildRecentProposalsSummary(텍스트)와 main()의 건수 집계가
// 같은 필터를 공유하게 한다(2026-08-30 코드리뷰 지적 — 필터를 두 군데 각자 인라인해두면
// 한쪽만 고쳤을 때 불릿 건수와 본문 목록이 조용히 어긋난다, 이걸 잡는 테스트도 없었음).
function filterRecentProposals(proposals, now) {
  const cutoff = now.getTime() - LOOKBACK_MS;
  return (proposals || []).filter((p) => p.createdAt && new Date(p.createdAt).getTime() >= cutoff);
}

// 순수함수 — proposals(파싱된 배열)와 기준 시각(now)을 받아 최근 7일 생성분만 텍스트로.
// 판단(우려되는지)은 하지 않는다 — 그건 Themis의 몫, 여기는 사실 나열만.
export function buildRecentProposalsSummary(proposals, now = new Date()) {
  const recent = filterRecentProposals(proposals, now);
  if (!recent.length) return '(최근 7일 생성된 제안 없음)';
  return recent
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((p) => `  · [${p.track}] ${p.side} ${p.assetKey} ${p.quantity}주 — 상태:${p.status}${p.reason ? ` — 사유: ${p.reason}` : ''}`)
    .join('\n');
}

// 순수함수 — Node가 계산한 사실을 텔레그램용 개조식 불릿으로 변환. LLM은 이 숫자를
// 재조회·재계산하지 않고 판정(interpretation)만 붙인다 — 텔레그램 메시지 표준 구조
// (2026-08-17 오너 확정, telegram-messages.mjs formatFactsMessage 헤더 주석 참고: "Node가
// 계산한 사실을 개조식으로 나열 → LLM 해석을 서술형으로 붙인다")를 이 잡에도 적용한다
// (2026-08-30, 오너 지적 — Themis 메시지만 다른 부서와 달리 불릿 없이 숫자·판정·제안
// 재검토가 전부 한 문단에 뭉쳐 나가고 있었다. 원인: formatDepartmentMessage에 LLM
// 원문을 그대로 넘겨써 왔던 것 — Hermes(morning-briefing, Node 전용)·Athena(제안 메시지,
// formatFactsMessage)는 애초에 이 구조를 안 벗어났었다).
export function buildThemisFacts({ macro, jobsText, recentProposalsCount }) {
  const macroLines = String(macro || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const jobLines = String(jobsText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return [...macroLines, ...jobLines, `최근 7일 생성된 제안: ${recentProposalsCount}건`];
}

// 순수함수 — Themis에게 줄 프롬프트. 숫자는 전부 주입된 사실(macro·jobsText·
// recentProposalsText)만 쓰게 강제하고, 판단(위험 수준·이번 주 제안 재검토)만 시킨다.
// ⚠️ 이 숫자들은 이제 위 buildThemisFacts로 별도 불릿 처리돼 먼저 나가므로(formatFactsMessage),
// LLM 출력은 숫자 재나열이 아니라 순수 판정·해석에 집중하게 지시한다(2026-08-30).
export function buildThemisPrompt({ macro, jobsText, recentProposalsText }) {
  return `[주간 위험 재검토] 아래는 이번 주 시점의 검증된 사실이다(재조회·추정 금지, 이 숫자만 사용).
[거시지표]·[감시 잡 상태]의 숫자는 텔레그램 메시지에 이미 불릿으로 따로 나간다 — 그
숫자들은 아래 출력에서 다시 나열하지 마라. 단 [최근 7일 생성된 제안] 목록은 건수만
불릿으로 나가고 개별 내역(어떤 제안이 어떻게 됐는지)은 안 나가니, 판단 2번에서 특정
제안을 짚을 땐 그 내용을 네가 직접 인용해라.

[거시지표]
${macro}

[감시 잡 상태 — daily-asset-allocation-check·health-watcher]
${jobsText}

[최근 7일 생성된 제안 — Athena/Kairos가 발송, 오너 승인/거부 대기 또는 이미 처리됨]
${recentProposalsText}

판단 요청:
1. 지금 거시 위험 수준을 네(테미스) 성격대로 판정해라 — 근거 없는 낙관·비관 없이, 걸린
   규칙과 실제 데이터를 저울에 올려라. 조용하면(이상 없으면) 조용하다고 명확히 말해라.
2. 위 "최근 7일 생성된 제안" 중 우려되는 게 있으면(예: 거시 위험 신호와 동시에 나간 제안,
   같은 방향으로 반복되는 제안 등) 구체적으로 짚어라(어떤 제안인지 인용 포함). 없으면
   없다고 말해라 — 있는 척 억지로 지적하지 마라.
3. 형식: 거시지표·잡상태 숫자를 다시 나열하지 말고 판정 결론 문장 하나(심각도
   🟢/🟡/🔴 포함) + 필요하면 근거 문장 1~2개, 합쳐서 2~4문장. 문장 사이는
   줄바꿈으로 분리해라 — 한 문단에 전부 몰아쓰지 마라. 판관의 언어로(인용과 함께
   짚는 서술형). JSON·마크다운 없이 순수 텍스트만 출력.`;
}

async function main() {
  loadEnv();
  const AGENT = loadAgent('themis', { fallbackModel: 'sonnet' });
  if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
  const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;

  const macroData = await fetchMacroIndicators().catch((e) => {
    console.error(`⚠️ 거시지표 조회 실패: ${e.message}`);
    return null;
  });
  const macro = macroData ? assembleMacro(macroData) : '(거시지표 데이터 부족: 조회 실패)';

  const jobRecords = readVaultDir(VAULT_PATHS.state.jobHealth).filter((r) => RISK_JOBS.includes(r.job));
  const jobs = assembleJobs(jobRecords);

  // readVaultDir가 이미 parseFrontmatter로 파싱한 객체를 반환한다 — proposal-vault.mjs의
  // parseProposal도 내부적으로 parseFrontmatter일 뿐이라 이중 파싱이 불필요(readVaultDir
  // 결과를 그대로 씀).
  const proposals = readVaultDir(VAULT_PATHS.decisions.proposals);
  const recentProposalsText = buildRecentProposalsSummary(proposals);
  const recentProposalsCount = filterRecentProposals(proposals, new Date()).length;

  const prompt = buildThemisPrompt({ macro, jobsText: jobs.text, recentProposalsText });
  const facts = buildThemisFacts({ macro, jobsText: jobs.text, recentProposalsCount });

  if (DRY_RUN) {
    console.log('(드라이런 — 텔레그램 발송 없음)\n');
    console.log(prompt);
    return;
  }

  let judgment;
  try {
    judgment = (await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt })).trim();
  } catch (e) {
    console.error(`❌ Themis 헤드리스 판단 실패: ${e.message}`);
    process.exit(1);
  }

  console.log(judgment);

  try {
    await sendTelegram(formatFactsMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '안내', facts, interpretation: judgment }));
  } catch (e) { console.error('텔레그램 알림 실패:', e.message); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ themis-risk-review 오류:', e.message); process.exit(1); });
}
