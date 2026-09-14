#!/usr/bin/env python3
"""과거 특정 시점의 코스피+코스닥 유니버스(시가총액 상위 200+150 근사) 재구성 —
생존편향 방지 목적(구현계획서 Phase 10, 백테스트 전용). fdr-universe.py(현재 시점
전용)와 별도 파일인 이유: 이쪽은 상장폐지종목까지 포함한 후보풀 구성 + 대량의 종목별
과거 시세 캐싱이 필요해 로직·실행 패턴이 근본적으로 다르다(현재판은 매달 1회, 이쪽은
백테스트 준비 시 한 번 대량 수집 후 재사용).

⚠️ 생존편향 자체는 해소되지만(KRX-DELISTING으로 상장폐지 종목도 포함), 공식
코스피200·코스닥150 지수 구성종목이 아니라 시가총액 상위 근사라는 기존 트레이드오프는
그대로 남는다(fdr-universe.py와 동일 한계 — 업종배분 등 KRX 추가 선정기준 미반영).

⚠️ 발행주식수 근사: 현재상장종목은 fdr.StockListing()의 Stocks 컬럼(실측 검증:
삼성전자 Marcap/Close == Stocks, 정확히 일치)을 쓰지만, 이는 "지금" 발행주식수이지
과거 특정 시점의 발행주식수가 아니다. 상장폐지종목은 KRX-DELISTING의 ListingShares
(상장 시점 또는 마지막 관측치로 추정)를 쓴다. 두 경우 다 실제로는 유상증자·자사주
매입·액면분할 등으로 시점마다 달라질 수 있는데 이 근사는 그 변화를 반영 못 한다 —
받아들이는 트레이드오프(전례: fdr-universe.py의 거래대금 근사와 같은 성격의 한계,
오너에게 결과 보고 시 이 한계를 명시할 것).

사용법:
  python3 historical-universe.py build-pool                    # 후보풀 JSON 출력
  python3 historical-universe.py cache-prices <시작일> [<종목코드,...>]  # 시세+거래량 캐시 채우기(최초 백필 전용, 이미 캐시된 종목은 스킵)
  python3 historical-universe.py update-prices [<종목코드,...>]  # 이미 캐시된 종목을 최신 거래일까지 증분 갱신(2026-09-14 신설, 일별 라이브 파이프라인용)
  python3 historical-universe.py prices-at <날짜배열JSON> [<종목코드,...>]
  python3 historical-universe.py liquidity-at <날짜배열JSON> [<종목코드,...>]
"""
import json
import os
import sys
import time
import FinanceDataReader as fdr
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(HERE, '..', '.cache', 'historical-prices')

# 전역장애 감지 — fdr-universe.py(Phase 9)가 이미 갖고 있던 가드(MIN_FILL_RATIO·
# MAX_NULL_RATIO)를 이 파일에도 적용한다(코드리뷰 지적, 2026-08-08 — 처음엔
# MIN_FILL_RATIO를 선언만 해두고 실제로 안 썼던 버그였음). 절대 하한값은 실측(2026-08-08:
# 코스피 1270·코스닥 2742·상장폐지누적 4172건) 대비 넉넉히 보수적으로 잡아, 정상적인
# 시장 변동(신규상장·상폐)은 여유롭게 통과시키되 SSL 깨짐·엔드포인트 개편처럼 결과가
# 텅 비거나 급감하는 경우는 "이번엔 회사가 적네"로 위장되지 않고 시끄럽게 실패한다.
MIN_KOSPI_LISTED = 500
MIN_KOSDAQ_LISTED = 800
MIN_DELISTING_ROWS = 1000
MAX_CACHE_FAIL_RATIO = 0.3  # 시세 캐싱 시도 중 오류+빈결과 비율 상한


def is_common_share(code, name):
    """fdr-universe.py의 동일 함수와 같은 판정 기준(보통주만) — 코드 마지막 자리 '0' +
    이름 끝 "우"/"우B" 이중확인."""
    code = str(code)
    return len(code) > 0 and code[-1] == '0' and not str(name).endswith(('우', '우B'))


