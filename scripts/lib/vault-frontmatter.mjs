// Vault 파일의 YAML frontmatter 빌더/파서 — 평평한(중첩 없는) key: value 형태 전용.
// ledger-vault-writer.mjs·job-health.mjs·proposal-vault.mjs가 전부 이 모듈 하나를
// 공유한다(2026-08-05 리팩터 — 3번째 사본이 생기기 전에 정리). 범용 YAML이 필요해지면
// (중첩 구조 등) 그때 라이브러리 도입을 검토한다 — 지금은 과설계 방지.

export function yamlValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // 문자열 배열(현재 유일한 용도는 `related:` 노트간 링크 — 2026-09-04 므네모시네
  // 대정리에서 도입) — 아래 parseFrontmatter의 배열 분기와 짝을 이뤄 왕복을 보장한다.
  // 이게 없으면 배열이 통짜 문자열로 파싱됐다가 다시 이스케이프돼 저장되면서
  // `related: "[\"[[허브]]\"]"`처럼 뭉개진다(= Obsidian이 링크로 못 읽음).
  if (Array.isArray(v)) return `[${v.map((el) => yamlValue(el)).join(', ')}]`;
  const s = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${s}"`;
}

export function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${yamlValue(v)}`);
  lines.push('---', '');
  return lines.join('\n');
}

// 기존 frontmatter 필드에 updates를 병합해 새 content를 만든다(파일 자체를 새로 쓰는 게
// 아니라 같은 파일을 갱신) — proposal-vault.mjs의 updateProposalRecord와 같은 패턴이라
// Phase 8(holdings-updater가 체결에 holdingsApplied 마킹)에서 재사용하려고 공용화했다.
export function updateFrontmatter(currentContent, updates) {
  const merged = { ...parseFrontmatter(currentContent), ...updates };
  return buildFrontmatter(merged);
}

// `["a", "b"]` 한 줄을 문자열 배열로 — 따옴표로 감싼 원소를 우선 인식하고(원소 안의
// 쉼표·대괄호를 안전하게 통과), 따옴표 없이 손으로 쓴 `[a, b]`도 관대하게 받는다.
//
// ⚠️ 2번째 이후 원소마다 따옴표가 안 벗겨지던 버그 수정(2026-09-05, vault-tags.mjs
// 다축 태그 작업 중 발견 — `tags: ["a", "b"]`을 파싱하면 두 번째 원소가 `"b"`처럼
// 따옴표를 문자 그대로 포함한 채 나왔다). 원인: 원래 정규식(`"(...)"|([^,]+)`)이
// 각 원소 사이 구분자(", ")를 매치에 포함하지 않아, 첫 원소를 매치한 뒤 `lastIndex`가
// 구분자 한가운데(쉼표 바로 뒤)에 남는다. 그 위치에서 두 alternation 둘 다 그 자리
// 시작으로는 실패하고, 정규식 엔진이 한 글자씩 밀다가 공백 위치에서 `[^,]+`(따옴표
// 없는 원소용 관대한 대안)이 먼저 매치해버려 뒤따르는 `"b"`를 따옴표째로 통째로
// 삼켜버린다 — 첫 원소만 우연히 위치 0이라 안 걸렸을 뿐, 구조적으로 3개 이상
// 원소에서도 첫 번째를 제외한 전부가 이 버그를 탄다. 두 alternation 앞에 선택적
// 구분자(`(?:,\s*)?`)를 붙여, 구분자 직후 위치에서도 따옴표 매치가 먼저 시도되게
// 고쳤다(캡처그룹 번호는 그대로 유지 — 아래 루프 로직 변경 불필요).
function parseArrayValue(raw) {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  const re = /(?:,\s*)?"((?:[^"\\]|\\.)*)"|(?:,\s*)?([^,]+)/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    if (m[1] !== undefined) items.push(m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    else if (m[2].trim()) items.push(m[2].trim());
  }
  return items;
}

// 아주 단순한 "key: value" frontmatter 파서 — buildFrontmatter의 역함수(왕복 보장).
export function parseFrontmatter(content) {
  const m = String(content ?? '').match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!mm) continue;
    const [, key, raw] = mm;
    if (raw === 'null') out[key] = null;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) out[key] = Number(raw);
    else if (raw === 'true' || raw === 'false') out[key] = raw === 'true';
    // 따옴표 없이 `[`로 시작·`]`로 끝나면 배열(yamlValue의 배열 분기가 만든 형태).
    // 문자열 값은 항상 따옴표로 감싸여 저장되므로("[중요] ..." 같은 값) 여기 안 걸린다.
    else if (raw.startsWith('[') && raw.endsWith(']')) out[key] = parseArrayValue(raw);
    else out[key] = raw.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return out;
}
