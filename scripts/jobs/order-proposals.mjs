#!/usr/bin/env node
/**
 * 주문제안 생성 잡 — 흩어진 신호를 "완성된 주문서"로 변환해 주문제안 시트에 적재.
 *
 * 왜: 리밸런싱 갭·급락O·논리훼손B·평가🟢가 각 탭에 "정보"로 흩어져 실제 매매 트리거로
 * 작동하지 않던 문제(2026-07 브레인스토밍). 계좌·종목·방향·수량·금액이 확정된 주문서 +
 * 제약 체크(예수금·500만·확신보호) + 근거 체인을 만들어 앱 "주문" 탭에서 승인/기각만 남긴다.
 *
 * 아키텍처(기존 원칙 동일): Node가 후보·수량·제약을 결정론 계산(order-candidates.mjs 순수부),
 * AI(weekly·crash 공용)는 후보 중 최종 선택·근거 산문 + 회전(로테이션) 판단만. AI 실패/쿨다운
 * 시 Node 후보 그대로 적재(결정론 데이터라 환각 위험 없음 — 파이프라인이 AI 가용성에 죽지 않게).
 * 2026-07-22: crash도 AI 판단을 받도록 확장 — "AI 생략"은 비용 절감이 아니라 실행 흐름 단순화
 * 목적이었을 뿐이라(커밋 이력 확인), 매일 같은 하드코딩 사유가 반복되는 문제의 근본 원인이었다.
 * 회전(회전=매도+매수 짝) 판단 재료는 buildHoldingsFacts()(보유종목별 등급·확신여부·목표) —
 * "상승여력 제한" 근거는 반드시 펀더멘털/평가등급/목표달성이어야 하고 가격·RSI 단독 근거는
 * 프롬프트에서 명시적으로 금지한다(risk-monitor.mjs의 "가격 상승은 매도 신호 아님" 철학과 동일).
 *
 * 모드:
 *   --mode=weekly (일 08:30): 리밸런싱+논리훼손B+평가🟢 전체 스캔. B🔴인데 매도평가 카드
 *                             없으면 평가요청에 매도평가 자동 의뢰(주문은 평가 후 다음 주기에).
 *   --mode=crash  (평일 16:50, risk-d 16:30 이후): 오늘 O🔴 급락 매수만 생성, AI가 단순매수/
 *                             회전(기존 배분형 보유 매도 후 교체)/스킵을 판단.
 *
 * 가드: 매칭키 동일한 제안/승인 건 존재 시 skip(dedup) · 7일 경과 제안 → 만료 ·
 *       보유 0건/예수금 전무 읽기 시 throw(오염 방지) · dry-run.
 *
 * 사용: node scripts/jobs/order-proposals.mjs --mode=weekly [--dry-run] [--model=sonnet] [token]
 */
import {
  getToken, getRange, appendValues, updateCell, ensureSheet, nowKST, todayKST,
  runHeadlessClaude, parseJsonBlock, cooldownActive, sendTelegram,
} from '../lib/sheets-common.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';
import { renderPrefRows, prefBlock, PREF_SHEET } from '../lib/preferences.mjs';
import { krStockCode, usTicker } from '../lib/instruments.mjs';
import { fetchKrMarketData, fetchMarketData } from '../lib/fundamentals.mjs';
import {
  PROPOSAL_HEADER, PROPOSAL_COL as P, PROPOSAL_STATUS, PROPOSAL_SOURCE, EVAL_STATUS, colLetter,
} from '../lib/sheet-contracts.mjs';
import {
  parseHoldingRows, latestConclusions, convictionMap, latestRiskByType, detectThesisReleases,
  buildRebalanceCandidates, buildCrashBuyCandidates, buildSellFromThesis, buildBuyFromEval,
  buildHoldingsFacts, resolveRotationSell, applyThesisGuard, checkConstraints, makeMatchKey,
  toDateStr, RULE500_WON,
} from '../lib/order-candidates.mjs';
import { unknownMentions, clampLen } from '../lib/llm-guard.mjs';
import { loadAgent } from '../lib/agent-loader.mjs';