def build_candidate_pool():
    """현재상장(코스피+코스닥) ∪ 상장폐지(KRX-DELISTING, 보통주만) — 각 항목:
    {code, name, market, sharesOutstanding, listingDate, delistingDate(살아있으면 None)}.
    ListingDate가 없는 현재상장종목은 listingDate=None으로 둔다(과거 시점 필터는
    가격 데이터 존재여부로 대신 처리 — fetch_price_at가 상장 전 날짜엔 자연히 데이터가
    없어 제외됨, 이 함수 차원에서 추가로 걸러낼 정보 자체가 없음).
    """
    pool = []
    min_listed = {'KOSPI': MIN_KOSPI_LISTED, 'KOSDAQ': MIN_KOSDAQ_LISTED}
    for market in ('KOSPI', 'KOSDAQ'):
        df = fdr.StockListing(market)
        if len(df) < min_listed[market]:
            raise RuntimeError(
                f'{market} 상장목록 확보 부족: {len(df)}건(최소 {min_listed[market]}건 기대) — '
                f'데이터 소스 장애 의심(개별 종목 결측이 아니라 목록 조회 자체가 깨진 상태일 수 있음)'
            )
        df = df[df['Marcap'].notna() & (df['Marcap'] > 0) & df['Stocks'].notna() & (df['Stocks'] > 0)]
        for _, r in df.iterrows():
            if not is_common_share(r['Code'], r['Name']):
                continue
            pool.append({
                'code': str(r['Code']), 'name': str(r['Name']), 'market': market,
                'sharesOutstanding': float(r['Stocks']), 'listingDate': None, 'delistingDate': None,
            })

    dl = fdr.StockListing('KRX-DELISTING')
    if len(dl) < MIN_DELISTING_ROWS:
        raise RuntimeError(
            f'상장폐지목록 확보 부족: {len(dl)}건(최소 {MIN_DELISTING_ROWS}건 기대, 1960년 이후 '
            f'누적이라 원래 대량이어야 함) — 데이터 소스 장애 의심'
        )
    # Kind 화이트리스트를 쓰지 않는다 — fdr-universe.py(현재 유니버스)가 is_common_share
    # 하나만으로 보통주를 판정하는 것과 일관되게 맞춘다(코드리뷰 지적, 2026-08-08: Kind
    # 값이 NaN이거나 예상 밖 라벨인 상장폐지 보통주가 화이트리스트에 걸려 조용히
    # 빠지면, 이 파일이 없애려는 바로 그 생존편향을 다른 경로로 재도입하는 셈이라
    # 위험 방향이 반대다 — "덜 걸러서 나중에 걸러지는 것"이 "더 걸러서 영영 빠지는
    # 것"보다 이 목적에서는 안전).
    dl = dl[dl['SecuGroup'] == '주권']
    dl = dl[dl['ListingShares'].notna() & (dl['ListingShares'] > 0)]
    for _, r in dl.iterrows():
        code = str(r['Symbol'])
        name = str(r['Name'])
        if not is_common_share(code, name):
            continue
        market = str(r['Market']) if pd.notna(r['Market']) else None
        if market not in ('KOSPI', 'KOSDAQ'):
            continue  # 코넥스 등 이 프로젝트 유니버스 밖 시장은 제외
        listing_date = r['ListingDate'].strftime('%Y-%m-%d') if pd.notna(r['ListingDate']) else None
        delisting_date = r['DelistingDate'].strftime('%Y-%m-%d') if pd.notna(r['DelistingDate']) else None
        pool.append({
            'code': code, 'name': name, 'market': market,
            'sharesOutstanding': float(r['ListingShares']), 'listingDate': listing_date, 'delistingDate': delisting_date,
        })
    return pool


def cache_path(code):
    return os.path.join(CACHE_DIR, f'{code}.csv')


