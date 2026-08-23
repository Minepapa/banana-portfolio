#!/usr/bin/env node
/**
 * 자산분배 트랙 미체결 리마인더 — 자산분배 트랙 최소개입 자동화 계획 Part 5(2026-08-23,
 * 오너 지시). 자산분배 트랙엔 자동 브로커 실행이 없다(퀀트 트랙과 달리 위탁·연금저축이
 * KIS가 아닌 NH·삼성증권이라 API 연동이 안 됨, 계획서 Context 참고) — 오너가 승인 후
 * 직접 브로커 앱에서 주문해야 한다. 이 잡은 그 "직접 해야 할 일"을 깜빡하지 않도록
 * 가볍게 리마인드만 한다(체결 자동화는 여전히 없음).
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

function markerPath(proposalId) {
  return join(STATE_DIR, `${proposalId}.md`);
}

function readLastRemindedAt(proposalId) {
  const p = markerPath(proposalId);
  if (!existsSync(p)) return null;
  const fm = parseFrontmatter(readFileSync(p, 'utf8'));
  return fm.lastRemindedAt ?? null;
}

async function writeLastRemindedAt(proposalId, now) {
  if (DRY_RUN) return;
  mkdirSync(STATE_DIR, { recursive: true });
  await writeStateFile(markerPath(proposalId), buildFrontmatter({ type: 'rebalance-reminder-state', proposalId, lastRemindedAt: now.toISOString() }));
}

function clearMarker(proposalId) {
  if (DRY_RUN) return;
  const p = markerPath(proposalId);
  if (existsSync(p)) rmSync(p, { force: true });
}

async function main() {
  const now = new Date();
  console.log('🔔 proposal-execution-reminder — 자산분배 트랙 미체결 점검');
  if (DRY_RUN) console.log('   (--dry-run: 쓰기·발송 없음)');

  const proposals = readMdDir(VAULT_PATHS.decisions.proposals);
  const executions = readMdDir(VAULT_PATHS.facts.ledger.executions);

  // 마커 정리 — 더 이상 "승인" 상태가 아닌(거부·대체됨) 제안의 리마인더 마커는 지운다.
  const proposalsById = Object.fromEntries(proposals.map((p) => [p.id, p]));
  if (existsSync(STATE_DIR)) {
    for (const f of readdirSync(STATE_DIR).filter((f) => f.endsWith('.md'))) {
      const proposalId = f.replace(/\.md$/, '');
      const p = proposalsById[proposalId];
      if (!p || p.status !== '승인') { clearMarker(proposalId); console.log(`  🧹 마커 정리: ${proposalId}(더 이상 승인 상태 아님)`); }
    }
  }

  const targets = proposals.filter((p) => p.track === '자산분배' && p.status === '승인');
  if (!targets.length) { console.log('  ✅ 대상 없음(자산분배 트랙 승인 대기 제안 없음)'); return; }

  let sentCount = 0;
  for (const proposal of targets) {
    const matched = findMatchingExecution(proposal, executions);
    if (matched) {
      clearMarker(proposal.id);
      console.log(`  ✅ ${proposal.id} — 체결 확인됨(${matched.recordedAt}), 리마인더 생략`);
      continue;
    }

    const lastRemindedAt = readLastRemindedAt(proposal.id);
    if (!shouldRemind({ proposal, now, lastRemindedAt })) {
      console.log(`  ℹ️ ${proposal.id} — 아직 리마인드 대상 아님`);
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

  console.log(`\n🏁 완료 — ${sentCount}건 리마인드`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ proposal-execution-reminder 오류:', e.message); process.exit(1); });
}
