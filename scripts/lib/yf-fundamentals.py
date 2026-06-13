#!/usr/bin/env python3
"""yfinance 분기 펀더멘털 → JSON 한 줄. 사용: python3 yf-fundamentals.py AAPL"""
import json, sys
import yfinance as yf

t = yf.Ticker(sys.argv[1])
info = t.info or {}
qf = t.quarterly_financials

def series(name):
    try:
        return [float(x) for x in qf.loc[name].tolist() if x == x]  # NaN 제외
    except Exception:
        return []

def yoy(a, i):
    if len(a) > i + 4 and a[i + 4]:
        return round((a[i] - a[i + 4]) / abs(a[i + 4]) * 1000) / 10
    return None

rev, op = series('Total Revenue'), series('Operating Income')
pct = lambda v: round(v * 1000) / 10 if isinstance(v, (int, float)) else None
d2e = info.get('debtToEquity')
ptb = info.get('priceToBook')
mc = info.get('marketCap')
bv = info.get('bookValue')
pbr = round(ptb * 100) / 100 if isinstance(ptb, (int, float)) else (
    round(mc / (bv * info.get('sharesOutstanding', 0)) * 100) / 100
    if isinstance(mc, (int, float)) and isinstance(bv, (int, float)) and bv and info.get('sharesOutstanding')
    else None
)
print(json.dumps({
    'revenueYoY': yoy(rev, 0), 'opYoYCurr': yoy(op, 0), 'opYoYPrev': yoy(op, 1),
    'grossMargin': pct(info.get('grossMargins')), 'opMargin': pct(info.get('operatingMargins')),
    'roe': pct(info.get('returnOnEquity')),
    'debtRatio': round(d2e * 10) / 10 if isinstance(d2e, (int, float)) else None,
    'eps': info.get('trailingEps'), 'pbr': pbr, 'source': 'yfinance quarterly+info(TTM)',
}, ensure_ascii=False))