def cache_prices(codes, start_date, end_date=None, delay=0.05, max_fail_ratio=MAX_CACHE_FAIL_RATIO):
    """codes 각각의 일별 시세를 로컬 CSV로 캐싱(이미 있으면 스킵 — 재실행해도 안전,
    중단 후 재개 가능). Close+Volume은 기존 OCF/P 백테스트(유동성 필터)가 쓰고,
    High+Low는 돌파매매 전략(2026-09-12 추가) — 52주 신고가·R배수 손절/트레일링
    시뮬레이션이 종가만으로는 장중 손절 터치를 놓칠 수 있어 필요해졌다. Open은
    같은 날 재수집(2026-09-13 추가) — 신호는 당일 종가로 확정되지만 실제 체결은
    다음날 시가에 이뤄진다는 걸 백테스트에 반영하려면 필요(오너 지적 — 당일 종가에
    바로 체결된다고 가정한 최초 버전은 실제로 불가능한 가격을 쓰고 있었음). 데이터소스
    (FinanceDataReader)는 원래도 OHLCV 전체를 주는데 저장 시 일부만 남기고 버렸던
    것 — 새 데이터소스 없이 재수집(re-fetch)만으로 해결된다. 반환:
    {code: 'cached'|'fetched'|'empty'|'error:...'} 요약.

    빈 결과(진짜 데이터 없음)는 이번 실행 전체가 "건강"할 때만 캐시에 확정한다 —
    전역장애(SSL 깨짐·레이트리밋 등)가 개별 종목 결측인 척 위장하면서 "빈 결과"를
    영구 캐싱해 다음 실행에서도 계속 빠지는 사고를 막는다(코드리뷰 지적, 2026-08-08 —
    예외는 원래도 캐시에 안 남아 재시도되지만, 빈 DataFrame 응답은 예외를 안 던지므로
    같은 보호가 없었음). 실패율(오류+빈결과)이 max_fail_ratio를 넘으면 이번 실행에서
    확정지은 캐시 파일 없이(빈 결과 전부 미기록) 예외를 던진다 — 다음 실행이 전부
    다시 시도할 수 있게.
    """
    os.makedirs(CACHE_DIR, exist_ok=True)
    end = end_date or pd.Timestamp.today().strftime('%Y-%m-%d')
    result = {}
    pending_empty = []
    to_fetch = [c for c in codes if not os.path.exists(cache_path(c))]
    for i, code in enumerate(to_fetch):
        try:
            df = fdr.DataReader(code, start_date, end)
            if df is None or df.empty:
                result[code] = 'empty'
                pending_empty.append(code)
            else:
                cols = [c for c in ('Open', 'Close', 'High', 'Low', 'Volume') if c in df.columns]
                df[cols].to_csv(cache_path(code))
                result[code] = 'fetched'
        except Exception as e:
            result[code] = f'error:{e}'
        if (i + 1) % 50 == 0:
            print(f'  ...{i + 1}/{len(to_fetch)}건 처리', file=sys.stderr)
        time.sleep(delay)

    if to_fetch:
        error_count = sum(1 for v in result.values() if v.startswith('error'))
        fail_ratio = (error_count + len(pending_empty)) / len(to_fetch)
        if fail_ratio > max_fail_ratio:
            raise RuntimeError(
                f'시세 캐싱 실패율 과다: 오류 {error_count}건 + 빈결과 {len(pending_empty)}건 / '
                f'시도 {len(to_fetch)}건({fail_ratio * 100:.0f}%) — 개별 종목 결측이 아니라 '
                f'데이터소스 전체 장애로 의심됨. 빈 결과는 캐시에 확정하지 않았으니 다음 실행이 '
                f'전부 재시도한다.'
            )

    # 여기 도달했다는 건 실패율이 정상 범위 — 빈 결과를 이제 캐시에 확정한다(헤더만
    # 있는 빈 CSV로 "조회했지만 없음"을 기록, 다음 실행부터 재조회 스킵).
    for code in pending_empty:
        pd.DataFrame(columns=['Open', 'Close', 'High', 'Low', 'Volume']).to_csv(cache_path(code))

    for code in codes:
        if code not in result:
            result[code] = 'cached'
    return result


