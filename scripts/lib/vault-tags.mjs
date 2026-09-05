import { getCodeRegistry, resolveCanonicalStockName } from './stock-registry.mjs';

// Facts/State/Decisions 레코드에 붙일 다중 축 태그 빌더(2026-09-05, 오너 지시 —
// 므네모시네 그래프 뷰에서 계좌·자산군·종목 등 여러 기준으로 노드가 실제로
// 뭉쳐 보이게 하고 싶다는 요청 반영).
//
// ⚠️ 색상 그룹(.obsidian/graph.json)이 아니라 태그를 쓰는 이유 — 이 Vault는
// Obsidian LiveSync로 Mac↔폰 동기화되는데, LiveSync 설정(`syncInternalFiles:
// false`)이 `.obsidian/` 설정 파일을 동기화 대상에서 제외한다(오너가 폰에서
// 색상 그룹이 하나도 안 보인다고 신고, 2026-09-05 확인). 반면 태그는 노트
// frontmatter에 들어가는 진짜 콘텐츠라 정상적으로 동기화되고, Obsidian 그래프
// 뷰에서 태그 노드는 실제로 노드들을 물리적으로 끌어당겨(색만 다른 게 아니라
// 진짜 뭉쳐 보임) 클러스터를 만든다 — 오너가 원한 "묶여 보여야 한다"에 색상
// 그룹보다 더 맞는 메커니즘.
//
// ⚠️ 범위: Facts/State/Decisions에만 적용(오너 명시 확인, 2026-09-05
// AskUserQuestion) — Knowledge/Log는 이미 허브·위키링크 방식으로 따로 연결돼
// 있고, 오너가 "서로 다른 것들을 억지로 연결짓지 말아달라"고 명시했다. 이
// 모듈은 그 두 카테고리를 다루는 어떤 코드에서도 import하면 안 된다.
//
// ⚠️ 종목 태그 정규화(2026-09-05, stock-registry.mjs 신설로 갱신) — Decisions/
// Proposals의 assetKey는 종목코드(예: "005930")와 종목명(예: "테슬라")이 혼재하고,
// 같은 종목도 소스마다 표기가 갈라진다(카카오 알림 장문명 vs 짧은 표시명 등).
// `종목/005930`(Proposals)과 `종목/삼성전자`(Holdings·Executions)가 태그에서
// 갈라지던 문제를 stock-registry.mjs의 resolveCanonicalStockName으로 해결 —
// State/Holdings의 ticker(code)로 안전하게(추정이 아니라 실제 code 일치로) 병합하고,
// code로도 못 잇는 이름 파편화는 stock-aliases.mjs의 수동 별칭표로 채운다. 그
// 레지스트리에도 없는 조합(예: 어디에도 이름이 함께 기록된 적 없는 순수 코드)은
// 여전히 raw 그대로 남는다 — 병합 안 해도 최소한 지금처럼 작동하는 안전한 폴백.

// Obsidian 태그 유효 문자만 남긴다(공백·괄호 등은 태그로 못 씀) — 한글·영문·
// 숫자·밑줄·하이픈만 허용, 공백은 하이픈으로. holdings-vault-writer.mjs의
// sanitizeSegment(파일명용)와 유사하지만 태그는 슬래시를 계층 구분자로 이미
// 쓰므로(예: `계좌/위탁`) 원본 값 안에 슬래시가 있으면 제거한다(파일명 규칙과
// 다른 지점).
function sanitizeTagSegment(s) {
  return String(s ?? '')
    .trim()
    .replace(/[()[\]{}]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
}

export function accountTag(account) {
  const seg = sanitizeTagSegment(account);
  return seg ? `계좌/${seg}` : null;
}

export function assetClassTag(assetClass) {
  const seg = sanitizeTagSegment(assetClass);
  return seg ? `자산군/${seg}` : null;
}

// registry 인자는 테스트 전용 주입 지점(기본값은 실제 Vault를 1회 스캔해 캐시하는
// stock-registry.mjs의 프로세스 싱글턴) — 순수 단위테스트가 실제 디스크 상태에
// 결합되지 않도록 빈 Map 등을 넘겨 격리할 수 있다.
export function stockTag(name, registry = getCodeRegistry()) {
  const seg = sanitizeTagSegment(resolveCanonicalStockName(name, registry));
  return seg ? `종목/${seg}` : null;
}

// 세 축(계좌/자산군/종목) 중 값이 있는 것만 조합 — 레코드 타입마다 가진 필드가
// 다르므로(예: CashEvents는 종목이 없음, Proposals는 assetClass가 없음) 없는
// 축은 자연히 빠진다. 순서 고정(계좌→자산군→종목)은 임의지만, 여러 곳에서
// 같은 순서로 나오면 눈으로 훑기 편해서 유지.
export function buildVaultTags({ account, assetClass, stockName } = {}, registry = getCodeRegistry()) {
  return [accountTag(account), assetClassTag(assetClass), stockTag(stockName, registry)].filter(Boolean);
}
