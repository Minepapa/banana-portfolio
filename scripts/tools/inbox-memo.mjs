#!/usr/bin/env node
// 📜 메모를 00_Inbox에 원문 그대로 남긴다(D40, 2026-10-10 구현). 텔레그램 세션이 "📜 …" 메시지를 받으면 표준입력 JSON으로 부른다.
//   echo '{"text":"…"}' | node scripts/tools/inbox-memo.mjs --json=- [--dry-run]
//   선택: {"attachment":"사진"} — 첨부가 있었다는 표시만 남긴다(D40: 텔레그램 사진·영상은 새 파일로 저장하지 않고
//   미디어 단계에서 드라이브 원본과 연결한다).
// - 메모 1건 = 노트 1개. 해석·요약·분류는 하지 않는다(클리오 ingest가 나중에 21_Notes로 옮기며 채운다).
// - 개인 메모일 수 있으니 sensitivity는 "개인"으로 둔다(데일리 요약 프롬프트에는 개수만 들어간다, D84).
// - created는 KST 날짜 — 데일리 노트 "오늘 들어온 기록"에 그날 기록으로 잡힌다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFrontmatter } from '../lib/vault-frontmatter.mjs';
import { VAULT_REL, vaultAbs } from '../lib/vault-paths.mjs';

const kst = (now) => new Date(now.getTime() + 9 * 3_600_000).toISOString();

// 제목: "YYYY-MM-DD HHmm 첫 말". 파일명 금지 문자(등록부 3절)·이모지·줄바꿈은 뺀다.
export function memoTitle(text, now) {
  const stamp = kst(now);
  const head = String(text).replace(/[\r\n\u0085\u2028\u2029]+/g, ' ')
    .replace(/[\\/:*?"<>|#^[\]·]/g, ' ')
    .replace(/\p{Extended_Pictographic}|\u200d|\ufe0f/gu, '')
    .replace(/\s+/g, ' ').trim().slice(0, 24).trim().replace(/[. ]+$/, '');
  return `${stamp.slice(0, 10)} ${stamp.slice(11, 13)}${stamp.slice(14, 16)}${head ? ` ${head}` : ' 메모'}`;
}

export function buildMemo(text, { now = new Date(), attachment = null } = {}) {
  const body = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!body && !attachment) throw new Error('빈 메모');
  if (body.length > 20_000) throw new Error('메모가 너무 김(2만 자 이하)');
  const stamp = kst(now);
  const fm = buildFrontmatter({
    type: 'inbox', origin: '텔레그램 📜', created: stamp.slice(0, 10), capturedAt: `${stamp.slice(0, 16)}+09:00`, sensitivity: '개인',
    ...(attachment ? { attachment: String(attachment).slice(0, 40) } : {}),
  });
  return `${fm}${body}${attachment ? `${body ? '\n\n' : ''}(첨부: ${String(attachment).slice(0, 40)} — 미디어 단계에서 원본과 연결)` : ''}\n`;
}

export function saveMemo(input, { now = new Date(), dryRun = false, dir = vaultAbs(VAULT_REL.inboxRoot) } = {}) {
  const content = buildMemo(input?.text, { now, attachment: input?.attachment ?? null });
  const base = memoTitle(input?.text ?? '', now);
  let name = `${base}.md`;
  for (let n = 2; existsSync(join(dir, name)); n += 1) name = `${base} (${n}).md`;
  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content, { flag: 'wx', mode: 0o644 });
  }
  return `📜 기록함: ${VAULT_REL.inboxRoot}/${name.replace(/\.md$/, '')}${dryRun ? ' (dry-run)' : ''}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (!process.argv.includes('--json=-')) throw new Error('--json=- 필요');
    console.log(saveMemo(JSON.parse(readFileSync(0, 'utf8')), { dryRun: process.argv.includes('--dry-run') }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
