// 앱 전역 상수·순수 데이터·소형 순수 헬퍼. App.jsx에서 추출 (동작 불변).

export const SHEET_RANGES = {
  ISA:          'ISA!A2:I',            // 0
  위탁:         '위탁!A2:I',           // 1
  연금저축:     '연금저축!A2:I',       // 2
  IRP:          'IRP!A2:I',            // 3
  위탁리밸:     '자산분배!B3:D9',      // 4  목표+현재+리밸 한 범위로 (row 2 = 계좌 레이블)
  연금저축리밸: '자산분배!B12:D18',    // 5
  ISA리밸:      '자산분배!B21:D21',    // 6
  IRP리밸:      '자산분배!B24:D24',    // 7
  월별잔고:     '월별잔고!A2:J',       // 8  (I=KOSPI지수, J=S&P500지수)
  배당금:       '배당금!A2:C',         // 9
  수익금:       '수익금!A2:F',         // 10
  평가노트:     '종목투자노트!A2:U',   // 11  (없거나 비어있어도 안전)
  평가요청:     '평가요청!A2:F',       // 12  비동기 평가 의뢰 큐 (모바일에서 추가 → Claude Pro가 처리)
  주간리포트:   '주간리포트!A2:C',     // 13  주간 AI 리포트 (날짜, 요약, 본문)
  리스크모니터: '리스크모니터!A2:H',   // 14  AI 리스크 신호 (날짜,유형,대상,신호,요약,상세,근거,기준선참조)
  리스크기준선: '리스크기준선!A2:J',   // 15  펀더멘털 기준선 (종목,티커,시장,기준일,매총이,영익,ROE,부채,EPS,비고)
  포지션저널:   '포지션저널!A2:P',     // 16  거래 생애주기 전제 (종목,티커,시장,계좌,유형,전제,목표,이탈조건,예상보유,진입일,상태,청산일,청산결과,교훈,확인여부,갱신시각)
  환율:         '설정!B2',             // 17  USD/KRW 환율 (GOOGLEFINANCE 수식)
  성향관찰:     '성향관찰!A2:H',       // 18  행동 학습 관찰 (날짜,신호유형,관찰,증거,§3대비,신뢰도,상태,갱신시각)
  일별스냅샷:   '일별스냅샷!A2:E',     // 19  매일 08:00 잔고 스냅샷 (날짜,스냅시각,총평가,계좌별JSON,종목별JSON) — 어제대비·무버 기준선
  주문제안:     '주문제안!A2:N',       // 20  주문서 (생성일시,출처,계좌,방향,종목명,수량,단가,금액,근거,제약,상태,응답,기각사유,매칭키)
  실시간시세:   '실시간시세!A2:F',     // 21  한투(KIS) 실시간 시세 — 보유 국내종목만 (종목명,시장,티커,실시간가,등락률,갱신시각)
};

export const REBAL_TARGET_START = { ISA: 21, 위탁: 3, 연금저축: 12, IRP: 24 };
// 잡 헬스 배너용 — 잡별 최대 허용 무갱신 시간(시간). 주말 갭 고려해 risk 류는 넉넉히.
// parse-notifications·realtime-quotes 는 평일 장중(각각 08:00–16:30·09:00–15:30)만 도므로
// staleness 판정 제외(야간·주말 갭 오탐 방지) — 실패 감지는 아래 설명대로 heartbeat 연속실패로.
// 실패 감지는 연속 2회 실패 시 텔레그램 알림(record-heartbeat)으로 대체.
export const JOB_CADENCE = { drain: 6, 'risk-d': 80, 'risk-b': 200 };

// 잡→판테온 부서 매핑 — 판테온탭 Hermes 카드·KpiTab 부서 배지(후속)가 소비.
// risk-b/risk-d/baseline(리스크 판정 근거)=Themis, drain/order-*(전략실 산출물)=Athena,
// weekly-report(비서실 보고)=Apollo, 나머지 장부 ETL류=Hermes.
export const JOB_DEPARTMENT = {
  'parse-notifications': 'hermes',
  'drain': 'athena',
  'journal-sync': 'hermes',
  'daily-snapshot': 'hermes',
  'risk-d': 'themis',
  'order-crash': 'athena',
  'risk-b': 'themis',
  'weekly-report': 'apollo',
  'order-weekly': 'athena',
  'report-sync': 'hermes',
  'backup': 'hermes',
  'baseline': 'themis',
  'realtime-quotes': 'hermes',
  'reconcile-irp': 'hermes',
};