def _atomic_to_csv(df, path):
    """to_csv를 원자적으로(임시파일→os.replace) 쓴다(2026-09-14 코드리뷰 MEDIUM
    지적) — index-price-cache.mjs가 이미 겪은 것과 같은 버그 클래스: read-modify-
    whole-file-write를 df.to_csv(최종경로)로 직접 하면 타임아웃·강제종료 시 잘린
    파일이 그대로 "캐시됨"으로 영구 고정될 수 있다. update_prices()는
    cache_prices()와 달리 파일당 매일 다시 쓰므로(최초 1회뿐인 cache_prices()보다
    노출 빈도가 훨씬 높음) 이 보호가 특히 중요하다."""
    tmp_path = f'{path}.tmp'
    df.to_csv(tmp_path)
    os.replace(tmp_path, path)


def _is_market_hours_kst(now=None):
    """KST 평일 09:00~15:30(정규장) 안이면 True — 이 시간대엔 오늘자 데이터가 아직
    미완성 봉일 수 있어 캐싱 대상에서 제외해야 한다(2026-09-14 코드리뷰 지적).
    update-breakout-price-cache.mjs는 장 시작 전 아침에 도는 게 정상 스케줄이라
    평소엔 안 걸리지만, 수동 재실행이 장중에 일어날 가능성에 대한 방어."""
    now_kst = now or pd.Timestamp.now(tz='Asia/Seoul')
    if now_kst.weekday() >= 5:  # 토(5)·일(6)
        return False
    minutes = now_kst.hour * 60 + now_kst.minute
    return 9 * 60 <= minutes < 15 * 60 + 30


CORPORATE_ACTION_TOLERANCE = 0.03  # 액면분할/병합 감지 허용오차(겹침구간 종가 3%
# 초과 차이 — 정상적인 데이터 수정 오차는 이보다 훨씬 작고, 분할/병합은 배수로 튐)
OVERLAP_CALENDAR_DAYS = 20  # 겹침재조회 기간(캘린더 기준, 거래일 10일 안팎을 넉넉히 커버)


