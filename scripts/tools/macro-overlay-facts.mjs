#!/usr/bin/env node
// macro-overlay-facts.mjs — 거시 전술 오버레이 대화형 보고용 Node 결정론 사실 조립기.
//
// ledger-facts.mjs·rebalance-facts.mjs와 같은 패턴(Node는 사실만 조립, 판단은 LLM)이되
// **한 가지 예외**: 이 도구는 Faber 크로스 판정을 위해 State/MacroOverlay에 "이번 확인
// 결과"를 매번 기록한다(다른 *-facts.mjs는 순수 읽기전용) — 크로스(상태변화) 자체가
// "지난 확인과 다른가"로 정의되는 신호라 기록 없이는 이 계산이 원천적으로 불가능하다
// (2026-08-05, 이 파일에서만 예외적으로 쓰기).
//
// yfinance 데이터는 기존 fundamentals.mjs가 쓰는 yf-macro.py를 그대로 재사용(같은
// spawnSync 패턴) — 단 MACRO_TICKERS(다른 잡들이 이미 의존)는 건드리지 않고, 이 파일
// 전용 티커 목록으로 별도 호출한다(회귀 위험 차단).
//
// 사용법:
//   node scripts/tools/macro-overlay-facts.mjs            # 사람이 읽는 보고 + 상태 갱신
//   node scripts/tools/macro-overlay-facts.mjs --json      # 구조화 데이터
//   node scripts/tools/macro-overlay-facts.mjs --dry-run   # 계산만, 상태 파일 갱신 없음
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { computeMacroOverlaySignals } from '../lib/macro-overlay.mjs';

const JSON_OUT = process.argv.includes('--json');
const DRY_RUN = process.argv.includes('--dry-run');

// ⚠️ 한국 국고채 스프레드(ECOS)는 API 키 미신청 — 오너 확정(2026-08-05) "나머지 4개
// 신호부터". 미국 금리차(^TNX-^IRX)·DXY(DX-Y.NYB)·VIX·유가(CL=F)·Faber용 KOSPI/SP500만.
const TICKERS = { KOSPI: '^KS11', SP500: '^GSPC', TNX: '^TNX', IRX: '^IRX', DXY: 'DX-Y.NYB', VIX: '^VIX', WTI: 'CL=F' };

function fetchCloses() {
  const py = new URL('../lib/yf-macro.py', import.meta.url).pathname;
  const r = spawnSync('python3', [py, ...Object.values(TICKERS)], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`yfinance 거시 조회 실패: ${(r.stderr || '').slice(-200)}`);
  return JSON.parse(r.stdout);
}

const FABER_STATE_FILE = 'faber-state.md';

function readPreviousFaberState() {
  const filepath = join(VAULT_PATHS.state.macroOverlay, FABER_STATE_FILE);
  if (!existsSync(filepath)) return { domestic: null, foreign: null };
  const fm = parseFrontmatter(readFileSync(filepath, 'utf8'));
  return { domestic: fm.domesticAboveMA ?? null, foreign: fm.foreignAboveMA ?? null };
}

function writeFaberState(domesticAboveMA, foreignAboveMA) {
  const dir = VAULT_PATHS.state.macroOverlay;
  mkdirSync(dir, { recursive: true });
  const content = buildFrontmatter({
    type: 'macro-overlay-faber-state',
    domesticAboveMA, foreignAboveMA,
    checkedAt: new Date().toISOString(),
  });
  writeAtomic(join(dir, FABER_STATE_FILE), content);
}

function main() {
  const raw = fetchCloses();
  const previousFaberState = readPreviousFaberState();
  const signals = computeMacroOverlaySignals({
    kospiCloses: raw[TICKERS.KOSPI], sp500Closes: raw[TICKERS.SP500],
    tnxCloses: raw[TICKERS.TNX], irxCloses: raw[TICKERS.IRX],
    dxyCloses: raw[TICKERS.DXY], vixCloses: raw[TICKERS.VIX], wtiCloses: raw[TICKERS.WTI],
    previousFaberState,
  });

  // 코드리뷰 지적(2026-08-05) 2건 반영:
  // 1) --json은 "구조화 데이터 조회"일 뿐 확정 보고가 아닌데, 상태를 갱신해버리면 그
  //    조회 한 번이 크로스를 "소비"해서 다음 진짜 보고가 크로스를 놓친다 — 사람이 읽는
  //    보고(JSON_OUT이 아닌 경우)에서만 상태를 갱신한다.
  // 2) 이번 계산이 데이터 부족으로 null이 나온 자산군은 직전 상태를 null로 덮어쓰지
  //    않는다 — 그 사이(예: KOSPI 일시 데이터 결손) 실제 크로스가 있었다면 null로
  //    덮으면 다음 진짜 크로스 때 "직전이 null이라 첫 확인" 취급돼 신호가 영구히
  //    사라진다. 계산 실패 시엔 마지막으로 알려진 값을 그대로 들고 간다.
  if (!DRY_RUN && !JSON_OUT) {
    writeFaberState(
      signals.faberDomestic?.aboveMA ?? previousFaberState.domestic,
      signals.faberForeign?.aboveMA ?? previousFaberState.foreign,
    );
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(signals, null, 2));
    return;
  }

  console.log('[거시 전술 오버레이 점검] (ECOS 한국채권스프레드 미연동 — 4개 신호만)\n');
  const faberLine = (label, sig, crossed) => sig
    ? `  ${label}: ${sig.aboveMA ? '10개월선 위' : '10개월선 아래'}(${sig.deviationPct.toFixed(2)}%)${crossed ? ' ⚠️ 크로스 발생' : ''}`
    : `  ${label}: 데이터 부족(판정 보류)`;
  console.log(faberLine('Faber 국내주식(KOSPI)', signals.faberDomestic, signals.faberDomesticCrossed));
  console.log(faberLine('Faber 해외주식(S&P500)', signals.faberForeign, signals.faberForeignCrossed));

  if (signals.rateSpread) {
    console.log(`  미국금리차(10Y-3M): ${signals.rateSpread.currentSpread.toFixed(2)}%p${signals.rateSpread.inverted ? ' ⚠️ 역전' : ''}`);
  } else {
    console.log('  미국금리차: 데이터 없음');
  }
  for (const [label, sig] of [['DXY', signals.dxy], ['VIX', signals.vix], ['WTI 유가', signals.wti]]) {
    console.log(sig ? `  ${label}: ${sig.current.toFixed(2)}${sig.breached ? ` ⚠️ 이탈(z=${sig.bands?.zscore})` : ' 정상'}` : `  ${label}: 데이터 없음`);
  }

  console.log(signals.anyMeaningfulChange
    ? '\n⚠️ 의미있는 변화 감지 — Athena 종합판단 필요(진짜 국면전환인지 노이즈인지)'
    : '\n✅ 5개 신호 전부 조용함 — 협의체 소집 불필요');
}

if (import.meta.url === `file://${process.argv[1]}`) main();
