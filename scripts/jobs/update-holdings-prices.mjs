#!/usr/bin/env node
/**
 * Vault 보유종목 시세 갱신(v2 네이티브) — State/Holdings/*.md의 curPrice·evalAmount·
 * profitAmount·profitPct를 갱신한다.
 *
 * 왜: v1 realtime-quotes.mjs(com.banana.realtime-quotes)는 KIS로 시세를 조회하지만
 * v1 구글시트의 별도 "실시간시세" 탭에만 쓴다 — Vault(State/Holdings)의 curPrice는
 * 어떤 잡도 갱신하지 않아 v1→v2 마이그레이션 스냅샷(Phase 7, 2026-08-05) 값이 그대로
 * 굳어있었다(2026-08-19 오너가 금현물 시세 확인 중 직접 발견). Vault가 실제로
 * "정본"이 되려면 시세도 Vault에 들어가야 한다는 지적을 받아 신설.
 *
 * 시세 소스(대상별로 다름 — 하나로 통일 안 됨, 각자 대체 불가한 이유가 있음):
 *   - KR 주식·ETF: KIS getKrQuote(실시간)
 *   - 해외주식: KIS getUsQuote(실시간)
 *   - 금현물(NH증권 실물자산 — KIS·DART 어디에도 종목코드가 없어 KIS 조회 자체가
 *     불가능): KRX gen/gold_bydd_trd(일별 배치, 장마감 후 발행 — 실시간 아님).
 *     "TIGER KRX금현물"(ETF, 연금저축 보유)은 이거 아니라 위 KR 경로로 정상 처리됨
 *     — krStockCode가 먼저 풀리므로 계좌명이 아니라 실제 상품 종류로 자동 분기.
 *
 * 대상 판정(classifyHolding): krStockCode(name) → usTicker(name) → 그래도 안
 * 풀리고 account가 '금현물'이면 금현물로 간주. realtime-quotes.mjs와 동일 순서·
 * 이유(assetClass 텍스트는 게이트로 안 씀 — "TIGER 미국S&P500"처럼 실제 시장과
 * 다를 수 있는 전례가 있어 코드 해결 성공 여부만 신뢰).
 *
 * 실패 처리: 종목별 개별 실패는 collectWarning 후 파일을 안 건드리고 건너뛴다(직전
 * curPrice 유지 — v1 carry-forward와 같은 원칙, 전체 잡은 안 죽음). ⚠️ KRX/KIS 조회가
 * 실패해도 다른 소스로 조용히 대체하지 않는다(feedback-no-silent-fallback, 2026-08-19
 * 오너 지시) — 실패는 로그·텔레그램으로 드러나야 원인을 고칠 수 있다.
 *
 * 사용: node scripts/jobs/update-holdings-prices.mjs [--dry-run]
 * (구글시트를 전혀 안 써서 다른 v2 잡들과 달리 token 인자가 없다.)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../lib/auth.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { parseFrontmatter, updateFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { krStockCode, usTicker, usExchange } from '../lib/instruments.mjs';
import {
  hasKisCredentials, loadKisCredentials, getKisToken, getKrQuote, getUsQuote,
  isKrMarketOpen, isUsMarketOpen, KIS_RATE_LIMIT_CODE,
} from '../lib/kis.mjs';
import { fetchGoldClose } from '../lib/krx.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';

loadEnv(); // KRX_API_KEY(금현물 조회용) — DART_API_KEY와 동일 관례

const DRY_RUN = process.argv.includes('--dry-run');
// KIS 레이트리밋(EGW00201) 실측 기반 — realtime-quotes.mjs와 동일 수치(2026-07 재실측
// 확정값 그대로 재사용, 별도 튜닝 근거 없음).
const STAGGER_MS = 800;
const QUOTE_RETRIES = 3;
const QUOTE_RETRY_DELAY_MS = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readHoldingFiles() {
  const dir = VAULT_PATHS.state.holdings;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const filepath = join(dir, f);
    const content = readFileSync(filepath, 'utf8');
    return { filepath, content, parsed: parseFrontmatter(content) };
  });
}

// 보유 하나를 어느 시세 소스로 조회할지 판정. resolveKr/resolveUs/resolveUsExcd
// 주입 가능(테스트에서 네트워크·캐시 파일 없이 순수 검증). 순수함수 — 테스트 가능.
export function classifyHolding(holding, { resolveKr = krStockCode, resolveUs = usTicker, resolveUsExcd = usExchange } = {}) {
  const krCode = resolveKr(holding.name);
  if (krCode) return { kind: 'KR', code: krCode };
  const ticker = resolveUs(holding.name);
  if (ticker) {
    const excd = resolveUsExcd(ticker);
    if (!excd) return { kind: 'unmapped', reason: '거래소코드(EXCD) 미등록(usExchange 등록 필요)' };
    return { kind: 'US', code: ticker, excd };
  }
  if (holding.account === '금현물') return { kind: 'GOLD' };
  return { kind: 'unmapped', reason: '종목코드/티커 매핑 없음' };
}

// curPrice → evalAmount·profitAmount·profitPct 재계산(기존 Vault 보유 필드와 동일
// 공식 — avgPrice·qty·invest는 그대로 두고 시세 파생값만 갱신). invest가 0/결측이면
// profitPct는 추정하지 않고 null. 순수함수 — 테스트 가능.
export function recomputeValuation(holding, curPrice) {
  const qty = Number(holding.qty) || 0;
  const invest = Number(holding.invest) || 0;
  const evalAmount = curPrice * qty;
  const profitAmount = evalAmount - invest;
  const profitPct = invest ? (profitAmount / invest) * 100 : null;
  return { curPrice, evalAmount, profitAmount, profitPct };
}

async function main() {
  const files = readHoldingFiles().filter(({ parsed }) => !parsed.isCashLike);
  if (!files.length) { console.log('갱신 대상 보유종목 0건'); return; }

  const krOpen = isKrMarketOpen();
  const usOpen = isUsMarketOpen();
  const hasKis = hasKisCredentials();
  if (!hasKis) console.log('ℹ️ KIS 크리덴셜 미설정 — KR/US 시세는 스킵, 금현물만 시도');

  let kisToken = null, appkey = null, appsecret = null;
  if (hasKis && (krOpen || usOpen)) {
    ({ appkey, appsecret } = loadKisCredentials());
    kisToken = await getKisToken({ appkey, appsecret });
  }

  let updated = 0, skipped = 0, failed = 0, unmapped = 0;
  for (const f of files) {
    const h = f.parsed;
    const cls = classifyHolding(h);

    if (cls.kind === 'unmapped') {
      collectWarning(`시세 갱신 제외: ${h.name} — ${cls.reason}`);
      unmapped++;
      continue;
    }
    if (cls.kind === 'KR' && (!krOpen || !hasKis)) { skipped++; continue; }
    if (cls.kind === 'US' && (!usOpen || !hasKis)) { skipped++; continue; }

    let curPrice = null;
    try {
      if (cls.kind === 'KR') {
        const q = await getKrQuote({ token: kisToken, appkey, appsecret, code: cls.code, retries: QUOTE_RETRIES, retryDelayMs: QUOTE_RETRY_DELAY_MS });
        curPrice = q.price;
      } else if (cls.kind === 'US') {
        const q = await getUsQuote({ token: kisToken, appkey, appsecret, excd: cls.excd, symb: cls.code, retries: QUOTE_RETRIES, retryDelayMs: QUOTE_RETRY_DELAY_MS });
        curPrice = q.price;
      } else if (cls.kind === 'GOLD') {
        curPrice = (await fetchGoldClose()).price;
      }
    } catch (e) {
      if (e.code === KIS_RATE_LIMIT_CODE) {
        console.log(`   ⏳ ${h.name}: 레이트리밋(EGW00201) — 이전 값 유지, 다음 실행 재시도`);
      } else {
        collectWarning(`시세 조회 실패: ${h.name}(${cls.kind}) — ${e.message.slice(0, 150)}`);
      }
      failed++;
      if (cls.kind !== 'GOLD') await sleep(STAGGER_MS);
      continue;
    }

    const valuation = recomputeValuation(h, curPrice);
    console.log(`   · ${h.name}(${cls.kind}): ${h.curPrice ?? '없음'} → ${curPrice} (평가액 ${Math.round(valuation.evalAmount).toLocaleString()}원)`);
    if (!DRY_RUN) writeAtomic(f.filepath, updateFrontmatter(f.content, { ...valuation, updatedAt: new Date().toISOString() }));
    updated++;
    if (cls.kind !== 'GOLD') await sleep(STAGGER_MS);
  }

  console.log(
    `\n✅ 시세 갱신 ${updated}건 · 장외/크리덴셜없음 스킵 ${skipped}건 · 조회실패 ${failed}건 · 매핑없음 ${unmapped}건`
    + (DRY_RUN ? ' (드라이런 — 쓰기 없음)' : ''),
  );
  await flushWarnings('update-holdings-prices');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (e) => {
    console.error('\n❌ 오류:', e.message);
    await flushWarnings('update-holdings-prices').catch(() => {});
    process.exit(1);
  });
}
