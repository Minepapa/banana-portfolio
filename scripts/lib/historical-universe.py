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
  python3 historical-universe.py cache-prices <시작일> [<종목코드,...>]  # 시세 캐시 채우기
  python3 historical-universe.py universe-at <기준일> [상위N_코스피] [상위N_코스닥]
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
    """codes 각각의 일별 종가 시계열을 로컬 CSV로 캐싱(이미 있으면 스킵 — 재실행해도
    안전, 중단 후 재개 가능). 반환: {code: 'cached'|'fetched'|'empty'|'error:...'} 요약.

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
                df[['Close']].to_csv(cache_path(code))
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
        pd.DataFrame(columns=['Close']).to_csv(cache_path(code))

    for code in codes:
        if code not in result:
            result[code] = 'cached'
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
    elif cmd == 'prices-at':
        target_dates = json.loads(sys.argv[2])
        codes = sys.argv[3].split(',') if len(sys.argv) > 3 else [c['code'] for c in build_candidate_pool()]
        print(json.dumps(prices_at(codes, target_dates), ensure_ascii=False))
    else:
        print(__doc__, file=sys.stderr)
        sys.exit(2)


if __name__ == '__main__':
    main()
