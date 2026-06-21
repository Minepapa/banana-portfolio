#!/usr/bin/env python3
"""월말 종가 조회. 사용: python3 yf-monthly-close.py <startYYYYMM> <endYYYYMM> [tickers...]
기본 티커: ^KS11(KOSPI) ^GSPC(S&P500).
출력: { "^KS11": {"202501": 2345.67, ...}, "^GSPC": {"202501": 5890.12, ...} }"""
import json, sys
from datetime import datetime, timedelta
import yfinance as yf
import pandas as pd

def month_end_closes(ticker, start_ym, end_ym):
    start_dt = datetime(start_ym // 100, start_ym % 100, 1)
    end_month = end_ym % 100
    end_year = end_ym // 100
    if end_month == 12:
        end_dt = datetime(end_year + 1, 1, 1)
    else:
        end_dt = datetime(end_year, end_month + 1, 1)
    end_dt += timedelta(days=7)

    h = yf.Ticker(ticker).history(start=start_dt.strftime("%Y-%m-%d"),
                                   end=end_dt.strftime("%Y-%m-%d"),
                                   interval="1d")
    if h.empty:
        return {}

    h.index = pd.to_datetime(h.index)
    if h.index.tz is not None:
        h.index = h.index.tz_localize(None)
    monthly = h["Close"].resample("ME").last()
    result = {}
    for dt, val in monthly.items():
        if pd.isna(val):
            continue
        ym = f"{dt.year}{dt.month:02d}"
        ym_int = dt.year * 100 + dt.month
        if start_ym <= ym_int <= end_ym:
            result[ym] = round(float(val), 2)
    return result

if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) < 2:
        print("Usage: yf-monthly-close.py <startYYYYMM> <endYYYYMM> [tickers...]", file=sys.stderr)
        sys.exit(1)
    start_ym = int(args[0])
    end_ym = int(args[1])
    tickers = args[2:] if len(args) > 2 else ["^KS11", "^GSPC"]

    out = {}
    for tk in tickers:
        out[tk] = month_end_closes(tk, start_ym, end_ym)
    print(json.dumps(out, ensure_ascii=False))