def update_prices(codes, end_date=None, delay=0.05, max_fail_ratio=MAX_CACHE_FAIL_RATIO):
    """cache_prices()와 달리 "이미 캐시된 종목을 최신 날짜까지 증분 갱신"하는 함수
    (2026-09-14 신설) — cache_prices()는 `to_fetch = [c for c in codes if not
    os.path.exists(cache_path(c))]`라 파일이 이미 있으면 그 종목은 영원히 다시
    안 건드린다(최초 백필 전용 설계). 이게 daily-breakout-signal-scan.mjs가 매번
    3거래일 밀린 캐시로 신호 0건만 내던 실제 사고의 원인이었다(2026-09-14, 첫
    실전 테스트에서 발견 — 개별종목 캐시는 09-11에서 멈춰있는데 코스피 지수 캐시는
    당일까지 갱신돼 있어 전 종목이 날짜 불일치로 탈락).

    캐시가 아예 없는 종목(파일 자체가 없음, 'no-cache-file')은 건너뛴다 — 최초
    백필은 여전히 cache_prices() 책임(관심사 분리), 다만 Node 쪽 호출부
    (update-breakout-price-cache.mjs)가 이 상태를 받아 그 종목들만 골라 자동
    후속 백필을 시도한다. 조회했지만 데이터가 없다고 이미 확정된 빈 캐시(헤더만
    있는 CSV)는 'empty-confirmed'로 별도 구분 — 2026-09-14 코드리뷰 지적: 예전엔
    두 경우가 똑같이 'no-cache-skip'으로 뭉개져서 "최초 백필이 필요한 신규상장"과
    "이미 조사 끝난 정상 상태"를 구분할 수 없었다(전자를 놓치면 신규상장 종목이
    영원히 후보풀에 못 들어와도 아무 신호가 없음).

    캐시 최신일 다음날부터 end_date까지만 조회해 기존 CSV에 이어붙인다 — 단
    "겹침재조회"(2026-09-14 코드리뷰 HIGH 지적)로 최근 OVERLAP_CALENDAR_DAYS도
    같이 다시 받아 기존 값과 대조한다: FinanceDataReader는 조회 시점 기준
    수정주가(액면분할/병합 반영)를 돌려주므로, 이미 캐시된 옛 데이터(미수정)와
    새로 받은 데이터(수정됨)가 섞이면 52주 신고가 판정이 조용히 틀어질 수 있다 —
    분할이면 과거 고가가 그대로 높게 남아 신고가가 영원히 안 뚫리는 조용한
    false negative, 병합이면 신규 가격이 배수로 튀어 가짜 돌파 신호가 나
    **승인 없이 자동매수되는 실주문 경로**(place-breakout-entry-order.mjs)까지
    이어질 수 있다. 불일치 발견 시 이어붙이지 않고 기존 캐시 시작일부터 통째로
    재수집(수정주가로 일관되게 통일) — "그런가보다" 하고 넘어가지 않는다(추정
    금지 원칙과 동일).

    end_date를 안 넘기고 지금이 KST 정규장 시간대(평일 09:00~15:30)면 오늘자를
    자동으로 제외한다(장중 수동 실행 시 미완성 봉이 영구 고정되는 것 방지).

    cache_prices()와 달리 "빈 결과"(no-new-rows)를 실패로 세지 않는다 — 이미
    데이터가 있는 종목의 증분 조회가 빈 결과인 건 흔한 정상 케이스(공휴일·거래정지
    등)이지, "그 종목이 원래 데이터가 없다"는 사실이 아니라 빈 CSV로 확정 지을
    이유가 없다(단순히 파일을 안 건드리고 넘어간다). 실패율 가드는 error만으로 계산.
    """
    end = end_date or pd.Timestamp.today().strftime('%Y-%m-%d')
    if end_date is None and _is_market_hours_kst():
        end = (pd.Timestamp.today() - pd.Timedelta(days=1)).strftime('%Y-%m-%d')

    result = {}
    to_update = []  # (code, overlap_start, existing_df, last_date)
    for code in codes:
        path = cache_path(code)
        if not os.path.exists(path):
            result[code] = 'no-cache-file'
            continue
        # 코드리뷰 지적(2026-09-14, MEDIUM) — 이 루프는 원래 예외 보호가 없어서
        # CSV 1개만 깨져도(잘린 파일 등) 전체 갱신이 죽었다. cache_prices() 두 번째
        # 루프와 동일하게 종목별로 격리.
        try:
            existing = pd.read_csv(path, index_col=0, parse_dates=True)
        except Exception as e:
            result[code] = f'error:기존 캐시 파일 파싱 실패({e})'
            continue
        if existing.empty:
            result[code] = 'empty-confirmed'
            continue
        last_date = existing.index[-1]
        next_day = (last_date + pd.Timedelta(days=1)).strftime('%Y-%m-%d')
        if next_day > end:
            result[code] = 'already-current'
            continue
        overlap_start = (last_date - pd.Timedelta(days=OVERLAP_CALENDAR_DAYS)).strftime('%Y-%m-%d')
        to_update.append((code, overlap_start, existing, last_date))

    for i, (code, overlap_start, existing, last_date) in enumerate(to_update):
        try:
            fetched = fdr.DataReader(code, overlap_start, end)
            if fetched is None or fetched.empty:
                result[code] = 'no-new-rows'
            else:
                cols = list(existing.columns)
                missing_cols = [c for c in cols if c not in fetched.columns]
                if missing_cols:
                    # 코드리뷰 지적(2026-09-14, MEDIUM) — 신규 조회가 기존 컬럼 일부를
                    # 못 주면(예: Volume 결측) pd.concat이 컬럼 합집합을 만들어 그
                    # 칸이 NaN→CSV 빈칸→Node 로더에서 0으로 둔갑한다("추정 안 함"
                    # 계약 위반). 조용히 진행하지 않고 에러로 기록, 그 종목은 안 건드림.
                    result[code] = f'error:신규 조회에 기존 컬럼 누락({missing_cols})'
                else:
                    fetched = fetched[cols]
                    overlap_dates = fetched.index.intersection(existing.index)
                    mismatch = False
                    if len(overlap_dates) > 0 and 'Close' in cols:
                        old_close = existing.loc[overlap_dates, 'Close']
                        new_close = fetched.loc[overlap_dates, 'Close']
                        diff_ratio = ((new_close - old_close).abs() / old_close.replace(0, pd.NA)).max()
                        if pd.notna(diff_ratio) and diff_ratio > CORPORATE_ACTION_TOLERANCE:
                            mismatch = True
                    if mismatch:
                        full_start = existing.index[0].strftime('%Y-%m-%d')
                        refetched = fdr.DataReader(code, full_start, end)
                        if refetched is None or refetched.empty:
                            result[code] = 'error:불일치 감지(액면분할/병합 의심) 후 전체 재수집 실패(빈 응답)'
                        else:
                            refetch_cols = [c for c in cols if c in refetched.columns]
                            if len(refetch_cols) < len(cols):
                                result[code] = f'error:불일치 감지 후 전체 재수집에도 컬럼 누락({[c for c in cols if c not in refetch_cols]})'
                            else:
                                _atomic_to_csv(refetched[cols], path=cache_path(code))
                                result[code] = f'corporate-action-refetched+{len(refetched)}'
                    else:
                        combined = pd.concat([existing, fetched])
                        combined = combined[~combined.index.duplicated(keep='last')].sort_index()
                        _atomic_to_csv(combined, path=cache_path(code))
                        new_count = int((fetched.index > last_date).sum())
                        result[code] = f'updated+{new_count}'
        except Exception as e:
            result[code] = f'error:{e}'
        if (i + 1) % 200 == 0:
            print(f'  ...{i + 1}/{len(to_update)}건 처리', file=sys.stderr)
        time.sleep(delay)

    if to_update:
        error_count = sum(1 for v in result.values() if v.startswith('error'))
        fail_ratio = error_count / len(to_update)
        if fail_ratio > max_fail_ratio:
            raise RuntimeError(
                f'시세 증분갱신 실패율 과다: 오류 {error_count}건 / 시도 {len(to_update)}건'
                f'({fail_ratio * 100:.0f}%) — 데이터소스 전체 장애로 의심됨.'
            )
    return result


