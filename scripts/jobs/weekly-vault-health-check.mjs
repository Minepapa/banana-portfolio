#!/usr/bin/env node
/**
 * 므네모시네(Vault) 주간 건강검진 — 비서실 Apollo "므네모시네 관리 총괄" 책임의
 * 실제 구현(2026-09-04, 오너 지시 — apollo.md "므네모시네 관리 총괄" 절 참고).
 *
 * Hermes의 "Vault 쓰기 정책"(장부 데이터가 맞는가)과 축이 다르다 — 이 잡은 볼트라는
 * 저장소 **자체**의 구조·문서 체계·미완료 작업이 건강한 상태인지 본다. Apollo는
 * Read/Grep/Glob뿐이라 직접 고치지 않는다 — 여기서도 마찬가지로 순수 관찰·보고만
 * 한다(고치는 건 오너와 함께 일하는 본 세션 몫).
 *
 * 세 갈래(오너 확정, 2026-09-04):
 *   A. 구조 정합성 — 깨진/중의적 [[wikilink]], 고립 노트(Hubs·Meta·Infra·API 중
 *      어디서도 안 걸린 참고문서 — 2026-09-04 동기화-인프라가 실제로 이 사례였음),
 *      대정리 이후 새로 쌓이는 레거시(legacy:true) 파일.
 *   B. 데이터 정합성 — Facts/Ledger/Profits의 통화 필드 누락·환율 계산 불일치
 *      (2026-09-03 엔비디아 환율 미반영 실사고와 같은 클래스 재발 감시).
 *   C. 미완료 작업 + 최신성 — Log/Implementation·Log/DevRequests의
 *      progress:"진행중"/"보류" 문서, "## 남은 것" 섹션이 있는 문서, "자동
 *      갱신"이라고 스스로 주장하는데 오래 안 바뀐 Meta/Infra/API 문서(2026-09-04
 *      삭제한 State/Baselines가 정확히 이 패턴이었음 — "분기마다 자동 갱신"이라고
 *      적혀 있었지만 그 잡이 애초에 없었다).
 *
 * 저정보 억제(daily-asset-allocation-check.mjs·intraday-market-move-monitor.mjs와
 * 동일 원칙) — 세 갈래 전부 조용하면 LLM 호출도 텔레그램 발송도 없다. 뭔가 있을 때만
 * Node가 계산한 사실을 Apollo(헤드리스 LLM)에게 주고 우선순위·서술을 받는다.
 *
 * 사용법:
 *   node scripts/jobs/weekly-vault-health-check.mjs            # 실제 실행 + 텔레그램 발송
 *   node scripts/jobs/weekly-vault-health-check.mjs --dry-run  # 계산까지, 발송 없음
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS, VAULT_ROOT } from '../lib/vault-paths.mjs';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { runHeadlessClaude } from '../lib/headless-claude.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';
import { sendTelegram } from '../lib/telegram.mjs';
import { formatFactsMessage, parseDepartmentResponse, CONCLUSION_MARKER, CONTEXT_MARKER, DECISIONS_MARKER } from '../lib/telegram-messages.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const DEPARTMENT_LABEL = '비서실 Apollo';
// 2026-09-04 므네모시네 대정리 완료일 — 이 날짜 이후 새로 생긴 legacy:true 파일은
// "정리했는데 다시 쌓이기 시작함" 신호다(대정리 자체로 생긴 legacy 파일은 없음 —
// 오히려 그 반대로 legacy를 지운 작업이었으므로 이 날짜를 기준으로 삼아도 안전).
const LEGACY_WATCH_SINCE = '2026-09-04';
// "자동 갱신"류 문구가 있는 문서가 이 기간 넘게 안 바뀌면 재확인 후보(확정 판정 아님).
const STALE_AUTO_CLAIM_DAYS = 56; // 8주

// ── 볼트 전체 파일 수집 ──────────────────────────────────────────────
function walkMdFiles(dir, out = []) {
  for (const f of readdirSync(dir)) {
    if (f === '.git' || f === '.obsidian') continue;
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walkMdFiles(p, out);
    else if (f.endsWith('.md')) out.push(p);
  }
  return out;
}

function readAllVaultFiles() {
  return walkMdFiles(VAULT_ROOT).map((absPath) => {
    const relPath = relative(VAULT_ROOT, absPath).replace(/\.md$/, '');
    const content = readFileSync(absPath, 'utf8');
    return { relPath, absPath, content, frontmatter: parseFrontmatter(content) };
  });
}

// ── A1. 깨진/중의적 [[wikilink]] ─────────────────────────────────────
// Obsidian 실제 해석 규칙(전체경로 우선, 없으면 베이스네임이 유일할 때만 해석)을
// 그대로 반영 — 므네모시네 대정리 세션에서 반복 실행하던 검증 스크립트를 정식
// 함수화한 것(2026-09-04).
export function findBrokenAndAmbiguousLinks(allFiles) {
  const fullPaths = new Set(allFiles.map((f) => f.relPath));
  const byBasename = new Map();
  for (const f of allFiles) {
    const base = f.relPath.split('/').pop();
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(f.relPath);
  }
  const broken = [];
  const ambiguous = [];
  const linkRe = /\[\[([^\]|]+)(\\?\|[^\]]+)?\]\]/g;
  for (const f of allFiles) {
    const stripped = f.content.replace(/`[^`\n]*`/g, ''); // 코드스팬 내부는 실제 링크 아님
    let m;
    while ((m = linkRe.exec(stripped))) {
      const target = m[1].trim().replace(/\\$/, '').replace(/\.md$/, '');
      if (fullPaths.has(target)) continue;
      const base = target.split('/').pop();
      const matches = byBasename.get(base);
      if (matches?.length === 1) continue;
      if (matches?.length > 1) { ambiguous.push({ file: f.relPath, target, candidates: matches }); continue; }
      broken.push({ file: f.relPath, target });
    }
  }
  return { broken, ambiguous };
}

// ── A2. 고립 노트 — Hubs·Meta·Infra·API 중 어디서도 인바운드 링크가 없는 문서 ──
// 2026-09-04 동기화-인프라.md가 실제로 이 사례(Phase 2 링크작업 9개 테마 중 어디와도
// 안 맞아 완전히 누락됨, 오너가 직접 지적해서 발견)였다 — 그 재발을 자동 감시.
export function findOrphanedNotes(allFiles, targetDirRelPaths) {
  const inboundTargets = new Set();
  const linkRe = /\[\[([^\]|]+)(\\?\|[^\]]+)?\]\]/g;
  for (const f of allFiles) {
    const stripped = f.content.replace(/`[^`\n]*`/g, '');
    let m;
    while ((m = linkRe.exec(stripped))) {
      const target = m[1].trim().replace(/\\$/, '').replace(/\.md$/, '');
      inboundTargets.add(target);
      inboundTargets.add(target.split('/').pop()); // 베이스네임으로도 걸릴 수 있으니 같이 등록
    }
  }
  const targets = new Set(targetDirRelPaths);
  return allFiles
    .filter((f) => targets.has(f.relPath.split('/').slice(0, -1).join('/')))
    .filter((f) => !inboundTargets.has(f.relPath) && !inboundTargets.has(f.relPath.split('/').pop()))
    .map((f) => f.relPath);
}

// ── A3. 대정리 이후 새로 쌓이는 레거시 ────────────────────────────────
export function findRecentLegacyFiles(allFiles, sinceDateStr = LEGACY_WATCH_SINCE) {
  return allFiles
    .filter((f) => f.frontmatter.legacy === true)
    .filter((f) => {
      const d = f.frontmatter.date || f.frontmatter.recordedAt || f.frontmatter.updatedAt;
      if (!d) return false;
      const parsed = new Date(String(d).slice(0, 10));
      return !Number.isNaN(parsed.getTime()) && parsed >= new Date(sinceDateStr);
    })
    .map((f) => f.relPath);
}

// ── B. Profits 통화 정합성 ────────────────────────────────────────────
// 2026-09-03 엔비디아 실사고(환율 미반영) 재발 감시. currency 필드 자체가 없으면
// 2026-09-04 수정 이전 구형 레코드(전부 국내종목이라 원래 안전)이거나 놓친 사례 —
// 후자만 구분하려면 buyPrice/sellPrice와 profit의 배율로 USD 원시값 그대로인지
// 추정한다(결정론적 재계산 — LLM 추정 아님).
export function findFxAnomalies(profitRecords) {
  const anomalies = [];
  for (const r of profitRecords) {
    if (r.currency !== 'USD') continue;
    const rawDiff = (Number(r.sellPrice) - Number(r.buyPrice)) * Number(r.quantity);
    if (!Number.isFinite(rawDiff) || rawDiff === 0) continue;
    const impliedRate = Number(r.profit) / rawDiff;
    // 정상 USD/KRW 범위 밖(원시 USD 차액 그대로 기록됐으면 impliedRate가 1에 가깝다)
    if (!(impliedRate >= 800 && impliedRate <= 2500)) {
      anomalies.push({ file: r.__relPath, stockName: r.stockName, profit: r.profit, impliedRate });
    }
  }
  return anomalies;
}

export function findMissingCurrencyField(profitRecords, sinceDateStr = LEGACY_WATCH_SINCE) {
  return profitRecords
    .filter((r) => !r.currency)
    .filter((r) => {
      const d = r.date;
      const parsed = d ? new Date(String(d).slice(0, 10)) : null;
      return parsed && !Number.isNaN(parsed.getTime()) && parsed >= new Date(sinceDateStr);
    })
    .map((r) => r.__relPath);
}

// ── C1. 미완료 작업(progress) ─────────────────────────────────────────
export function findPendingWork(records) {
  return records
    .filter((r) => r.progress === '진행중' || r.progress === '보류')
    .map((r) => ({ file: r.__relPath, progress: r.progress, status: r.status ?? null }));
}

// ── C2. "## 남은 것" 섹션 ─────────────────────────────────────────────
export function findRemainingWorkSections(files) {
  const results = [];
  for (const f of files) {
    const m = f.content.match(/## 남은 것\n([\s\S]*?)(?=\n## |\n---|\n?$)/);
    if (m && m[1].trim()) {
      const firstLine = m[1].trim().split('\n')[0].replace(/^[-*]\s*/, '');
      results.push({ file: f.relPath, preview: firstLine.slice(0, 80) });
    }
  }
  return results;
}

