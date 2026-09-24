#!/usr/bin/env node
// 매 평일 아침 KIS 국내휴장일조회로 오늘의 KRX 개장 여부를 캐시한다.
// 주문·신호 잡은 이 KIS API를 반복 호출하지 않고 당일 캐시를 확인한다.
import { getKisToken, getKrHoliday, hasKisCredentials, loadKisCredentials } from '../lib/kis.mjs';
import { kstDateLabel, readKrxTradingDayStatus, writeKrxTradingDayStatus } from '../lib/krx-trading-calendar.mjs';

async function main() {
  const date = kstDateLabel();
  const cached = readKrxTradingDayStatus();
  if (cached.isOpen !== null) {
    console.log(`[캐시] ${date} KRX ${cached.isOpen ? '개장일' : '휴장일'} — KIS 일일 호출 생략`);
    return;
  }
  if (!hasKisCredentials()) throw new Error('KIS API 인증정보를 찾을 수 없어 KRX 거래일 확인 불가');
  const credentials = loadKisCredentials();
  const token = await getKisToken(credentials);
  const result = await getKrHoliday({ ...credentials, token, date });
  const record = writeKrxTradingDayStatus({ ...result, queriedAt: new Date().toISOString() });
  console.log(`[갱신] ${record.date} KRX ${record.status === 'open' ? '개장일' : '휴장일'} (KIS CTCA0903R)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('[KRX 거래일 캐시 갱신 실패]', e.message);
    process.exit(1);
  });
}