def load_price_series(code):
    """캐시된 종목의 전체 시계열을 한 번만 읽어온다(DataFrame) — 캐시가 없거나
    비어있으면 None. price_at_or_before/prices_at가 종목당 CSV를 여러 번 다시 읽는
    낭비를 막기 위해 분리(코드리뷰 지적, 2026-08-08 — 워크포워드처럼 target_dates가
    수십 개면 종목당 CSV를 수십 번씩 다시 파싱하고 있었음)."""
    path = cache_path(code)
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    return df if not df.empty else None


def price_at_or_before(code, target_date):
    """캐시된 시세에서 target_date 이하 가장 최근 거래일 종가(DelistingDate가 "마지막
    거래일의 다음날" 컨벤션임을 실측 확인 — 한진해운: 마지막 거래 2017-03-06 종가12원,
    DelistingDate=2017-03-07 — 그래서 상장폐지일 당일은 제외해도 마지막 거래일은
    누락되지 않는다). 캐시가 없거나 조건을 만족하는 데이터가 없으면 None(추정 안 함).
    """
    df = load_price_series(code)
    if df is None:
        return None
    eligible = df[df.index <= pd.Timestamp(target_date)]
    if eligible.empty:
        return None
    return float(eligible['Close'].iloc[-1])


def avg_trading_value_at(code, target_date, days=20, min_window_ratio=0.9):
    """target_date 이하 최근 days거래일의 평균 거래대금(종가×거래량 근사) — fdr-universe.py
    avg_trading_value()의 "과거 특정 시점" 버전(그쪽은 항상 "오늘" 기준). 짧은 창(신규상장
    직후 등)은 min_window_ratio 미만이면 null(추정 안 함, fdr-universe.py와 동일 원칙).
    이 함수는 유니버스 순위(computePointInTimeUniverse)로 이미 상위 350위 안에 든 종목만
    호출측이 골라서 넘기는 걸 전제한다(전체 4천여 종목이 아니라 시장당 상위 200+150만) —
    유니버스 랭킹 자체는 시가총액만 필요하고 유동성은 그 다음 단계 필터라, ARCHITECTURE-V2.md
    "유니버스 → 유동성 필터" 순서와 정합."""
    df = load_price_series(code)
    if df is None or 'Volume' not in df.columns:
        return None
    eligible = df[df.index <= pd.Timestamp(target_date)].tail(days)
    if len(eligible) < days * min_window_ratio:
        return None
    amounts = (eligible['Close'] * eligible['Volume']).dropna()
    if amounts.empty:
        return None
    return float(amounts.mean())


