#!/usr/bin/env python3
"""yfinance 시세·밸류에이션 raw → JSON. 사용: python3 yf-marketdata.py AAPL
계산(RSI·52주위치·FCF yield·MACD·이평배열·ATR·스토캐스틱·거래대금급증)은 Node(fundamentals.mjs)
가 한다 — 여기선 raw만 넘긴다. period를 2mo→6mo로 확대(기존 RSI14는 15개면 충분했지만 MA60·
MACD(26+9 warmup)가 안정적으로 수렴하려면 최소 60~90개 필요 — 6mo ≈ 125거래일 확보 후 최근
90개만 자름). closes/highs/lows/volumes는 반드시 같은 DataFrame에서 같은 [-90:] 슬라이스로
잘라 인덱스가 서로 어긋나지 않게 한다(ATR·스토캐스틱은 날짜별 H/L/C 정합이 필수)."""
import json, sys
import yfinance as yf

tk = sys.argv[1]
t = yf.Ticker(tk)
info = t.info or {}
num = lambda v: float(v) if isinstance(v, (int, float)) else None
try:
    h = t.history(period="6mo", interval="1d").tail(90)
    # 네 컬럼 전부 유효한 행만 — Close만 걸렀을 때 H/L/V 중 하나라도 NaN이면 json.dumps가
    # 비표준 NaN 토큰을 내보내 Node JSON.parse가 깨진다(코드리뷰 지적).
    valid = h[["Close", "High", "Low", "Volume"]].notna().all(axis=1)
    closes = [float(x) for x in h.loc[valid, "Close"].tolist()]
    highs = [float(x) for x in h.loc[valid, "High"].tolist()]
    lows = [float(x) for x in h.loc[valid, "Low"].tolist()]
    volumes = [float(x) for x in h.loc[valid, "Volume"].tolist()]
except Exception:
    closes, highs, lows, volumes = [], [], [], []
print(json.dumps({
    'trailingPE': num(info.get('trailingPE')),
    'forwardPE':  num(info.get('forwardPE')),
    'priceToBook': num(info.get('priceToBook')),
    'fiftyTwoWeekHigh': num(info.get('fiftyTwoWeekHigh')),
    'fiftyTwoWeekLow':  num(info.get('fiftyTwoWeekLow')),
    'currentPrice': num(info.get('currentPrice') or info.get('regularMarketPrice')),
    'marketCap': num(info.get('marketCap')),
    'freeCashflow': num(info.get('freeCashflow')),
    'payoutRatio': num(info.get('payoutRatio')),
    'closes': closes,
    'highs': highs,
    'lows': lows,
    'volumes': volumes,
}, ensure_ascii=False))
