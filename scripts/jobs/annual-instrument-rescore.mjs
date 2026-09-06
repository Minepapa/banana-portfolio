#!/usr/bin/env node
/**
 * 연 1회 보유 ETF 재스코어링 — "자산분배 트랙 핵심 로직 설계" §3(2026-09-06, 오너 지시
 * "가장 중요한 로직"). 지금까지 신규 매수 시 한 번 고른 ETF는 그 뒤로 다시 검증 안 됨 —
 * 보수율이 더 싸거나 유동성이 더 좋은 대안이 나와도 시스템이 알 방법이 없었다. 이 잡이
 * 연 1회, 계좌+자산군별로 "지금 보유 중인 종목"과 "유니버스(ASSET_CLASS_ETF_UNIVERSE)의
 * 대안들"을 같은 4축(scripts/lib/instrument-scoring.mjs)으로 재스코어링해 격차가 크면
 * Athena에게 "유지 vs 교체" 판단을 요청한다.
 *
 * ⚠️ 새 "현재 선택된 종목" 상태 파일은 없다 — findExistingInstruments가 State/Holdings를
 * 그대로 읽는 게 이미 정본이다. 필요한 건 "연 1회만 실행" cadence 상태뿐
 * (State/InstrumentRescoring/last-year.md) — quarterly-allocation-review.mjs의
 * getQuarterLabel/shouldRunToday와 같은 패턴을 연 단위로 옮긴 것. 1월 분기점검과 같은
 * 캘린더 창(1~3일 첫 평일)에 걸리지만 별도 스크립트·별도 상태 파일로 완전히 분리한다
 * (실패 격리 — 하나가 죽어도 다른 하나는 영향 없음).
 *
 * 게이트 순서(2026-09-06 설계 확정) — Node가 먼저 순수 숫자로 걸러낸다(scoreDelta가
 * RESCORE_THRESHOLD 미만이면 LLM 호출 자체를 안 함, 비용 낭비 방지 + "숫자로 판단
 * 가능한 건 LLM에 안 맡긴다" 원칙). 격차가 크면 그때부터 Athena(LLM)에게 "유지 vs
 * 교체"를 묻는다 — 위탁 매도 시 세금·회전비용 같은 정성적 트레이드오프는 진짜 판단
 * 영역이라 이건 LLM 몫(scripts/lib/instrument-scoring.mjs는 그 숫자만 준다).
 *
 * ASSET_CLASS_ETF_UNIVERSE·EXPENSE_RATIO_TABLE이 비어있는 동안(오너가 아직 안 채움)은
 * 이 잡이 비교 대상 자체가 없어 조용히 스킵한다 — 0으로 추정하지 않는다.
 *
 * 사용법:
 *   node scripts/jobs/annual-instrument-rescore.mjs            # 실제 판단+발송(연 1회 캘린더 창에서만)
 *   node scripts/jobs/annual-instrument-rescore.mjs --dry-run  # 재스코어링·프롬프트까지, 발송 없음
 *   node scripts/jobs/annual-instrument-rescore.mjs --force    # 연 dedup 무시하고 강제 실행(수동 테스트용)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic, writeStateFile } from '../lib/state-writer.mjs';
import { ACCOUNT_ELIGIBLE_ASSET_CLASSES, findExistingInstruments } from '../lib/cash-allocation-candidates.mjs';
import { computeInstrumentScore, rankAssetClassUniverse } from '../lib/instrument-scoring.mjs';
import { fetchEtfSeries } from '../lib/krx.mjs';
import { runHeadlessClaude, parseJsonBlock } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { createAndSendProposal } from '../lib/proposal-flow.mjs';
import { parseProposal } from '../lib/proposal-vault.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { isProposalBlocked } from '../lib/proposal-mode.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const DEPARTMENT_LABEL = '투자전략실 Athena';
const IN_SCOPE_ACCOUNTS = ['위탁', '연금저축'];
const SERIES_DAYS = 60; // instrument-scoring.mjs scoreTrackingError와 같은 여유(3일 최소 요구보다 넉넉히)
const RESCORE_THRESHOLD = 10; // 1차 placeholder(100점 만점) — 오너가 나중에 조정
const STATE_DIR = join(VAULT_PATHS.root, 'State', 'InstrumentRescoring');
const STATE_FILE = join(STATE_DIR, 'last-year.md');

// 순수함수 — KST 기준 연도 라벨. 테스트 가능.
export function getYearLabel(date) {
  return String(date.getFullYear());
}

// 순수함수 — 오늘 이 잡을 실제로 돌려야 하는지: 1월 1~3일 중 평일이고, 올해 아직
// 실행 기록이 없을 때만(quarterly-allocation-review.mjs shouldRunToday와 동일 원리,
// 분기시작월 집합 대신 1월 고정 + 연 단위 dedup).
export function shouldRunThisYear(date, lastYearLabel) {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const dow = date.getDay();
  if (month !== 1 || day > 3) return false;
  if (dow === 0 || dow === 6) return false;
  return getYearLabel(date) !== lastYearLabel;
}

function readLastYear() {
  if (!existsSync(STATE_FILE)) return null;
  return parseFrontmatter(readFileSync(STATE_FILE, 'utf8')).year ?? null;
}

function writeLastYear(year) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeAtomic(STATE_FILE, buildFrontmatter({ type: 'annual-instrument-rescore-state', year, updatedAt: new Date().toISOString() }));
}

// 순수함수 — 보유 종목 점수(computeInstrumentScore 반환 모양) vs 유니버스 대안 순위
// (rankInstruments 반환 배열, 이미 정렬됨)를 비교해 "재검토가 필요할 만큼 격차가
// 큰지"만 판단한다. LLM 호출 여부를 정하는 순수 숫자 게이트 — 여기서 "유지/교체"까지
// 정하지 않는다(그건 Athena 몫). 보유 종목 자체가 유니버스 최상위 후보와 같으면(이미
// 최선을 들고 있음) 그 다음으로 좋은 대안과 비교한다.
export function evaluateRescoreCandidate(heldScore, rankedAlternatives, threshold = RESCORE_THRESHOLD) {
  if (heldScore.composite == null) return { needsReview: false, reason: '보유 종목 스코어링 불가(데이터 부족)' };
  const bestAlternative = rankedAlternatives.find((r) => r.name !== heldScore.name && r.composite != null);
  if (!bestAlternative) return { needsReview: false, reason: '비교할 유니버스 대안 없음' };
  // 코드리뷰 지적(2026-09-06, MEDIUM) — computeInstrumentScore는 데이터 있는 축만
  // 가중평균(가중치 재분배)하므로, 보유 종목이 3축으로 계산된 점수와 대안이 4축으로
  // 계산된 점수는 서로 다른 척도라 직접 뺄셈하면 안 된다(사과 대 오렌지). 두 축 구성이
  // 다르면 공정 비교가 불가능하다고 보고 재검토 자체를 하지 않는다 — 억지로 보정하지
  // 않는다(추정 대신 드러냄 원칙).
  const heldGaps = [...heldScore.dataGaps].sort().join(',');
  const altGaps = [...bestAlternative.dataGaps].sort().join(',');
  if (heldGaps !== altGaps) {
    return { needsReview: false, reason: `축 구성 불일치(보유 데이터부족축: ${heldGaps || '없음'}, 대안: ${altGaps || '없음'}) — 공정 비교 불가` };
  }
  const scoreDelta = bestAlternative.composite - heldScore.composite;
  return { needsReview: scoreDelta >= threshold, scoreDelta, bestAlternative };
}

// 스코어(computeInstrumentScore 반환 모양)를 프롬프트용 한 줄로. 순수함수.
function formatScoreLine(score) {
  const axesText = Object.entries(score.axes).map(([k, v]) => `${k}:${v == null ? '데이터없음' : v.toFixed(1)}`).join(', ');
  return `${score.name} — 종합 ${score.composite.toFixed(1)}/100 (${axesText})${score.dataGaps.length ? ` [데이터 부족축: ${score.dataGaps.join('·')}]` : ''}`;
}

// 순수함수 — Athena에게 줄 "유지 vs 교체" 판단 프롬프트. 숫자 재도출 금지, 판단만.
export function buildRescorePrompt({ account, assetClass, heldScore, bestAlternative, scoreDelta }) {
  return `[연 1회 보유종목 재스코어링] ${account} 계좌 ${assetClass} 자산군의 보유종목과 유니버스 대안을
데이터 기반으로 재스코어링했다(재조회·추정 금지, 아래 숫자만 사용).

[현재 보유]
${formatScoreLine(heldScore)}

[유니버스 최상위 대안]
${formatScoreLine(bestAlternative)}

[점수 격차] ${scoreDelta.toFixed(1)}점 (100점 만점, 대안이 더 높음)

판단 요청 — 이 격차가 실제로 종목을 교체할 만큼인지 판단해라. 특히:
- ${account === '위탁' ? '위탁은 과세 계좌라 매도 시 양도소득세·거래비용이 발생한다 — 점수 격차가 그 비용을 상쇄할 만큼 큰지 고려해라.' : '연금저축은 계좌 내 교체라 매도 시 별도 과세 이벤트가 없다(연금 수령 시 과세로 이연) — 위탁보다는 교체 문턱이 낮다.'}
- 데이터 부족축이 있으면(위 [데이터 부족축] 표기) 그 축을 근거로 섣불리 판단하지 마라.
- "유지"가 기본값이다 — 격차가 있다고 무조건 교체를 권하지 마라, 애매하면 유지가 안전하다.

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{"verdict":"유지 또는 교체","reasoning":"판단 근거 1~2문장, Frank에게 텔레그램으로 그대로 전달됨"}
\`\`\``;
}

function readMdDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, filepath: join(dir, f), ...parseFrontmatter(readFileSync(join(dir, f), 'utf8')) }));
}

function loadExistingProposals(dir) {
  return readMdDir(dir).map((p) => ({ ...p, ...parseProposal(readFileSync(p.filepath, 'utf8')) }));
}

async function main() {
  const now = new Date();
  const lastYear = readLastYear();
  if (!FORCE && !shouldRunThisYear(now, lastYear)) {
    console.log('ℹ️ 올해는 재스코어링 대상 아님(이미 실행됐거나 1월 1~3일 평일이 아님) — 건너뜀');
    return;
  }

  loadEnv();
  const AGENT = loadAgent('athena', { fallbackModel: 'sonnet' });
  if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
  const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;

  console.log('🔬 annual-instrument-rescore — 보유 ETF 연 1회 재스코어링 점검');
  if (DRY_RUN) console.log('   (--dry-run: 쓰기·발송 없음)');

  const proposalsBlocked = isProposalBlocked(existsSync(VAULT_PATHS.state.proposalMode) ? readFileSync(VAULT_PATHS.state.proposalMode, 'utf8') : null);
  if (proposalsBlocked) {
    console.log('  🚫 제안금지 모드 — 점검 자체를 건너뜀("제안요청"으로 해제 전까지, 연 마커도 안 건드림)');
    return;
  }

  const holdings = readMdDir(VAULT_PATHS.state.holdings);
  const rankedCache = {};
  let existingProposals = null;
  let reviewedAny = false;
  let hadLimitError = false; // 사용량 한도로 판단 보류된 종목이 있으면 연 마커를 안 써서
  // 남은 캘린더 창(1~3일) 안에서 재시도되게 한다(quarterly-allocation-review.mjs의
  // "발송 실패 시 마커 미전진"과 동일 원칙).
  let hadPartialFailure = false; // 매도/매수 한쪽만 발송된 교체가 있으면 마찬가지로
  // 연 마커를 안 써서 재시도되게 한다(2026-09-06 코드리뷰 지적).

  for (const account of IN_SCOPE_ACCOUNTS) {
    for (const assetClass of ACCOUNT_ELIGIBLE_ASSET_CLASSES[account]) {
      const held = findExistingInstruments(holdings, account, assetClass);
      if (!held.length) continue;

      if (!(assetClass in rankedCache)) rankedCache[assetClass] = await rankAssetClassUniverse(assetClass);
      const rankedAlternatives = rankedCache[assetClass];
      if (!rankedAlternatives.length) {
        console.log(`  ⏭️  [${account}/${assetClass}] 유니버스 미확인(ASSET_CLASS_ETF_UNIVERSE 비어있음) — 비교 불가, 건너뜀`);
        continue;
      }

      for (const inst of held) {
        const series = await fetchEtfSeries(inst.name, SERIES_DAYS);
        if (!series.length) {
          console.log(`  ⏭️  [${account}/${assetClass}] ${inst.name}: KRX 조회 실패(상장폐지·이름불일치 등) — 건너뜀`);
          continue;
        }
        const latest = series[series.length - 1];
        const heldScore = computeInstrumentScore({ name: inst.name, accTrdVal: latest.accTrdVal, close: latest.close, nav: latest.nav, series });
        const evaluation = evaluateRescoreCandidate(heldScore, rankedAlternatives);
        if (!evaluation.needsReview) {
          console.log(`  ✅ [${account}/${assetClass}] ${inst.name}: 재검토 불필요(${evaluation.reason ?? `격차 ${evaluation.scoreDelta?.toFixed(1)}점 < 임계값`})`);
          continue;
        }

        reviewedAny = true;
        const prompt = buildRescorePrompt({ account, assetClass, heldScore, bestAlternative: evaluation.bestAlternative, scoreDelta: evaluation.scoreDelta });
        console.log(`  🔎 [${account}/${assetClass}] ${inst.name} — 격차 ${evaluation.scoreDelta.toFixed(1)}점, Athena 판단 요청`);
        if (DRY_RUN) { console.log(`\n┌─── 프롬프트 [${account}/${assetClass}/${inst.name}] ───┐\n${prompt}\n└──────────────────┘`); continue; }

        let verdict;
        try {
          const r = parseJsonBlock(await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt }));
          verdict = r;
        } catch (e) {
          if (e.isLimit) { console.log('  ⏳ 사용량 한도 → 이 종목 판단 보류(캘린더 창 안에서 재시도).'); hadLimitError = true; continue; }
          console.error(`  ❌ [${account}/${assetClass}] ${inst.name} 판단 실패: ${e.message}`);
          continue;
        }
        if (verdict.verdict !== '교체') {
          console.log(`  ℹ️  [${account}/${assetClass}] ${inst.name}: Athena 판단 "유지" — ${verdict.reasoning ?? ''}`);
          continue;
        }

        // 코드리뷰 지적(2026-09-06, MEDIUM) — evalAmount는 nullable(holdings-vault-
        // writer.mjs) 필드라 가격 가드와 동일하게 여기도 막아야 한다. 안 막으면
        // Math.floor(null/…)=0으로 quantity·amountWon이 조용히 null이 돼 "가격만 있고
        // 크기가 아예 없는 매수" 제안이 나간다.
        if (!Number.isFinite(inst.evalAmount) || inst.evalAmount <= 0) {
          console.error(`  ❌ [${account}/${assetClass}] ${inst.name} 보유평가액 데이터 없음 — 교체 제안 생성 보류(수동 확인 필요)`);
          continue;
        }

        const altSeries = await fetchEtfSeries(evaluation.bestAlternative.name, 5);
        const altLatest = altSeries[altSeries.length - 1];
        if (!altLatest || !Number.isFinite(altLatest.close) || altLatest.close <= 0) {
          console.error(`  ❌ [${account}/${assetClass}] 교체 대상 ${evaluation.bestAlternative.name} 가격 조회 실패 — 제안 생성 보류`);
          continue;
        }
        const buyQuantity = Math.floor(inst.evalAmount / altLatest.close);

        existingProposals ??= loadExistingProposals(VAULT_PATHS.decisions.proposals);
        const reason = `[연 1회 재스코어링] ${verdict.reasoning ?? ''} (점수 ${heldScore.composite.toFixed(1)}→${evaluation.bestAlternative.composite.toFixed(1)})`;
        const isSent = (r) => r?.action === 'created';
        let sellResult = { action: 'failed' };
        let buyResult = { action: 'failed' };
        try {
          sellResult = await createAndSendProposal({
            track: '자산분배', account, assetKey: inst.ticker || inst.name, name: inst.name,
            side: '매도', quantity: inst.qty, proposedPrice: inst.curPrice,
            reason, departmentLabel: DEPARTMENT_LABEL,
            existingProposals,
            writeProposalFile: (filename, content) => writeStateFile(join(VAULT_PATHS.decisions.proposals, filename), content),
            sendMessage: (text) => sendTelegram(text).then((r) => r?.result ?? r),
          });
          console.log(`  📤 [${account}/${assetClass}] 매도 ${inst.name}: ${sellResult.action}${sellResult.reason ? ` (${sellResult.reason})` : ''}`);
          // 코드리뷰 지적(2026-09-06, HIGH) — 성공한 제안을 existingProposals에 되먹이지
          // 않으면(rebalance-proposal.mjs·new-cash-allocation.mjs는 이미 이렇게 함) 같은
          // (account,assetClass) 안의 다른 보유 종목이 같은 bestAlternative로 교체될 때
          // 단일활성제안 판정이 이 방금 만든 제안을 못 보고 중복 매수 제안을 또 만든다.
          if (isSent(sellResult)) {
            existingProposals.push({ filename: sellResult.filename, ...parseProposal(readFileSync(join(VAULT_PATHS.decisions.proposals, sellResult.filename), 'utf8')) });
          }
        } catch (e) {
          console.error(`  ❌ [${account}/${assetClass}] 매도 제안 발송 실패: ${e.message}`);
        }

        if (isSent(sellResult)) {
          try {
            buyResult = await createAndSendProposal({
              track: '자산분배', account, assetKey: evaluation.bestAlternative.name, name: evaluation.bestAlternative.name,
              side: '매수', quantity: buyQuantity > 0 ? buyQuantity : null, proposedPrice: altLatest.close,
              amountWon: inst.evalAmount,
              reason, departmentLabel: DEPARTMENT_LABEL,
              existingProposals,
              writeProposalFile: (filename, content) => writeStateFile(join(VAULT_PATHS.decisions.proposals, filename), content),
              sendMessage: (text) => sendTelegram(text).then((r) => r?.result ?? r),
            });
            console.log(`  📤 [${account}/${assetClass}] 매수 ${evaluation.bestAlternative.name}: ${buyResult.action}${buyResult.reason ? ` (${buyResult.reason})` : ''}`);
            if (isSent(buyResult)) {
              existingProposals.push({ filename: buyResult.filename, ...parseProposal(readFileSync(join(VAULT_PATHS.decisions.proposals, buyResult.filename), 'utf8')) });
            }
          } catch (e) {
            console.error(`  ❌ [${account}/${assetClass}] 매수 제안 발송 실패: ${e.message}`);
          }
        }

        // 코드리뷰 지적(2026-09-06, HIGH) — 매도만 나가고 매수가 실패(또는 그 반대)하면
        // 오너가 "반쪽짜리 교체"를 알 방법이 없었다(콘솔 로그만 남고 연 마커는 그대로
        // 전진 → 다음 기회가 1년 뒤). 텔레그램으로 명시 경고 + 연 마커 미전진(캘린더 창
        // 안에서 재시도 — 성공한 다리는 단일활성제안 판정이 재중복 안 되게 막아준다).
        if (!isSent(sellResult) || !isSent(buyResult)) {
          hadPartialFailure = true;
          const alertMsg = `⚠️ [연 1회 재스코어링] 교체 제안 반쪽 발송 — [${account}] ${inst.name}→${evaluation.bestAlternative.name}: 매도 ${sellResult.action}${sellResult.reason ? `(${sellResult.reason})` : ''}, 매수 ${buyResult.action}${buyResult.reason ? `(${buyResult.reason})` : ''} — 수동 확인 필요`;
          console.error(alertMsg);
          try { await sendTelegram(alertMsg); } catch (e2) { console.error(`  ❌ 반쪽 발송 경고 텔레그램 실패: ${e2.message}`); }
        }
      }
    }
  }

  if (DRY_RUN) return;
  if (!reviewedAny) console.log('  ℹ️ 이번 연도엔 재검토 대상(격차 임계값 이상) 없음');
  if (hadLimitError) { console.log('  ⏳ 사용량 한도로 보류된 종목이 있어 연 마커 미전진(캘린더 창 안에서 재시도).'); return; }
  if (hadPartialFailure) { console.log('  ⚠️ 반쪽 발송된 교체가 있어 연 마커 미전진(캘린더 창 안에서 재시도).'); return; }
  writeLastYear(getYearLabel(now));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ annual-instrument-rescore 오류:', e.message); process.exit(1); });
}
