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
 *   - VIP한국형가치투자증권자투자신탁(주식)-C-Pe(연금저축 보유 사모펀드 — 마찬가지로
 *     거래소 종목코드 없음): vipasset.co.kr 내부 API(scripts/lib/vip-fund.mjs).
 *     v1은 이걸 Google Apps Script로 시트에 직접 썼는데 v2로 안 옮겨져 curPrice가
 *     마이그레이션 스냅샷에 멈춰있었다(2026-08-20 오너 지적으로 발견) — Node fetch로
 *     재현. 한국 펀드 기준가 관례(1,000좌당 표기)라 recomputeValuation의 unitScale로
 *     보정한다.
 *
 * 대상 판정(classifyHolding): krStockCode(name) → usTicker(name) → 그래도 안
 * 풀리면 account가 '금현물'이면 금현물, name이 VIP펀드 정식명이면 FUND로 간주.
 * realtime-quotes.mjs와 동일 순서·이유(assetClass 텍스트는 게이트로 안 씀 —
 * "TIGER 미국S&P500"처럼 실제 시장과 다를 수 있는 전례가 있어 코드 해결 성공
 * 여부만 신뢰).
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
import { fetchUsdKrwRate } from '../lib/fundamentals.mjs';
import { fetchVipFundPrice } from '../lib/vip-fund.mjs';
import { collectWarning, flushWarnings } from '../lib/job-alerts.mjs';

// vipasset.co.kr opt2=C-Pe(클래스 코드)에 대응하는 Vault holding 정식명 — 이 이름과
// 정확히 일치할 때만 FUND로 분류한다(오탐 방지, 다른 펀드가 추가돼도 자동으로 같은
// 경로를 타지 않게).
const VIP_FUND_NAME = 'VIP한국형가치투자증권자투자신탁(주식)-C-Pe';

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
  // ticker가 이미 채워져 있고 KR 6자리 코드 형태면 이름 조회를 건너뛴다(2026-08-22) —
  // 자동 파이프라인 밖에서 수동 등록한 보유(예: "삼성전자(자사주)" — 자사주 계좌는
  // Kakao·KIS 파이프라인에 안 잡혀 수동 기록, 종목명을 원본과 다르게 붙여 별도
  // 관리하다 보니 DART/KIS 종목마스터의 정식 명칭과 이름이 안 맞아 resolveKr(name)이
  // 항상 null로 떨어짐). 이런 경우까지 이름매칭에만 의존하면 시세가 영원히 안 갱신된다.
  if (/^\d{6}$/.test(holding.ticker ?? '')) return { kind: 'KR', code: holding.ticker };
  const krCode = resolveKr(holding.name);
  if (krCode) return { kind: 'KR', code: krCode };
  const ticker = resolveUs(holding.name);
  if (ticker) {
    const excd = resolveUsExcd(ticker);
    if (!excd) return { kind: 'unmapped', reason: '거래소코드(EXCD) 미등록(usExchange 등록 필요)' };
    return { kind: 'US', code: ticker, excd };
  }
  if (holding.account === '금현물') return { kind: 'GOLD' };
  if (holding.name === VIP_FUND_NAME) return { kind: 'FUND' };
  return { kind: 'unmapped', reason: '종목코드/티커 매핑 없음' };
}

