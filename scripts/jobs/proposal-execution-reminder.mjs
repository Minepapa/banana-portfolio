#!/usr/bin/env node
/**
 * 자산분배 트랙 제안 리마인더 — 자산분배 트랙 최소개입 자동화 계획 Part 5(2026-08-23,
 * 오너 지시) + 2026-09-07 "흔들리지 않는 최소개입 시스템" 보완(오너 지시: "내가
 * 흔들리지 않고 최소한의 개입으로 자산분배 전략을 수행할 수 있도록... 이걸 잘 지키게
 * 하는 게 너의 몫이야"). 두 가지를 리마인드한다:
 *
 * ①**미체결 리마인더**(원래 기능) — 자산분배 트랙엔 자동 브로커 실행이 없다(퀀트
 * 트랙과 달리 위탁·연금저축이 KIS가 아닌 NH·삼성증권이라 API 연동이 안 됨, 계획서
 * Context 참고. 2026-09-05부터 위탁·금현물은 execute-asset-allocation.mjs로
 * 자동체결되지만 연금저축은 여전히 수동) — 승인 후에도 오너가 직접 브로커 앱에서
 * 주문해야 하는 경우를 깜빡하지 않도록 리마인드.
 *
 * ②**무응답 제안 리마인더**(2026-09-07 신설) — ①은 "승인은 했는데 체결을 깜빡함"만
 * 다뤘다. 실제로는 그보다 앞선 구멍이 있었다: 제안 자체에 승인도 거부도 안 하고
 * 방치하는 경우엔 아무도 다시 알려주지 않았다 — 그 사이 같은 종목·방향의 새 제안은
 * "단일활성제안" 원칙 때문에 자동으로 막혀서, 그 자산군 교정이 오너가 응답할 때까지
 * 조용히 멈춘다. 이건 "흔들리지 않고 지켜나간다"는 목표와 정면으로 어긋나는 구멍이라
 * 오너가 직접 지시해 보완.
 *
 * ⚠️ status는 절대 안 건드림 — 이 코드베이스에서 Proposal의 status는 "승인됐다"만
 * 의미하지 "체결됐다"를 의미한 적이 없다(execute-quant-proposal.mjs 자체 헤더 주석:
 * "영원히 '승인' 상태로 남는다" — 자동체결되는 퀀트 트랙조차 그렇다). 이 잡은 리마인더
 * 발송 여부만 조절할 뿐 Decisions/Proposals 파일 내용을 절대 안 바꾼다.
 *
 * 매칭은 완전일치만(추정 금지) — 계좌+매매구분+종목코드/명 일치+시각순서, 전부 맞아야
 * "체결됨"으로 판정한다. 애매하면 "못 찾음"(리마인더 계속) 쪽으로 — 오탐(이미 체결
 * 했는데 또 리마인더 보냄, 그냥 무시하면 그만)보다 미탐(체결 못 찾아 계속 리마인더)이
 * 훨씬 안전한 방향이다.
 *
 * 사용법:
 *   node scripts/jobs/proposal-execution-reminder.mjs            # 실제 점검+발송
 *   node scripts/jobs/proposal-execution-reminder.mjs --dry-run  # 판정까지, 발송 없음
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeStateFile } from '../lib/state-writer.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatDepartmentMessage } from '../lib/telegram-messages.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const DEPARTMENT_LABEL = '운영실 Hermes';
const THRESHOLD_DAYS = 3;
const REPEAT_DAYS = 3;
const STATE_DIR = join(VAULT_PATHS.root, 'State', 'RebalanceReminder');

// 무응답 제안 리마인더(2026-09-07 신설) — 승인/거부 자체를 안 해서 방치되는 경우.
// 미체결 리마인더(승인 후 3일)보다 짧게 잡는다 — "체결을 깜빡함"보다 "제안 자체를
// 못 봄"이 더 시급하고(그 사이 같은 종목 재제안이 막힘), 응답은 브로커 앱에서 직접
// 매매하는 것보다 훨씬 저마찰(그냥 텔레그램 답장)이라 매일 다시 물어봐도 안 naggy함.
const THRESHOLD_DAYS_PENDING = 1;
const REPEAT_DAYS_PENDING = 1;
const PENDING_STATE_DIR = join(VAULT_PATHS.root, 'State', 'ProposalResponseReminder');

function readMdDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, ...parseFrontmatter(readFileSync(join(dir, f), 'utf8')) }));
}

// 순수함수 — 두 시각(ISO) 사이의 KST 캘린더 일수 차이. order-gate.isApprovalStale와
// 같은 KST 변환 방식(Intl.DateTimeFormat en-CA)이되, 같은 날 여부가 아니라 일수 차를 낸다.
export function kstDayDiff(fromIso, toDate = new Date()) {
  const kstDateStr = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
  const from = new Date(`${kstDateStr(new Date(fromIso))}T00:00:00Z`);
  const to = new Date(`${kstDateStr(toDate)}T00:00:00Z`);
  return Math.round((to - from) / (24 * 3600 * 1000));
}

// 순수함수 — 완전일치 매칭만(추정 금지). 계좌+매매구분+종목코드/명+수량 일치, 그리고
// 체결 시각이 승인 시각 이후여야 한다(승인 전에 이미 있던 우연한 동일 거래를 오매칭하지
// 않기 위함). 수량까지 요구하는 이유(2026-08-23 코드리뷰 지적) — 연금저축은 매월
// 적립식 자동매수가 따로 돌아가는 계좌라, 수량 없이 계좌+구분+종목만 맞춰버리면 리밸런싱
// 제안과 무관한 그 달의 정기 적립매수가 우연히 매칭돼 "체결됨"으로 오판, 실제로는
// 오너가 리밸런싱 제안 자체를 아직 실행 안 했는데도 리마인더가 조용해지는 오탐이
// 난다(이 잡의 명시적 설계 원칙과 정반대 방향의 오류라 반드시 막아야 함). proposal.quantity
// 가 없는 경우(신규종목 제안이라 Node가 수량을 못 계산했던 케이스)는 수량 비교를
// 생략한다 — 그때는 애초에 비교할 기준이 없다.
export function findMatchingExecution(proposal, executions) {
  return (executions || []).find((e) => {
    if (e.account !== proposal.account) return false;
    if (e.tradeType !== proposal.side) return false;
    if (e.stockCode !== proposal.assetKey && e.stockName !== proposal.assetKey) return false;
    if (proposal.quantity != null && e.quantity !== proposal.quantity) return false;
    if (!e.recordedAt || !proposal.decidedAt) return false;
    return new Date(e.recordedAt).getTime() > new Date(proposal.decidedAt).getTime();
  }) ?? null;
}

// 순수함수 — 리마인드를 보낼지: 승인 후 THRESHOLD_DAYS 이상 지났고, 마지막 리마인드
// 이후 REPEAT_DAYS 이상 지났을 때만(매일 안 보냄, naggy 방지).
export function shouldRemind({ proposal, now = new Date(), lastRemindedAt = null }) {
  if (proposal.status !== '승인' || !proposal.decidedAt) return false;
  if (kstDayDiff(proposal.decidedAt, now) < THRESHOLD_DAYS) return false;
  if (!lastRemindedAt) return true;
  return kstDayDiff(lastRemindedAt, now) >= REPEAT_DAYS;
}

// 순수함수 — 리마인더 텍스트.
export function buildReminderText(proposal, days) {
  return `${proposal.side} [${proposal.account}] ${proposal.assetKey} ${proposal.quantity ?? ''}주 (제안 ${proposal.id})\n`
    + `승인 후 ${days}일째 체결 확인이 안 됩니다. 이미 브로커 앱에서 직접 체결하셨다면 무시하세요 — `
    + `다음 확인 때 자동으로 조용해집니다. 아직이면 직접 주문해주세요.`;
}

// 순수함수(2026-09-07 신설) — 무응답 제안을 리마인드할지: 생성 후 THRESHOLD_DAYS_
// PENDING 이상 지났고, 마지막 리마인드 이후 REPEAT_DAYS_PENDING 이상 지났을 때만.
// status가 '대기'가 아니면(이미 승인·거부·대체됨) 더 이상 대상 아님.
export function shouldRemindPending({ proposal, now = new Date(), lastRemindedAt = null }) {
  if (proposal.status !== '대기' || !proposal.createdAt) return false;
  if (kstDayDiff(proposal.createdAt, now) < THRESHOLD_DAYS_PENDING) return false;
  if (!lastRemindedAt) return true;
  return kstDayDiff(lastRemindedAt, now) >= REPEAT_DAYS_PENDING;
}

// 순수함수 — 무응답 제안 리마인더 텍스트. 승인/거부 방법을 다시 안내(오래전 온
// 제안이라 원본 메시지가 화면 위로 스크롤됐을 가능성이 높음 — 그때 어떻게 답장하는지
// 까먹었을 수 있어 다시 알려줌).
export function buildPendingReminderText(proposal, days) {
  return `${proposal.side} [${proposal.account}] ${proposal.assetKey} (제안 ${proposal.id})\n`
    + `${days}일째 승인/거부 응답이 없습니다. 이 제안에 "승인" 또는 "거부"로 답장해주세요 — `
    + `응답 전까지는 같은 종목·방향의 새 제안이 안 만들어져 리밸런싱이 멈춰 있습니다.\n`
    + `사유: ${proposal.reason || '(없음)'}`;
}

function markerPath(proposalId) {
  return join(STATE_DIR, `${proposalId}.md`);
}

function pendingMarkerPath(proposalId) {
  return join(PENDING_STATE_DIR, `${proposalId}.md`);
}

function readLastRemindedAt(proposalId) {
  const p = markerPath(proposalId);
  if (!existsSync(p)) return null;
  const fm = parseFrontmatter(readFileSync(p, 'utf8'));
  return fm.lastRemindedAt ?? null;
}

function readLastPendingRemindedAt(proposalId) {
  const p = pendingMarkerPath(proposalId);
  if (!existsSync(p)) return null;
  const fm = parseFrontmatter(readFileSync(p, 'utf8'));
  return fm.lastRemindedAt ?? null;
}

async function writeLastRemindedAt(proposalId, now) {
  if (DRY_RUN) return;
  mkdirSync(STATE_DIR, { recursive: true });
  await writeStateFile(markerPath(proposalId), buildFrontmatter({ type: 'rebalance-reminder-state', proposalId, lastRemindedAt: now.toISOString() }));
}

async function writeLastPendingRemindedAt(proposalId, now) {
  if (DRY_RUN) return;
  mkdirSync(PENDING_STATE_DIR, { recursive: true });
  await writeStateFile(pendingMarkerPath(proposalId), buildFrontmatter({ type: 'proposal-response-reminder-state', proposalId, lastRemindedAt: now.toISOString() }));
}

function clearPendingMarker(proposalId) {
  if (DRY_RUN) return;
  const p = pendingMarkerPath(proposalId);
  if (existsSync(p)) rmSync(p, { force: true });
}

function clearMarker(proposalId) {
  if (DRY_RUN) return;
  const p = markerPath(proposalId);
  if (existsSync(p)) rmSync(p, { force: true });
}

async function main() {
  const now = new Date();
  console.log('🔔 proposal-execution-reminder — 자산분배 트랙 제안 점검(미체결+무응답)');
  if (DRY_RUN) console.log('   (--dry-run: 쓰기·발송 없음)');

  const proposals = readMdDir(VAULT_PATHS.decisions.proposals);
  const executions = readMdDir(VAULT_PATHS.facts.ledger.executions);
  const proposalsById = Object.fromEntries(proposals.map((p) => [p.id, p]));

  // 마커 정리 — 더 이상 "승인" 상태가 아닌(거부·대체됨) 제안의 미체결 리마인더 마커는 지운다.
  if (existsSync(STATE_DIR)) {
    for (const f of readdirSync(STATE_DIR).filter((f) => f.endsWith('.md'))) {
      const proposalId = f.replace(/\.md$/, '');
      const p = proposalsById[proposalId];
      if (!p || p.status !== '승인') { clearMarker(proposalId); console.log(`  🧹 미체결 마커 정리: ${proposalId}(더 이상 승인 상태 아님)`); }
    }
  }
  // 무응답 리마인더 마커도 같은 원칙으로 정리 — 더 이상 "대기" 상태가 아니면(응답함) 지운다.
  if (existsSync(PENDING_STATE_DIR)) {
    for (const f of readdirSync(PENDING_STATE_DIR).filter((f) => f.endsWith('.md'))) {
      const proposalId = f.replace(/\.md$/, '');
      const p = proposalsById[proposalId];
      if (!p || p.status !== '대기') { clearPendingMarker(proposalId); console.log(`  🧹 무응답 마커 정리: ${proposalId}(더 이상 대기 상태 아님)`); }
    }
  }

  let sentCount = 0;

  // ①미체결 리마인더(승인했는데 체결 안 한 경우)
  const unexecutedTargets = proposals.filter((p) => p.track === '자산분배' && p.status === '승인');
  if (!unexecutedTargets.length) {
    console.log('  ✅ 미체결 대상 없음(자산분배 트랙 승인 대기 제안 없음)');
  }
  for (const proposal of unexecutedTargets) {
    const matched = findMatchingExecution(proposal, executions);
    if (matched) {
      clearMarker(proposal.id);
      console.log(`  ✅ ${proposal.id} — 체결 확인됨(${matched.recordedAt}), 리마인더 생략`);
      continue;
    }

    const lastRemindedAt = readLastRemindedAt(proposal.id);
    if (!shouldRemind({ proposal, now, lastRemindedAt })) {
      console.log(`  ℹ️ ${proposal.id} — 아직 미체결 리마인드 대상 아님`);
      continue;
    }

    const days = kstDayDiff(proposal.decidedAt, now);
    const body = buildReminderText(proposal, days);
    console.log(`  🔔 ${proposal.id} — ${days}일째 미체결, 리마인더 발송`);
    if (DRY_RUN) { sentCount++; continue; }

    try {
      await sendTelegram(formatDepartmentMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '리마인더', body }));
      await writeLastRemindedAt(proposal.id, now);
      sentCount++;
    } catch (e) {
      console.error(`  ❌ ${proposal.id} 리마인더 발송 실패(다음 실행 재시도): ${e.message}`);
    }
  }

  // ②무응답 제안 리마인더(승인도 거부도 안 한 경우, 2026-09-07 신설)
  const pendingTargets = proposals.filter((p) => p.track === '자산분배' && p.status === '대기');
  if (!pendingTargets.length) {
    console.log('  ✅ 무응답 대상 없음(자산분배 트랙 대기 중 제안 없음)');
  }
  for (const proposal of pendingTargets) {
    const lastRemindedAt = readLastPendingRemindedAt(proposal.id);
    if (!shouldRemindPending({ proposal, now, lastRemindedAt })) {
      console.log(`  ℹ️ ${proposal.id} — 아직 무응답 리마인드 대상 아님`);
      continue;
    }

    const days = kstDayDiff(proposal.createdAt, now);
    const body = buildPendingReminderText(proposal, days);
    console.log(`  🔔 ${proposal.id} — ${days}일째 무응답, 리마인더 발송`);
    if (DRY_RUN) { sentCount++; continue; }

    try {
      await sendTelegram(formatDepartmentMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '리마인더', body }));
      await writeLastPendingRemindedAt(proposal.id, now);
      sentCount++;
    } catch (e) {
      console.error(`  ❌ ${proposal.id} 무응답 리마인더 발송 실패(다음 실행 재시도): ${e.message}`);
    }
  }

  console.log(`\n🏁 완료 — ${sentCount}건 리마인드`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ proposal-execution-reminder 오류:', e.message); process.exit(1); });
}