// 체결내역 A~M 컬럼 레이블
export const CHEOL_COLS = [
  { key: 'A', label: '날짜',     placeholder: 'YYYY-MM-DD' },
  { key: 'B', label: '매수/매도', placeholder: '매수 or 매도' },
  { key: 'C', label: '계좌',     placeholder: 'ISA / 위탁 / 연금저축 / IRP' },
  { key: 'D', label: '종목코드', placeholder: '005930 / AAPL' },
  { key: 'E', label: '자산군',   placeholder: '채권 / 국내주식 / 해외주식 ...' },
  { key: 'F', label: '종목명',   placeholder: '삼성전자' },
  { key: 'G', label: '체결가',   placeholder: '0' },
  { key: 'H', label: '수량',     placeholder: '0' },
  { key: 'I', label: '체결금액', placeholder: '0' },
  { key: 'J', label: '현재가',   placeholder: '0' },
  { key: 'K', label: '수수료',   placeholder: '0' },
  { key: 'L', label: '세금',     placeholder: '0' },
  { key: 'M', label: '정산금액', placeholder: '0' },
];

// 색상 시스템(PROFIT_*·CHART_BAR_COLOR·COLORS·profitColor)은 colors.js로 분리됨.
// relTime은 textFormat.js로 분리됨.