// ── C3. "자동 갱신" 주장 대비 최신성 ──────────────────────────────────
// 확정 판정이 아니다(키워드 매칭) — "재확인 후보"로만 취급.
export function findStaleAutoClaims(files, now = new Date(), staleDays = STALE_AUTO_CLAIM_DAYS) {
  const cadenceRe = /자동\s*(갱신|기록|발행)/;
  const results = [];
  for (const f of files) {
    if (!cadenceRe.test(f.content)) continue;
    const updatedAt = f.frontmatter.updatedAt || f.frontmatter.date;
    if (!updatedAt) continue;
    const parsed = new Date(String(updatedAt).slice(0, 10));
    if (Number.isNaN(parsed.getTime())) continue;
    const ageDays = (now.getTime() - parsed.getTime()) / 86_400_000;
    if (ageDays > staleDays) results.push({ file: f.relPath, updatedAt, ageDays: Math.round(ageDays) });
  }
  return results;
}

// ── 사실 조립 ─────────────────────────────────────────────────────────
export function buildHealthCheckFacts(r) {
  const lines = [];
  if (r.broken.length) lines.push(`깨진 링크 ${r.broken.length}건: ${r.broken.slice(0, 5).map((b) => `${b.file}→[[${b.target}]]`).join(', ')}${r.broken.length > 5 ? ' 외' : ''}`);
  if (r.ambiguous.length) lines.push(`중의적 링크 ${r.ambiguous.length}건: ${r.ambiguous.slice(0, 5).map((b) => `${b.file}→[[${b.target}]](${b.candidates.length}개 후보)`).join(', ')}`);
  if (r.orphaned.length) lines.push(`고립 노트 ${r.orphaned.length}건(어디서도 안 걸림): ${r.orphaned.join(', ')}`);
  if (r.recentLegacy.length) lines.push(`대정리(${LEGACY_WATCH_SINCE}) 이후 새로 쌓인 legacy 파일 ${r.recentLegacy.length}건: ${r.recentLegacy.join(', ')}`);
  if (r.fxAnomalies.length) lines.push(`Profits 환율 이상치 ${r.fxAnomalies.length}건: ${r.fxAnomalies.map((a) => `${a.stockName}(배율 ${a.impliedRate.toFixed(2)})`).join(', ')}`);
  if (r.missingCurrency.length) lines.push(`Profits 통화 필드 누락(${LEGACY_WATCH_SINCE} 이후) ${r.missingCurrency.length}건: ${r.missingCurrency.join(', ')}`);
  if (r.pendingWork.length) lines.push(`미완료 작업(진행중/보류) ${r.pendingWork.length}건: ${r.pendingWork.slice(0, 8).map((p) => `${p.file}(${p.progress})`).join(', ')}${r.pendingWork.length > 8 ? ' 외' : ''}`);
  if (r.remainingSections.length) lines.push(`"남은 것" 섹션 있는 문서 ${r.remainingSections.length}건: ${r.remainingSections.slice(0, 8).map((s) => s.file).join(', ')}${r.remainingSections.length > 8 ? ' 외' : ''}`);
  if (r.staleAutoClaims.length) lines.push(`"자동 갱신" 주장 대비 ${STALE_AUTO_CLAIM_DAYS}일 이상 정체(재확인 후보) ${r.staleAutoClaims.length}건: ${r.staleAutoClaims.map((s) => `${s.file}(${s.ageDays}일)`).join(', ')}`);
  return lines;
}

