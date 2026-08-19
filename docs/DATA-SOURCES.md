# 데이터 소스 카탈로그

정확도 우선순위: **KRX API(거래소 원천) > OpenDart API(금감원 원천) > KIS API(증권사 원천) > 기타(Naver 스크래핑·yfinance·FDR)**.
이 문서는 "지금 뭘 어디서 가져오는지"와 "어디서 더 정확하게 가져올 수 있는지" 판단용 참고자료다 — 실제 소스 교체(마이그레이션)는 별도 구현 단계에서 진행.

작성일: 2026-08-19. 검증 방법: KRX는 실키로 curl 직접 호출(200 확인), OpenDart·KIS·기타는 기존 코드(`scripts/lib/*.mjs`, `*.py`) 정독.

---

## 1. KRX Data Marketplace API — 승인된 9개 서비스

`.env`의 `KRX_API_KEY` 사용. 공통 호출 패턴:

```
GET https://data-dbg.krx.co.kr/svc/apis/{카테고리}/{API_ID}?basDd=YYYYMMDD
Header: AUTH_KEY: <키>
```

(`-dbg` 접미사가 붙어있지만 실제 운영 호스트임 — "샘플/디버그"라는 뜻이 아니라 호스트 이름일 뿐. 개발명세서 PDF에 명시된 정식 엔드포인트.)

| # | API명 | 엔드포인트 | 반환 단위 | 주요 필드 |
|---|---|---|---|---|
| 1 | KOSPI 시리즈 일별시세정보 | `idx/kospi_dd_trd` | 코스피 계열 지수 전체(코스피/코스피200/각 업종지수 등, basDd 1건 조회시 다건 반환) | `IDX_NM`(지수명), `CLSPRC_IDX`(종가), `FLUC_RT`(등락률), `OPNPRC_IDX/HGPRC_IDX/LWPRC_IDX`(시고저), `ACC_TRDVOL/ACC_TRDVAL`(거래량/대금), `MKTCAP`(시가총액) |
| 2 | KOSDAQ 시리즈 일별시세정보 | `idx/kosdaq_dd_trd` | 코스닥 계열 지수 전체 | 위와 동일 필드 |
| 3 | KRX 시리즈 일별시세정보 | `idx/krx_dd_trd`(추정 — idx 카테고리 동일 패턴, 미검증) | KRX 계열 지수 | 위와 동일 필드 추정 |
| 4 | 유가증권 일별매매정보 | `sto/stk_bydd_trd` | KOSPI 전종목 개별 시세 | `ISU_CD/ISU_NM`, `MKT_NM`, `TDD_CLSPRC`(종가), `FLUC_RT`, `TDD_OPNPRC/HGPRC/LWPRC`, `ACC_TRDVOL`, **`ACC_TRDVAL`(실거래대금 — 근사치 아님)**, `MKTCAP`, `LIST_SHRS`(상장주식수) |
| 5 | 코스닥 일별매매정보 | `sto/ksq_bydd_trd` | KOSDAQ 전종목 개별 시세 | 위와 동일 필드 |
| 6 | 유가증권 종목기본정보 | `sto/stk_isu_base_info` | KOSPI 전종목 기본정보 | `ISU_CD`(ISIN), `ISU_SRT_CD`(단축코드), `ISU_NM/ISU_ABBRV/ISU_ENG_NM`, `LIST_DD`(상장일), `MKT_TP_NM`, `SECUGRP_NM`(증권그룹), `SECT_TP_NM`(소속부 — 벤처기업부 등), `PARVAL`(액면가), `LIST_SHRS`. **업종분류(GICS/WICS류) 필드 없음** |
| 7 | 코스닥 종목기본정보 | `sto/ksq_isu_base_info` | KOSDAQ 전종목 기본정보 | 위와 동일 필드, 업종분류 없음 동일 |
| 8 | ETF 일별매매정보 | `etp/etf_bydd_trd` | 전체 ETF 시세 | `ISU_CD/ISU_NM`, `TDD_CLSPRC`, `NAV`(순자산가치), `MKTCAP`, `INVSTASST_NETASST_TOTAMT`(순자산총액), `LIST_SHRS`, **`IDX_IND_NM`(추적지수명)**, `OBJ_STKPRC_IDX`(추적지수 종가) |
| 9 | 금시장 일별매매정보 | `gen/gold_bydd_trd` | KRX 금시장 시세 | `ISU_NM`(예: "금 99.99_1kg"), `TDD_CLSPRC`, `ACC_TRDVOL/ACC_TRDVAL` |