// ── 학습 모듈 + AI 능동 평가 (banana learning/ 참조 — 2026-06-14 이전) ─────────────────
export const LEARNING_MODULES = {
  // 수익성
  revenue_growth:   { title: '매출성장률 YoY', summary: '작년 같은 분기 대비 매출이 몇 % 늘었나. 회사의 외형 성장 속도. 마진과 함께 봐야 의미 있음.', threshold: 'Frank 확정: 10%+ 3년 유지면 성장주로 분류. 마진 동시 상승이면 강력.' },
  operating_margin: { title: '영업이익률', summary: '본업으로 매출 100원에 영업단계 얼마 남는지. 동종 평균 1.5배 이상이면 가격결정력 강함.', threshold: 'Frank: 동종 대비 1.5배 + 3년 추세 평탄/상승이면 매수 근거' },
  gross_margin:     { title: '매출총이익률 (Gross Margin)', summary: '매출에서 원가를 빼고 남는 비율. 회사의 원가 경쟁력과 가격결정력의 1차 지표. 영업이익률의 상한선.', threshold: 'Frank: 50%+ 소프트웨어/플랫폼급, 30~50% 제조업 우수, 20% 미만 → 가격 경쟁 치열' },
  roe:              { title: 'ROE (자기자본이익률)', summary: '주주 자본 대비 순이익. 자기 돈을 굴려 얼마 벌었는지. 부채 레버리지 포함이라 ROIC와 함께 봐야 정확.', threshold: 'Frank: 15%+ 3년 유지면 우수. 단 부채비율 100% 이상이면 레버리지 효과 감안 필요' },
  roic:             { title: 'ROIC (투하자본수익률)', summary: '빚+자기자본을 굴려 얼마 남기는지. 15% 이상 5년 유지면 해자(moat) 강력. ROE보다 정직.', threshold: 'Frank: 15% 이상 5년 평균 → 매수 후보, 10% 미만 → 신중' },

  // 재무 안정성
  debt_ratio:       { title: '부채비율', summary: '부채총계 ÷ 자기자본. 100%면 빚과 자본이 같다는 뜻. 업종마다 정상 범위 다름.', threshold: 'Frank: 제조업 < 100% 양호, 금융업은 별도 기준. 200% 초과 → 재무 리스크 점검' },
  equity_ratio:     { title: '자기자본비율', summary: '자기자본 ÷ 총자산. 높을수록 재무 안전. 부채비율의 역수 관계.', threshold: 'Frank: 50%+ 양호, 30~50% 보통, 30% 미만 → 차입 의존도 높음' },
  debt_to_equity:   { title: 'D/E (부채자본비율)', summary: '총부채 ÷ 자기자본. 부채비율과 동일 개념이나 US 기업 분석에서 주로 사용. 낮을수록 안전.', threshold: 'Frank: 테크 < 50% 양호, 유틸리티/리츠는 100%+ 정상. 업종 맥락 필수' },
  net_cash:         { title: '순현금', summary: '보유 현금 − 총차입금. 양수면 빚보다 현금이 많아 재무 안전. 음수(순부채)면 차입 의존.', threshold: 'Frank: 순현금 양수 → 재무 리스크 낮음. 순부채 전환 추세면 경계' },
  net_debt_ebitda:  { title: '순부채/EBITDA', summary: '회사가 번 돈(EBITDA)으로 빚을 갚는 데 몇 년 걸리는지. 1배 이하면 빚 부담 없음, 3배 이상이면 위험.', threshold: 'Frank: < 1배 양호, 1~3배 보통, > 3배 신중. 사이클 산업은 더 보수적으로' },
  interest_coverage:{ title: '이자보상배율 (EBIT/이자비용)', summary: '영업이익으로 이자를 몇 번 갚을 수 있는지. 5배 이상이 안전선, 2배 이하면 위험.', threshold: 'Frank: > 5배 안전, 3~5 보통, < 3 신중. 금리 상승기엔 5배 이상 권장' },
  current_ratio:    { title: '유동비율', summary: '1년 안에 갚을 빚(유동부채) 대비 1년 안에 현금화 가능한 자산(유동자산). 150%+ 양호.', threshold: 'Frank: > 150% 양호, 100~150% 보통, < 100% 단기 유동성 리스크' },

  // 밸류에이션
  fwd_per:          { title: 'Forward PER 5년 밴드', summary: '애널리스트 컨센서스 예상 EPS 기준 PER이 지난 5년 밴드 어디인지. 자기 자신과의 비교라 업종 차이를 흡수. 미래 이익에 대한 기대를 반영해 Trailing PER보다 낮게 나오는 경우가 많음.', threshold: 'Frank: 밴드 P25 이하 + 펀더멘털 OK → 적극 매수, P75 이상 → 보류' },
  trailing_per:     { title: 'Trailing PER (실적 PER)', summary: '지난 12개월(LTM/TTM) 실제 EPS 기준 PER. 이미 확인된 이익을 기반으로 현재 주가 수준을 평가. 추정 오차 없이 사실 기반.\n\nForward PER과 비교:\n· Trailing > Forward → 시장이 이익 증가를 기대\n· Trailing < Forward → 이익 감소 우려', threshold: '동종 업종 평균 대비 낮으면 저평가 신호. 단, 일시적 이익 급증으로 낮아 보일 수 있으니 Forward PER, EV/EBITDA와 함께 비교할 것.' },
  ev_ebitda:        { title: 'EV/EBITDA', summary: '회사 전체 가격(EV) ÷ 본업 현금이익(EBITDA). PER보다 부채·세금·감가상각 영향 제거해 더 정직.', threshold: 'Frank: < 8배 저평가, 8~12 보통, > 15 고평가. 동종/5년 밴드와 같이' },
  pbr:              { title: 'PBR (주가순자산비율)', summary: '주가 ÷ 주당순자산. 회사를 청산해서 받는 돈 대비 시장가. 1배 이하 = 청산가치 미달.', threshold: 'Frank: 자산형 회사(은행·금융지주) 0.5~1배, 성장주는 PBR로 판단하지 말 것' },
  peg:              { title: 'PEG (PER ÷ 성장률)', summary: 'PER을 이익성장률로 나눈 값. 성장 속도 대비 주가가 비싼지 판단. 1 미만이면 성장 대비 저평가, 2 이상이면 성장을 이미 다 반영.', threshold: 'Frank: < 0.8 적극 매수, 0.8~1.2 합리적, 1.5+ 성장 프리미엄 과다. 단 적자 전환 시 무의미' },
  ps_ratio:         { title: 'P/S (주가매출비율)', summary: '시가총액 ÷ 매출. 적자 기업이나 고성장 기업에서 PER 대신 사용. 매출 1원에 시장이 얼마를 지불하는지.', threshold: 'Frank: SaaS/플랫폼 10~20x 정상, 제조업 1~3x. 같은 업종 내 비교 필수' },

  // 현금흐름
  fcf_yield:        { title: 'FCF yield', summary: 'FCF/시가총액. 시가총액 대비 매년 회수되는 현금. 회계이익은 거짓말 가능, 현금은 사실.', threshold: 'Frank: 매수 시 영업이익만 보지 말 것. 배당주는 FCF 커버리지 80% 마지노선' },
  payout_ratio:     { title: '배당성향', summary: '순이익 중 배당으로 나가는 비율. 70% 넘으면 성장 재투자 여력 적음, 100% 넘으면 배당컷 임박.', threshold: 'Frank 확정: 40~60% 이상적 (메리츠금융지주형 균형). 80%+면 FCF 커버리지 같이 확인.' },
  dividend_sustainability:{ title: '배당지속가능성 (FCF 커버리지)', summary: '배당총액/FCF. 회사가 버는 현금으로 배당을 얼마나 여유롭게 지급하나. 80% 넘으면 배당컷 리스크.', threshold: 'Frank: < 80% 안전, 80~100% 경계, > 100% 배당컷 경보' },

  // 모멘텀
  rsi:              { title: 'RSI (상대강도지수)', summary: '14거래일 상승/하락 비율. 30 이하 = 일방적 매도세(반등 확률↑), 70 이상 = 과열.', threshold: 'RSI 30 이하 → 적극 매수 / 70 이상 → 일부 차익실현' },
  pos_52w:          { title: '52주 위치', summary: '현재가가 52주 최저~최고 어디인지. 하단 20% = 저점 매수, 상단 80% = 차익실현 검토.', threshold: '52주 고점 +20% 초과 → 일부 매도 / ≤20% + 펀더멘털 OK → 적극 매수' },
  foreign_flow:     { title: '외국인·기관 수급', summary: '한국 시장에서 외국인은 시총 ~35% 보유, 시장 방향 결정. 4거래일 흐름 + 환율 같이.', threshold: 'Frank: 외국인 4일 연속 순매도 → 추가 매수 보류 / 동반 순매수 4일 → 적립식 가속' },
  sector_rs:        { title: '섹터 상대강도', summary: '해당 섹터 ETF 수익률 − 시장 지수 수익률. 양수면 섹터가 시장을 이기는 중, 강세 모멘텀 시그널.', threshold: 'Frank: 보유 섹터의 RS가 4주 연속 양수면 비중 유지/확대, 음수 전환 시 점검' },

  // KPI (운용)
  twr:    { title: 'TWR (시간가중수익률)',
    summary: '저축·입금 효과를 제거하고 순수 운용 실력만 측정하는 지표.\n\n"단순 수익률은 얼마 벌었나, TWR은 운용을 잘했나."\n\n고점에 많이 입금하고 저점에 적게 입금하면 운용이 좋아도 단순 수익률은 낮게 나온다. TWR은 그 왜곡을 제거한다. 단순 수익률 vs TWR의 차이가 곧 타이밍 효과 — 실력은 TWR만 본다. 펀드·ETF·기관 모두 표준.',
    threshold: 'Frank 확정: 연 TWR 시장 혼합(KOSPI:S&P500=50:50) 대비 +3~5%p 목표.\n· +3%p 미만 → 인덱스 ETF 위주 운용이 더 효율적일 수 있다는 신호\n· +5%p 초과 → 매우 우수, 종목 선별 운 가능성 점검' },
  sharpe: { title: '샤프 비율 (위험 효율)',
    summary: '(수익률 − 무위험수익률) ÷ 표준편차. "위험 1단위당 초과 수익."\n\n같은 +30% 수익이라도:\n· 변동성 10% → 샤프 ~3.0 (매우 우수)\n· 변동성 50% → 샤프 ~0.6 (평범)\n\n수익률만 보면 무모한 운용이 이긴다. 샤프는 "별점과 표준편차를 같이 본다."',
    threshold: '샤프 해석:\n· < 0.5: 비효율\n· 0.5~1.0: 평범\n· 1.0~2.0: 좋음\n· 2.0+: 매우 우수(장기 유지 어려움)\n\nFrank 확정: 1년 샤프 0.8~1.2 목표. 0.8 미만 → 위험 대비 효율이 시장 평균과 큰 차이 없음 → 자산배분 점검.' },
  mdd:    { title: '최대낙폭 (MDD)',
    summary: '일정 기간 최고점 대비 최저점까지의 하락폭(%). "운용의 가장 어두운 골짜기."\n\n같은 연 +10%여도:\n· MDD −10% 운용 vs MDD −50% 운용\n→ 완전히 다른 경험. 후자는 중간에 패닉 매도할 확률이 훨씬 높다.\n\n평균은 행복해 보여도 거기서 못 견디고 던지면 평균은 의미 없다. 회복 시간(months to recovery)도 함께 봐야 한다.',
    threshold: 'Frank 확정:\n· 1년 MDD −25% 이내\n· 3년 MDD −35% 이내\n· 회복 12개월 이내\n이 한계 넘으면 패닉 매도 위험↑ → 자산배분 보수화 검토.' },
};

