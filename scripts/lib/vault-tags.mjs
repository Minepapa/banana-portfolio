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
// ⚠️ 종목 태그의 알려진 한계 — Decisions/Proposals의 assetKey는 종목코드
// (예: "005930")와 종목명(예: "테슬라")이 혼재한다(원본 데이터 자체가 그럼).
// 코드↔이름 매핑을 이 모듈이 대신 추정하면 틀릴 위험이 있어(예: 상장폐지·
// 종목명 변경) 일부러 안 한다 — 즉 `종목/005930`(Proposals)과 `종목/삼성전자`
// (Holdings·Executions)는 같은 종목이어도 태그가 갈라져 그래프에서 안 뭉친다.
// 이건 원본 데이터의 불일치를 있는 그대로 반영한 것이지 이 모듈의 버그가 아님.

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

export function stockTag(name) {
  const seg = sanitizeTagSegment(name);
  return seg ? `종목/${seg}` : null;
}

// 세 축(계좌/자산군/종목) 중 값이 있는 것만 조합 — 레코드 타입마다 가진 필드가
// 다르므로(예: CashEvents는 종목이 없음, Proposals는 assetClass가 없음) 없는
// 축은 자연히 빠진다. 순서 고정(계좌→자산군→종목)은 임의지만, 여러 곳에서
// 같은 순서로 나오면 눈으로 훑기 편해서 유지.
export function buildVaultTags({ account, assetClass, stockName } = {}) {
  return [accountTag(account), assetClassTag(assetClass), stockTag(stockName)].filter(Boolean);
}
