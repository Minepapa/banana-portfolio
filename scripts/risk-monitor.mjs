#!/usr/bin/env node
/**
 * 리스크 모니터 — AI 리스크 엔진 Phase 4
 *
 * 두 모드로 동작, 결과를 `리스크모니터` 탭에 적재한다.
 *   --mode=B (주1회): 보유종목별 펀더멘털을 재조회해 저장된 기준선/매수논리 대비 "논리 훼손" 판단.
 *                     가드레일: 영업이익 YoY 2분기 연속 감소·가이던스 하향·FCF 적자전환·부채 급증은
 *                     강제 🟡 이상. 단순 가격 과열(52주/RSI)은 단독 신호로 쓰지 않음(Frank 철학).
 *   --mode=D (매일): USDKRW·미10년물·VIX·KOSPI·S&P 조회 → Trading Agent CLAUDE.md 거시 트리거 대조
 *                    → Frank 보유 포지션/자산군에 연결된 영향만 산출.
 *
 * `리스크모니터` 스키마(8열):
 *   날짜 | 유형(B/D) | 대상 | 신호(🟢🟡🔴) | 요약 | 상세 | 근거데이터(JSON) | 기준선참조
 *
 * 사용법:
 *   node scripts/risk-monitor.mjs --mode=D            # 거시 리스크 (매일)
 *   node scripts/risk-monitor.mjs --mode=B            # 논리 훼손 (주1회)
 *   node scripts/risk-monitor.mjs --mode=D --dry-run  # 프롬프트만 출력
 *   node scripts/risk-monitor.mjs --mode=B --model=opus
 *   node scripts/risk-monitor.mjs --mode=D <TOKEN>    # OAuth 대신 토큰 직접 전달
 *   node scripts/risk-monitor.mjs --mode=B --no-push  # 🔴 텔레그램 푸시 끔
 *
 * 🔴 신호는 텔레그램으로 즉시 푸시(신규만 — 같은 유형·대상의 직전 🔴 는 중복 발송 안 함).
 * 🟡🟢 는 푸시하지 않음(시트 기록만).
 */

import {
  loadEnv, getTokenViaBrowser, getRange, appendValues, ensureSheet,
  readHoldings, runHeadlessClaude, parseJsonBlock, todayKST, HEADLESS_NOTE,
  sendTelegram,
} from './lib/sheets-common.mjs';

const RISK_SHEET = '리스크모니터';
const RISK_HEADER = ['날짜', '유형', '대상', '신호', '요약', '상세', '근거데이터', '기준선참조'];
const BASELINE_SHEET = '리스크기준선';
const HUB_CLAUDE = '/Users/huinique/Claude/Agent/Trading Agent/CLAUDE.md';

const args = process.argv.slice(2);
const explicitToken = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');
const NO_PUSH = args.includes('--no-push');
const modeArg = args.find(a => a.startsWith('--mode='));
const MODE = modeArg ? modeArg.split('=')[1].toUpperCase() : '';
const modelArg = args.find(a => a.startsWith('--model='));
const MODEL = modelArg ? modelArg.split('=')[1] : 'sonnet';

loadEnv();

if (!['B', 'D'].includes(MODE)) {
  console.error('❌ --mode=B 또는 --mode=D 를 지정하세요.');
  process.exit(1);
}

// 보유 포지션 요약 텍스트 (헤드리스 프롬프트용)
function holdingsSummary(holdings) {
  if (!holdings.length) return '(보유종목 없음)';
  // 자산군별 집계
  const byType = {};
  let krInvest = 0, usInvest = 0;
  for (const h of holdings) {
    const invest = h.accounts.reduce((s, a) => s + (a.invest || 0), 0);
    byType[h.type || '기타'] = (byType[h.type || '기타'] || 0) + invest;
    if (h.market === 'US') usInvest += invest; else krInvest += invest;
  }
  const total = krInvest + usInvest || 1;
  const typeLines = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([t, v]) => `  - ${t}: ${Math.round(v / total * 100)}%`)
    .join('\n');
  const names = holdings.map(h => h.name).join(', ');
  return `자산군 비중:\n${typeLines}\n  - 국내 ${Math.round(krInvest / total * 100)}% / 해외 ${Math.round(usInvest / total * 100)}%\n보유종목: ${names}`;
}

