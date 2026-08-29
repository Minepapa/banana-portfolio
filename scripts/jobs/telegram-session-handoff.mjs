#!/usr/bin/env node
/**
 * 텔레그램 상시세션(Zeus) 일일 인수인계 노트 — 2026-08-29, 오너 지시("가상세션 기록은
 * 므네모시네로 흡수하자. 종료 전 기록 남기고 시작 이후 기록 읽어오고").
 *
 * ⚠️ 왜 이 잡이 따로 있나 — telegram-session-restart.mjs(매일 04:00)는 `launchctl
 * kickstart -k`로 살아있는 세션을 그냥 죽이고 다시 띄운다(restart-telegram-session.sh
 * 참고). 죽기 직전에 "한 턴 더 돌아서 알아서 요약해라"를 시킬 방법이 구조적으로 없다
 * (SIGTERM성 종료, 우아한 종료 훅 없음) — 그래서 살아있는 Zeus 세션 자신이 기록을
 * 남기게 하는 대신, 재시작 5분 전(03:55 KST)에 이 Node 잡이 그날 하루 므네모시네에
 * 남은 사실(제안 생성·결정, 모드 전환)을 결정론으로 모아 기록한다. LLM 호출 없음
 * (사실 나열만 — daily-execution-report.mjs와 같은 "Node 전용" 성격).
 *
 * 읽어오는 쪽(재시작 후 새 세션이 이 파일을 참고하는 것)은 별개 메커니즘 —
 * `scripts/hooks/telegram-session-context.mjs`(SessionStart 훅, `.claude/
 * settings.json`에 등록)가 이 잡이 쓴 최신 파일을 additionalContext로 주입하고
 * `State/TelegramSession/last-read.md`에 "무엇을 읽었다"는 마커를 남긴다.
 *
 * 날짜 기준 — 03:55에 도는 잡이라 "오늘"(그 시각 기준 KST 날짜)은 방금 시작된 지
 * 4시간이 채 안 돼 사실상 비어있다. 이 잡이 요약해야 할 건 "이제 막 끝나가는
 * 하루"(어제, KST 기준 -1일)다 — 파일명도 그 날짜로 남긴다.
 *
 * 사용법: node scripts/jobs/telegram-session-handoff.mjs [--dry-run]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

// 순수함수 — UTC now를 KST 날짜(YYYY-MM-DD)로. 다른 곳의 +9h 관례(proposal-flow.mjs
// formatKstDateTime 등)와 동일 방식.
export function kstDateStr(isoOrDate) {
  // ⚠️ new Date(null)은 Invalid Date가 아니라 1970-01-01(epoch)이 나온다 — null·
  // undefined를 명시적으로 먼저 걸러야 한다(테스트로 실제로 잡힌 버그).
  if (isoOrDate == null) return null;
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

// 순수함수 — KST 기준 "어제" 날짜. 이 잡이 요약할 대상 날짜.
export function kstYesterdayStr(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  kst.setUTCDate(kst.getUTCDate() - 1);
  return kst.toISOString().slice(0, 10);
}

// 순수함수 — createdAt이 targetDateStr(KST)에 속하는 제안만.
export function filterProposalsByCreatedDate(proposals, targetDateStr) {
  return proposals.filter((p) => kstDateStr(p.createdAt) === targetDateStr);
}

// 순수함수 — decidedAt이 targetDateStr(KST)에 속하는 제안만.
export function filterProposalsByDecidedDate(proposals, targetDateStr) {
  return proposals.filter((p) => kstDateStr(p.decidedAt) === targetDateStr);
}

// 순수함수 — 오늘(대상일) changedAt인 모드 State만 골라 서술 한 줄로.
export function buildModeChangeNotes(modeStates, targetDateStr) {
  const notes = [];
  for (const { name, state } of modeStates) {
    if (!state) continue;
    if (kstDateStr(state.changedAt) !== targetDateStr) continue;
    notes.push(`${name}: ${state.mode ?? (state.active ? '발동' : '해제')}${state.reason ? ` — ${state.reason}` : ''}`);
  }
  return notes;
}

// 순수함수 — 최종 마크다운 본문. LLM 없이 사실 나열만(daily-execution-report.mjs와
// 동일 철학).
export function buildHandoffText({ targetDateStr, createdToday, decidedToday, pendingCount, modeNotes }) {
  const proposalLine = (p) => `- [${p.track}] ${p.side} ${p.assetKey} — ${p.status}${p.status === '거부' && p.rejectReason ? `(${p.rejectReason})` : ''}`;
  const lines = [
    `# ${targetDateStr} 텔레그램 세션 인수인계`,
    '',
    `## 그날 생성된 제안 (${createdToday.length}건)`,
    ...(createdToday.length ? createdToday.map(proposalLine) : ['- 없음']),
    '',
    `## 그날 결정된 제안 (${decidedToday.length}건)`,
    ...(decidedToday.length ? decidedToday.map(proposalLine) : ['- 없음']),
    '',
    `## 지금(작성 시점) 대기 중인 제안: ${pendingCount}건`,
    '',
  ];
  if (modeNotes.length) {
    lines.push('## 그날 바뀐 모드');
    lines.push(...modeNotes.map((n) => `- ${n}`));
    lines.push('');
  }
  return lines.join('\n');
}

function readProposals() {
  const dir = VAULT_PATHS.decisions.proposals;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

function readModeState(filepath) {
  if (!existsSync(filepath)) return null;
  return parseFrontmatter(readFileSync(filepath, 'utf8'));
}

function main() {
  const now = new Date();
  const targetDateStr = kstYesterdayStr(now);

  const proposals = readProposals();
  const createdToday = filterProposalsByCreatedDate(proposals, targetDateStr);
  const decidedToday = filterProposalsByDecidedDate(proposals, targetDateStr);
  const pendingCount = proposals.filter((p) => p.status === '대기').length;

  const modeStates = [
    { name: '킬스위치', state: readModeState(VAULT_PATHS.state.killSwitch) },
    { name: '체결모드', state: readModeState(VAULT_PATHS.state.executionMode) },
    { name: '제안모드', state: readModeState(VAULT_PATHS.state.proposalMode) },
  ];
  const modeNotes = buildModeChangeNotes(modeStates, targetDateStr);

  const body = buildHandoffText({ targetDateStr, createdToday, decidedToday, pendingCount, modeNotes });
  const content = buildFrontmatter({ type: 'telegram-session-handoff', date: targetDateStr, generatedAt: now.toISOString() }) + '\n' + body;

  console.log(body);

  if (DRY_RUN) { console.log('(드라이런 — 쓰기 없음)'); return; }

  mkdirSync(VAULT_PATHS.log.telegramSession, { recursive: true });
  const filepath = join(VAULT_PATHS.log.telegramSession, `${targetDateStr}.md`);
  writeAtomic(filepath, content);
  console.log(`\n✅ ${filepath} 기록 완료`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