// 5축 → 학습 모듈 metric key. 시트 적재 카드는 axis grade만 있어 지표별 📘가 안 보이므로
// axis 단위로 학습 모듈 진입 칩을 묶어 보여준다.
export const AXIS_METRICS = {
  '수익성':     ['revenue_growth', 'operating_margin', 'gross_margin', 'roe', 'roic'],
  '재무 안정성': ['debt_ratio', 'equity_ratio', 'debt_to_equity', 'net_cash', 'net_debt_ebitda', 'interest_coverage', 'current_ratio'],
  '밸류에이션':  ['fwd_per', 'trailing_per', 'ev_ebitda', 'pbr', 'peg', 'ps_ratio'],
  '현금흐름':    ['fcf_yield', 'payout_ratio', 'dividend_sustainability'],
  '모멘텀':      ['rsi', 'pos_52w', 'foreign_flow', 'sector_rs'],
};

// 항목 label → metric key (item.metric 없을 때 자동 추론용)
export const LABEL_TO_METRIC = {
  '매출성장률 yoy': 'revenue_growth', '매출성장률': 'revenue_growth',
  '영업이익률': 'operating_margin',
  '매출총이익률': 'gross_margin', 'gross margin': 'gross_margin', '매출총이익률 (gross margin)': 'gross_margin',
  'roe': 'roe', 'roe (자기자본이익률)': 'roe', '자기자본이익률': 'roe',
  'roic': 'roic', 'roic (투하자본수익률)': 'roic',
  '부채비율': 'debt_ratio',
  '자기자본비율': 'equity_ratio',
  'd/e': 'debt_to_equity', 'd/e (부채자본비율)': 'debt_to_equity', '부채자본비율': 'debt_to_equity',
  '순현금': 'net_cash',
  '순부채/ebitda': 'net_debt_ebitda',
  '이자보상배율': 'interest_coverage', '이자보상배율 (ebit/이자비용)': 'interest_coverage',
  '유동비율': 'current_ratio',
  'forward per': 'fwd_per', 'forward per 5년 밴드': 'fwd_per', 'fwd per': 'fwd_per',
  'trailing per': 'trailing_per', 'trailing per (ttm)': 'trailing_per', 'per (ttm)': 'trailing_per', 'trailing p/e': 'trailing_per',
  'ev/ebitda': 'ev_ebitda',
  'pbr': 'pbr', 'pbr (주가순자산비율)': 'pbr',
  'peg': 'peg', 'peg (per ÷ 성장률)': 'peg',
  'p/s': 'ps_ratio', 'p/s (주가매출비율)': 'ps_ratio', '주가매출비율': 'ps_ratio',
  'fcf yield': 'fcf_yield',
  '배당성향': 'payout_ratio',
  '배당지속가능성': 'dividend_sustainability', '배당지속가능성 (fcf 커버리지)': 'dividend_sustainability', '배당커버': 'dividend_sustainability',
  'rsi': 'rsi', 'rsi(14)': 'rsi', 'rsi (상대강도지수)': 'rsi',
  '52주 위치': 'pos_52w',
  '외국인·기관 수급': 'foreign_flow', '외국인 4일': 'foreign_flow', '외국인·기관': 'foreign_flow',
  '섹터 상대강도': 'sector_rs',
  'twr': 'twr', 'twr (시간가중수익률)': 'twr',
  '샤프 비율': 'sharpe', 'sharpe': 'sharpe',
  '최대낙폭': 'mdd', 'mdd': 'mdd', '최대낙폭 (mdd)': 'mdd',
};