const PROPOSAL_SHEET = '주문제안';
const ACCOUNT_TABS = ['ISA', '위탁', '연금저축', 'IRP'];
// 자산분배 시트 계좌별 범위 (A=자산군, B=목표, C=현재, D=리밸금액) — SHEET_RANGES와 동일 행
const REBAL_RANGES = { 위탁: 'A3:D9', 연금저축: 'A12:D18', ISA: 'A21:D21', IRP: 'A24:D24' };
const EXPIRE_DAYS = 7;

const args = process.argv.slice(2);
const explicitToken = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');
const MODE = (args.find(a => a.startsWith('--mode='))?.split('=')[1] || '').toLowerCase();
// 주문서 초안(후보 선별+근거)은 투자전략실(Athena) 소관 — 에이전트 정의가 모델·판단원칙의
// 단일 진실 소스. 우선순위: CLI --model= > frontmatter > 폴백.
const AGENT = loadAgent('athena', { fallbackModel: 'sonnet' });
if (AGENT.warning) collectWarning(AGENT.warning);
const MODEL = args.find(a => a.startsWith('--model='))?.split('=')[1] || AGENT.model;

if (!['weekly', 'crash'].includes(MODE)) {
  console.error('❌ --mode=weekly 또는 --mode=crash 를 지정하세요.');
  process.exit(1);
}

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[,%+\s]/g, '')); return Number.isFinite(n) ? n : null; };
const s = (v) => String(v ?? '').trim();

// KRW 예수금(예수금·MMF 행 평가금) — 매수 예산 상한. 외화RP(USD)는 v1 범위 밖(제약 표기만).
function parseCashRow(acct, rows) {
  for (const r of rows || []) {
    const name = s(r[1]);
    if (name === '예수금' || (acct === '연금저축' && name.includes('MMF'))) return num(r[7]) ?? 0;
  }
  return 0;
}

