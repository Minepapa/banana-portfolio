#!/usr/bin/env node
// ledger-facts.mjs — 운영실 Hermes 대화형 보고용 Node 결정론 사실 조립기.
//
// 앱 최우선 원칙(LLM 숫자 날조 금지)의 Hermes 확장. Hermes는 "Vault 쓰기 단일 창구"라
// 실제 쓰기는 헤드리스 잡(parse-notifications-to-vault·update-holdings-from-executions
// 등)이 담당 — 이 파일은 보고(읽기) 전용이다.
//
// ⚠️ 2026-08-20 Vault 네이티브 전환 — 원래 구글시트(예수금기준·체결내역·잡상태)를
// 읽었는데, v1 무인 잡 전체 중단(2026-08-14) 이후 그 시트들을 채우던 주체가 없어져
// 이 CLI가 정지된 데이터로 계속 보고하고 있었다(오너가 "부서가 조용히 낡은 답을 준다"고
// 지적, 2026-08-20 전체 진단 중 발견). 세 섹션 전부 이미 Vault에 실시간으로 갱신되는
// 동등한 소스가 있어 그쪽으로 교체:
//   - 예수금 → State/Holdings/{계좌}-예수금.md(isCashLike, evalAmount/anchorTs/anchorSource)
//   - 체결내역 → Facts/Ledger/Executions/*.md(update-holdings-from-executions.mjs가 기록)
//   - 잡상태 → State/JobHealth/*.md(record-heartbeat-vault.mjs가 매 실행마다 기록)
//
// /hermes 커맨드가 Hermes 스폰 전에 이 CLI를 실행해 factsText를 주입한다.
// (하드 보장의 나머지 절반은 hermes.md frontmatter의 도구 제한.)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';

const SECTIONS = ['all', 'cash', 'trades', 'jobs'];

export function parseArgs(argv) {
  let section = 'all', name = null, json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--section') {
      section = argv[++i];
      if (!SECTIONS.includes(section)) throw new Error(`--section 값은 ${SECTIONS.join('|')} 여야 함: "${section}"`);
    } else if (a === '--name') name = argv[++i];
  }
  return { section, name, json };
}

const won = (n) => Math.round(n).toLocaleString('ko-KR');
// 체결가는 US 종목이면 소수(예: $342.5)라 won()으로 반올림하면 실제 체결가를 왜곡한다.
const price = (n) => Number.isInteger(n) ? n.toLocaleString('ko-KR') : n.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
// 잡상태 detail은 잡의 마지막 로그 줄 전체가 들어와 수백자에 달할 수 있다.
// 대화형 주입 토큰·가독성 보호를 위해 자른다 — 원문은 Vault 파일에 그대로 있으니 필요하면 직접 확인 가능.
const clamp = (s, max = 80) => (s.length <= max ? s : s.slice(0, max - 1) + '…');

function readVaultDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

// State/Holdings의 "예수금" 보유(isCashLike, name==="예수금")만 대상 — 다른 현금성
// 상품(외화RP·MMF 등)은 예수금 기준 보고 범위 밖(옛 예수금기준 시트와 동일 스코프,
// 계좌 수는 6개로 늘어남 — 시트 시절 4개보다 정확해짐: 위탁·연금저축·ISA·IRP·CMA·금현물).
// 전 계좌 빈 응답은 "예수금 없음"이 아니라 Vault 읽기 이상이므로 그대로 부족 표시.
export function assembleCash(holdings) {
  const rows = (holdings || []).filter((h) => h.isCashLike && h.name === '예수금');
  if (!rows.length) return { text: '(예수금 데이터 부족: Vault Holdings에 예수금 항목 없음 — 읽기 이상 의심, 추정 금지)', byAcct: {} };
  const byAcct = {};
  const lines = [];
  for (const h of rows) {
    const acct = String(h.account ?? '').trim();
    if (!acct) continue;
    const base = Number(h.evalAmount) || 0;
    const date = String(h.anchorTs ?? '').trim();
    const source = String(h.anchorSource ?? '').trim();
    byAcct[acct] = { base, date, source };
    lines.push(`  ${acct}: ${won(base)}원 (기준일 ${date || '?'}, 소스 ${source || '?'})`);
  }
  return { text: lines.length ? lines.join('\n') : '(예수금 데이터 부족)', byAcct };
}