// ── D 모드: 거시 리스크 프롬프트 ────────────────────────
function buildMacroPrompt(holdings) {
  return `[거시 리스크 점검 — 매일] Frank 포트폴리오에 대한 거시 충격(D 유형) 리스크를 평가해줘.

먼저 \`${HUB_CLAUDE}\` 파일을 Read 로 읽고 거시 트리거 기준(환율/금리/VIX 임계값 등)을 확인해.
그 다음 아래 거시지표를 실제로 조회(yfinance)하고, Frank 보유 포지션에 "연결되는 영향만" 판단해.

[Frank 포트폴리오]
${holdingsSummary(holdings)}

조회 거시지표(yfinance): USDKRW("KRW=X") · 미10년물("^TNX") · VIX("^VIX") · KOSPI("^KS11") · S&P500("^GSPC")
- 각 지표의 현재값 + 최근 5거래일 변화율도 함께.

판단 규칙:
- Hub CLAUDE.md 거시 트리거에 해당하면 그 자산군/종목을 대상으로 신호 생성.
- 일반적 지표 나열 금지 — 반드시 "Frank의 어느 자산군/포지션에 어떻게" 영향인지 매핑.
- 신호 없으면(트리거 미발동) signals 빈 배열로.
- 가격 과열 단독은 리스크로 쓰지 않음(펀더멘털 우선 철학).

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{
  "date": "${todayKST()}",
  "indicators": {"USDKRW":"","TNX":"","VIX":"","KOSPI":"","SP500":""},
  "signals": [
    {"target":"해외주식(US 익스포저)","signal":"🟡","summary":"한줄 요약","detail":"무엇이 어떻게 바뀌어 어느 포지션에 영향","evidence":{"VIX":"","변화":""}}
  ]
}
\`\`\`
${HEADLESS_NOTE}`;
}

// ── B 모드: 논리 훼손 프롬프트 (종목별) ─────────────────
function buildLogicPrompt(h, baseline, buyCard) {
  const baseLine = baseline
    ? `[저장된 기준선 (${baseline.date})]
매출총이익률 ${baseline.gross_margin} · 영업이익률 ${baseline.operating_margin} · ROE ${baseline.roe} · 부채비율 ${baseline.debt_ratio} · EPS ${baseline.eps}
(${baseline.note || ''})`
    : '[저장된 기준선] 없음 — 현재 펀더멘털만으로 절대 평가';
  const cardLine = buyCard
    ? `[매수 논리 (${buyCard.date})]
결론: ${buyCard.conclusion}
근거: ${(buyCard.reasons || []).join(' / ') || '(미기록)'}
리스크: ${(buyCard.risks || []).join(' / ') || '(미기록)'}`
    : '[매수 논리] 종목투자노트에 없음 — 기준선 대비 변화만 판단';
  const dataRule = h.market === 'KR'
    ? '- KR: OpenDart REST(curl). 오늘 기준 직전 분기(4~5월=1분기 11013) 매출총이익률·영업이익률·ROE·부채비율 + 최근 2분기 영업이익 YoY 추세'
    : '- US: yfinance quarterly_financials/info. 매출총이익률·영업이익률·ROE·부채비율 + 최근 2분기 영업이익 YoY 추세';

  return `[논리 훼손 점검 — 주간] 보유종목의 매수 논리가 펀더멘털상 훼손됐는지 판단해줘.

종목: ${h.name} (${h.market})

${baseLine}

${cardLine}

현재 펀더멘털을 재조회해서 기준선/매수논리와 비교:
${dataRule}

판단 규칙(가드레일 — 해당 시 강제 🟡 이상):
- 영업이익 YoY 2분기 연속 감소
- 가이던스/컨센서스 명백한 하향
- FCF 적자 전환
- 부채비율 급증(기준선 대비 +20%p 이상)
- 매수 근거의 핵심 전제가 깨짐(예: "마진 개선" 논리인데 마진 급락)
신호: 🟢 논리 유효 / 🟡 약화·주의 / 🔴 훼손(매도 평가 필요)
※ 단순 주가 하락·52주/RSI 과열은 단독으로 신호 삼지 않음(펀더멘털 우선).

출력: 설명 없이 \`\`\`json 블록 하나만.
\`\`\`json
{"date":"${todayKST()}","name":"${h.name}","signal":"🟢","summary":"한줄","detail":"무엇이 어떻게 바뀌었나(기준선 대비)","evidence":{"매출총이익률":"","영업이익률":"","영업이익YoY":""},"baseline_ref":"${baseline ? baseline.date : '없음'}"}
\`\`\`
${HEADLESS_NOTE}`;
}

