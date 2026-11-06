#!/usr/bin/env node
// 텔레그램 관문 시험 볼트 준비(2026-10-30, 관문 1단계 재리뷰 LOW-A) — 시험 봇 실봇 왕복 전에 한 번 돌린다.
// 시험 데몬(--mode=test)은 비어 있는 시험 볼트(<시험 상태 폴더>/vault)에서 돈다. 장소 등록·🪶은 경로 등록부를 읽고,
// WQ 답은 질문 큐에 질문이 있어야 처리된다. 그래서:
//   1) 실제 볼트에서 구조 파일(경로 등록부·상태표준)만 복사한다. 개인 노트는 복사하지 않는다. 금고 경로는 어떤 경우에도 거부한다.
//   2) 시험 볼트의 질문 큐에 시험 질문 1건(manual-change)을 만든다. 텔레그램으로 보내지 않는다(가짜 발송 함수, 네트워크 없음).
// 질문 큐는 모듈을 불러올 때 볼트 경로가 정해지므로, 데몬과 같이 VAULT_PATH를 시험 볼트로 두고 자기 자신을 다시 띄운다.
//
// 사용법: node scripts/tools/telegram-gate-test-vault.mjs
//   출력의 "WQ-… 등록"을 시험 봇에 보내 위키 답 처리를 확인한다.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTestIsolation, defaultGatePaths } from '../lib/telegram-gate-config.mjs';
import { DEFAULT_VAULT_ROOT, VAULT_REL, VAULT_ROOT } from '../lib/vault-paths.mjs';
import { CALENDAR_DAY_SCHEMA, calendarDayPath, kstDate } from '../lib/calendar-days.mjs';

// 복사해도 되는 구조 파일(규칙층 90_Delphi의 스키마·채널 규칙만, 개인 기록 없음). 2단계부터 관문 LLM 시스템 프롬프트가
// 텔레그램 입력 규칙·세션 운영 규칙 원문을 읽으므로 두 채널 규칙도 넣는다.
export const SEED_FILES = Object.freeze([VAULT_REL.registryFile, VAULT_REL.statusStandardFile, VAULT_REL.telegramInputRulesFile, VAULT_REL.telegramChannelFile]);

export function testVaultRoot(env = process.env) {
  return join(env.TELEGRAM_GATE_STATE_DIR || defaultGatePaths().testStateDir, 'vault');
}

export function seedTestVault({ sourceRoot, targetRoot, files = SEED_FILES }) {
  const copied = [];
  for (const rel of files) {
    if (rel === VAULT_REL.adytonRoot || rel.startsWith(`${VAULT_REL.adytonRoot}/`)) throw new Error('금고 경로는 시험 볼트에 복사하지 않는다');
    if (rel.includes('..')) throw new Error(`올바르지 않은 경로: ${rel}`);
    const target = join(targetRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceRoot, rel), target);
    copied.push(rel);
  }
  return copied;
}

export async function createTestQuestion({ create }) {
  // 가짜 발송: message_id만 돌려줘 큐 상태를 "답변대기"로 만든다. 실제 텔레그램으로 아무것도 나가지 않는다.
  return create({
    kind: 'manual-change',
    question: '[시험] 텔레그램 창구 위키 답 처리 확인용 질문입니다. 등록·보류·제외 중 하나로 답해 주세요.',
    asker: 'zeus',
    urgent: true,
  }, { sender: async () => ({ result: { message_id: 1 } }) });
}

// 시험 볼트 일정 샘플(구조만, 개인 일정 아님): 오늘부터 days일치 일정 정본 파일(calendarDayPath)에 시험 일정 1건씩.
// 창구 대화의 일정 질문 → 헤르메스 기본 사실(calendar-facts) 경로를 시험 봇으로 확인하려고 둔다(설계 14절 4단계 전 확인).
// 이미 있는 날짜 파일은 건드리지 않는다.
export function seedCalendarSample({ targetRoot, now = new Date(), days = 7 }) {
  if (resolve(targetRoot) === resolve(DEFAULT_VAULT_ROOT)) throw new Error('실제 볼트에는 일정 샘플을 쓰지 않는다');
  const written = [];
  for (let i = 0; i < days; i += 1) {
    const date = kstDate(new Date(now.getTime() + i * 24 * 3_600_000));
    const path = calendarDayPath(date, targetRoot);
    if (existsSync(path)) continue;
    const event = { owner: '시험', person: '시험', sharedWith: [], title: '[시험] 창구 일정 경로 확인용', start: `${date}T20:00:00+09:00`,
      end: `${date}T21:00:00+09:00`, allDay: false, location: null, calendar: '시험' };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ schemaVersion: CALENDAR_DAY_SCHEMA, date, events: [event] }, null, 2)}\n`);
    written.push(date);
  }
  return written;
}

// 인자: 없음(전체 준비) 또는 --calendar-only(일정 샘플만, 시험 질문을 다시 만들지 않음). 모르는 인자는 거부한다.
export function parseTestVaultArgs(argv) {
  if (!argv.length) return { calendarOnly: false };
  if (argv.length === 1 && argv[0] === '--calendar-only') return { calendarOnly: true };
  return { error: '사용법: telegram-gate-test-vault.mjs [--calendar-only]' };
}

async function main() {
  const parsed = parseTestVaultArgs(process.argv.slice(2));
  if (parsed.error) { console.error(parsed.error); process.exit(2); }
  const target = testVaultRoot();
  if (process.env.VAULT_PATH !== target) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const result = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, VAULT_PATH: target } });
    process.exit(result.status ?? 1);
  }
  assertTestIsolation({ mode: 'test', vaultRoot: target, processVaultRoot: VAULT_ROOT, realVaultRoot: DEFAULT_VAULT_ROOT });
  const calendar = seedCalendarSample({ targetRoot: target });
  console.log(`일정 샘플: ${calendar.length ? calendar.join(', ') : '새로 쓴 날 없음(이미 있음)'}`);
  if (parsed.calendarOnly) return;
  const copied = seedTestVault({ sourceRoot: DEFAULT_VAULT_ROOT, targetRoot: target });
  // 질문 큐 모듈은 볼트 경로 확정 뒤에 불러온다(이 프로세스는 이미 시험 볼트 경로로 떠 있다).
  const { createWikiQuestion } = await import('../lib/wiki-question-queue.mjs');
  const question = await createTestQuestion({ create: createWikiQuestion });
  console.log(`시험 볼트: ${target}`);
  console.log(`구조 파일 복사: ${copied.join(', ')}`);
  console.log(`시험 질문: ${question.questionId} (${question.status}) — 시험 봇에 "${question.questionId} 등록"을 보내 확인`);
}

const invokedPath = (() => { try { return realpathSync(process.argv[1] ?? ''); } catch { return null; } })();
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
