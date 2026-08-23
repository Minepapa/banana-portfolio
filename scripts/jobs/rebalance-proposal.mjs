#!/usr/bin/env node
/**
 * 자동 리밸런싱 제안 — 자산분배 트랙 최소개입 자동화 계획 Part 3(2026-08-23, 오너 지시).
 *
 * ⚠️ 메꾸는 공백 — daily-asset-allocation-check.mjs(평일 16:30)는 5/25 밴드 이탈을
 * 매일 점검하지만 텔레그램 알림만 보내고 끝난다(Proposal 생성 없음, "새 판정 로직을
 * 만들지 않는다"는 그 잡의 명시적 설계 원칙). 지금까지는 이탈 알림을 받은 뒤 오너가
 * 직접 "리밸런싱안 줘"라고 물어야만 실제 매수/매도 제안이 나왔다 — 신규현금배분
 * (new-cash-allocation.mjs)은 이미 완전 자동인데 순수 밴드이탈만 이 구멍이 있었다.
 * 이 잡이 그 구멍을 메운다 — new-cash-allocation.mjs와 같은 골격(Node 사실계산 →
 * Athena 헤드리스 판단 → createAndSendProposal)이지만 별도 파일이다
 * (daily-asset-allocation-check.mjs는 "LLM 호출 없음"이 설계 원칙이라 여기 못 얹음).
 *
 * 트리거·중복방지 — 평일 16:32 KST(daily-asset-allocation-check 16:30 직후, 그날 최신
 * 데이터 확보 후). 분기가 아니라 매일 검사한다 — 5/25 밴드 이탈은 시세 이벤트지 캘린더
 * 이벤트가 아니라 분기까지 기다리면 방치된다. 대신 State/RebalanceProposal/
 * last-triggered.md에 "이탈 자산군 집합의 지문"(자산군+이탈유형+방향)을 저장해 지난번과
 * 똑같으면 Athena 호출·발송을 생략한다(new-cash-allocation.mjs의 CashAccumulator
 * dedup과 동일 원리 — 비용은 여기서 잡힌다).
 *
 * 분할매수(오너 지적 반영) — Athena가 프롬프트 지시를 어겨도 "갭 전체를 한 번에 채우기"가
 * 물리적으로 불가능하도록 validateRebalanceActions가 각 자산군 갭의 최대 50%로
 * 하드 캡을 건다. 갭이 매번 절반씩만 줄어드는 자연스러운 단계적 접근이 되고, 잔여 갭이
 * 남아있으니(지문이 안 사라짐) 다음 실행에서 자동으로 이어서 제안된다. 달러 자산군은
 * 미국달러ETF·엔선물ETF 두 상품에 나눠 담으라고 프롬프트에 명시(오너의 구체적 상품 계획).
 *
 * 승인·체결: new-cash-allocation.mjs와 동일 원칙 — 이 잡은 제안 생성·발송까지만 한다.
 * 실제 체결은 오너가 직접(자산분배 트랙엔 자동 브로커 실행이 없음, proposal-execution-
 * reminder.mjs가 미체결을 리마인드로 보완).
 *
 * ⚠️ 알려진 한계(new-cash-allocation.mjs와 공유) — 이 리밸런싱은 매도 방향(초과 자산군)도
 * 다루는데, 매도 후보 목록에 위탁 레거시 개별종목(삼성전자 등)이 실보유로 그대로
 * 섞여 나온다(Vault holdings 스키마에 ETF/개별주식을 구분하는 필드가 없어 Node가
 * 구조적으로 걸러낼 수 없음 — 이름 패턴 추정은 "추정 금지" 원칙 위반). "절대 제안하지
 * 말 것" 지시는 프롬프트+Athena 시스템프롬프트(athena.md) 이중 방어뿐, Node 하드가드는
 * 없다 — new-cash-allocation.mjs의 매수 후보 목록도 동일한 한계를 이미 갖고 있다(기존
 * 운영 중인 위험을 그대로 물려받음, 이번에 새로 만든 구멍이 아님).
 *
 * 사용법:
 *   node scripts/jobs/rebalance-proposal.mjs            # 실제 판단+발송
 *   node scripts/jobs/rebalance-proposal.mjs --dry-run  # 지문·프롬프트까지, 발송 없음
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { computeRebalanceGaps, normalizeAccount } from '../lib/rebalance-gap.mjs';
import { ACCOUNT_ELIGIBLE_ASSET_CLASSES, findExistingInstruments } from '../lib/cash-allocation-candidates.mjs';
import { runHeadlessClaude, parseJsonBlock } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { createAndSendProposal } from '../lib/proposal-flow.mjs';
import { parseProposal } from '../lib/proposal-vault.mjs';
import { sendTelegram } from '../lib/telegram.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const DEPARTMENT_LABEL = '투자전략실 Athena';
const IN_SCOPE_ACCOUNTS = ['위탁', '연금저축'];
const CAP_FRACTION = 0.5; // 갭의 최대 50%만 한 번에 제안(분할매수 하드 캡)
const STATE_DIR = join(VAULT_PATHS.root, 'State', 'RebalanceProposal');
const STATE_FILE = join(STATE_DIR, 'last-triggered.md');

function readMdDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, filepath: join(dir, f), ...parseFrontmatter(readFileSync(join(dir, f), 'utf8')) }));
}

// 순수함수 — 이탈된 자산군마다 방향(초과/부족)·갭금액(원)·매도후보(과대보유쪽 실보유,
// 계좌태그 포함)·매수후보(과소보유쪽, 계좌별 세금자격 기준)를 계산. Node는 여기까지만 —
// 구체적으로 뭘 얼마나 팔고 살지는 Athena 재량(rebalance-gap.mjs 헤더 주석과 동일 경계).
export function buildBreachFacts(holdings, gaps, totalEval) {
  const breached = gaps.filter((g) => g.breached);
  return breached.map((g) => {
    const direction = g.absDeltaPct > 0 ? '초과' : '부족';
    const gapWon = Math.round(((g.targetPct - g.currentPct) / 100) * totalEval); // 음수=팔아야, 양수=사야
    if (direction === '초과') {
      const sellCandidates = holdings
        .filter((h) => IN_SCOPE_ACCOUNTS.includes(normalizeAccount(h.account)) && h.assetClass === g.assetClass)
        .map((h) => ({ account: normalizeAccount(h.account), name: h.name, ticker: h.ticker, qty: h.qty, curPrice: h.curPrice, evalAmount: h.evalAmount }));
      return { ...g, direction, gapWon, sellCandidates };
    }
    const buyCandidatesByAccount = {};
    for (const account of IN_SCOPE_ACCOUNTS) {
      if (ACCOUNT_ELIGIBLE_ASSET_CLASSES[account]?.includes(g.assetClass)) {
        buyCandidatesByAccount[account] = findExistingInstruments(holdings, account, g.assetClass);
      }
    }
    return { ...g, direction, gapWon, buyCandidatesByAccount };
  });
}

// 순수함수 — 이탈 자산군 집합의 지문(자산군+이탈유형+방향+갭크기버킷, 정렬됨). 지난번과
// 같으면 재트리거 안 함 — 방향이 뒤집히거나(초과↔부족) 갭 크기가 1%p 이상 바뀌면 다른
// 지문이 돼 다시 트리거된다. 갭버킷이 없으면(2026-08-23 코드리뷰 지적) 50% 캡으로 절반만
// 사서 갭이 줄어도 breachType·direction이 그대로면 지문이 안 바뀌어 "잔여 갭은 다음
// 실행에서 이어서 제안"이 실제로는 영원히 멈춘다 — 분할매수의 핵심 전제가 깨지는 버그.
export function computeBreachFingerprint(breachFacts) {
  return JSON.stringify(
    breachFacts
      .map((b) => [b.assetClass, b.breachType, b.direction, Math.round(b.absDeltaPct)])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

// 순수함수 — Athena에게 줄 프롬프트. 이탈 사실·후보만 주고 "구체적으로 뭘 얼마나
// 팔고 살지"만 판단시킨다(rebalance-gap.mjs 헤더 주석의 경계와 동일).
export function buildRebalanceProposalPrompt(breachFacts) {
  const sections = breachFacts.map((b) => {
    const header = `[${b.assetClass}] 목표 ${b.targetPct}% / 현재 ${b.currentPct.toFixed(2)}% — ${b.direction}(갭 약 ${Math.abs(b.gapWon).toLocaleString('ko-KR')}원)`;
    if (b.direction === '초과') {
      const lines = b.sellCandidates.length
        ? b.sellCandidates.map((h) => `    - [${h.account}] ${h.name} ${h.qty}주 @${h.curPrice ?? '?'}원 (평가액 ${h.evalAmount?.toLocaleString('ko-KR') ?? '?'}원)`).join('\n')
        : '    (실보유 없음 — 이 방향은 제안하지 말 것)';
      return `${header}\n  매도 후보(실보유):\n${lines}`;
    }
    const accLines = Object.entries(b.buyCandidatesByAccount).map(([acc, insts]) => {
      if (!insts.length) return `    [${acc}] 현재 보유 없음 — 신규 ETF 제안 가능(가격 미확인)`;
      const lines = insts.map((h) => `      - ${h.name}${h.ticker ? `(${h.ticker})` : ''} 현재가 ${h.curPrice ?? '데이터 부족'}원`).join('\n');
      return `    [${acc}]\n${lines}`;
    }).join('\n');
    return `${header}\n  매수 후보(계좌별, 세금상 담을 수 있는 곳만):\n${accLines || '    (담을 수 있는 계좌 없음)'}`;
  }).join('\n\n');

  return `[자동 리밸런싱 제안] 아래 자산군들이 5/25 밴드를 이탈했다(재조회·추정 금지, 이 숫자만 사용).

${sections}

판단 규칙:
- 개별 회사 주식(삼성전자·SK하이닉스 등)은 매수·매도 후보 목록에 섞여 나올 수 있지만
  **절대 제안하지 마라 — 매도 후보로 나온 개별주식도 대상이 아니다.** 위탁 레거시
  개별종목의 전환 시점·방향은 오너 직접 판단 영역이라 이 시스템이 관여하지 않는다.
  후보 중 ETF(펀드형 상품)만 골라라.
- **이탈 금액 전체를 한 번에 채우려 하지 마라.** 이번엔 갭의 절반 정도만 제안하고
  나머지는 다음 기회로 남겨라 — 시스템이 어차피 매일 재점검해 이어서 제안한다.
- **"달러" 자산군을 채울 때는 미국달러ETF와 엔선물ETF 두 상품에 나눠 담아라**(한쪽에
  몰지 말 것) — 통화 하나에 타이밍 리스크를 몰아주지 않기 위함.
- instrumentName은 후보 목록의 이름을 정확히 그대로 쓸 것(신규 제안일 때만 새 ETF명).
- side는 그 자산군의 방향과 정확히 일치해야 한다("초과"면 "매도"만, "부족"이면 "매수"만).
- reasoning은 네(아테나) 성격대로 — 왜 이 계좌·종목·타이밍인지 1~2문장, Frank에게
  텔레그램으로 그대로 전달된다.

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{
  "actions": [
    {"assetClass":"국내주식","side":"매도","account":"위탁","instrumentName":"...","amountWon":300000,"reasoning":"..."}
  ],
  "summary": "한줄 요약"
}
\`\`\``;
}

// 순수함수 — LLM 응답 검증(new-cash-allocation.mjs validateAllocations와 동일 철학:
// 드롭이지 throw 아님, 부분 오염이 전체를 막지 않음) + 분할매수 하드 캡.
export function validateRebalanceActions(actions, { breachFacts, holdings }) {
  const breachByClass = Object.fromEntries(breachFacts.map((b) => [b.assetClass, b]));
  const remainingCap = Object.fromEntries(breachFacts.map((b) => [b.assetClass, Math.abs(b.gapWon) * CAP_FRACTION]));
  const kept = [], dropped = [];
  for (const a of actions ?? []) {
    const assetClass = String(a?.assetClass ?? '').trim();
    const side = String(a?.side ?? '').trim();
    const account = String(a?.account ?? '').trim();
    const instrumentName = String(a?.instrumentName ?? '').trim();
    let amountWon = Number(a?.amountWon);

    const breach = breachByClass[assetClass];
    if (!breach) { dropped.push({ a, reason: `이탈 집합 밖 자산군: ${assetClass}` }); continue; }
    const expectedSide = breach.direction === '초과' ? '매도' : '매수';
    if (side !== expectedSide) { dropped.push({ a, reason: `방향 불일치(${assetClass}은 "${expectedSide}"만 가능)` }); continue; }
    if (!IN_SCOPE_ACCOUNTS.includes(account)) { dropped.push({ a, reason: `부적격 계좌: ${account}` }); continue; }
    if (!instrumentName) { dropped.push({ a, reason: '종목명 없음' }); continue; }
    if (!Number.isFinite(amountWon) || amountWon <= 0) { dropped.push({ a, reason: '금액 값 이상' }); continue; }

    if (side === '매수' && !ACCOUNT_ELIGIBLE_ASSET_CLASSES[account]?.includes(assetClass)) {
      dropped.push({ a, reason: `${account} 계좌가 담을 수 없는 자산군: ${assetClass}` }); continue;
    }
    let heldEval = null;
    if (side === '매도') {
      const held = holdings.find((h) => normalizeAccount(h.account) === account && h.assetClass === assetClass && h.name === instrumentName);
      if (!held) { dropped.push({ a, reason: `실보유 없음(매도 불가): [${account}] ${instrumentName}` }); continue; }
      heldEval = held.evalAmount ?? 0;
      if (amountWon > heldEval) amountWon = heldEval; // 보유액 초과 매도 방지
      if (heldEval <= 0) { dropped.push({ a, reason: `보유평가액 0 이하(매도 불가): [${account}] ${instrumentName}` }); continue; }
    }

    const remaining = remainingCap[assetClass] ?? 0;
    if (remaining <= 0) { dropped.push({ a, reason: `분할매수 캡(갭의 ${CAP_FRACTION * 100}%) 이미 소진: ${assetClass}` }); continue; }
    if (amountWon > remaining) amountWon = remaining; // 초과분은 드롭이 아니라 캡까지 축소
    remainingCap[assetClass] = remaining - amountWon;

    kept.push({ assetClass, side, account, instrumentName, amountWon, reasoning: String(a?.reasoning ?? '') });
  }
  return { kept, dropped };
}

// 순수함수 — 확정된 action의 실제 보유(가격·수량) 조회해 quantity·proposedPrice 산출.
// new-cash-allocation.mjs resolveInstrumentPricing과 동일 철학(신규 매수 후보는
// quantity/proposedPrice null → order-gate가 "적용 대상 아님"으로 안전 처리).
export function resolveRebalanceInstrumentPricing(action, holdings) {
  const match = holdings.find((h) => normalizeAccount(h.account) === action.account && h.assetClass === action.assetClass && h.name === action.instrumentName);
  if (!match || !Number.isFinite(match.curPrice) || match.curPrice <= 0) {
    return { assetKey: action.instrumentName, ticker: '', quantity: null, proposedPrice: null };
  }
  const quantity = Math.floor(action.amountWon / match.curPrice);
  return { assetKey: match.ticker || match.name, ticker: match.ticker || '', quantity: quantity > 0 ? quantity : null, proposedPrice: match.curPrice };
}

function readLastFingerprint() {
  if (!existsSync(STATE_FILE)) return null;
  const fm = parseFrontmatter(readFileSync(STATE_FILE, 'utf8'));
  return fm.fingerprint ?? null;
}

async function writeLastFingerprint(fingerprint) {
  if (DRY_RUN) return;
  mkdirSync(STATE_DIR, { recursive: true });
  await writeStateFile(STATE_FILE, buildFrontmatter({ type: 'rebalance-proposal-state', fingerprint, updatedAt: new Date().toISOString() }));
}

function clearLastFingerprint() {
  if (DRY_RUN || !existsSync(STATE_FILE)) return;
  writeStateFile(STATE_FILE, buildFrontmatter({ type: 'rebalance-proposal-state', fingerprint: null, updatedAt: new Date().toISOString() }));
}

function loadExistingProposals(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const content = readFileSync(join(dir, f), 'utf8');
    return { filename: f, content, ...parseProposal(content) };
  });
}

// 발송 라인이 전부 성공(created)이어야 지문을 갱신한다 — new-cash-allocation.mjs
// allAllocationsSent와 동일 원칙(부분 실패는 다음 실행 재시도).
export function allActionsSent(sendResults) {
  return sendResults.length > 0 && sendResults.every((r) => r.action === 'created');
}

async function main() {
  loadEnv();
  const AGENT = loadAgent('athena', { fallbackModel: 'sonnet' });
  if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
  const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;

  console.log('⚖️  rebalance-proposal — 5/25 밴드 이탈 자동 리밸런싱 제안 점검');
  if (DRY_RUN) console.log('   (--dry-run: 쓰기·발송 없음)');

  const holdings = readMdDir(VAULT_PATHS.state.holdings);
  const { gaps, totalEval } = computeRebalanceGaps(holdings);
  const breachFacts = buildBreachFacts(holdings, gaps, totalEval);

  if (!breachFacts.length) {
    console.log('  ✅ 이탈 없음 — 조용히 종료');
    clearLastFingerprint();
    return;
  }

  const fingerprint = computeBreachFingerprint(breachFacts);
  const lastFingerprint = readLastFingerprint();
  if (fingerprint === lastFingerprint) {
    console.log('  → 지난번과 동일한 이탈 집합 — 재트리거 안 함(이미 제안 발송됨, 오너 응답 대기 중)');
    return;
  }

  console.log(`  이탈 자산군 ${breachFacts.length}개: ${breachFacts.map((b) => `${b.assetClass}(${b.direction})`).join(', ')}`);

  const prompt = buildRebalanceProposalPrompt(breachFacts);
  if (DRY_RUN) { console.log(`\n┌─── 프롬프트 ───┐\n${prompt}\n└──────────────────┘`); return; }

  let actions;
  try {
    const r = parseJsonBlock(await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt }));
    const { kept, dropped } = validateRebalanceActions(r.actions, { breachFacts, holdings });
    dropped.forEach((d) => console.log(`  ⚠️ 액션 드롭: ${d.reason}`));
    actions = kept;
  } catch (e) {
    if (e.isLimit) { console.log('  ⏳ 사용량 한도 → 판단 보류(다음 실행 재시도).'); return; }
    console.error(`  ❌ 리밸런싱 판단 실패: ${e.message} — 다음 실행 재시도`);
    return;
  }
  if (!actions.length) { console.log('  ⚠️ 유효한 액션 없음 — 다음 실행 재시도'); return; }

  let existingProposals = loadExistingProposals(VAULT_PATHS.decisions.proposals);
  const sendResults = [];
  for (const action of actions) {
    const pricing = resolveRebalanceInstrumentPricing(action, holdings);
    try {
      const result = await createAndSendProposal({
        track: '자산분배', account: action.account, assetKey: pricing.assetKey, name: action.instrumentName,
        side: action.side, quantity: pricing.quantity, proposedPrice: pricing.proposedPrice,
        amountWon: action.amountWon,
        reason: action.reasoning, departmentLabel: DEPARTMENT_LABEL,
        existingProposals,
        writeProposalFile: (filename, content) => writeStateFile(join(VAULT_PATHS.decisions.proposals, filename), content),
        sendMessage: (text) => sendTelegram(text).then((r) => r?.result ?? r),
      });
      if (result.action === 'blocked') {
        console.log(`  ⛔ ${action.instrumentName} 제안 차단: ${result.reason}`);
        sendResults.push({ action: 'blocked' });
        continue;
      }
      console.log(`  ✅ 제안 발송: [${action.account}] ${action.side} ${action.instrumentName} ${action.amountWon.toLocaleString('ko-KR')}원`);
      existingProposals.push({ filename: result.filename, ...parseProposal(readFileSync(join(VAULT_PATHS.decisions.proposals, result.filename), 'utf8')) });
      sendResults.push({ action: 'created' });
    } catch (e) {
      console.error(`  ❌ ${action.instrumentName} 제안 발송 실패: ${e.message}`);
      sendResults.push({ action: 'failed' });
    }
  }

  if (allActionsSent(sendResults)) {
    await writeLastFingerprint(fingerprint);
    console.log('  🔄 이탈 지문 갱신 — 이 집합으로는 재트리거 안 함(잔여 갭은 다음 실행에서 새 지문으로 이어서 제안)');
  } else {
    console.log('  ⚠️ 일부 미발송(차단·실패) — 지문 미갱신(다음 실행 재시도)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ rebalance-proposal 오류:', e.message); process.exit(1); });
}
