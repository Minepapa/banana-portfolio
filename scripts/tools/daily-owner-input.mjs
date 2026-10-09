#!/usr/bin/env node
// 데일리 노트 "오늘 한 줄" 입력(2026-10-10) — 텔레그램 세션이 "🪶 …" 메시지를 받으면 표준입력 JSON으로 부른다.
//   echo '{"kind":"한줄","text":"오늘은 …"}' | node scripts/tools/daily-owner-input.mjs --json=- [--dry-run]
// 메모는 이 도구가 아니라 📜 → 00_Inbox(inbox-memo.mjs, D40)다. "오너 메모" 칸은 Obsidian에서 직접 쓰는 칸으로만 둔다
// (같은 메모가 두 길로 흩어지지 않게, 2026-10-10 오너 결정).
// - 날짜: KST 지금 기준. 05시 전이면 전날 노트(아직 하루를 마감하기 전 회고로 본다). {"date":"YYYY-MM-DD"}로 지정 가능.
// - 노트가 없으면 데일리 잡의 미리 만들기(prepare)로 먼저 만든다.
// - 오너 칸 줄만 바꾸고 AI 칸 지문(aiHash)이 그대로인지 확인한 뒤 쓴다(데일리 잡이 다음 실행에서 계속 갱신할 수 있게).
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectExisting, setOwnerSection } from '../lib/daily-note.mjs';
import { notePath, processDay, kstDate } from '../jobs/daily-note.mjs';
import { VAULT_PATHS, VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';

const KINDS = { 한줄: '오늘 한 줄' };
const kstClock = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(11, 16);

export function targetDate(now, explicit) {
  if (explicit != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(explicit) || new Date(`${explicit}T00:00:00Z`).toISOString().slice(0, 10) !== explicit) throw new Error(`날짜 형식 오류: ${explicit}`);
    return explicit;
  }
  const hour = Number(kstClock(now).slice(0, 2));
  return hour < 5 ? kstDate(new Date(now.getTime() - 86_400_000)) : kstDate(now);
}

export async function addOwnerInput(input, {
  now = new Date(), dryRun = false, read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null), write = writeAtomic,
  prepare = (date, rules) => processDay({ mode: 'prepare', date, dryRun: false, noSend: true, rules, today: kstDate(now) }),
  rules = parseRegistry(readFileSync(vaultAbs(VAULT_REL.registryFile), 'utf8')), pathOf = notePath,
} = {}) {
  const section = KINDS[input?.kind];
  if (!section) throw new Error('kind는 "한줄"만 지원(메모는 📜 → inbox-memo.mjs)');
  const date = targetDate(now, input.date);
  const path = pathOf(date);
  let before = read(path);
  if (before == null) {
    if (dryRun) return `${KINDS[input.kind]} 저장 예정(${date}, 노트 없음 — 실제 실행 때 미리 만들기) (dry-run)`;
    const made = await prepare(date, rules);
    before = read(path);
    if (made?.failed || before == null) throw new Error(`${date} 노트를 만들지 못함`);
  }
  const { content, previous } = setOwnerSection(before, { section, text: input.text, time: section === '오너 메모' ? kstClock(now) : null });
  const was = inspectExisting(before);
  const now2 = inspectExisting(content);
  if (was.ok && (!now2.ok || now2.prev.fields.aiHash !== was.prev.fields.aiHash)) throw new Error('AI 칸이 바뀌는 입력이라 쓰지 않음');
  const problems = checkNote(relative(VAULT_PATHS.root, path), content, rules);
  if (problems.length) throw new Error(`등록부 위반: ${problems.join(' / ')}`);
  if (!dryRun) {
    if (read(path) !== before) throw new Error('쓰는 사이 노트가 바뀜 — 다시 시도');
    write(path, content);
  }
  const label = section === '오늘 한 줄' ? `오늘 한 줄 저장(${date})${previous ? ' — 이전 한 줄을 바꿈' : ''}` : `메모 추가(${date} ${kstClock(now)})`;
  return `${label}${dryRun ? ' (dry-run)' : ''}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (!process.argv.includes('--json=-')) throw new Error('--json=- 필요');
    console.log(await addOwnerInput(JSON.parse(readFileSync(0, 'utf8')), { dryRun: process.argv.includes('--dry-run') }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
