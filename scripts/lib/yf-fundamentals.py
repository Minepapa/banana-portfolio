#!/usr/bin/env python3
"""yfinance 분기 펀더멘털 → JSON 한 줄. 사용: python3 yf-fundamentals.py AAPL"""
import json, sys
import yfinance as yf

t = yf.Ticker(sys.argv[1])
info = t.info or {}
qf = t.quarterly_financials
qcf = t.quarterly_cashflow  # 별도 DataFrame — Free Cash Flow는 quarterly_financials에 없음

def series(df, name):
    try:
        return [float(x) for x in df.loc[name].tolist() if x == x]  # NaN 제외
    except Exception:
        return []

def yoy(a, i):
    if len(a) > i + 4 and a[i + 4]:
        return round((a[i] - a[i + 4]) / abs(a[i + 4]) * 1000) / 10
    return None

rev, op = series(qf, 'Total Revenue'), series(qf, 'Operating Income')
fcf = series(qcf, 'Free Cash Flow')  # 단일분기 값(Yahoo 파생 현금흐름표는 누적 아님, KR operCf와 다름)
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
    'fcfCurr': fcf[0] if fcf else None, 'fcfPrev': fcf[1] if len(fcf) > 1 else None,
    'grossMargin': pct(info.get('grossMargins')), 'opMargin': pct(info.get('operatingMargins')),
    'roe': pct(info.get('returnOnEquity')),
    'debtRatio': round(d2e * 10) / 10 if isinstance(d2e, (int, float)) else None,
    'eps': info.get('trailingEps'), 'pbr': pbr, 'source': 'yfinance quarterly+info(TTM)',
}, ensure_ascii=False))