export const SAMPLE_EVALUATION = {
  stock: { name: 'SK하이닉스', ticker: '000660', market: 'KR' },
  date: '2026-05-17',
  axes: [
    { label: '수익성', grade: '🟢', items: [
      { label: '매출성장률 YoY', value: '+47%',   source: 'OpenDart Q1',   metric: 'revenue_growth' },
      { label: '영업이익률',    value: '32.1%',  source: 'HBM 마진 견인', metric: 'operating_margin' },
      { label: 'ROIC',          value: '21.4%',  source: 'vs 동종 12%',   metric: 'roic' },
    ]},
    { label: '재무 안정성', grade: '🟢', items: [
      { label: '순부채/EBITDA', value: '0.8',   source: '양호', metric: 'net_debt_ebitda' },
      { label: '이자보상배율',  value: '11x',   source: '양호', metric: 'interest_coverage' },
      { label: '유동비율',      value: '185%',                  metric: 'current_ratio' },
    ]},
    { label: '밸류에이션', grade: '🟢', items: [
      { label: 'Forward PER',  value: '6.8x',  source: '5년 밴드 하단, 평균 12x', metric: 'fwd_per' },
      { label: 'EV/EBITDA',    value: '4.2x',                                      metric: 'ev_ebitda' },
      { label: 'PBR',          value: '1.8x',                                      metric: 'pbr' },
    ]},
    { label: '현금흐름', grade: '🟢', items: [
      { label: 'FCF yield',         value: '8.2%', source: '시장금리 4.6% 대비 우수', metric: 'fcf_yield' },
      { label: '배당성향',          value: '12%',                                       metric: 'payout_ratio' },
      { label: '배당지속가능성',    value: '✅',  source: 'FCF 8% > 배당 1%',           metric: 'dividend_sustainability' },
    ]},
    { label: '모멘텀', grade: '🟡', items: [
      { label: 'RSI(14)',        value: '58',         source: '중립',                  metric: 'rsi' },
      { label: '52주 위치',      value: '78%',        source: '상단 영역',             metric: 'pos_52w' },
      { label: '외국인 4일',     value: '−2,300억',   source: '순매도',                metric: 'foreign_flow' },
      { label: '섹터 상대강도',  value: '+4.2%',      source: '반도체 vs 코스피',      metric: 'sector_rs' },
    ]},
  ],
  conclusion: { grade: '🟢', label: '매수 적합 O' },
  reasons: [
    'HBM 사이클 구조적 수혜로 영업이익률 30%대 정착, 동종 평균 12% 대비 2.6배.',
    'Fwd PER 6.8x는 5년 밴드 하단 + FCF yield 8.2%로 채권(4.6%) 대비 매력.',
    'ROIC 21.4% 5년 추세 유효 — 자본 효율 강력.',
  ],
  risks: [
    '외국인 4거래일 순매도 −2,300억 — 단기 환율/지정학 영향 가능.',
    '미·중 반도체 규제 강화 시 중국향 매출(전체 22%) 노출.',
  ],
  actions: [
    '1회 500만원 미만 분할 매수 가능.',
    '외국인 4일 흐름이 순매수 전환 후 1차 진입 권장.',
    '52주 위치 60% 이하로 눌림 발생 시 추가 매수 트리거.',
  ],
  sources: [
    'OpenDart Q1 2026 (조회일 2026-05-17)',
    'NaverFinance 종목페이지 (조회일 2026-05-17)',
    '5/17 weekly_report 외부 변수',
  ],
};

