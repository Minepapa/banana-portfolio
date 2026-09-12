// 미국 직접 상장 ETF(VOO·QQQM 등) 데이터 조회 — 2026-09-07 신설. "자산분배 트랙 핵심
// 로직 설계" §2 후속(오너 요청, 2026-09-07 — "해외주식(미국 직접 투자)" 후보로
// VOO·QQQM 추가). krx.mjs의 fetchEtfSeries는 KRX 상장 종목만 조회 가능하고, 미국
// 직접 상장 ETF는 KRX 데이터 자체가 없어(ISU_NM 매칭 불가) 완전히 별도 데이터 소스가
// 필요하다 — yf-macro.py와 동일한 yfinance spawnSync 패턴을 그대로 따른다.
//
// instrument-scoring.mjs의 4+2축 스코어링 함수(computeInstrumentScore 등)는 그대로
// 재사용한다 — 이 모듈은 순수 데이터 조회만 담당(krx.mjs와 대칭 역할). 순환 참조를
// 피하기 위해 이 파일은 instrument-scoring.mjs를 import하지 않는다(반대 방향으로만
// 의존 — instrument-scoring.mjs의 rankAssetClassUniverse가 이 파일의
// fetchUsEtfSeries·US_ETF_BENCHMARK_TICKER를 가져다 씀).
//
// ⚠️ NAV 축은 항상 데이터 부족(null) — yfinance 기본 API엔 ETF NAV 시계열이 신뢰성
// 있게 없다(mutual-fund navPrice 필드가 있어도 스냅샷일 뿐이고 티커마다 신뢰도가
// 다름). computeInstrumentScore의 기존 dataGaps 메커니즘이 그대로 처리 — 추정 안 함.
// ⚠️ 유동성(거래대금)은 KRW 환산 — 기존 THRESHOLDS.liquidityWon이 원화 기준이라
// 원본 USD 거래대금(종가×거래량)에 최신 USD/KRW 환율을 곱해 같은 스케일로 맞춘다
// (일별 정확한 환율이 아니라 조회 시점 최신 환율 하나로 전체 구간에 적용 — 유동성
// 축은 정밀한 금액이 아니라 "이 정도 규모인가"만 보면 되므로 이 근사로 충분하다).
// ⚠️ 이 KRW=X도 ECOS 대체는 검토 후 기각(2026-09-12, ~/banana-vault/Knowledge/
// API/ECOS.md 참고 — ECOS 원/달러 매매기준율은 전영업일 지연이 있어 프로젝트
// 전체에서 USDKRW의 ECOS 대체 자체를 접었다). 설령 지연 문제가 없었어도 여기는
// ①이미 종목·벤치마크와 한 번의 배치 호출(runYfEtf)로 같이 받아오는 구조라 분리하면
// 네트워크 왕복만 늘고 ②"이 정도 규모인가"만 보는 근사치 용도라 추가 비용을
// 정당화하지 못했을 것.
import { spawnSync } from 'node:child_process';

// 티커가 추종하는 벤치마크 지수(yfinance 티커) — excessReturn·trackingError 계산용.
// 이 객체의 키 자체가 "yfinance로 조회 가능한 것으로 확인된 미국 티커 집합"이기도
// 하다(instrument-scoring.mjs rankAssetClassUniverse가 이 키 목록으로 라우팅 판단).
// 오너가 새 미국 ETF를 유니버스에 추가하면 여기도 같이 추가해야 한다 — 벤치마크를
// 모르면 값을 null로 등록(라우팅은 되지만 excessReturn·trackingError만 데이터 부족).
export const US_ETF_BENCHMARK_TICKER = {
  VOO: '^GSPC', // Vanguard S&P 500 ETF
  QQQM: '^NDX', // Invesco NASDAQ-100 ETF (Mini)
};

function runYfEtf(tickers) {
  const py = new URL('./yf-etf.py', import.meta.url).pathname;
  const r = spawnSync('python3', [py, ...tickers], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`yfinance 미국ETF 조회 실패: ${(r.stderr || '').slice(-200)}`);
  return JSON.parse(r.stdout);
}

// ticker(예: 'VOO') 하나의 시계열을 krx.mjs fetchEtfSeries와 같은 모양
// ({basDd,close,nav,accTrdVal,idxClose,idxName})으로 변환 — nav는 항상 null(위
// 주석 참고), basDd도 미국 거래일 캘린더라 KRX의 "YYYYMMDD" 개념과 안 맞아 안 씀.
export async function fetchUsEtfSeries(ticker, { fetchImpl = runYfEtf } = {}) {
  const benchmarkTicker = Object.hasOwn(US_ETF_BENCHMARK_TICKER, ticker) ? US_ETF_BENCHMARK_TICKER[ticker] : null;
  const tickers = [ticker, 'KRW=X', ...(benchmarkTicker ? [benchmarkTicker] : [])];
  const raw = fetchImpl(tickers);

  const own = raw[ticker] ?? { close: [], volume: [] };
  const closes = own.close ?? [];
  const volumes = own.volume ?? [];
  const fxCloses = raw['KRW=X']?.close ?? [];
  const fxRate = fxCloses.length ? fxCloses[fxCloses.length - 1] : null;
  const idxCloses = benchmarkTicker ? (raw[benchmarkTicker]?.close ?? []) : [];
  // 종목·지수 배열 길이가 다르면(휴장일 캘린더 불일치 등) 인덱스로 억지로 짝짓지
  // 않는다(macro-overlay.mjs computeRateSpreadSignal과 동일 방어 원칙) — 그냥 지수
  // 다리를 버려서 excessReturn·trackingError만 데이터 부족 처리되게 한다.
  const idxAligned = idxCloses.length === closes.length ? idxCloses : null;

  const series = [];
  for (let i = 0; i < closes.length; i++) {
    const close = closes[i];
    if (!Number.isFinite(close) || close <= 0) continue;
    const volume = volumes[i];
    const accTrdVal = Number.isFinite(volume) && Number.isFinite(fxRate) ? close * volume * fxRate : null;
    series.push({
      basDd: null,
      close,
      nav: null,
      accTrdVal,
      idxClose: idxAligned ? idxAligned[i] : null,
      idxName: benchmarkTicker,
    });
  }
  return series;
}