// 종목투자노트에서 최신 매수 카드 조회 (status 매도 제외)
function findBuyCard(noteRows, name) {
  const matches = [];
  (noteRows || []).forEach((r) => {
    if (String(r[1] ?? '').trim() !== name) return;
    if (String(r[14] ?? '').trim() === '매도') return;
    matches.push({
      date: String(r[0] ?? '').trim(),
      conclusion: String(r[4] ?? '').trim(),
      reasons: String(r[10] ?? '').split(/\d+\)\s*/).filter(Boolean).map(s => s.trim()),
      risks: String(r[11] ?? '').split(/\d+\)\s*/).filter(Boolean).map(s => s.trim()),
    });
  });
  matches.sort((a, b) => b.date.localeCompare(a.date)); // 최신 우선
  return matches[0] || null;
}

function baselineMap(rows) {
  const m = new Map();
  for (const r of (rows || [])) {
    const name = String(r[0] ?? '').trim();
    if (!name) continue;
    m.set(name, {
      name, ticker: r[1], market: r[2], date: r[3],
      gross_margin: r[4], operating_margin: r[5], roe: r[6],
      debt_ratio: r[7], eps: r[8], note: r[9],
    });
  }
  return m;
}

// 기존 리스크모니터 행에서 직전 🔴 (유형|대상) 키 수집 → 신규 🔴 만 푸시
function redKeysFromRows(rows) {
  const s = new Set();
  for (const r of (rows || [])) {
    if (String(r[3] ?? '').includes('🔴')) s.add(`${r[1]}|${r[2]}`);
  }
  return s;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 신규 🔴 행만 텔레그램 푸시. priorRedKeys 를 변형해 같은 실행 내 중복도 차단.
async function pushNewReds(rows, priorRedKeys) {
  if (NO_PUSH) return;
  for (const row of rows) {
    const [date, type, target, signal, summary, detail] = row;
    if (!String(signal).includes('🔴')) continue;
    const key = `${type}|${target}`;
    if (priorRedKeys.has(key)) continue;
    priorRedKeys.add(key);
    const typeLabel = type === 'D' ? '거시 충격' : '논리 훼손';
    const text = `🔴 <b>리스크 경보</b> · ${typeLabel}\n`
      + `<b>${escapeHtml(target)}</b>\n`
      + `${escapeHtml(summary || '')}\n`
      + (detail ? `\n${escapeHtml(String(detail).slice(0, 300))}\n` : '')
      + `\n<i>${date}</i>`;
    try { await sendTelegram(text); console.log(`      📲 텔레그램 푸시: ${target}`); }
    catch (e) { console.error(`      ⚠️ 텔레그램 실패: ${e.message}`); }
  }
}

async function main() {
  console.log(`🛡️  리스크 모니터 — 모드 ${MODE} (${MODE === 'D' ? '거시/일간' : '논리훼손/주간'})`);
  if (DRY_RUN) console.log('   (--dry-run: 프롬프트만 출력)');

  let token = explicitToken?.trim();
  if (!DRY_RUN) {
    if (!token) { console.log('\n🔑 Google 인증 중...'); token = await getTokenViaBrowser(); console.log('✅ 토큰 획득'); }
    else console.log('✓ 토큰 인수 사용');
    await ensureSheet(token, RISK_SHEET, RISK_HEADER);
  }

  // dry-run 이면서 토큰 없으면 보유종목을 읽을 수 없음 → 빈 목록으로 프롬프트 형태만 확인
  const holdings = (token) ? await readHoldings(token) : [];

  // 신규 🔴 판별용: 기존 리스크모니터의 직전 🔴 (유형|대상) 키
  const priorRedKeys = (token && !NO_PUSH)
    ? redKeysFromRows(await getRange(token, `${RISK_SHEET}!A2:H`))
    : new Set();

  if (MODE === 'D') {
    const prompt = buildMacroPrompt(holdings);
    if (DRY_RUN) { console.log('\n┌─── D 프롬프트 ───┐\n' + prompt + '\n└──────────────────┘'); return; }
    console.log(`\n⏳ 거시 리스크 분석 중... (수 분)`);
    try {
      const res = parseJsonBlock(await runHeadlessClaude(prompt, MODEL));
      const sigs = res.signals || [];
      const evidenceBase = JSON.stringify(res.indicators || {});
      if (!sigs.length) {
        console.log('   ✅ 거시 트리거 미발동 — 신호 없음. (기록은 남김: 🟢 정상)');
        await appendValues(token, `${RISK_SHEET}!A2`, [[
          res.date || todayKST(), 'D', '포트폴리오 전체', '🟢',
          '거시 트리거 미발동', '환율·금리·VIX·지수 정상 범위', evidenceBase, '',
        ]]);
      } else {
        const rows = sigs.map(s => [
          res.date || todayKST(), 'D', s.target || '포트폴리오', s.signal || '🟡',
          s.summary || '', s.detail || '', JSON.stringify({ ...res.indicators, ...(s.evidence || {}) }), '',
        ]);
        await appendValues(token, `${RISK_SHEET}!A2`, rows);
        console.log(`   ✅ 거시 신호 ${rows.length}건 적재`);
        sigs.forEach(s => console.log(`      ${s.signal} ${s.target}: ${s.summary}`));
        await pushNewReds(rows, priorRedKeys);
      }
    } catch (e) {
      console.error(`   ❌ 실패: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  // MODE === 'B'
  const [noteRows, baseRows] = await Promise.all([
    getRange(token, '종목투자노트!A2:U'),
    getRange(token, `${BASELINE_SHEET}!A2:J`),
  ]);
  const bMap = baselineMap(baseRows);

  console.log(`\n📊 보유종목 ${holdings.length}개 논리 점검 시작`);
  let ok = 0, fail = 0, alerts = 0;
  for (const h of holdings) {
    const baseline = bMap.get(h.name) || null;
    const buyCard = findBuyCard(noteRows, h.name);
    const prompt = buildLogicPrompt(h, baseline, buyCard);
    if (DRY_RUN) { console.log(`\n┌─── B 프롬프트 [${h.name}] ───┐\n` + prompt + '\n└──────────────────┘'); continue; }
    console.log(`\n⏳ ${h.name} 논리 점검 중... (수 분)`);
    try {
      const r = parseJsonBlock(await runHeadlessClaude(prompt, MODEL));
      const row = [
        r.date || todayKST(), 'B', h.name, r.signal || '🟢',
        r.summary || '', r.detail || '', JSON.stringify(r.evidence || {}),
        r.baseline_ref || (baseline ? baseline.date : '없음'),
      ];
      await appendValues(token, `${RISK_SHEET}!A2`, [row]);
      console.log(`   ${r.signal || '🟢'} ${h.name}: ${r.summary || ''}`);
      await pushNewReds([row], priorRedKeys);
      if (r.signal && r.signal !== '🟢') alerts++;
      ok++;
    } catch (e) {
      console.error(`   ❌ ${h.name} 실패: ${e.message}`);
      fail++;
    }
  }
  if (!DRY_RUN) console.log(`\n🏁 완료 — 점검 ${ok} · 경보(🟡🔴) ${alerts} · 실패 ${fail}`);
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
