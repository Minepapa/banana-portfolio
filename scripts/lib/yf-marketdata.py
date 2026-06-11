#!/usr/bin/env python3
"""yfinance 시세·밸류에이션 raw → JSON. 사용: python3 yf-marketdata.py AAPL
계산(RSI·52주위치·FCF yield)은 Node(fundamentals.mjs)가 한다 — 여기선 raw만 넘긴다."""
import json, sys
import yfinance as yf

tk = sys.argv[1]
t = yf.Ticker(tk)
info = t.info or {}
num = lambda v: float(v) if isinstance(v, (int, float)) else None
try:
    h = t.history(period="2mo", interval="1d")
    closes = [float(x) for x in h["Close"].tolist() if x == x][-30:]  # RSI14 여유분
except Exception:
    closes = []
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
}, ensure_ascii=False))