// Facts/Ledger/Executions/*.md. name 지정 시 정확일치 또는 선행 단어 매칭 필터, 아니면
// 최근 limit건. 파일명이 아니라 tradeDate로 명시 정렬(디렉토리 나열 순서는 시간순이
// 아님 — 옛 시트 append 순서와 같은 이유의 함정).
export function assembleTrades(executions, { name = null, limit = 10 } = {}) {
  const all = executions || [];
  const filtered = name
    ? all.filter((e) => { const nm = String(e.stockName ?? '').trim(); return nm === name || nm.startsWith(name + ' '); })
    : all;
  if (!filtered.length) {
    return { rows: [], text: name ? `(체결 없음: "${name}" 매칭 행 없음)` : '(체결 데이터 부족: Vault에 체결 기록 없음)' };
  }
  const sorted = [...filtered].sort((a, b) => String(b.tradeDate ?? '').localeCompare(String(a.tradeDate ?? '')));
  const recent = sorted.slice(0, limit);
  const lines = recent.map((e) => {
    const qty = Number(e.quantity) || 0;
    const p = Number(e.price) || 0;
    const unit = e.currency === 'USD' ? '$' : '원';
    return `  ${e.tradeDate} ${e.tradeType} [${e.account || '?'}] ${e.stockName} ${qty}주 @${unit === '$' ? '$' : ''}${price(p)} = ${unit === '$' ? '$' : ''}${won(qty * p)}${unit === '$' ? '' : '원'}`;
  });
  return { rows: recent, text: lines.join('\n') };
}

// State/JobHealth/*.md — record-heartbeat-vault.mjs가 잡 실행마다 갱신.
export function assembleJobs(jobs) {
  const all = jobs || [];
  if (!all.length) return { text: '(잡상태 데이터 부족: Vault에 JobHealth 기록 없음)', failing: [] };
  const failing = [];
  const lines = all.map((j) => {
    const job = String(j.job ?? '').trim();
    const status = String(j.status ?? '').trim();
    const detail = String(j.detail ?? '').trim();
    if (status && status !== 'OK') failing.push({ job, status, detail });
    return `  ${job}: ${status || '?'} (마지막 실행 ${j.lastRun || '?'}${detail ? `, ${clamp(detail)}` : ''}, 연속실패 ${j.failStreak || 0}회)`;
  });
  return { text: lines.join('\n'), failing };
}

export function renderLedgerFacts({ cash, trades, jobs }, { json = false } = {}) {
  if (json) {
    return JSON.stringify({
      cash: { byAcct: cash?.byAcct ?? {}, text: cash?.text ?? '' },
      trades: { rows: trades?.rows ?? [], text: trades?.text ?? '' },
      jobs: { failing: jobs?.failing ?? [], text: jobs?.text ?? '' },
    });
  }
  const lines = ['[Node 검증 숫자 — 운영실] (Vault 결정론 조회 — 재조회·수정 금지)'];
  if (cash) lines.push('', '[예수금 — 계좌별]', cash.text);
  if (trades) lines.push('', '[체결내역]', trades.text);
  if (jobs) {
    lines.push('', '[잡상태]', jobs.text);
    // clamp된 요약 줄은 가독성용 — FAIL 사유(예: 실패 종목명·오류코드)가 잘려 안 보이면 실제 원인을
    // 놓친다. 여기 실패 잡의 전체 detail을 그대로 붙여 clamp로 인한 정보 손실을 막는다.
    if (jobs.failing?.length) {
      lines.push('', '[실패 상세 — 잘리지 않은 원문]');
      for (const f of jobs.failing) lines.push(`  ${f.job} (${f.status}): ${f.detail || '(상세 없음)'}`);
    }
  }
  lines.push('', '⚠️ 위 숫자만 사용하라. 어떤 수치도 직접 fetch·추정하지 말 것 — 역할은 사실만 보고하는 것뿐이다.');
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
  const want = (s) => opts.section === 'all' || opts.section === s;
  const holdings = want('cash') ? readVaultDir(VAULT_PATHS.state.holdings) : null;
  const executions = want('trades') ? readVaultDir(VAULT_PATHS.facts.ledger.executions) : null;
  const jobs = want('jobs') ? readVaultDir(VAULT_PATHS.state.jobHealth) : null;

  const facts = {
    cash: holdings ? assembleCash(holdings) : null,
    trades: executions ? assembleTrades(executions, { name: opts.name }) : null,
    jobs: jobs ? assembleJobs(jobs) : null,
  };
  process.stdout.write(renderLedgerFacts(facts, { json: opts.json }) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