// AI 프롬프트 — Node 후보(검증된 수치)를 주고 선택·근거 산문만 시킨다. 재조회·재계산 금지.
// holdingsFacts(회전판단 재료)가 있으면 "단순 추가매수"뿐 아니라 "기존 배분형 보유를 매도하고
// 이 후보로 교체"(회전)도 판단할 수 있게 한다 — 매도측 수량/단가는 Node가 후처리로 결정론
// 계산하므로 AI는 종목명·근거만 고른다(기존 "숫자는 Node" 원칙 그대로 확장).
function buildSelectionPrompt(candidates, confirmedPrefsText, holdingsFacts, label = '') {
  const rotationBlock = holdingsFacts?.length ? `

[보유 종목 현황 — 회전(매도 후 매수) 판단 재료. conviction:"확신"인 종목은 매도 대상에서
 반드시 제외. grade는 최근 매수/매도평가 결론(🟢🟡🔴⚪), target/targetRet은 그 종목을 평가할
 때 이미 적어둔 목표(자유서술/퍼센트) — 참고만, 반드시 다 채워져 있진 않음.]
${JSON.stringify(holdingsFacts, null, 1)}

회전 판단 규칙(중요):
- 위 매수 후보 중 하나가 "이미 보유 중인 배분형(conviction:"배분") 종목보다 뚜렷이 매력적"이라
  판단되면, 그 후보의 선택 항목에 rotateSell을 추가해 매도할 기존 종목을 지목해도 된다.
- rotateSell.name은 반드시 위 "보유 종목 현황" 목록에 실존하는 이름이어야 하고, 확신 종목이거나
  이 후보 자신과 같은 종목이면 안 된다.
- **회전(매도) 근거는 반드시 펀더멘털·평가등급 하락·목표 이미 달성·투자논리 훼손 중 하나여야
  한다. 가격·RSI·52주 고점/저점만으로 매도를 정당화하는 것은 금지**(가격 상승은 매도 신호가
  아니라는 것이 이 투자자의 확정 원칙 — 프로필 §3과 동일).
- 회전이 아니라 단순 추가매수가 낫다고 판단되면 rotateSell 없이 채택해도 된다(기본값).` : '';

  return `[주문서 최종 선별${label ? ` — ${label}` : ''}] Node가 결정론으로 계산한 주문 후보 중 실제 제안할 것을 골라줘.

[후보 목록 — 시스템이 시트·신호에서 직접 계산한 값. 이 수치만 사용, 재조회·재계산·추정 금지.
 qty/price/amount 는 절대 바꾸지 말 것(수량 조정이 필요하면 그 후보를 제외하고 이유를 남겨).]
${JSON.stringify(candidates, null, 1)}
${rotationBlock}

${prefBlock(confirmedPrefsText)}

판단 규칙:
- 같은 계좌에서 매도·매수가 짝이 되면 둘 다 채택(리밸런싱 세트).
- 서로 모순되는 후보(같은 종목 매수+매도)는 더 근거 강한 쪽만.
- 성향과 충돌하는 후보는 제외하고 reason에 명시.
- rationale: 각 채택 후보의 why 사실들을 1~2문장 산문으로(수치 그대로 인용, 단위 변형 금지).
- rationale에는 위 후보 JSON·보유종목 현황에 실존하는 종목명·수치만 사용 — 그 밖 종목명을
  언급하면 그 rationale은 폐기되고 결정론 근거만 남는다. idx는 후보 배열의 정수 인덱스 그대로.

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{"selected":[{"idx":0,"rationale":"한줄","rotateSell":{"name":"기존보유종목명","reason":"매도 근거 한줄"}}],"dropped":[{"idx":1,"reason":"한줄"}]}
\`\`\`
(rotateSell은 회전을 제안할 때만 포함 — 단순 매수면 생략)`;
}

function toRow(c, rationaleText) {
  const row = new Array(PROPOSAL_HEADER.length).fill('');
  row[P.DATE] = nowKST();
  row[P.SOURCE] = c.source;
  row[P.ACCT] = c.acct;
  row[P.SIDE] = c.side;
  row[P.NAME] = c.name;
  row[P.QTY] = c.qty;
  row[P.PRICE] = c.price;
  row[P.AMOUNT] = c.amount;
  row[P.RATIONALE] = JSON.stringify({ text: rationaleText || '', facts: c.why || {} });
  row[P.CONSTRAINTS] = JSON.stringify(c.checks || []);
  row[P.STATUS] = PROPOSAL_STATUS.PROPOSED;
  row[P.MATCH_KEY] = makeMatchKey(c);
  return row;
}

