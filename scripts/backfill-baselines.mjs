#!/usr/bin/env node
/**
 * 보유종목 펀더멘털 기준선(baseline) 백필 — AI 리스크 엔진 Phase 3
 *
 * 4개 계좌 보유종목을 읽어, 종목별 펀더멘털 기준선을 OpenDart/yfinance에서 직접
 * 조회(결정론)해 `리스크기준선` 탭에 적재한다. Phase 4 B 유형(논리 훼손) 판단의 비교 기준점.
 * (LLM 미사용 — 숫자는 Node가 fundamentals.mjs 페처로만 산출해 환각 차단)
 *
 * `리스크기준선` 스키마(10열):
 *   종목 | 티커 | 시장 | 기준일 | 매출총이익률 | 영업이익률 | ROE | 부채비율 | EPS | 비고(소스)
 *
 * 사용법:
 *   node scripts/backfill-baselines.mjs            # 기준선 백필(직접 조회)
 *   node scripts/backfill-baselines.mjs --dry-run  # 보유종목/대상만 확인
 *   node scripts/backfill-baselines.mjs --force     # 이미 적재된 종목도 재조회
 *   node scripts/backfill-baselines.mjs <TOKEN>     # OAuth 대신 토큰 직접 전달
 *
 * 멱등성: 기본은 이미 `리스크기준선`에 있는 종목은 건너뜀(--force 로 무시).
 */

import {
  loadEnv, getToken, hasServiceAccount, getRange, appendValues, setValues, ensureSheet,
  readHoldings, todayKST,
} from './lib/sheets-common.mjs';
import { fetchKrFundamentals, fetchUsFundamentals } from './lib/fundamentals.mjs';
import { krCorpCode, usTicker, krStockCode } from './lib/instruments.mjs';

const BASELINE_SHEET = '리스크기준선';
const BASELINE_HEADER = ['종목', '티커', '시장', '기준일', '매출총이익률', '영업이익률', 'ROE', '부채비율', 'EPS', 'PBR', '비고'];

const args = process.argv.slice(2);
const explicitToken = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

loadEnv();

async function main() {
  console.log('🧭 보유종목 기준선 백필 (OpenDart/yfinance 직접 조회 — 결정론)');
  if (DRY_RUN) console.log('   (--dry-run)');
  if (FORCE) console.log('   (--force: 기존 적재 종목도 재조회)');

  let token = explicitToken?.trim() || null;
  if (!token) {
    console.log(hasServiceAccount() ? '\n🤖 서비스 계정 인증(무인)...' : '\n🔑 Google 인증 중...');
    token = await getToken(token);
    console.log('✅ 토큰 획득');
  } else console.log('✓ 토큰 인수 사용');

  await ensureSheet(token, BASELINE_SHEET, BASELINE_HEADER);
  // ensureSheet는 신규 탭만 헤더를 씀 — 기존 탭도 스키마 변경 시 갱신.
  await setValues(token, `${BASELINE_SHEET}!A1`, [BASELINE_HEADER]);

  const holdings = await readHoldings(token);

  // 기준선은 risk-monitor mode B(위탁 개별주식 국내/해외)의 논리훼손 비교 기준점.
  // B 점검 대상이 아닌 ETF·펀드·현금성에는 기준선이 쓰이지 않고 헤드리스 호출(사용량 한도)만
  // 낭비하므로 동일하게 위탁 개별주식만 대상으로 한정. (risk-monitor.mjs mode B 필터와 일치)
  const STOCK_TYPES = new Set(['국내주식', '해외주식']);
  const stocks = holdings.filter(h => h.accounts.some(a => a.acct === '위탁' && STOCK_TYPES.has(a.type)));

  // 기존 행 rowNum 맵 구성 (--force 시에도 제자리 업데이트하려면 위치가 필요)
  const existingRowMap = new Map(); // name → 1-indexed 시트 행 번호
  const baseRows = await getRange(token, `${BASELINE_SHEET}!A2:A`).catch(() => []);
  baseRows.forEach((r, i) => { const k = String(r[0] ?? '').trim(); if (k) existingRowMap.set(k, i + 2); });

  const targets = stocks.filter(h => FORCE || !existingRowMap.has(h.name));
  const skippedCount = stocks.length - targets.length;
  console.log(`\n📊 위탁 개별주식 ${stocks.length}개 (전체 ${holdings.length}개 중 ETF·펀드·현금성 ${holdings.length - stocks.length}개 제외) · 백필 대상 ${targets.length}개` + (skippedCount ? ` (기존 ${skippedCount}개 건너뜀)` : ''));
  for (const h of targets) console.log(`   - ${h.name} (${h.market}, ${h.accounts.map(a => a.acct).join('/')})`);

  if (DRY_RUN || targets.length === 0) { console.log('\n완료(적재 없음).'); return; }

  const pct = (v) => v == null ? '데이터 부족' : `${v}%`;
  let ok = 0, fail = 0;
  for (const h of targets) {
    console.log(`\n⏳ ${h.name} 기준선 조회 중...`);
    try {
      let f, ticker = '';
      if (h.market === 'KR') {
        const code = krCorpCode(h.name);
        if (!code) throw new Error(`corp_code 미해결: ${h.name}`);
        const sc = krStockCode(h.name);
        f = await fetchKrFundamentals(code, undefined, undefined, sc); ticker = code;
      } else {
        const tk = usTicker(h.name);
        if (!tk) throw new Error(`US 티커 미등록: ${h.name}`);
        f = fetchUsFundamentals(tk); ticker = tk;
      }
      const row = [
        h.name, ticker, h.market, todayKST(),
        pct(f.grossMargin), pct(f.opMargin), pct(f.roe), pct(f.debtRatio),
        f.eps ?? '데이터 부족',
        f.pbr != null ? String(f.pbr) : '데이터 부족',
        f.source,
      ];
      const existingRow = existingRowMap.get(h.name);
      if (existingRow) {
        // 기존 행 제자리 업데이트 (중복 방지)
        await setValues(token, `${BASELINE_SHEET}!A${existingRow}:K${existingRow}`, [row]);
      } else {
        await appendValues(token, `${BASELINE_SHEET}!A2`, [row]);
      }
      console.log(`   ✅ ${existingRow ? '갱신' : '신규'}: 매총이 ${pct(f.grossMargin)} · 영익률 ${pct(f.opMargin)} · ROE ${pct(f.roe)} · 부채 ${pct(f.debtRatio)} · PBR ${f.pbr ?? '데이터 부족'}`);
      ok++;
    } catch (e) {
      console.error(`   ❌ 실패: ${e.message}`);
      fail++;
    }
  }
  console.log(`\n🏁 완료 — 성공 ${ok} · 실패 ${fail}`);
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
