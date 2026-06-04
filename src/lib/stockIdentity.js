// 종목 식별 정규화 — 코드 우선, 이름은 NFC·공백 정규화로 변형 흡수.
// 괄호(우선주 구분 등)는 보존: 거짓 병합(삼성전자 vs 삼성전자우)을 막기 위함.
export function canonName(name) {
  return String(name ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function canonCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

// 이름 비교용: canonName 위에 공백을 완전 제거해 '삼성 전자' ↔ '삼성전자' 흡수.
function normNameForCompare(name) {
  return canonName(name).replace(/\s/g, '');
}

// 두 종목이 같은가? 코드가 양쪽 모두 있으면 코드로, 아니면 정규화 이름으로 판정.
export function sameStock(aCode, aName, bCode, bName) {
  const ac = canonCode(aCode), bc = canonCode(bCode);
  if (ac && bc) return ac === bc;
  return normNameForCompare(aName) === normNameForCompare(bName);
}
