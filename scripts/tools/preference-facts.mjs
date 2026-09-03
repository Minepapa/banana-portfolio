#!/usr/bin/env node
// preference-facts.mjs — 비서실 Apollo 대화형 보고용 Node 결정론 사실 조립기(성향관찰만).
//
// Apollo는 다른 부서와 무결성 구멍의 성격이 다르다: KPI(profile/kpi_baseline.md)·주간리포트
// (Knowledge/Reports/*.md)는 이미 로컬 파일이라 Read 도구가 리터럴 원문을 그대로 보여준다 —
// fetch가 아니므로 지어낼 수가 없고 그 자체로 하드 보장이다. 성향관찰만 여러 파일에 흩어진
// 실시간 상태(신뢰도·상태 등)를 집계해야 해서 이 CLI가 그것만 담당한다.
//
// ⚠️ 2026-08-20 Vault 네이티브 전환 — 원래 구글시트 "성향관찰" 탭을 읽었는데, 그 시트를
// 채우던 유일한 주체(weekly-report.mjs)가 v1 전용이라 v2 전환(2026-08-14 v1 무인 잡 전체
// 중단) 이후 정지된 데이터를 계속 보고하고 있었다. weekly-report.mjs를 Vault 네이티브로
// 재작성하면서 성향관찰 자체도 Knowledge/Profile/*.md(한 관찰당
// 파일 하나)로 옮김 — 이 CLI도 그쪽을 읽도록 교체.
//
// preferences.mjs의 renderPrefRows는 "다른 프롬프트에 확정 성향만 주입"용이라 기각을 항상
// 배제한다 — Apollo의 감사형 보고(전체 상태 노출·대기건 카운트·거부 이력 추적)엔 안 맞아
// 별도 조립기를 둔다(중복이 아니라 다른 소비자).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';

const STATUSES = ['관찰', '승격후보', '확정', '기각'];
const PENDING = ['관찰', '승격후보'];

export function parseArgs(argv) {
  let status = null, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--status') {
      status = argv[++i];
      if (status !== 'pending' && !STATUSES.includes(status)) {
        throw new Error(`--status 값은 pending|${STATUSES.join('|')} 여야 함: "${status}"`);
      }
    }
  }
  return { status, json };
}

// 상태 미기입은 preferences.mjs renderPrefRows와 동일 관례로 '관찰' 취급.
const normStatus = (r) => { const raw = String(r.status ?? '').trim(); return STATUSES.includes(raw) ? raw : '관찰'; };

// records: Knowledge/Profile/*.md frontmatter 배열
// ({ date, signalType, observation, evidence, vsProfile, confidence, status, updatedAt }).
export function assemblePreferences(records, { status = null } = {}) {
  const all = records || [];
  const counts = { 관찰: 0, 승격후보: 0, 확정: 0, 기각: 0, total: 0 };
  for (const r of all) { counts[normStatus(r)]++; counts.total++; }
  if (!all.length) return { rows: [], counts, text: '(성향관찰 데이터 부족: Vault에 관찰 없음)' };

  // 카운트 집계와 동일한 정규화(normStatus)로 필터해 버킷 수·필터 결과가 항상 일치하게 한다.
  const want = status === 'pending' ? PENDING : status ? [status] : null;
  const filtered = want ? all.filter((r) => want.includes(normStatus(r))) : all;
  if (!filtered.length) return { rows: [], counts, text: `(성향관찰 없음: "${status}" 매칭 없음)` };

  const lines = filtered.map((r) =>
    `  [${r.status}] ${r.signalType}: ${r.observation}${r.vsProfile ? ` (§3대비 ${r.vsProfile})` : ''} · 신뢰도 ${r.confidence || '?'} · ${r.date || '?'}`
  );
  return { rows: filtered, counts, text: lines.join('\n') };
}

export function renderPreferenceFacts({ rows, counts, text }, { json = false } = {}) {
  if (json) return JSON.stringify({ rows: rows ?? [], counts, text: text ?? '' });
  const lines = [
    '[Node 검증 숫자 — 비서실] (Vault 결정론 조회 — 재조회·수정 금지)',
    '',
    `[성향관찰 현황] 확정 ${counts.확정} · 관찰 ${counts.관찰} · 승격후보 ${counts.승격후보} · 기각 ${counts.기각} (총 ${counts.total}건)`,
    '',
    text,
    '',
    '⚠️ 위 숫자만 사용하라. KPI·주간리포트는 로컬 파일(profile/kpi_baseline.md, Knowledge/Reports/*.md)을 Read로 직접 읽어라 — 이미 결정론이다.',
  ];
  return lines.join('\n');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const dir = VAULT_PATHS.knowledge.profile;
  const records = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')))
    : [];
  const facts = assemblePreferences(records, { status: opts.status });
  process.stdout.write(renderPreferenceFacts(facts, { json: opts.json }) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
