// Vault 파일의 YAML frontmatter 빌더/파서 — 평평한(중첩 없는) key: value 형태 전용.
// ledger-vault-writer.mjs·job-health.mjs·proposal-vault.mjs가 전부 이 모듈 하나를
// 공유한다(2026-08-05 리팩터 — 3번째 사본이 생기기 전에 정리). 범용 YAML이 필요해지면
// (중첩 구조 등) 그때 라이브러리 도입을 검토한다 — 지금은 과설계 방지.

export function yamlValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
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
    else out[key] = raw.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return out;
}