### 확정된 한계
- **업종분류(섹터) API 없음** — 전체 카탈로그(지수/주식/증권상품/채권/파생상품/일반상품/ESG) 어디에도 종목별 업종코드(GICS/WICS류)를 주는 서비스가 없음. `종목기본정보`엔 시장구분(KOSPI/KOSDAQ)·소속부(벤처기업부 등)만 있고 진짜 업종분류는 없음.
- **지수 구성종목(멤버십) API 없음** — "KOSPI200에 어떤 종목이 속하는가" 같은 조회가 카탈로그에 없음. 지수 카테고리는 지수 자체의 시세(레벨값)만 제공.
- **실시간·계좌·주문 기능 없음** — 전부 일별 배치(`basDd` 파라미터) 데이터. 실시간 시세·잔고조회·주문 실행은 KIS API 영역.
- **국내 시장 전용** — 미국 주식·환율·금리 등 해외 데이터 없음.

---

## 2. OpenDart API (금융감독원 전자공시)

`.env`의 `DART_API_KEY` 사용. `scripts/lib/fundamentals.mjs`가 전담.

| 엔드포인트 | 용도 | 비고 |
|---|---|---|
| `fnlttSinglAcnt.json` (주요계정) | 매출액, 영업이익, 당기순이익, 자산총계, 부채총계, 자본총계 | **현금흐름표는 안 줌**(실측 확인 — CF 항목 0건, 2026-08-07 발견). CFS(연결) 우선, 없으면 OFS(별도) |
| `fnlttSinglAcntAll.json` (전체 재무제표) | 영업활동현금흐름(OCF), 당기순이익 — CFS/OFS 둘 다 조회 | OCF·순이익의 정확한 소스. IFRS 표준계정코드 우선 매칭, 이름매칭 폴백 |
| `fnlttSinglIndx.json` (재무비율, M210000/M220000/M310000) | 매출총이익률, 영업이익률, ROE, 부채비율, 현금배당성향 | 지표 미제공 종목은 Node가 금액으로 직접 계산(영업이익률·부채비율) |
| `list.json` (공시서류검색) | 원본 공시일 확인 | 정정공시(기재정정)로 rcept_no 기반 공시일이 밀리는 문제 보정용(2026-08-09 버그 수정) |
| `corpCode.xml` | 회사명 ↔ corp_code 매핑 | **상장기업만 등재, ETF 미포함** — ETF는 KIS 비인증 마스터파일로 폴백 |

**PBR 관련 특이사항**: OpenDart는 PBR을 직접 안 주고, 자본총계(equity)만 제공. 시가총액은 yfinance에서 받아와 `시가총액 ÷ 자기자본`으로 직접 계산 중(`computePbr`) — **KRX `sto/stk_bydd_trd`의 `MKTCAP` 필드로 대체 가능한 지점**.

---

## 3. KIS(한국투자증권) Open API

`~/.config/banana-portfolio/kis-key.json`의 appkey/appsecret 사용(계좌별 별도 앱 등록). `scripts/lib/kis.mjs`가 전담. **이 프로젝트에서 실주문·잔고조회의 유일한 창구 — 대체 불가 영역.**

| tr_id | 엔드포인트 | 용도 |
|---|---|---|
| — | `oauth2/tokenP` | 토큰 발급(1일 유효, 파일 캐시) |
| `FHKST01010100` | `inquire-price` | 국내주식 현재가 + 등락률(실시간) |
| `HHDFS00000300` | `overseas-price/quotations/price` | 해외주식 현재체결가 + 등락률 |
| `FHKST01010900` | `inquire-investor` | 국내주식 투자자별 매매동향(외국인/기관 순매수, 최근 거래일) |
| `FHKST663300C0` | `invest-opinion` | 국내주식 증권사별 투자의견 + 목표주가(최근 90일, 하향/상향 판정용) |
| `TTTC8434R` | `inquire-balance` | **계좌 잔고**(보유종목 + 예수금) — IRP 포함, 연금 전용 API 별도 없음 |
| `TTTC0081R` | `inquire-daily-ccld` | 당일 주문체결 조회 |
| `TTTC0012U`/`TTTC0011U` | `order-cash` | **국내주식 매수/매도 주문**(지정가만, 실계좌 전용) |

**비인증 부가 기능**(`scripts/lib/instruments.mjs`, 인증 불필요):
- KOSPI/KOSDAQ 종목마스터 ZIP 다운로드(`new.real.download.dws.co.kr`) — 종목명↔코드 매핑, **ETF 포함**(DART corpCode.xml이 놓치는 부분의 폴백)
- 나스닥/뉴욕/아멕스 해외종목마스터 ZIP — 한글명↔티커↔거래소코드 매핑(US_MAP 수동등록 폴백)