// curPrice → evalAmount·profitAmount·profitPct 재계산(기존 Vault 보유 필드와 동일
// 공식 — avgPrice·qty·invest는 그대로 두고 시세 파생값만 갱신). invest가 0/결측이면
// profitPct는 추정하지 않고 null. 순수함수 — 테스트 가능.
//
// ⚠️ 버그 수정(2026-08-19, 실사고 — 오너가 배포된 대시보드 확인 중 발견) — 해외주식은
// curPrice가 원화가 아니라 원어(USD) 그대로 저장되는 기존 관례인데(예: 마이크로소프트
// curPrice:493, 8/18 스냅샷 확인 — avgPrice도 395.8로 동일 관례), invest는 항상 원화로
// 저장돼 있다. usdKrwRate 없이 curPrice×qty를 그대로 KRW 평가금으로 취급했더니 해외
// 개별주식 4종목(마이크로소프트·알파벳·테슬라·엔비디아)의 profitPct가 전부 -99.9%대로
// 잘못 기록됐다 — 이 잡을 만들면서 curPrice의 통화가 종목마다 다르다는 걸 놓쳤던 게
// 근본원인. usdKrwRate 기본값 1(국내종목·금현물은 이미 원화라 그대로 통과).
//
// unitScale: 한국 펀드 기준가(NAV)는 1,000좌당 표기 관례(예: VIP펀드 curPrice
// 1950 = 1,000좌당 1,950원, 실제 좌당 1.95원)라 qty(보유 좌수)를 그대로 곱하면
// 1,000배로 부풀려진다. Vault의 avgPrice·기존 evalAmount도 이미 이 관례로
// 저장돼 있으므로(v1 시트 수식 =D*F/1000과 동일) 기본값 1(주식·ETF·금현물은
// 좌당 표기라 보정 불필요), 펀드만 0.001로 넘긴다.
export function recomputeValuation(holding, curPrice, { usdKrwRate = 1, unitScale = 1 } = {}) {
  const qty = Number(holding.qty) || 0;
  const invest = Number(holding.invest) || 0;
  const evalAmount = curPrice * qty * usdKrwRate * unitScale;
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

  // 해외주식 evalAmount를 invest(KRW 저장)와 같은 통화로 맞추는 데 필요한 환율 — US
  // 보유가 실제로 있고 이번 실행에서 조회를 시도할 때만 가져온다(불필요한 네트워크
  // 호출 방지). 실패하면 이번 실행의 해외주식은 전부 건너뛴다(잘못된 통화로 계산하는
  // 것보다 이전 값 유지가 안전 — 추정 안 함).
  let usdKrwRate = null;
  const hasUsTarget = usOpen && hasKis && files.some((f) => classifyHolding(f.parsed).kind === 'US');
  if (hasUsTarget) {
    try {
      usdKrwRate = fetchUsdKrwRate();
      console.log(`   💱 USD/KRW ${usdKrwRate.toFixed(2)}`);
    } catch (e) {
      collectWarning(`USD/KRW 환율 조회 실패 — 해외주식 평가금 갱신 이번엔 스킵: ${e.message}`);
    }
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
    if (cls.kind === 'US' && usdKrwRate == null) { skipped++; continue; }

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
      } else if (cls.kind === 'FUND') {
        curPrice = (await fetchVipFundPrice()).price;
      }
    } catch (e) {
      if (e.code === KIS_RATE_LIMIT_CODE) {
        console.log(`   ⏳ ${h.name}: 레이트리밋(EGW00201) — 이전 값 유지, 다음 실행 재시도`);
      } else {
        collectWarning(`시세 조회 실패: ${h.name}(${cls.kind}) — ${e.message.slice(0, 150)}`);
      }
      failed++;
      if (cls.kind === 'KR' || cls.kind === 'US') await sleep(STAGGER_MS);
      continue;
    }

    const opts = cls.kind === 'US' ? { usdKrwRate } : cls.kind === 'FUND' ? { unitScale: 0.001 } : {};
    const valuation = recomputeValuation(h, curPrice, opts);
    console.log(`   · ${h.name}(${cls.kind}): ${h.curPrice ?? '없음'} → ${curPrice} (평가액 ${Math.round(valuation.evalAmount).toLocaleString()}원)`);
    if (!DRY_RUN) writeAtomic(f.filepath, updateFrontmatter(f.content, { ...valuation, updatedAt: new Date().toISOString() }));
    updated++;
    if (cls.kind === 'KR' || cls.kind === 'US') await sleep(STAGGER_MS);
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