def liquidity_at(codes, target_dates, days=20):
    """codes × target_dates 조합별 avg_trading_value_at — prices_at과 같은 로드-후-질의
    패턴(종목당 CSV 1회 로드). 반환: {code: {date: avgTradingValue_or_null}}."""
    out = {}
    for code in codes:
        out[code] = {d: avg_trading_value_at(code, d, days) for d in target_dates}
    return out


def prices_at(codes, target_dates):
    """codes × target_dates 조합별 "그 날짜 이하 최근 거래일 종가" — 데이터 조회만
    (순위·필터 판정은 안 함, 그건 historical-universe.mjs의 computePointInTimeUniverse가
    순수함수로 담당 — fdr-universe.py/quant-universe.mjs와 같은 Node·Python 역할분담
    원칙). 종목당 CSV를 한 번만 읽고 메모리 상에서 모든 target_dates를 조회(로드-후-
    질의 방식, 날짜마다 다시 읽지 않음). 반환: {code: {date: price_or_null}}."""
    out = {}
    target_ts = [pd.Timestamp(d) for d in target_dates]
    for code in codes:
        df = load_price_series(code)
        if df is None:
            out[code] = {d: None for d in target_dates}
            continue
        row = {}
        for d, ts in zip(target_dates, target_ts):
            eligible = df[df.index <= ts]
            row[d] = float(eligible['Close'].iloc[-1]) if not eligible.empty else None
        out[code] = row
    return out


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else None
    if cmd == 'build-pool':
        print(json.dumps(build_candidate_pool(), ensure_ascii=False))
    elif cmd == 'cache-prices':
        start_date = sys.argv[2]
        codes = sys.argv[3].split(',') if len(sys.argv) > 3 else [c['code'] for c in build_candidate_pool()]
        result = cache_prices(codes, start_date)
        summary = {}
        for v in result.values():
            key = v.split(':')[0]
            summary[key] = summary.get(key, 0) + 1
        print(json.dumps({'summary': summary, 'total': len(result)}, ensure_ascii=False))
    elif cmd == 'update-prices':
        # ⚠️ 2026-09-14 코드리뷰 CRITICAL 지적 — 원래 이 분기가 요약(summary)만
        # 찍어서, historical-universe.mjs의 updatePrices()가 기대하는 "{code: 상태}"
        # 전체 맵과 계약이 안 맞아 Node 쪽(summarizeUpdateResult)이 매번 크래시했다
        # (Python은 CSV를 정상적으로 갱신했지만 잡 자체는 항상 exit 1로 끝나던 상태
        # — "검증됐다"고 볼 수 없는 상태였음). prices-at/liquidity-at과 동일하게
        # 전체 result 맵을 그대로 출력 — 집계는 이미 Node 쪽 summarizeUpdateResult가
        # 담당(중복 집계 제거).
        codes = sys.argv[2].split(',') if len(sys.argv) > 2 else [c['code'] for c in build_candidate_pool()]
        print(json.dumps(update_prices(codes), ensure_ascii=False))
    elif cmd == 'prices-at':
        target_dates = json.loads(sys.argv[2])
        codes = sys.argv[3].split(',') if len(sys.argv) > 3 else [c['code'] for c in build_candidate_pool()]
        print(json.dumps(prices_at(codes, target_dates), ensure_ascii=False))
    elif cmd == 'liquidity-at':
        target_dates = json.loads(sys.argv[2])
        codes = sys.argv[3].split(',') if len(sys.argv) > 3 else [c['code'] for c in build_candidate_pool()]
        print(json.dumps(liquidity_at(codes, target_dates), ensure_ascii=False))
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
