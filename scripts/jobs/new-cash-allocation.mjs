#!/usr/bin/env node
/**
 * 신규 현금 배분 — ARCHITECTURE-V2.md "신규 현금 배분 원칙" 절(2026-08-04 확정)의
 * Vault-native 구현. 구현계획서 Phase 8이 "신규 현금 배분(누적 50만원 트리거) 미구현"
 * 으로 열어둔 채 남겨뒀던 부분(2026-08-16 신설).
 *
 * 흐름(설계서 그대로):
 *   1. Facts/Ledger/Dividends·Profits(배당·매도체결로 생긴 현금)를 계좌별로 누적
 *      (cash-accumulator.mjs) — 매도는 실현손익이 아니라 전액(quantity*sellPrice)이
 *      새 현금이 된다.
 *   2. 계좌당(위탁·연금저축) 누적 50만원 이상이면: computeRebalanceGaps(전체 보유)로
 *      갭을 계산(rebalance-gap.mjs 재사용, 새 로직 안 만듦) → 그 계좌가 세금상 담을 수
 *      있는 자산군만 후보로 필터(cash-allocation-candidates.mjs, ARCHITECTURE-V2.md
 *      "원칙 2" 표를 그대로 상수화) → Athena 헤드리스 판단(갭 크기·후보만 주고 "어디에
 *      얼마씩"은 재량 — 고정공식 금지, [[feedback-no-hardcoded-judgment]]) →
 *      Decisions/Proposals + 텔레그램 제안(proposal-flow.mjs 재사용, 트랙 무관 공용
 *      함수라 새로 안 만듦).
 *   3. 제안 발송 성공 시에만 그 계좌의 누적을 리셋한다 — 실패(LLM 한도 등)하면 누적을
 *      그대로 남겨 다음 실행이 자연히 재시도한다(엣지 트리거가 아니라 레벨 조건으로
 *      매 실행 재확인 — 크로싱 순간에만 트리거하면 그 순간 LLM 호출이 실패할 때 영구
 *      누락될 위험이 있어 피함).
 *
 * ⚠️ 개별종목 배분 금지 — 위탁 레거시 개별종목(삼성전자 등) 전환은 오너 직접 판단
 * 영역(ARCHITECTURE-V2.md "정리된 항목과 그 이유" 표, 2026-08-02 확정 — 이 원칙을 안
 * 지키면 risk-b-monitor.mjs와 같은 실수 반복). Athena 에이전트 정의(athena.md)에 이미
 * "자산분배 트랙은 개별종목 신규 매수를 하지 않는다"가 있어 시스템프롬프트로 1차 방어,
 * 이 잡의 태스크 프롬프트에서도 명시적으로 재확인한다(방어 이중화).
 *
 * 승인·체결: 이 잡은 제안 생성·발송까지만 한다. 자산분배 트랙엔 자동 브로커 실행이
 * 없다(퀀트 트랙만 KIS API로 자동체결, Phase 9 확정) — Frank가 텔레그램 승인 답장 후
 * 본인이 직접 브로커 앱에서 주문하고, 그 체결이 카카오 알림으로 다시 Vault에 들어오는
 * 루프(parse-notifications-to-vault→update-holdings-from-executions)로 닫힌다.
 *
 * 사용법:
 *   node scripts/jobs/new-cash-allocation.mjs            # 실제 반영+제안 발송
 *   node scripts/jobs/new-cash-allocation.mjs --dry-run   # 누적 계산·프롬프트만, 쓰기 없음
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeStateFile, writeAtomic } from '../lib/state-writer.mjs';
import { applyCashEvents, resetAccumulator, NEW_CASH_THRESHOLD_WON, CASH_ELIGIBLE_ACCOUNTS } from '../lib/cash-accumulator.mjs';
import { rankEligibleGaps, findExistingInstruments, ACCOUNT_ELIGIBLE_ASSET_CLASSES } from '../lib/cash-allocation-candidates.mjs';
import { computeRebalanceGaps } from '../lib/rebalance-gap.mjs';
import { resolveExecutionAccount } from '../lib/account-resolver.mjs';
import { runHeadlessClaude, parseJsonBlock } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { createAndSendProposal } from '../lib/proposal-flow.mjs';
import { parseProposal } from '../lib/proposal-vault.mjs';
import { sendTelegram } from '../lib/telegram.mjs';

loadEnv();

const DRY_RUN = process.argv.includes('--dry-run');
const AGENT = loadAgent('athena', { fallbackModel: 'sonnet' });
if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;
const DEPARTMENT_LABEL = '투자전략실 Athena';

function readMdDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, filepath: join(dir, f), ...parseFrontmatter(readFileSync(join(dir, f), 'utf8')) }));
}

// Athena에게 줄 프롬프트 — 갭·후보(실존 보유)만 주고 "어디에 얼마씩"은 판단시킨다.
// 순수 함수(테스트 가능) — candidatesByClass: { [assetClass]: [{name,ticker,curPrice}] }.
export function buildCashAllocationPrompt({ account, accumulatedAmount, rankedGaps, candidatesByClass }) {
  const gapLines = rankedGaps.map((g) =>
    `  ${g.assetClass}: 목표 ${g.targetPct}% / 현재 ${g.currentPct.toFixed(2)}% (갭 ${g.absDeltaPct.toFixed(2)}%p, 부족)`,
  ).join('\n') || '  (이 계좌가 담을 수 있는 자산군 중 언더웨이트 없음)';

  const candLines = Object.entries(candidatesByClass).map(([cls, insts]) => {
    if (!insts.length) return `  [${cls}] 현재 이 계좌에 보유 없음 — 신규 ETF 제안 가능(가격 미확인)`;
    const lines = insts.map((h) => `    - ${h.name}${h.ticker ? `(${h.ticker})` : ''} 현재가 ${h.curPrice ?? '데이터 부족'}원`).join('\n');
    return `  [${cls}]\n${lines}`;
  }).join('\n');

  return `[신규 현금 배분 판단] ${account} 계좌에 배당·매도체결로 생긴 미투자 현금이 누적 ${accumulatedAmount.toLocaleString('ko-KR')}원(문턱 ${NEW_CASH_THRESHOLD_WON.toLocaleString('ko-KR')}원) 쌓였다. 어디에 얼마씩 배분할지 "판단"해줘.

[검증된 갭 — 시스템이 위탁+연금저축 합산 5/25 밴드 기준으로 계산한 값. 이 계좌가 세금상
 담을 수 있는 자산군만 후보로 이미 걸러져 있다. 재계산·재조회 금지, 이 숫자만 사용할 것]
${gapLines}

[이 계좌의 실존 보유 후보 — 새 종목을 지어내지 말고 최대한 이 목록 안에서 고를 것.
 마땅한 후보가 없는 자산군만 예외적으로 신규 ETF명을 제안할 수 있다(그 경우 quantity는
 시스템이 계산 못하니 amountWon만 명시)]
${candLines}

판단 규칙:
- ⚠️ 개별 회사 주식(삼성전자·엔비디아 등 레거시 전환 대상)에는 절대 배분하지 말 것 — ETF만.
- 갭이 가장 큰 자산군 하나에 몰아줘도 되고, 여러 자산군에 나눠도 된다(고정 비율 없음).
- allocations의 amountWon 합계는 ${accumulatedAmount}원을 넘지 말 것.
- instrumentName은 위 후보 목록의 이름을 정확히 그대로 쓸 것(새로 짓지 말 것) — 신규
  제안일 때만 새 ETF명 사용 가능.

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{
  "allocations": [
    {"assetClass":"국내주식","instrumentName":"...","amountWon":300000,"reasoning":"왜 이 자산군·종목인지"}
  ],
  "summary": "한줄 요약"
}
\`\`\``;
}

// LLM 응답 검증 — 후보에 없는 자산군·개별종목·합계초과는 여기서 드롭(THROW 아님, 나머지
// 유효한 라인은 살린다 — 부분 오염이 전체 제안을 막지 않게). 순수 함수.
export function validateAllocations(allocations, { account, accumulatedAmount, eligibleClasses }) {
  const kept = [], dropped = [];
  let remaining = accumulatedAmount;
  for (const a of allocations ?? []) {
    const assetClass = String(a?.assetClass ?? '').trim();
    const amountWon = Number(a?.amountWon);
    const instrumentName = String(a?.instrumentName ?? '').trim();
    if (!eligibleClasses.includes(assetClass)) { dropped.push({ a, reason: `${account} 계좌가 담을 수 없는 자산군: ${assetClass}` }); continue; }
    if (!instrumentName) { dropped.push({ a, reason: '종목명 없음' }); continue; }
    if (!Number.isFinite(amountWon) || amountWon <= 0) { dropped.push({ a, reason: '금액 값 이상' }); continue; }
    if (amountWon > remaining) { dropped.push({ a, reason: `누적잔여(${remaining}원) 초과 요청(${amountWon}원)` }); continue; }
    remaining -= amountWon;
    kept.push({ assetClass, instrumentName, amountWon, reasoning: String(a?.reasoning ?? '') });
  }
  return { kept, dropped };
}

// 후보 보유 중 이름이 정확히 일치하는 것 찾아 가격 정보를 붙인다 — 없으면(신규 제안)
// quantity·proposedPrice는 null(order-gate.checkPriceDeviation이 null을 "적용 대상 아님"
// 으로 이미 처리하므로 안전). 순수 함수.
export function resolveInstrumentPricing(allocation, candidates) {
  const match = candidates.find((h) => h.name === allocation.instrumentName);
  if (!match || !Number.isFinite(match.curPrice) || match.curPrice <= 0) {
    return { assetKey: allocation.instrumentName, ticker: '', quantity: null, proposedPrice: null };
  }
  const quantity = Math.floor(allocation.amountWon / match.curPrice);
  return { assetKey: match.ticker || match.name, ticker: match.ticker || '', quantity: quantity > 0 ? quantity : null, proposedPrice: match.curPrice };
}

// 배당·매도체결 파일 → 계좌별 이벤트 분류 + "처리됨(cashAccumApplied)" 표시 대상 파일 결정.
// 순수 함수(fs 없음, resolveAccount 주입 — 테스트 가능). 계좌 귀속이 **확정**된 파일만
// processedFilepaths에 넣는다 — 확정이면 범위 밖(ISA·IRP)이어도 다시 안 볼 파일이라 표시,
// 확정 자체가 안 된(resolveAccount가 null 반환 — 같은 이름 상품이 위탁·ISA 양쪽에 있어
// 못 좁히는 등) 파일은 표시하지 않아 다음 실행이 자연히 재확인한다(2026-08-17 코드리뷰
// MEDIUM 지적 — 예전엔 귀속 여부와 무관하게 전부 처리됨으로 찍어, 모호했던 배당의 현금이
// 나중에 보유정보가 갱신돼 귀속이 풀려도 영원히 트래킹에서 빠져 있었다).
export function classifyCashEvents({ dividendFiles, profitFiles, holdings, resolveAccount = resolveExecutionAccount }) {
  const eventsByAccount = { 위탁: [], 연금저축: [] };
  const processedFilepaths = [];

  for (const d of dividendFiles) {
    const account = resolveAccount({ broker: d.broker, stockName: d.stockName, stockCode: null, acctNo: d.acctRaw }, holdings);
    if (account == null) continue; // 귀속 모호 — 처리됨 표시 안 함(다음 실행 재시도)
    processedFilepaths.push(d.filepath);
    if (!CASH_ELIGIBLE_ACCOUNTS.has(account)) continue; // ISA·IRP 등 — 확정 계좌이나 범위 밖
    eventsByAccount[account].push({ dedupKey: d.dedupKey, amount: d.afterTaxAmount });
  }
  for (const p of profitFiles) {
    // 실현손익 파일은 매도 시점에 계좌 귀속이 이미 끝난 뒤에만 생성된다(ledger-vault-writer.mjs
    // buildProfitRecord 계약) — account가 null일 수 없어 배당과 달리 모호 케이스가 없다.
    processedFilepaths.push(p.filepath);
    if (!CASH_ELIGIBLE_ACCOUNTS.has(p.account)) continue;
    const proceeds = (p.quantity ?? 0) * (p.sellPrice ?? 0);
    eventsByAccount[p.account].push({ dedupKey: p.dedupKey, amount: proceeds });
  }
  return { eventsByAccount, processedFilepaths };
}

// 배분 라인 발송 결과가 전부 'created'(실제 발송 성공)여야 누적을 리셋한다 — 'blocked'
// (거부 재상정 쿨다운 등, order-gate.resolveProposalIntake)도 미발송이므로 리셋 대상이
// 아니다(2026-08-17 코드리뷰 MEDIUM 지적 — 예전엔 예외(throw)만 실패로 잡아, 전부
// blocked인 배치도 "실패 없음"으로 오판해 아직 못 보낸 현금의 누적을 지워버렸다).
export function allAllocationsSent(sendResults) {
  return sendResults.length > 0 && sendResults.every((r) => r.action === 'created');
}

function loadExistingProposals(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const content = readFileSync(join(dir, f), 'utf8');
    return { filename: f, content, ...parseProposal(content) };
  });
}

function readAccumulator(account) {
  const p = join(VAULT_PATHS.state.cashAccumulator, `${account}.md`);
  if (!existsSync(p)) return null;
  return parseFrontmatter(readFileSync(p, 'utf8'));
}

async function writeAccumulator(account, state) {
  const content = buildFrontmatter({
    type: 'cash-accumulator', account,
    accumulatedAmount: state.accumulatedAmount,
    appliedDedupKeys: JSON.stringify(state.appliedDedupKeys),
    updatedAt: new Date().toISOString(),
  });
  if (!DRY_RUN) {
    mkdirSync(VAULT_PATHS.state.cashAccumulator, { recursive: true });
    await writeStateFile(join(VAULT_PATHS.state.cashAccumulator, `${account}.md`), content);
  }
}

function parseAppliedDedupKeys(raw) {
  try { const v = JSON.parse(raw?.appliedDedupKeys ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

async function main() {
  console.log('💰 new-cash-allocation — 신규 현금 배분 점검');
  if (DRY_RUN) console.log('   (--dry-run: 쓰기·발송 없음)');

  const holdings = readMdDir(VAULT_PATHS.state.holdings);
  // legacy(Phase 7 마이그레이션 스냅샷)는 제외 — update-holdings-from-executions.mjs의
  // pickUnprocessedExecutions와 동일 원칙(그 시점 스냅샷이 이미 State로 반영됐으므로,
  // 그 과거 이벤트를 지금 다시 "새 현금"으로 세면 안 됨). 대부분 account:null이라
  // resolveExecutionAccount가 우연히 걸러주지만(broker 필드 자체가 없음), 우연에 기대지
  // 않고 명시적으로 제외한다.
  const dividendFiles = readMdDir(VAULT_PATHS.facts.ledger.dividends).filter((d) => !d.legacy && !d.cashAccumApplied);
  const profitFiles = readMdDir(VAULT_PATHS.facts.ledger.profits).filter((p) => !p.legacy && !p.cashAccumApplied);
  console.log(`🔎 미처리 배당 ${dividendFiles.length}건 · 매도실현 ${profitFiles.length}건`);

  const { eventsByAccount, processedFilepaths: processedFiles } = classifyCashEvents({ dividendFiles, profitFiles, holdings });

  let existingProposals = null;
  for (const account of CASH_ELIGIBLE_ACCOUNTS) {
    const existing = readAccumulator(account);
    const existingState = existing ? { accumulatedAmount: existing.accumulatedAmount ?? 0, appliedDedupKeys: parseAppliedDedupKeys(existing) } : null;
    const updated = applyCashEvents(existingState, eventsByAccount[account]);
    if (updated.addedCount > 0) console.log(`  ${account}: 신규 이벤트 ${updated.addedCount}건 반영 → 누적 ${updated.accumulatedAmount.toLocaleString('ko-KR')}원${updated.crossed ? ' 🔔 문턱 최초 돌파' : ''}`);
    await writeAccumulator(account, updated);

    if (updated.accumulatedAmount < NEW_CASH_THRESHOLD_WON) continue;
    console.log(`\n💡 ${account} 누적 ${updated.accumulatedAmount.toLocaleString('ko-KR')}원 — 배분 판단 시작`);

    const { gaps } = computeRebalanceGaps(holdings);
    const rankedGaps = rankEligibleGaps(gaps, account);
    const eligibleClasses = ACCOUNT_ELIGIBLE_ASSET_CLASSES[account];
    const candidatesByClass = Object.fromEntries(eligibleClasses.map((c) => [c, findExistingInstruments(holdings, account, c)]));

    const prompt = buildCashAllocationPrompt({ account, accumulatedAmount: updated.accumulatedAmount, rankedGaps, candidatesByClass });
    if (DRY_RUN) { console.log(`\n┌─── 프롬프트 [${account}] ───┐\n${prompt}\n└──────────────────┘`); continue; }

    let allocations;
    try {
      const r = parseJsonBlock(await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt }));
      const { kept, dropped } = validateAllocations(r.allocations, { account, accumulatedAmount: updated.accumulatedAmount, eligibleClasses });
      dropped.forEach((d) => console.log(`  ⚠️ 배분 라인 드롭: ${d.reason}`));
      allocations = kept;
    } catch (e) {
      if (e.isLimit) { console.log(`  ⏳ 사용량 한도 → 배분 판단 보류(누적은 유지, 다음 실행 재시도).`); continue; }
      console.error(`  ❌ ${account} 배분 판단 실패: ${e.message} — 누적 유지, 다음 실행 재시도`);
      continue;
    }
    if (!allocations.length) { console.log(`  ⚠️ 유효한 배분 라인 없음 — 누적 유지, 다음 실행 재시도`); continue; }

    existingProposals ??= loadExistingProposals(VAULT_PATHS.decisions.proposals);
    const sendResults = [];
    for (const alloc of allocations) {
      const candidates = candidatesByClass[alloc.assetClass] ?? [];
      const pricing = resolveInstrumentPricing(alloc, candidates);
      try {
        const result = await createAndSendProposal({
          track: '자산분배', account, assetKey: pricing.assetKey, name: alloc.instrumentName,
          side: '매수', quantity: pricing.quantity, proposedPrice: pricing.proposedPrice,
          reason: alloc.reasoning, departmentLabel: DEPARTMENT_LABEL,
          existingProposals,
          writeProposalFile: (filename, content) => writeStateFile(join(VAULT_PATHS.decisions.proposals, filename), content),
          sendMessage: (text) => sendTelegram(text).then((r) => r?.result ?? r),
        });
        if (result.action === 'blocked') {
          console.log(`  ⛔ ${alloc.instrumentName} 제안 차단: ${result.reason}`);
          sendResults.push({ action: 'blocked' });
          continue;
        }
        console.log(`  ✅ 제안 발송: ${alloc.assetClass} → ${alloc.instrumentName} ${alloc.amountWon.toLocaleString('ko-KR')}원`);
        existingProposals.push({ filename: result.filename, ...parseProposal(readFileSync(join(VAULT_PATHS.decisions.proposals, result.filename), 'utf8')) });
        sendResults.push({ action: 'created' });
      } catch (e) {
        console.error(`  ❌ ${alloc.instrumentName} 제안 발송 실패: ${e.message}`);
        sendResults.push({ action: 'failed' });
      }
    }
    if (allAllocationsSent(sendResults)) {
      await writeAccumulator(account, resetAccumulator());
      console.log(`  🔄 ${account} 누적 리셋 완료`);
    } else {
      console.log(`  ⚠️ 일부 미발송(차단·실패) — 누적 유지(다음 실행 재시도, 이미 보낸 제안은 단일활성제안 원칙으로 중복 방지됨)`);
    }
  }

  if (!DRY_RUN) {
    for (const filepath of processedFiles) {
      const content = readFileSync(filepath, 'utf8');
      writeAtomic(filepath, updateFrontmatter(content, { cashAccumApplied: true, cashAccumAppliedAt: new Date().toISOString() }));
    }
  }
  console.log('\n🏁 완료');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ new-cash-allocation 오류:', e.message); process.exit(1); });
}
