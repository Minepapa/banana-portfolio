#!/usr/bin/env node
// preference-facts.mjs — 비서실 Apollo 대화형 보고용 Node 결정론 사실 조립기(성향관찰만).
//
// Apollo는 다른 부서와 무결성 구멍의 성격이 다르다: KPI(profile/kpi_baseline.md)·주간리포트
// (reports/*.md)는 이미 로컬 파일이라 Read 도구가 리터럴 원문을 그대로 보여준다 — fetch가
// 아니므로 지어낼 수가 없고 그 자체로 하드 보장이다. 무결성이 필요한 유일한 실시간 소스는
// 성향관찰 구글시트(신뢰도·상태 등 실시간 값)이므로 이 CLI가 그것만 담당한다.
//
// preferences.mjs의 renderPrefRows는 "다른 프롬프트에 확정 성향만 주입"용이라 기각을 항상
// 배제한다 — Apollo의 감사형 보고(전체 상태 노출·대기건 카운트·거부 이력 추적)엔 안 맞아
// 별도 조립기를 둔다(중복이 아니라 다른 소비자).

import { loadEnv, hasServiceAccount, getToken, getRange } from '../lib/sheets-common.mjs';
import { PREF_SHEET } from '../lib/preferences.mjs';

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
const normStatus = (r) => { const raw = String(r[6] ?? '').trim(); return STATUSES.includes(raw) ? raw : '관찰'; };

// 성향관찰!A2:H = 날짜0 신호유형1 관찰2 증거3 §3대비4 신뢰도5 상태6 갱신시각7
export function assemblePreferences(rows, { status = null } = {}) {
  const all = rows || [];
  const counts = { 관찰: 0, 승격후보: 0, 확정: 0, 기각: 0, total: 0 };
  for (const r of all) { counts[normStatus(r)]++; counts.total++; }
  if (!all.length) return { rows: [], counts, text: '(성향관찰 데이터 부족: 빈 응답 — 시트에 관찰 없음)' };

  // 카운트 집계와 동일한 정규화(normStatus)로 필터해 버킷 수·필터 결과가 항상 일치하게 한다.
  const want = status === 'pending' ? PENDING : status ? [status] : null;
  const filtered = want ? all.filter((r) => want.includes(normStatus(r))) : all;
  if (!filtered.length) return { rows: [], counts, text: `(성향관찰 없음: "${status}" 매칭 없음)` };

  const lines = filtered.map((r) =>
    `  [${r[6]}] ${r[1]}: ${r[2]}${r[4] ? ` (§3대비 ${r[4]})` : ''} · 신뢰도 ${r[5] || '?'} · ${r[0] || '?'}`
  );
  return { rows: filtered, counts, text: lines.join('\n') };
}

export function renderPreferenceFacts({ rows, counts, text }, { json = false } = {}) {
  if (json) return JSON.stringify({ rows: rows ?? [], counts, text: text ?? '' });
  const lines = [
    '[Node 검증 숫자 — 비서실] (Google Sheets 결정론 조회 — 재조회·수정 금지)',
    '',
    `[성향관찰 현황] 확정 ${counts.확정} · 관찰 ${counts.관찰} · 승격후보 ${counts.승격후보} · 기각 ${counts.기각} (총 ${counts.total}건)`,
    '',
    text,
    '',
    '⚠️ 위 숫자만 사용하라. KPI·주간리포트는 로컬 파일(profile/kpi_baseline.md, reports/*.md)을 Read로 직접 읽어라 — 이미 결정론이다.',
  ];
  return lines.join('\n');
}

async function main() {
  loadEnv();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (!hasServiceAccount()) {
    console.error('⚠️ 서비스계정 없음 — 시트 조회 불가(데이터 부족으로 처리, 추정 금지)');
    process.exit(1);
  }
  try {
    const token = await getToken(null, { allowBrowser: false });
    const rows = await getRange(token, `${PREF_SHEET}!A2:H`);
    const facts = assemblePreferences(rows, { status: opts.status });
    process.stdout.write(renderPreferenceFacts(facts, { json: opts.json }) + '\n');
  } catch (e) {
    console.error(`⚠️ preference facts 조립 실패: ${e.message} — 데이터 부족으로 처리(추정 금지)`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