export function hasAnyIssue(r) {
  return Boolean(
    r.broken.length || r.ambiguous.length || r.orphaned.length || r.recentLegacy.length
    || r.fxAnomalies.length || r.missingCurrency.length
    || r.pendingWork.length || r.remainingSections.length || r.staleAutoClaims.length,
  );
}

export function buildApolloPrompt(facts) {
  return `[므네모시네 주간 건강검진] 아래는 이번 주 Node가 결정론으로 계산한 사실이다
(재조회·추정 금지, 이 목록만 사용). 볼트 구조·데이터 정합성·미완료 작업 세 갈래를
훑은 결과이고, 조용한 항목(문제 없음)은 애초에 이 목록에 안 실린다.

[발견 사항]
${facts.join('\n')}

판단 요청:
1. 위 발견 사항 중 오너가 이번 주 안에 확인해야 할 만큼 급한 게 있는지 네(아폴론)
   성격대로 판정해라 — 전부 사소하면(예: "남은 것" 섹션 몇 개뿐) 그렇다고 명확히
   말해라, 과잉경고 하지 마라.
2. 급한 것부터 우선순위를 매겨 오너가 뭘 먼저 볼지 짚어라.

형식(반드시 정확히 이 세 마커로 응답을 나눠라, 다른 마커·JSON·마크다운·이모지·
긴 하이픈(—) 없이 순수 텍스트만 — 문장은 마침표로 끊어라):
${CONCLUSION_MARKER}
전체 상황을 한 문장으로(급한 게 있으면 몇 건인지 숫자 포함).

${CONTEXT_MARKER}
왜 그 결론인지 — 발견 사항을 그대로 재나열하지 말고(이미 [사실]로 따로 나감),
그중 어떤 게 왜 중요한지 판단 문장 1~3개.

${DECISIONS_MARKER}
오너가 확인해볼 점을 "- "로 시작하는 줄로 1~5개, 급한 순서대로. 정말 사소한
것뿐이면 이 섹션은 빈 채로 둬라(억지로 채우지 마라).`;
}