// ── 기본 데이터 ───────────────────────────────────────────────────────────────
// 계좌 순서·표기 통일(2026-08-22 오너 확정): 위탁·연금저축·금·ISA·IRP·CMA. 객체 key
// 순서 = 화면 표시 순서(accountsFromMirror가 Object.entries(DEFAULT_ACCOUNTS)를 그
// 순서 그대로 순회해 만들고, HoldingsTab·RebalanceTab도 그 결과 객체를
// Object.entries/keys로 그대로 순회 — 여기 순서만 바꾸면 화면 전체에 자동 반영).
export const DEFAULT_ACCOUNTS = {
  위탁: {
    label: "위탁", sub: "NH · 수비형포트",
    total_invest: 0, total_eval: 0, profit: 0, color: "#52C8D4",
    assets: [
      { name: "채권",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "금",      ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "달러",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "배당주",  ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "리츠",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "국내주식", ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "해외주식", ratio: 0, invest: 0, eval: 0, target: 0 },
    ],
    holdings: [],
  },
  연금저축: {
    label: "연금저축", sub: "삼성 · 공격형포트",
    total_invest: 0, total_eval: 0, profit: 0, color: "#B07FE8",
    assets: [
      { name: "채권",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "금",      ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "달러",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "배당주",  ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "리츠",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "국내주식", ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "해외주식", ratio: 0, invest: 0, eval: 0, target: 0 },
    ],
    holdings: [],
  },
  // 2026-08-21 추가 — CMA와 동일 사유로 누락돼 있었다(금 99.99K 실물이 State/Holdings엔
  // account: "금현물"로 정확히 기록되는데, 이 목록에 키가 없어 어느 계좌 카드에도 안
  // 뜨고 있었음). 자산분배(목표비중) 계산상으로는 위탁에 합산되지만(rebalance-gap.mjs
  // normalizeAccount), 실제 매매·보유는 별도 NH 계좌(209-02-92***6)라 자기 자신의 계좌
  // 블록이 따로 있어야 한다(ARCHITECTURE-V2.md 금현물 각주). assets 목록은 위탁·연금저축과
  // 동일 7종 — 이 계좌도 같은 합산 풀(위탁+연금저축+금현물)의 목표비중을 보여준다.
  // ⚠️ 객체 key는 "금현물"로 유지(Vault State/Holdings의 account 필드·
  // rebalance-gap.mjs normalizeAccount·isa-exposure.mjs 등 내부 매칭 로직이 전부 이
  // 문자열을 그대로 쓴다 — key까지 바꾸면 그 전부를 같이 고쳐야 해서 리스크만 커짐).
  // 화면 표기만 오너 확정대로 "금"으로 통일(2026-08-22, label만 변경).
  금현물: {
    label: "금", sub: "NH · 실물자산",
    // 색상 주의: 처음엔 골드 계열(#D4A94A)을 골랐으나 이 계좌가 "금"을 담는다는 이유로
    // 화면에서 자산군 금 색상(colors.js COLORS.금 #F5C842)·SIGNAL_AMBER(#E0A000)·
    // Apollo(#B8862F)와 같은 색 군집에 바로 붙어 보여 육안 혼동 위험(코드리뷰 지적) —
    // 계좌 선택 버튼 색과 그 옆 자산군 점 색이 둘 다 금색이면 구별이 안 된다. 골드
    // 계열에서 완전히 벗어난 스틸블루로 교체.
    total_invest: 0, total_eval: 0, profit: 0, color: "#6E8FB0",
    assets: [
      { name: "채권",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "금",      ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "달러",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "배당주",  ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "리츠",    ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "국내주식", ratio: 0, invest: 0, eval: 0, target: 0 },
      { name: "해외주식", ratio: 0, invest: 0, eval: 0, target: 0 },
    ],
    holdings: [],
  },
  ISA: {
    label: "ISA", sub: "NH · 배당포트",
    total_invest: 0, total_eval: 0, profit: 0, color: "#F4845F",
    assets: [{ name: "배당주", ratio: 0, invest: 0, eval: 0, target: 0 }],
    holdings: [],
  },
  IRP: {
    label: "IRP", sub: "한투 · TDF",
    total_invest: 0, total_eval: 0, profit: 0, color: "#A8D672",
    assets: [{ name: "TDF", ratio: 0, invest: 0, eval: 0, target: 0 }],
    holdings: [],
  },
  // 2026-08-21 추가 — 이 계좌가 목록에 없어서 계좌 카드·자산분배 탭에서 완전히
  // 안 보이고 있었다(홈 화면 총계엔 이미 포함돼 있었음 — accountsFromMirror가
  // mirror.holdings.items를 이 목록으로만 순회해서 여기 없는 계좌는 그냥 버려짐).
  CMA: {
    label: "CMA", sub: "NH · 현금성",
    total_invest: 0, total_eval: 0, profit: 0, color: "#8C8577",
    assets: [{ name: "현금", ratio: 0, invest: 0, eval: 0, target: 0 }],
    holdings: [],
  },
};
