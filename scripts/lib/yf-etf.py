#!/usr/bin/env python3
"""yfinance 미국 상장 ETF/지수/환율 종가+거래량(1년) → JSON.
사용: python3 yf-etf.py VOO KRW=X ^GSPC
지수(^GSPC 등)·환율(KRW=X)은 거래량이 없거나 무의미해 volume이 빈 배열로 옴 —
호출측(us-etf-scoring.mjs)이 그 경우를 이미 감안해서 쓴다.
숫자 계산(수익률·추적오차 등)은 Node(instrument-scoring.mjs)가 한다 — 여기선
raw 종가·거래량 배열만 과거→현재 순으로 넘긴다(yf-macro.py와 동일 원칙)."""
import json, sys
import yfinance as yf

out = {}
for tk in sys.argv[1:]:
    try:
        h = yf.Ticker(tk).history(period="1y", interval="1d")
        closes = [float(x) for x in h["Close"].tolist() if x == x]  # NaN 제외
        volumes = [float(x) for x in h["Volume"].tolist() if x == x] if "Volume" in h else []
        out[tk] = {"close": closes, "volume": volumes}
    except Exception:
        out[tk] = {"close": [], "volume": []}
print(json.dumps(out, ensure_ascii=False))