**KIS로만 되는 것(대체 불가)**: 실시간 시세, 계좌 잔고, 주문 실행, 외국인/기관 매매동향, 증권사 투자의견 컨센서스 — KRX Data Marketplace 카탈로그엔 이 중 아무것도 없음.

---

## 4. 기타 외부 사이트 (Naver / yfinance / FinanceDataReader)

| 소스 | 파일 | 데이터 | 정확도 이슈 / 선택 이유 |
|---|---|---|---|
| **Naver Finance** (`api.finance.naver.com/siseJson.naver`) | `fetchNaverIndexCloses` (fundamentals.mjs) | KOSPI/KOSDAQ 지수 종가 | 무인증, **당일 장마감 즉시 반영**(yfinance `^KS11`이 일봉 확정에 지연 있어 이걸 씀). → KRX `idx/kospi_dd_trd`도 당일 반영 확인됨(20260818 데이터 정상 조회) — **대체 유력 후보** |
| **yfinance** — `yf-marketdata.py` | KR·US 종목 시세: `forwardPE`, `priceToBook`, `marketCap`, `currentPrice`, 52주 고저, `freeCashflow`, `payoutRatio`, OHLCV 90개(RSI·MACD·ATR·스토캐스틱·거래량서지는 Node가 이 closes로 계산) | KR분(.KS/.KQ)의 OHLCV·시가총액은 **KRX `sto/stk_bydd_trd`로 대체 가능**(실거래대금·실시총 필드 보유). US분은 대체 불가(KRX는 국내 전용) |
| yfinance — `yf-fundamentals.py` | US 종목 분기 펀더멘털(매출/영업이익 YoY, FCF, 마진율, ROE, 부채비율, PBR) | US 전용 — OpenDart·KRX 둘 다 커버 못 함, 대체 불가 |
| yfinance — `yf-macro.py` | 거시지표 종가 1년치: `USDKRW`, 미국채10년(`TNX`), `VIX`, `KOSPI`(`^KS11`), `S&P500`, `KOSDAQ`, `NASDAQ`, `GOLD`, `WTI` | KOSPI/KOSDAQ만 KRX로 대체 가능(위 Naver 항목과 동일 논리). 환율·금리·VIX·미국지수·금·유가는 KRX 카탈로그에 없음(금 현물시장만 있음 — `gen/gold_bydd_trd`는 국내 금시장 현물가, `GC=F` 선물가와 다른 상품이라 단순 대체 아님) |
| **FinanceDataReader** — `fdr-universe.py` | KOSPI/KOSDAQ **시가총액 상위 200/150 종목 리스트**(공식 코스피200/코스닥150 지수 구성종목이 아닌 근사치, 오너 확정 2026-08-07) + 20거래일 평균 거래대금(`Close×Volume` 근사) | **대체 불가 확정**(§1 캐비어트 참고 — KRX에 지수 구성종목 API가 없음). 거래대금 근사치는 KRX `ACC_TRDVAL`로 개선 가능하나, "코스피200/코스닥150 소속 여부" 판정 자체는 여전히 시가총액 근사에 의존해야 함 |

---

## 5. 요약 — 정확도 개선 여지가 있는 지점 (참고용, 미실행)

| 현재 근사/우회 | 실제 값을 주는 곳 | 비고 |
|---|---|---|
| FDR `Close×Volume`으로 거래대금 근사 | KRX `sto/stk_bydd_trd.ACC_TRDVAL`(실거래대금) | |
| yfinance `.KS/.KQ` marketCap → PBR 계산 | KRX `sto/stk_bydd_trd.MKTCAP`(실시가총액) | OpenDart 자기자본과 조합해 PBR 계산 시 |
| yfinance KR OHLCV(52주고저·RSI 계산용) | KRX `sto/stk_bydd_trd`·`sto/ksq_bydd_trd` (일별 시가/고가/저가/종가) | 과거분 누적 필요 시 여러 `basDd` 반복 조회 |
| Naver KOSPI/KOSDAQ 지수 종가(비지연 목적) | KRX `idx/kospi_dd_trd`·`idx/kosdaq_dd_trd` | 당일 반영 확인됨 |
| FDR 시가총액 상위 200/150 근사(코스피200/코스닥150 대신) | **없음 — KRX에 지수 구성종목 API 부재, 대체 불가** | |
| yfinance 미국 시세·거시지표(환율/금리/VIX 등) | **없음 — KRX는 국내 전용, 대체 불가** | |