async function main() {
  loadEnv();
  const AGENT = loadAgent('apollo', { fallbackModel: 'sonnet' });
  if (AGENT.warning) console.log(`⚠ ${AGENT.warning}`);
  const MODEL = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] || AGENT.model;

  const allFiles = readAllVaultFiles();

  const { broken, ambiguous } = findBrokenAndAmbiguousLinks(allFiles);
  const orphaned = findOrphanedNotes(allFiles, ['Knowledge/Hubs', 'Knowledge/Meta', 'Knowledge/Infra', 'Knowledge/API']);
  const recentLegacy = findRecentLegacyFiles(allFiles);

  const profitRecords = allFiles
    .filter((f) => f.relPath.startsWith('Facts/Ledger/Profits/'))
    .map((f) => ({ ...f.frontmatter, __relPath: f.relPath }));
  const fxAnomalies = findFxAnomalies(profitRecords);
  const missingCurrency = findMissingCurrencyField(profitRecords);

  const implRecords = allFiles
    .filter((f) => f.relPath.startsWith('Log/Implementation/') || f.relPath.startsWith('Log/DevRequests/'))
    .map((f) => ({ ...f.frontmatter, __relPath: f.relPath }));
  const pendingWork = findPendingWork(implRecords);
  const remainingSections = findRemainingWorkSections(
    allFiles.filter((f) => f.relPath.startsWith('Log/Implementation/') || f.relPath.startsWith('Log/DevRequests/') || f.relPath.startsWith('Log/Sessions/')),
  );
  const staleAutoClaims = findStaleAutoClaims(
    allFiles.filter((f) => f.relPath.startsWith('Knowledge/Meta/') || f.relPath.startsWith('Knowledge/Infra/') || f.relPath.startsWith('Knowledge/API/')),
  );

  const results = { broken, ambiguous, orphaned, recentLegacy, fxAnomalies, missingCurrency, pendingWork, remainingSections, staleAutoClaims };

  if (!hasAnyIssue(results)) {
    console.log('✅ weekly-vault-health-check: 세 갈래 전부 이상 없음(조용함, 알림 생략)');
    return;
  }

  const facts = buildHealthCheckFacts(results);
  console.log(`🔔 weekly-vault-health-check: 발견 사항 ${facts.length}줄`);
  facts.forEach((l) => console.log(`  · ${l}`));

  const prompt = buildApolloPrompt(facts);

  if (DRY_RUN) {
    console.log('\n(드라이런 — 텔레그램 발송 없음)\n');
    console.log(prompt);
    return;
  }

  let judgment;
  try {
    judgment = (await runHeadlessClaude(prompt, MODEL, 'Read', { appendSystemPrompt: AGENT.systemPrompt })).trim();
  } catch (e) {
    console.error(`❌ Apollo 헤드리스 판단 실패: ${e.message}`);
    process.exit(1);
  }

  console.log(judgment);
  const { conclusion, context, decisions } = parseDepartmentResponse(judgment);

  try {
    await sendTelegram(formatFactsMessage({ departmentLabel: DEPARTMENT_LABEL, tag: '점검', facts, conclusion, context, decisions }));
  } catch (e) { console.error('텔레그램 알림 실패:', e.message); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('❌ weekly-vault-health-check 오류:', e.message); process.exit(1); });
}
