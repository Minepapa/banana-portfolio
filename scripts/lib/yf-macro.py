#!/usr/bin/env python3
"""yfinance 거시지표 일별 종가 → JSON. 사용: python3 yf-macro.py KRW=X ^TNX ^VIX ^KS11 ^GSPC
숫자 계산(현재값·5일 변화율)은 Node(fundamentals.mjs)가 한다 — 여기선 raw 종가 배열만 넘긴다."""
import json, sys
import yfinance as yf

out = {}
for tk in sys.argv[1:]:
    try:
        h = yf.Ticker(tk).history(period="1mo", interval="1d")
        closes = [float(x) for x in h["Close"].tolist() if x == x]  # NaN 제외
        out[tk] = closes[-10:]  # 최근 10거래일(과거→현재)
    except Exception:
        out[tk] = []
print(json.dumps(out, ensure_ascii=False))
