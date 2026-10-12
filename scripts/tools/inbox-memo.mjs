#!/usr/bin/env node
// 텔레그램 📜 글 메모·사진 판독·📎 사진 메모를 00_Inbox에 남긴다(D97, 2026-10-12 — D40의 사진 첨부 방식 대체).
//   echo '{"text":"…"}' | node scripts/tools/inbox-memo.mjs --json=- [--dry-run]
//   사진판독: {"kind":"사진판독","decoded":"…","caption":"…"}
//   사진메모: {"kind":"사진메모","text":"…","photoDescription":"…"}
// - 메모 1건 = 노트 1개. 해석·요약·분류는 하지 않는다(클리오 ingest가 나중에 21_Notes로 옮기며 채운다).
// - 개인 메모일 수 있으니 sensitivity는 "개인"으로 둔다(데일리 요약에는 일반과 같이 제목·설명이 들어간다, D96).
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

export function buildMemo(text, { now = new Date(), kind = null, decoded, caption, photoDescription } = {}) {
  let body;
  let origin = '텔레그램 📜';
  const extra = {};
  if (kind === null) {
    body = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!body) throw new Error('빈 메모');
  } else if (kind === '사진판독') {
    if (!String(decoded ?? '').trim()) throw new Error('빈 사진 판독');
    body = `${String(caption ?? '').trim() ? `## 캡션\n${caption}\n\n` : ''}## 판독\n${decoded}`;
    origin = '텔레그램 사진';
    extra.attachment = '사진(파일 저장 안 함)';
  } else if (kind === '사진메모') {
    if (!String(text ?? '').trim()) throw new Error('빈 메모');
    body = `${text}\n\n${String(photoDescription ?? '').trim() ? `(사진: ${photoDescription} — 원본 연결 대기)` : '(사진 원본 연결 대기)'}`;
    origin = '텔레그램 📎';
    extra.photoLink = '대기';
  } else {
    throw new Error(`알 수 없는 kind: ${kind}`);
  }
  if (body.length > 20_000) throw new Error('메모가 너무 김(2만 자 이하)');
  const stamp = kst(now);
  const fm = buildFrontmatter({
    type: 'inbox', origin, created: stamp.slice(0, 10), capturedAt: `${stamp.slice(0, 16)}+09:00`, sensitivity: '개인',
    ...extra,
  });
  return `${fm}${body}\n`;
}

export function saveMemo(input, { now = new Date(), dryRun = false, dir = vaultAbs(VAULT_REL.inboxRoot) } = {}) {
  const kind = input?.kind ?? null;
  const content = buildMemo(input?.text, { now, kind, decoded: input?.decoded, caption: input?.caption, photoDescription: input?.photoDescription });
  const titleText = kind === '사진판독'
    ? `사진 ${String(input?.caption ?? '').trim() || String(input.decoded).split(/\r?\n/)[0]}`
    : input?.text ?? '';
  const base = memoTitle(titleText, now);
  let name = `${base}.md`;
  for (let n = 2; existsSync(join(dir, name)); n += 1) name = `${base} (${n}).md`;
  if (!dryRun) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content, { flag: 'wx', mode: 0o644 });
  }
  const label = kind === '사진판독' ? '🖼️ 판독 기록함' : kind === '사진메모' ? '📎 기록함' : '📜 기록함';
  return `${label}: ${VAULT_REL.inboxRoot}/${name.replace(/\.md$/, '')}${dryRun ? ' (dry-run)' : ''}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (!process.argv.includes('--json=-')) throw new Error('--json=- 필요');
    console.log(saveMemo(JSON.parse(readFileSync(0, 'utf8')), { dryRun: process.argv.includes('--dry-run') }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
