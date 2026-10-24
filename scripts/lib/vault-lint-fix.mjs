// 등록부 위반의 3단 처리(2026-10-24 오너 승인, 클리오 세션) — 볼트 Requests `2026-10-24 볼트 등록부 위반 즉시 감지와 안전 자동 수정`.
// 나: 정보 손실 없는 기계적 수정만 자동(safeFixWorkDoc·autoFixVault). 다: 해석이 필요한 위반은 추천안만(suggestFixes).
// 불변식: 자동 수정은 원래 글자를 지우지 않는다(statusDetail로 옮김) · 수정 뒤 위반이 늘면 쓰지 않는다 ·
// 최근에 고친 파일(LiveSync 동시 편집 위험)은 건드리지 않는다 · 파일당 한 번에 쓴다.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertFrontmatterRoundTrip, parseFrontmatter } from './vault-frontmatter.mjs';
import { VAULT_REL } from './vault-paths.mjs';
import { agentLabel } from './agent-registry.mjs';
import { checkNote, lintVault, listVaultNotes, parseRegistry } from './vault-registry.mjs';
import { OPEN, WAITING_ON, isWorkDoc, lintWorkDoc, workStatus } from './work-doc-freshness.mjs';

export const WAITING_ON_PROBLEM = '작업 문서 waitingOn 없음 또는 허용값 아님';
export const NEXT_CHECK_PROBLEM = '작업 문서 nextCheck 없음 또는 유효한 날짜 아님';
export const MIN_AGE_MS = 30 * 60 * 1000;
// 허용값 뒤에 명시적 구분자가 올 때만 나눈다. 공백만 있으면("오너 판단 불필요…") 뜻이 뒤집힐 수 있어 추천안으로 돌린다.
const EXPLICIT_SEPARATOR = /^\s*[—–\-:·,/(]/;
const LEADING_SEPARATOR = /^\s*[—–\-:·,/]\s*/;
const NEGATION = /^(?:불필요|필요 없|아님|없음|안 ?함)/;
const UNSAFE_CHARS = /[\\\u0000-\u001f]/; // 이스케이프·제어문자는 단순 파서와 YAML의 해석이 갈린다

function kstDate(now) {
  return new Date(now).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// waitingOn 자유서술이 허용값 하나로 시작하면 { value, rest }(rest는 옮길 설명, 없으면 ''). 아니면 null.
export function splitWaitingOn(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (UNSAFE_CHARS.test(text)) return null;
  for (const value of WAITING_ON) {
    if (!text.startsWith(value)) continue;
    const tail = text.slice(value.length);
    if (tail && !EXPLICIT_SEPARATOR.test(tail)) continue; // "외부인"·"착수 대기 중"은 허용값으로 보지 않는다
    let rest = tail.trim();
    // 바깥 괄호 하나가 끝까지 감쌀 때만 벗긴다("(A) 그리고 (B)"는 그대로 둔다).
    if (/^\([^()]*\)$/.test(rest)) rest = rest.slice(1, -1).trim();
    else rest = rest.replace(LEADING_SEPARATOR, '').trim();
    if (NEGATION.test(rest)) return null;
    return { value, rest };
  }
  return null;
}

function frontmatterLines(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  return m ? { lines: m[1].split('\n'), end: m[0].length } : null;
}

// 한 줄짜리 문자열 값인지 — 여러 줄 YAML(|·>)·배열·작은따옴표·들여쓴 이어지는 줄이 있으면 손대지 않는다.
// 이어지는 줄을 놓치면 닫는 따옴표 뒤에 줄이 붙어 머리말 전체가 깨진다(리뷰 HIGH, 2026-10-24).
function singleLineString(lines, index, field) {
  if (/^\s/.test(lines[index + 1] ?? '')) return false;
  const raw = lines[index].slice(field.length + 1).trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) return !UNSAFE_CHARS.test(raw.slice(1, -1).replace(/\\"/g, ''));
  return raw !== '' && !/^[|>[\-{'"]/.test(raw) && !UNSAFE_CHARS.test(raw);
}

// 나 — 정보 손실 없는 수정. 반환: { content, changes } 또는 null(고칠 것 없음·자동으로 고칠 수 없음).
export function safeFixWorkDoc(rel, content, { today } = {}) {
  if (!isWorkDoc(rel)) return null;
  const fields = parseFrontmatter(content);
  if (!OPEN.has(workStatus(fields)) || WAITING_ON.has(fields.waitingOn)) return null;
  const split = splitWaitingOn(fields.waitingOn);
  if (!split) return null;
  const fm = frontmatterLines(content);
  if (!fm) return null;
  const lines = [...fm.lines];
  const wi = lines.findIndex((l) => l.startsWith('waitingOn:'));
  if (wi < 0 || !singleLineString(lines, wi, 'waitingOn')) return null;
  const expected = { waitingOn: split.value };
  lines[wi] = `waitingOn: ${JSON.stringify(split.value)}`;
  if (split.rest) {
    const si = lines.findIndex((l) => l.startsWith('statusDetail:'));
    if (si >= 0) {
      if (!singleLineString(lines, si, 'statusDetail')) return null;
      const joiner = /[.。!?]$/.test(split.rest) ? ' ' : '. ';
      const detail = `${split.rest}${joiner}${String(fields.statusDetail ?? '')}`.trim();
      lines[si] = `statusDetail: ${JSON.stringify(detail)}`;
      expected.statusDetail = detail;
    } else {
      lines.splice(wi + 1, 0, `statusDetail: ${JSON.stringify(split.rest)}`);
      expected.statusDetail = split.rest;
    }
  }
  const mi = lines.findIndex((l) => l.startsWith('modified:'));
  if (today && mi >= 0) { lines[mi] = `modified: ${JSON.stringify(today)}`; expected.modified = today; }
  const next = `---\n${lines.join('\n')}\n---${content.slice(fm.end)}`;
  assertFrontmatterRoundTrip(next, expected);
  return { content: next, changes: [`waitingOn "${fields.waitingOn}" → "${split.value}"${split.rest ? ' (설명은 statusDetail로)' : ''}`] };
}

// 다 — waitingOn 설명에서 허용값을 추정하는 단서(순서가 우선순위). 추천일 뿐 자동 적용하지 않는다.
const WAITING_HINTS = [
  ['오너 판단', /오너|승인|확인|결정|판단/],
  ['시장 이벤트', /시장|장 마감|금리|실적|발표/],
  ['데이터 축적', /축적|수집|관찰|비교|병행|쌓/],
  ['외부', /외부|업체|답변|배송|기관/],
  ['착수 대기', /착수|대기|뒤에?|이후|순서/],
];

function typesForPath(rel, rules) {
  return [...new Set(rules.filter((r) => r.pathRegex.test(rel)).map((r) => r.type))];
}

// 위반마다 사람이 확인할 추천안(문자열 목록). 확신이 없는 위반은 추천을 만들지 않는다.
export function suggestFixes(rel, content, problems, rules, { today } = {}) {
  const fields = parseFrontmatter(content);
  const out = [];
  for (const problem of problems) {
    if (problem === WAITING_ON_PROBLEM) {
      const text = [fields.waitingOn, fields.statusDetail].filter((v) => typeof v === 'string').join(' ');
      const split = splitWaitingOn(fields.waitingOn); // 자동 수정과 같은 답을 먼저(리뷰 M6)
      const hit = split ? [split.value] : WAITING_HINTS.find(([, re]) => re.test(text));
      out.push(hit
        ? `waitingOn "${hit[0]}"${fields.waitingOn ? ', 원래 설명은 statusDetail로' : ''}`
        : `waitingOn을 ${[...WAITING_ON].join('·')} 중 하나로`);
    } else if (problem === NEXT_CHECK_PROBLEM && today) {
      out.push(`nextCheck "${addDays(today, 7)}"(일주일 뒤)`);
    } else if (problem === 'type 없음' || problem.startsWith('type "')) {
      const types = typesForPath(rel, rules);
      if (types.length === 1) out.push(`type "${types[0]}"`);
      else if (types.length > 1) out.push(`type ${types.map((t) => `"${t}"`).join('·')} 중 하나`);
      else if (!rel.includes('/')) out.push('볼트 맨 위 노트 — 00_Inbox로 옮기거나 삭제 판단');
      else out.push('이 경로에 맞는 type이 없음 — 위치부터 확인');
    } else if (problem.startsWith('제목 형식 위반')) {
      const created = String(fields.created ?? '').slice(0, 10);
      const name = rel.split('/').pop().replace(/\.md$/, '');
      const candidate = `${created} ${name}`;
      const rule = rules.find((r) => r.type === fields.type && r.pathRegex.test(rel));
      if (/^\d{4}-\d{2}-\d{2}$/.test(created) && rule?.titleRegex?.test(candidate)) out.push(`제목 "${candidate}"`);
    }
  }
  return out;
}

export function problemsFor(root, rel, content, rules) {
  return [...checkNote(rel, content, rules), ...lintWorkDoc(root, rel, content)];
}

// 나 — 볼트 전체에서 안전 수정 대상을 고친다(야간 backup-vault). 반환: [{ rel, changes }].
// 파일 하나의 오류가 전체를 멈추지 않게 파일별로 감싼다 — 실패는 skipped로 모은다(리뷰 M3).
// 반환 배열의 skipped 속성: [{ rel, error }].
export function autoFixVault(root, { now = Date.now(), minAgeMs = MIN_AGE_MS, write = writeFileSync, dryRun = false } = {}) {
  const rules = parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const today = kstDate(now);
  const fixed = [];
  const skipped = [];
  for (const rel of listVaultNotes(root)) {
    if (!isWorkDoc(rel)) continue;
    try {
      const path = join(root, rel);
      const mtimeBefore = statSync(path).mtimeMs;
      const content = readFileSync(path, 'utf8');
      const before = problemsFor(root, rel, content, rules);
      if (!before.includes(WAITING_ON_PROBLEM)) continue;
      if (now - mtimeBefore < minAgeMs) continue; // 방금 고친 파일은 폰·태블릿 편집과 겹칠 수 있다
      const fix = safeFixWorkDoc(rel, content, { today });
      if (!fix) continue;
      const after = problemsFor(root, rel, fix.content, rules);
      if (after.includes(WAITING_ON_PROBLEM) || after.some((p) => !before.includes(p))) continue;
      if (statSync(path).mtimeMs !== mtimeBefore) continue; // 읽은 뒤 누가 고쳤으면 다음 밤으로 미룬다
      if (!dryRun) write(path, fix.content);
      fixed.push({ rel, changes: fix.changes });
    } catch (e) {
      skipped.push({ rel, error: e.message });
    }
  }
  fixed.skipped = skipped;
  return fixed;
}

// 자동 수정 내역을 클리오 월간 기록에 남긴다(그날 구역을 새로 쓴다, 파일당 한 번에 쓰기).
export function recordFixesInClioLog(root, fixed, { now = Date.now(), write = writeFileSync } = {}) {
  if (!fixed.length) return null;
  const today = kstDate(now);
  const rel = `${VAULT_REL.clioLog}/${today.slice(0, 7)}.md`;
  const path = join(root, rel);
  const start = `<!-- vault-autofix:${today}:start -->`;
  const end = `<!-- vault-autofix:${today}:end -->`;
  const newItems = fixed.map(({ rel: r, changes }) => `- [[${r.replace(/\.md$/, '')}]]: ${changes.join(' / ')}`);
  // 새 달 첫 기록이면 기존 월간 기록과 같은 머리말로 만든다(이름은 레지스트리에서).
  const id = 'clio';
  const name = agentLabel(id).split(' ').pop();
  let content = existsSync(path) ? readFileSync(path, 'utf8') : ['---', 'type: "agent-log"', `description: "${name} agent log"`,
    `created: "${today}"`, `modified: "${today}"`, `agent: "${id}"`, '---', '', `# ${today.slice(0, 7)} ${name} 기록`, ''].join('\n');
  const s = content.indexOf(start);
  const e = content.indexOf(end);
  // 같은 날 두 번째 기록(야간 잡 뒤 CLI --fix 등)은 앞 항목을 지우지 않고 덧붙인다(리뷰 M5).
  const oldItems = s >= 0 && e > s ? content.slice(s, e).split('\n').filter((l) => l.startsWith('- ')) : [];
  const items = [...new Set([...oldItems, ...newItems])];
  const section = [start, `## ${today} 등록부 위반 자동 수정`, '', ...items, end].join('\n');
  content = s >= 0 && e > s ? `${content.slice(0, s)}${section}${content.slice(e + end.length)}`
    : `${content.replace(/\n*$/, '\n\n')}${section}\n`;
  content = content.replace(/^---\n[\s\S]*?\n---/, (block) => block.replace(/^modified: .*$/m, `modified: "${today}"`));
  mkdirSync(dirname(path), { recursive: true });
  write(path, content);
  return rel;
}

// 다 — 전수 lint 결과에 위반별 추천안을 붙인다(야간 알림·lint CLI).
export function lintVaultWithSuggestions(root, { now = Date.now() } = {}) {
  const rules = parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8'));
  const today = kstDate(now);
  const { checked, results } = lintVault(root);
  return {
    checked,
    results: results.map((r) => ({ ...r, suggestions: suggestFixes(r.rel, readFileSync(join(root, r.rel), 'utf8'), r.problems, rules, { today }) })),
  };
}
