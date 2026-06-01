#!/usr/bin/env node
/**
 * 보유종목 펀더멘털 기준선(baseline) 백필 — AI 리스크 엔진 Phase 3
 *
 * 4개 계좌 보유종목을 읽어, 종목별 펀더멘털 기준선을 헤드리스 claude -p 로 조회해
 * `리스크기준선` 탭에 적재한다. 이 기준선은 Phase 4 B 유형(논리 훼손) 판단의 비교 기준점.
 *
 * `리스크기준선` 스키마(10열):
 *   종목 | 티커 | 시장 | 기준일 | 매출총이익률 | 영업이익률 | ROE | 부채비율 | EPS | 비고(소스)
 *
 * 사용법:
 *   node scripts/backfill-baselines.mjs            # 헤드리스로 기준선 백필
 *   node scripts/backfill-baselines.mjs --dry-run  # 보유종목/대상만 확인
 *   node scripts/backfill-baselines.mjs --force     # 이미 적재된 종목도 재조회
 *   node scripts/backfill-baselines.mjs --model=opus
 *   node scripts/backfill-baselines.mjs <TOKEN>     # OAuth 대신 토큰 직접 전달
 *
 * 멱등성: 기본은 이미 `리스크기준선`에 있는 종목은 건너뜀(--force 로 무시).
 */

import {
  loadEnv, getTokenViaBrowser, getRange, appendValues, ensureSheet,
  readHoldings, runHeadlessClaude, parseJsonBlock, todayKST, HEADLESS_NOTE,
} from './lib/sheets-common.mjs';

const BASELINE_SHEET = '리스크기준선';
const BASELINE_HEADER = ['종목', '티커', '시장', '기준일', '매출총이익률', '영업이익률', 'ROE', '부채비율', 'EPS', '비고'];

const args = process.argv.slice(2);
const explicitToken = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const modelArg = args.find(a => a.startsWith('--model='));
const MODEL = modelArg ? modelArg.split('=')[1] : 'sonnet';

loadEnv();

function buildBaselinePrompt(h) {
  const dataRule = h.market === 'KR'
    ? '- KR: OpenDart REST(curl, $DART_API_KEY). 오늘 기준 직전 분기 우선(4~5월=1분기 11013, 없으면 직전 사업보고서 11011). 수익성 M210000(매출총이익률·영업이익률·ROE), 안정성 M220000(부채비율)'
    : '- US: python3 yfinance. info(grossMargins·operatingMargins·returnOnEquity·debtToEquity·trailingEps) 또는 financials/balance_sheet 계산. quarterly/TTM 우선';
  return `다음 보유종목의 펀더멘털 "기준선"을 조회해줘. 향후 실적 훼손(논리 붕괴) 감지의 비교 기준점이야.

종목: ${h.name}
시장: ${h.market}

조회 항목(현재 시점 최신 분기 기준): 매출총이익률(%) · 영업이익률(%) · ROE(%) · 부채비율(%) · EPS(주당순이익)

데이터 규칙:
${dataRule}
- 데이터 못 구하면 추정 금지, 해당 값은 정확히 "데이터 부족" 으로만 표기(부연 설명·사유 금지)
- 실제 조회한 수치만 사용. 소스(예: "OpenDart 2026 1분기보고서", "yfinance TTM")를 note에 명시

출력: 설명 없이 아래 형식의 \`\`\`json 블록 하나만.
\`\`\`json
{"name":"${h.name}","ticker":"","market":"${h.market}","date":"${todayKST()}","gross_margin":"","operating_margin":"","roe":"","debt_ratio":"","eps":"","note":""}
\`\`\`
${HEADLESS_NOTE}`;
}

function buildRow(b) {
  return [
    b.name || '', b.ticker || '', b.market || '', b.date || '',
    b.gross_margin || '', b.operating_margin || '', b.roe || '',
    b.debt_ratio || '', b.eps || '', b.note || '',
  ];
}

async function main() {
  console.log('🧭 보유종목 기준선 백필 (헤드리스)');
  if (DRY_RUN) console.log('   (--dry-run)');
  if (FORCE) console.log('   (--force: 기존 적재 종목도 재조회)');

  let token = explicitToken?.trim();
  if (!token) { console.log('\n🔑 Google 인증 중...'); token = await getTokenViaBrowser(); console.log('✅ 토큰 획득'); }
  else console.log('✓ 토큰 인수 사용');

  await ensureSheet(token, BASELINE_SHEET, BASELINE_HEADER);

  const holdings = await readHoldings(token);

  // 기준선은 risk-monitor mode B(위탁 개별주식 국내/해외)의 논리훼손 비교 기준점.
  // B 점검 대상이 아닌 ETF·펀드·현금성에는 기준선이 쓰이지 않고 헤드리스 호출(사용량 한도)만
  // 낭비하므로 동일하게 위탁 개별주식만 대상으로 한정. (risk-monitor.mjs mode B 필터와 일치)
  const STOCK_TYPES = new Set(['국내주식', '해외주식']);
  const stocks = holdings.filter(h => h.accounts.some(a => a.acct === '위탁' && STOCK_TYPES.has(a.type)));

  const existing = new Set();
  if (!FORCE) {
    const base = await getRange(token, `${BASELINE_SHEET}!A2:B`);
    for (const r of base) { const k = String(r[0] ?? '').trim(); if (k) existing.add(k); }
  }

  const targets = stocks.filter(h => FORCE || !existing.has(h.name));
  console.log(`\n📊 위탁 개별주식 ${stocks.length}개 (전체 ${holdings.length}개 중 ETF·펀드·현금성 ${holdings.length - stocks.length}개 제외) · 백필 대상 ${targets.length}개` + (existing.size ? ` (기존 ${existing.size}개 건너뜀)` : ''));
  for (const h of targets) console.log(`   - ${h.name} (${h.market}, ${h.accounts.map(a => a.acct).join('/')})`);

  if (DRY_RUN || targets.length === 0) { console.log('\n완료(적재 없음).'); return; }

  let ok = 0, fail = 0;
  for (const h of targets) {
    console.log(`\n⏳ ${h.name} 기준선 조회 중... (수 분)`);
    try {
      const b = parseJsonBlock(await runHeadlessClaude(buildBaselinePrompt(h), MODEL));
      await appendValues(token, `${BASELINE_SHEET}!A2`, [buildRow(b)]);
      console.log(`   ✅ 적재: 매총이 ${b.gross_margin} · 영익률 ${b.operating_margin} · ROE ${b.roe} · 부채 ${b.debt_ratio}`);
      ok++;
    } catch (e) {
      console.error(`   ❌ 실패: ${e.message}`);
      fail++;
    }
  }
  console.log(`\n🏁 완료 — 성공 ${ok} · 실패 ${fail}`);
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