async function main() {
  console.log(`📋 주문제안 생성 — 모드 ${MODE}${DRY_RUN ? ' (dry-run)' : ''}`);
  const token = await getToken(explicitToken?.trim() || null, { allowBrowser: false });
  if (!DRY_RUN) await ensureSheet(token, PROPOSAL_SHEET, PROPOSAL_HEADER);

  // ── 입력 수집 (결정론) ──────────────────────────────
  const holdings = [];
  const cash = {};
  for (const acct of ACCOUNT_TABS) {
    const rows = await getRange(token, `${acct}!A2:I`);
    holdings.push(...parseHoldingRows(acct, rows));
    cash[acct] = parseCashRow(acct, rows);
  }
  if (!holdings.length) throw new Error('보유종목 0건 — 읽기 이상 의심, 안전을 위해 중단');

  const [riskRows, noteRows, journalRows, execRows, prefRows, existingRows, releaseRows] = await Promise.all([
    getRange(token, '리스크모니터!A2:H'),
    getRange(token, '종목투자노트!A2:U'),
    getRange(token, '포지션저널!A2:P'),
    getRange(token, '체결내역!A2:M'),
    getRange(token, `${PREF_SHEET}!A2:H`).catch(() => []),
    getRange(token, `${PROPOSAL_SHEET}!A2:N`).catch(() => []),
    getRange(token, '차단해제이력!A2:E').catch(() => []),   // 시트 미존재(최초 실행 전)면 빈 배열
  ]);
  const conclusions = latestConclusions(noteRows);
  const conviction = convictionMap(journalRows);
  // 회전(로테이션) 판단 재료 — weekly/crash 공용, 신규 fetch 없음(이미 읽은 rows에서 조립).
  const holdingsFacts = buildHoldingsFacts({ holdings, conclusions, conviction, journalRows });

  // ── 만료 처리: 7일 경과한 "제안" → 만료 (응답 없는 제안이 무한히 쌓이는 것 방지) ──
  const today = todayKST();
  const cutoff = new Date(new Date(today).getTime() - EXPIRE_DAYS * 86400000).toISOString().slice(0, 10);
  let expired = 0;
  for (let i = 0; i < existingRows.length; i++) {
    const r = existingRows[i];
    if (s(r[P.STATUS]) !== PROPOSAL_STATUS.PROPOSED) continue;
    if (toDateStr(r[P.DATE]) >= cutoff) continue;   // 시리얼 방어 — 생성일이 시리얼로 재읽힐 수 있음
    if (!DRY_RUN) await updateCell(token, `${PROPOSAL_SHEET}!${colLetter(P.STATUS)}${i + 2}`, PROPOSAL_STATUS.EXPIRED);
    expired++;
  }
  if (expired) console.log(`  🕰 만료 처리 ${expired}건 (${EXPIRE_DAYS}일 경과)`);

  // dedup: 미응답(제안)·승인 상태의 매칭키는 재제안 안 함
  const activeKeys = new Set(existingRows
    .filter(r => [PROPOSAL_STATUS.PROPOSED, PROPOSAL_STATUS.APPROVED].includes(s(r[P.STATUS])))
    .map(r => s(r[P.MATCH_KEY])));

  // ── 후보 생성 ───────────────────────────────────────
  let candidates = [];
  const evalRequests = [];

  // 논리(B) 신호는 모드 무관 공용 — crash 모드도 급락매수 가드에 필요, weekly 는 매도 후보에 사용.
  const bSignals = latestRiskByType(riskRows, 'B');
  // 차단해제 감지(구조조정 안건7) — B🔴에서 막 회복한 종목을 자동·조용히 통과시키지 않고 플래그.
  // risk-monitor.mjs가 전환 시점에 남긴 영구 로그(차단해제이력)를 읽는다 — 리스크모니터 시트
  // 자체는 pruneRiskSheet가 종목당 최신 1행만 남겨 이력 재구성이 불가하다(code-reviewer 지적).
  const bReleases = detectThesisReleases(releaseRows, today);

  if (MODE === 'crash') {
    const oSignals = latestRiskByType(riskRows, 'O');
    // 오늘 신호만 — 어제 급락 제안은 weekly가 이미 다뤘거나 만료됨
    for (const [k, v] of oSignals) if (v.date.slice(0, 10) !== today) oSignals.delete(k);
    candidates = buildCrashBuyCandidates({ oSignals, holdings, cash });
  } else {
    // weekly: 자산분배 갭
    const gaps = [];
    for (const [acct, range] of Object.entries(REBAL_RANGES)) {
      const rows = await getRange(token, `자산분배!${range}`).catch(() => []);
      for (const r of rows) {
        const assetType = s(r[0]); if (!assetType) continue;
        gaps.push({ acct, assetType, targetPct: num(r[1]) ?? 0, currentPct: num(r[2]) ?? 0, rebalAmt: num(r[3]) ?? 0 });
      }
    }
    candidates.push(...buildRebalanceCandidates({ gaps, holdings, conviction, conclusions }));

    const thesis = buildSellFromThesis({ bSignals, holdings, conviction, conclusions });
    candidates.push(...thesis.candidates);
    evalRequests.push(...thesis.evalRequests);

    candidates.push(...buildBuyFromEval({ conclusions, execRows, holdings, cash }));
  }

  // dedup 적용
  candidates = candidates.filter(c => !activeKeys.has(makeMatchKey(c)));

  // 미보유 종목(가격 미상) 단가 해결 — yfinance. 미해결이면 추정 금지, 제안 제외(경고).
  for (const c of candidates) {
    if (c.price != null) continue;
    try {
      const market = s(noteRows.find(r => s(r[1]) === c.name)?.[3]).toUpperCase();
      const md = market === 'US'
        ? (usTicker(c.name) ? fetchMarketData(usTicker(c.name)) : null)
        : (krStockCode(c.name) ? await fetchKrMarketData(krStockCode(c.name)) : null);
      if (md?.currentPrice > 0) {
        // KR은 KRW 그대로, US는 환율 미적용 상태라 v1은 KR만 지원 — US 미보유는 제외
        if (market === 'US') { collectWarning(`주문제안 제외: ${c.name} — US 미보유 종목 단가 환산 미지원(v1)`); c.qty = null; continue; }
        c.price = Math.round(md.currentPrice);
        const budget = Math.min(RULE500_WON, cash[c.acct] ?? 0);
        c.qty = Math.floor(budget / c.price);
        c.amount = c.qty * c.price;
      }
    } catch (e) { console.error(`   ⚠️ ${c.name} 단가 조회 실패 — ${e.message}`); /* 아래 공통 제외 처리 */ }
    if (!(c.qty >= 1)) collectWarning(`주문제안 제외: ${c.name} — 단가 미해결/예산 부족`);
  }
  candidates = candidates.filter(c => c.qty >= 1 && c.price != null);

  // 논리훼손 가드 — B🔴 매수 후보 제외, B🟡 매수 후보엔 충돌 플래그(리스크 우선순위 B>가격 강제).
  // 매도평가 라우팅은 weekly buildSellFromThesis + risk-monitor 🔴 텔레그램이 담당(중복 방지).
  const guard = applyThesisGuard(candidates, bSignals, bReleases);
  candidates = guard.kept;
  guard.dropped.forEach(d => {
    console.log(`  ⛔ 매수 제외 [${d.source}] ${d.acct} ${d.name} — ${d.reason}`);
    collectWarning(`주문제안 제외: ${d.name} — ${d.reason}`);
  });

  // 제약 체크 부착
  for (const c of candidates) c.checks = checkConstraints(c, { cash, conviction });

  console.log(`  후보 ${candidates.length}건 · 매도평가 의뢰 ${evalRequests.length}건 (dedup 후)`);
  candidates.forEach(c => console.log(`    · [${c.source}] ${c.acct} ${c.side} ${c.name} ${c.qty}주 @${c.price?.toLocaleString()} ≈ ${c.amount?.toLocaleString()}원`));

  // ── AI 최종 선별 (weekly·crash 공용·후보 있을 때만·쿨다운 존중) ──
  // crash도 weekly와 동일하게 AI 판단을 받는다 — "AI 생략"은 원래 비용 절감이 아니라 실행
  // 흐름 단순화 목적이었고(커밋 이력 확인), AI 실패 시 아래처럼 Node 결정론 후보로 안전
  // 폴백하므로 크래시 경로의 신속성·신뢰성은 그대로 유지된다.
  let finalRows = [];
  if (candidates.length) {
    let selected = candidates.map((c, i) => ({ c, rationale: '' , idx: i }));
    if (!DRY_RUN && !cooldownActive()) {
      try {
        const confirmedPrefsText = renderPrefRows(prefRows, { confirmedOnly: true });
        // 확신 종목은 회전 매도 후보에서 원천 배제 — AI에게 애초에 보여주지 않는다.
        const rotatable = holdingsFacts.filter(f => f.conviction !== '확신');
        const res = parseJsonBlock(await runHeadlessClaude(buildSelectionPrompt(
          candidates.map(({ checks: _checks, ...rest }) => rest), confirmedPrefsText, rotatable,
          MODE === 'crash' ? '급락 대응' : '주간'), MODEL, 'Read',
          { appendSystemPrompt: AGENT.systemPrompt }));
        if (!Array.isArray(res.selected)) throw new Error('AI 응답에 selected 배열 없음');
        // 파싱에 성공했으면 빈 selected 도 "전부 제외" 의도로 존중한다 — 실패 폴백(전체 적재)과
        // 구분하지 않으면 AI가 성향 충돌로 걸러낸 후보가 그대로 올라가는 역전이 생긴다.
        // LLM 출력 하네스(2026-07): idx는 정수만, rationale은 후보 목록 밖 종목명을 언급하면
        // 폐기(빈 문자열)하고 경고 — 수치는 어차피 candidates[idx]가 정본이라 rationale만 리스크.
        // allowedNames는 후보별로 좁게 스코프한다 — 후보명 전체를 항상 허용하되, 회전을 지목한
        // 항목만 그 매도 대상 이름 하나를 추가로 허용(전체 보유종목으로 다 열면 실존 종목을 아무
        // 데나 끌어다 쓰는 걸 가드가 못 잡게 된다 — 2026-07 성향관찰 환각 사고의 재발 방지 지점).
        const candidateNames = candidates.map(c => c.name);
        const nameUniverse = [...new Set([...holdings.map(h => h.name), ...candidateNames])];
        // 같은 idx 중복 선택 방지 + 회전 매도 중복 방지(직전 사고 지점: activeKeys는 이번 실행
        // 이전의 시트 상태만 반영해 같은 실행 안에서 나온 매도끼리는 서로 못 잡는다) — 이번
        // 실행에서 확정될 매도(결정론 후보 중 selected에 포함될 것 + 회전으로 새로 만든 것)를
        // 전부 한 Set에 누적해 대조한다.
        const seenIdx = new Set();
        const selectedIdxSet = new Set(res.selected.map(x => x.idx));
        const runSellKeys = new Set(
          candidates
            .filter((c, i) => c.side === '매도' && selectedIdxSet.has(i))
            .map(makeMatchKey)
        );
        selected = res.selected
          .filter(x => Number.isInteger(x.idx) && candidates[x.idx])
          .filter(x => { if (seenIdx.has(x.idx)) return false; seenIdx.add(x.idx); return true; })
          .flatMap(x => {
            const c = candidates[x.idx];
            const sellName = s(x.rotateSell?.name);
            const itemAllowed = sellName ? [...candidateNames, sellName] : candidateNames;

            let rationale = s(x.rationale);
            const unknown = unknownMentions(rationale, nameUniverse, itemAllowed);
            if (unknown.length) {
              collectWarning(`주문제안 rationale 폐기: ${c.name} — 후보 밖 종목 언급(${unknown.join(', ')})`);
              rationale = '';
            }
            const picked = { c, rationale: clampLen(rationale, 300) };
            if (!sellName) return [picked];

            // 회전(로테이션): AI가 매도할 기존 보유종목을 지목 — Node가 수량/단가를 보유
            // 데이터에서 결정론 계산해 짝 후보로 조립한다(AI는 종목명·근거만, 수치는 안 만듦).
            const { candidate: sellCandidate, reason: rejectReason } = resolveRotationSell({
              sellName, buyName: c.name, holdings, rotatable,
              isDuplicateKey: (k) => activeKeys.has(k) || runSellKeys.has(k),
            });
            if (!sellCandidate) {
              collectWarning(`회전 매도 제외: ${sellName} — ${rejectReason}`);
              return [picked];
            }
            runSellKeys.add(makeMatchKey(sellCandidate));
            sellCandidate.checks = checkConstraints(sellCandidate, { cash, conviction });
            let sellReason = s(x.rotateSell.reason);
            const sellUnknown = unknownMentions(sellReason, nameUniverse, itemAllowed);
            if (sellUnknown.length) sellReason = '';
            c.source = PROPOSAL_SOURCE.ROTATION;
            c.why = { ...c.why, 회전상대: `${sellName} 매도와 연동(회전)` };
            console.log(`    🔁 회전 제안: ${sellName} 매도 → ${c.name} 매수`);
            return [picked, { c: sellCandidate, rationale: clampLen(sellReason, 300) }];
          });
        (res.dropped || []).forEach(d => candidates[d.idx] &&
          console.log(`    ✂ AI 제외: ${candidates[d.idx].name} — ${s(d.reason)}`));
      } catch (e) {
        // AI 불가 시 Node 후보 그대로 — 수치는 전부 결정론이라 안전(파이프라인 생존 우선)
        console.error(`  ⚠️ AI 선별 실패(${e.message.slice(0, 80)}) — Node 후보 전체 적재`);
        collectWarning('주문제안: AI 선별 실패 — 결정론 후보로 대체');
      }
    }
    finalRows = selected.map(x => toRow(x.c, x.rationale));
  }

  // ── 매도평가 자동 의뢰 (weekly) — 이미 대기/처리중인 동일 종목 의뢰는 skip ──
  let enqueued = 0;
  if (evalRequests.length && !DRY_RUN) {
    const queueRows = await getRange(token, '평가요청!A2:F').catch(() => []);
    for (const req of evalRequests) {
      const dup = queueRows.some(r => s(r[1]) === req.name && /매도\s*평가/.test(s(r[5]))
        && [EVAL_STATUS.PENDING, EVAL_STATUS.PROCESSING].includes(s(r[3]) || EVAL_STATUS.PENDING));
      if (dup) continue;
      const market = s(noteRows.find(r => s(r[1]) === req.name)?.[3]) || 'KR';
      await appendValues(token, '평가요청!A2:F',
        [[nowKST(), req.name, market, EVAL_STATUS.PENDING, '', `매도평가 — ${req.reason} (주문제안 자동의뢰)`]]);
      enqueued++;
    }
    if (enqueued) console.log(`  📮 매도평가 자동 의뢰 ${enqueued}건`);
  }

  if (DRY_RUN) { console.log('\n(드라이런 — 쓰기 없음)'); await flushWarnings('order-proposals', { dryRun: true }); return; }

  if (finalRows.length) {
    await appendValues(token, `${PROPOSAL_SHEET}!A2`, finalRows);
    const buys = finalRows.filter(r => r[P.SIDE] === '매수').length;
    const sells = finalRows.length - buys;
    console.log(`✅ 주문서 ${finalRows.length}건 적재 (매수 ${buys}·매도 ${sells})`);
    try {
      const lines = finalRows.map(r =>
        `· ${r[P.ACCT]} <b>${r[P.SIDE]}</b> ${r[P.NAME]} ${r[P.QTY]}주 ≈ ${Number(r[P.AMOUNT]).toLocaleString()}원`);
      await sendTelegram(`📋 <b>주문서 ${finalRows.length}건 도착</b> (${MODE === 'crash' ? '급락 대응' : '주간'})\n${lines.join('\n')}\n\n앱 주문 탭에서 승인/기각해 주세요.`);
    } catch (e) { console.error('텔레그램 실패(무시):', e.message); }
  } else {
    console.log('✅ 신규 주문서 없음 (신호 없음 또는 전부 dedup)');
  }
  await flushWarnings('order-proposals');
}

main().catch(async (e) => {
  console.error('\n❌ 오류:', e.message);
  await flushWarnings('order-proposals').catch(() => {});
  process.exit(1);
});
