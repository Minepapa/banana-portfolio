#!/usr/bin/env node
// risk-facts.mjs — 리스크관리실 Themis 대화형 보고용 Node 결정론 사실 조립기.
//
// ⚠️ 2026-08-20 축소 재작성 — v1 "리스크모니터"(B/D 신호 로그)·"리스크기준선"(개별종목
// 펀더멘털 기준선) 섹션을 통째로 뺐다. 배경(오너와 Themis 역할 재검토,
// project-v2-gap-audit-20260820 메모리 참고): B신호(논리훼손)는 "재량적 개별종목
// 매수논리가 무너졌는가"를 감시하는 개념인데, 지금 두 트랙 다 그 전제가 없다 —
// Athena(자산분배)는 신규 매수가 ETF뿐이라 재량적 매수논리 자체가 안 생기고,
// Kairos(퀀트)는 팩터스코어로 기계 선정이라 "재량 논리"가 없으며 그 재평가는 월간
// 리컨스티튜션이 이미 담당한다. 위탁 계좌에 남은 레거시 개별종목 7종(2트랙 확정
// 이전 매수분)도 "시스템 감시 대상에서 빼고 오너 재량 판단"으로 명시 결정(2026-08-20)
// — 그래서 리스크기준선을 갱신하던 backfill-baselines.mjs도 같이 용도 폐기(포팅 안
// 함). 퀀트 전략-불가지론적 안전장치(포지션사이징·서킷브레이커)도 전략 확정(task
// #33) 이후로 보류 결정 — 지금 만들 게 없다.
//
// 남은 건 거시지표(자산분배 D신호와 같은 소스, Themis 자체 조회용)와 감시 잡 상태뿐.
// Themis의 실제 살아있는 역할은 이 CLI가 아니라 "Athena/Kairos 제안 2차검증"(LLM
// 판단, 헌장 §2)이다 — 그건 데이터 조회가 아니라 제안 자체를 비판적으로 읽는 일이라
// 이 CLI의 소관이 아니다.
//
// /themis 커맨드가 스폰 전 이 CLI를 실행해 factsText를 주입한다.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { getCachedMacroIndicators } from '../lib/macro-cache.mjs';
import { assembleJobs } from './ledger-facts.mjs';

const SECTIONS = ['all', 'macro', 'jobs'];
// 리스크 감시와 직결된 잡만 — daily-asset-allocation-check(거시 D신호+5/25 이탈 매일
// 점검), health-watcher(전체 잡 헬스). v1 risk-b·risk-d 잡은 더 이상 없음(위 설명).
const RISK_JOBS = ['daily-asset-allocation-check', 'health-watcher'];

export function parseArgs(argv) {
  let section = 'all', json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--section') {
      section = argv[++i];
      if (!SECTIONS.includes(section)) throw new Error(`--section 값은 ${SECTIONS.join('|')} 여야 함: "${section}"`);
    }
  }
  return { section, json };
}

// macroData: fetchMacroIndicators() 반환 형태({KEY: {value, change5d, source}}) — 이 함수는
// 순수(IO 없음), 실 조회는 main()에서 getCachedMacroIndicators()(2026-09-06부터, macro-
// cache.mjs)로 수행해 주입한다(테스트 용이성).
// yfinance 원본은 부동소수점 그대로(예: 1487.4599609375) — 값을 바꾸는 게 아니라 반올림 표기만.
const round2 = (n) => Math.round(n * 100) / 100;

export function assembleMacro(macroData) {
  const entries = Object.entries(macroData || {});
  if (!entries.length) return '(거시지표 데이터 부족)';
  const lines = entries.map(([key, d]) => {
    if (d?.value == null) return `  ${key}: 데이터없음`;
    const chg = d.change5d != null ? `${d.change5d > 0 ? '+' : ''}${round2(d.change5d)}%` : '?';
    // §4 가드레일(checkGuardrails)은 종점 변동(change5d)이 아니라 저점대비 상승(rally5d)·고점대비
    // 낙폭(drawdown5d)으로 D신호를 발동한다 — 있으면 반드시 같이 노출해야 Themis 판정이 실제
    // 트리거 근거와 어긋나지 않는다(리뷰 지적).
    const extra = [];
    if (d.drawdown5d != null) extra.push(`고점대비 ${round2(d.drawdown5d)}%`);
    if (d.rally5d != null) extra.push(`저점대비 +${round2(d.rally5d)}%`);
    const extraText = extra.length ? `, ${extra.join(', ')}` : '';
    return `  ${key}: ${round2(d.value)} (5일 ${chg}${extraText}, 출처 ${d.source || '?'})`;
  });
  return lines.join('\n');
}

function readVaultDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => parseFrontmatter(readFileSync(join(dir, f), 'utf8')));
}

export function renderRiskFacts({ macro, jobs }, { json = false } = {}) {
  if (json) {
    return JSON.stringify({ macro: macro ?? '', jobs: { failing: jobs?.failing ?? [], text: jobs?.text ?? '' } });
  }
  const lines = ['[Node 검증 숫자 — 리스크관리실] (Vault·KRX·yfinance 결정론 조회 — 재조회·수정 금지)'];
  if (macro) lines.push('', '[거시지표]', macro);
  if (jobs) lines.push('', '[감시 잡 상태 — daily-asset-allocation-check·health-watcher]', jobs.text);
  lines.push('', '⚠️ 위 숫자만 사용하라. 어떤 수치도 직접 fetch·추정하지 말 것.');
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
  const want = (s) => opts.section === 'all' || opts.section === s;
  // 2026-09-06 — 하루(KST 달력일) 한 번만 계산해 공유(macro-cache.mjs 참고). 오너가
  // /themis를 오늘 무인 잡(Themis·weekly-report 등)이 이미 도는 날 실행하면 그 값을
  // 그대로 재사용 — 사고 방지(Log/DevRequests/2026-09-06-weekly-report-facts-불일치-
  // 버그.md).
  const macroData = want('macro')
    ? await getCachedMacroIndicators().catch((e) => { console.error(`⚠️ 거시지표 조회 실패: ${e.message}`); return null; })
    : null;
  const jobRecords = want('jobs') ? readVaultDir(VAULT_PATHS.state.jobHealth).filter((r) => RISK_JOBS.includes(r.job)) : null;

  const facts = {
    macro: macroData ? assembleMacro(macroData) : (want('macro') ? '(거시지표 데이터 부족: 조회 실패)' : null),
    jobs: jobRecords ? assembleJobs(jobRecords) : null,
  };
  process.stdout.write(renderRiskFacts(facts, { json: opts.json }) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
