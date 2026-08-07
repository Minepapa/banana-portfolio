#!/usr/bin/env python3
"""FinanceDataReader로 코스피+코스닥 유니버스(시가총액 상위 200+150 근사) + 유동성(20거래일
평균 거래대금) 조회 → JSON. 숫자 계산(순위·필터 판정)은 Node(quant-universe.mjs)가 한다.

⚠️ 공식 코스피200·코스닥150 지수 구성종목이 아니라 시가총액 상위 200(코스피)+150(코스닥)
종목으로 근사한다(오너 확정, 2026-08-07) — 공식 지수 API(pykrx get_index_portfolio_
deposit_file)는 KRX 정보데이터시스템 실계정 로그인이 있어야만 조회되는 걸 이 세션에서
직접 확인(일반 종목리스트·시세는 로그인 없이도 되지만, 지수 구성종목 리포트(MDCSTAT00601)
는 서버가 명시적으로 거부함 — "LOGOUT" 응답). 시가총액 기준 근사는 공식 지수와 대체로
겹치지만 유동성·업종배분 등 KRX의 추가 선정기준은 반영 안 됨(설계서에 명시된 트레이드오프).

⚠️ Python 표준 urllib/requests의 SSL 인증서 검증이 이 환경에서 깨져있다(이미 알려진 문제,
project-headless-automation 메모리 참고) — SSL_CERT_FILE 환경변수로 certifi 번들을
가리켜야 한다(호출부 Node가 spawnSync 시 env로 주입).

⚠️ 거래대금은 근사치다 — FinanceDataReader.DataReader에 실제 거래대금(Amount) 컬럼이
없어(실측 확인) 종가×거래량으로 근사한다. 경계값(30억원 부근) 근처에서는 실제 거래대금과
소폭 어긋날 수 있음 — 받아들이는 근사(허용된 트레이드오프).

⚠️ 실패를 조용히 삼키지 않는다(코드리뷰 지적, 2026-08-05) — 종목 하나의 데이터 결측은
null로 정상 처리(제외)하지만, **시스템 전체 장애**(SSL 깨짐·백엔드 다운 등)가 "이번 달은
그냥 유동성 낮은 달"로 위장되면 안 된다. 그래서: (1) 각 시장에서 요청한 개수의 90% 미만이
나오면 즉시 비정상 종료, (2) 유동성 조회 실패율이 20%를 넘으면 즉시 비정상 종료 — 두 경우
다 Node 호출부의 `r.status !== 0` 가드가 잡아 "이번 달 결과가 이상하다"를 시끄럽게 알린다.

사용법: python3 fdr-universe.py <상위N_코스피> <상위N_코스닥> <유동성조회일수>
  예: python3 fdr-universe.py 200 150 20
"""
import json
import sys
import time
import FinanceDataReader as fdr
import pandas as pd

MIN_FILL_RATIO = 0.9   # 시장별 요청 개수 대비 최소 확보 비율
MAX_NULL_RATIO = 0.2   # 유동성 조회 실패 허용 상한(이 이상이면 시스템 장애로 간주)
MIN_WINDOW_RATIO = 0.9  # 거래일 수 요구치(짧은 창을 "20일 평균"으로 위장하지 않음)


def is_common_share(code, name):
    """보통주만 남긴다 — 우선주(예: 삼성전자우 005935, 미래에셋증권2우B 00680K)가 섞이면
    같은 회사가 유니버스에 중복 편입되고, 아직 안 만든 OCF/P 랭킹 단계에서 같은 회사의
    OCF를 서로 다른 두 가격에 대입해 순위를 왜곡한다(코드리뷰 지적, 2026-08-05). KRX
    관행상 보통주 코드는 마지막 자리가 '0'(우선주는 5·9 등 다른 숫자나 K 등 문자) — 이름
    끝 "우"·"우B" 패턴도 이중 확인으로 함께 본다.
    """
    return code[-1] == '0' and not name.endswith(('우', '우B'))


def top_by_marcap(market, n):
    df = fdr.StockListing(market)
    df = df[df['Marcap'].notna() & (df['Marcap'] > 0)]
    df = df[df.apply(lambda r: is_common_share(r['Code'], r['Name']), axis=1)]
    df = df.sort_values('Marcap', ascending=False).head(n)
    got = len(df)
    if got < n * MIN_FILL_RATIO:
        raise RuntimeError(f'{market} 종목 확보 부족: 요청 {n}, 실제 {got}(데이터 소스 장애 의심)')
    return df[['Code', 'Name', 'Marcap']].to_dict('records')


def avg_trading_value(code, days):
    """최근 days거래일 평균 거래대금(원, 종가×거래량 근사) — 데이터 부족·조회실패는
    None(추정 안 함). 요구 거래일수의 MIN_WINDOW_RATIO 미만이면(예: 신규상장 직후) 짧은
    창을 "20일 평균"으로 속이지 않고 null 처리한다(코드리뷰 지적 — 상장 초기 급등락
    거래량이 며칠치만으로 평균에 섞이면 실제보다 유동성이 부풀려질 수 있음).
    """
    try:
        end = pd.Timestamp.today()
        start = end - pd.Timedelta(days=days * 2 + 10)  # 주말·공휴일 감안 여유
        df = fdr.DataReader(code, start.strftime('%Y-%m-%d'), end.strftime('%Y-%m-%d'))
        if df is None or df.empty:
            return None
        recent = df.tail(days)
        if len(recent) < days * MIN_WINDOW_RATIO:
            return None
        amounts = (recent['Close'] * recent['Volume']).dropna()
        if amounts.empty:
            return None
        return float(amounts.mean())
    except Exception:
        return None


def main():
    n_kospi = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    n_kosdaq = int(sys.argv[2]) if len(sys.argv) > 2 else 150
    liq_days = int(sys.argv[3]) if len(sys.argv) > 3 else 20

    candidates = top_by_marcap('KOSPI', n_kospi) + top_by_marcap('KOSDAQ', n_kosdaq)
    null_count = 0
    for c in candidates:
        c['avgTradingValue'] = avg_trading_value(c['Code'], liq_days)
        if c['avgTradingValue'] is None:
            null_count += 1
        time.sleep(0.05)  # 과도한 연속요청 방지(예의상 지연, KRX/네이버 백엔드 배려)

    if candidates and (null_count / len(candidates)) > MAX_NULL_RATIO:
        raise RuntimeError(
            f'유동성 조회 실패율 과다: {null_count}/{len(candidates)}건 — '
            f'개별 종목 결측이 아니라 데이터 소스 전체 장애로 의심됨'
        )

    print(json.dumps(candidates, ensure_ascii=False))


if __name__ == '__main__':
    main()
