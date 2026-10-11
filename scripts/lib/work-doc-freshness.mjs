import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseFrontmatter } from './vault-frontmatter.mjs';
import { VAULT_REL } from './vault-paths.mjs';

const OPEN = new Set(['예정', '진행중', '차단됨', '보류']);
const CLOSED = new Set(['완료', '폐기']);
const WAITING_ON = new Set(['오너 판단', '시장 이벤트', '데이터 축적', '착수 대기', '외부']);
const WORK_PATH = /^40_Projects\/[^/]+\/(Implementation|Requests)\/[^/]+\.md$/;
const LOG_PATH = /^60_Logs\//;

export function isWorkDoc(rel) { return WORK_PATH.test(rel); }
export function workStatus(fields) {
  const canonical = new Set([...OPEN, ...CLOSED]);
  return canonical.has(fields.status) ? fields.status : fields.progress;
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validSince(value) {
  if (validDate(value)) return true;
  const match = typeof value === 'string' && value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(\+09:00|Z)$/);
  return Boolean(match && validDate(match[1]) && Number(match[2]) < 24 && Number(match[3]) < 60);
}

// The flat vault parser handles inline arrays; hand-written YAML lists also occur in vault notes.
export function stringArray(content, field) {
  const raw = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${field}:`));
  if (index < 0) return null;
  const inline = lines[index].slice(field.length + 1).trim();
  if (inline.startsWith('[') && inline.endsWith(']')) {
    if (/^\[\s*\]$/.test(inline)) return [];
    if (!/^\[\s*(?:"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*,\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'))*\s*\]$/.test(inline)) return null;
    return [...inline.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)]
      .map((match) => match[1] === undefined ? match[2] : match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  }
  if (inline) return null;
  const items = [];
  for (const line of lines.slice(index + 1)) {
    if (!/^\s+-\s/.test(line)) break;
    const item = line.replace(/^\s+-\s*/, '').trim();
    if (!/^(['"]).*\1$/.test(item)) return null;
    items.push(item.slice(1, -1));
  }
  return items.length ? items : null;
}

export function parseDoneWhen(value) {
  if (!Array.isArray(value)) return null;
  const conditions = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    let match = item.match(/^job-ok:([A-Za-z0-9_-]+) since:(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?:\+09:00|Z))?)$/);
    if (match && validSince(match[2])) { conditions.push({ type: 'job-ok', value: match[1], since: match[2], raw: item }); continue; }
    match = item.match(/^commit:([0-9a-fA-F]{7,40})$/);
    if (match) { conditions.push({ type: 'commit', value: match[1], raw: item }); continue; }
    match = item.match(/^file:([^/][^\r\n]*)$/);
    if (match && !match[1].split('/').some((part) => !part || part === '.' || part === '..') && !match[1].startsWith('/')) {
      conditions.push({ type: 'file', value: match[1], raw: item }); continue;
    }
    match = item.match(/^launchd:([A-Za-z0-9_.-]+)$/);
    if (match) { conditions.push({ type: 'launchd', value: match[1], raw: item }); continue; }
    return null;
  }
  return conditions;
}

function remainingItemsWithoutLinks(content) {
  let inSection = false;
  const problems = [];
  for (const line of content.split(/\r?\n/)) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      if (heading[1].length <= 3) inSection = heading[1].length >= 2 && heading[2].includes('남은 것');
      continue;
    }
    if (inSection && /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line) && !/\[\[[^\]]+\]\]/.test(line)) problems.push(line.trim());
  }
  return problems;
}

export function lintWorkDoc(root, rel, content) {
  const fields = parseFrontmatter(content);
  const problems = [];
  if (isWorkDoc(rel)) {
    const status = workStatus(fields);
    if (OPEN.has(status)) {
      if (!WAITING_ON.has(fields.waitingOn)) problems.push('작업 문서 waitingOn 없음 또는 허용값 아님');
      if (!validDate(fields.nextCheck)) problems.push('작업 문서 nextCheck 없음 또는 유효한 날짜 아님');
    }
    if (rel.includes('/Implementation/') && status === '예정') problems.push('Implementation 예정 상태 위반: 계획은 Requests에');
    if (Object.hasOwn(fields, 'supersedes')) {
      const links = stringArray(content, 'supersedes');
      if (!links || links.some((link) => !/^\[\[[^\]|#]+\]\]$/.test(link)
        || link.slice(2, -2).split('/').some((part) => !part || part === '.' || part === '..')
        || link.slice(2, -2).startsWith('/'))) problems.push('supersedes는 볼트 상대경로 링크 배열이어야 함');
      else for (const link of links) {
        const target = link.slice(2, -2).replace(/\.md$/, '');
        const path = join(root, `${target}.md`);
        if (!existsSync(path)) { problems.push(`supersedes 대상 없음: ${link}`); continue; }
        if (!realpathSync(path).startsWith(`${realpathSync(root)}${sep}`)) {
          problems.push(`supersedes 대상이 볼트 밖임: ${link}`);
          continue;
        }
        const targetFields = parseFrontmatter(readFileSync(path, 'utf8'));
        if (!CLOSED.has(workStatus(targetFields))) problems.push(`supersedes 대상 미종결: ${link}`);
      }
    }
    if (Object.hasOwn(fields, 'doneWhen') && !parseDoneWhen(stringArray(content, 'doneWhen'))) {
      problems.push('doneWhen 형식 위반: 문자열 배열과 조건 형식을 확인');
    }
  }
  if (LOG_PATH.test(rel)) {
    const createdDate = String(fields.created ?? '').slice(0, 10);
    const filenameDate = rel.split('/').pop().match(/^\d{4}-\d{2}-\d{2}/)?.[0];
    if ((validDate(createdDate) && createdDate >= '2026-10-11')
      || (validDate(filenameDate) && filenameDate >= '2026-10-11')) {
      for (const item of remainingItemsWithoutLinks(content)) problems.push(`남은 것 목록에 작업 문서 링크 없음: ${item.slice(0, 80)}`);
    }
  }
  return problems;
}

export function evaluateDoneWhen(conditions, { vaultRoot, repoPath, launchctlList = () => execFileSync('launchctl', ['list'], { encoding: 'utf8' }), git = execFileSync } = {}) {
  if (!conditions?.length) return { satisfied: false, evidence: [] };
  const evidence = conditions.map((condition) => {
    let satisfied = false;
    let detail = '확인 실패';
    try {
      if (condition.type === 'job-ok') {
        const path = join(vaultRoot, VAULT_REL.jobHealth, `${condition.value}.md`);
        const health = parseFrontmatter(readFileSync(path, 'utf8'));
        const lastRun = new Date(health.lastRun);
        // 날짜만 적은 조건은 해당 날짜의 배포 전 실행을 인정하지 않는다.
        const dateOnly = validDate(condition.since);
        const threshold = dateOnly
          ? new Date(`${condition.since}T15:00:00Z`)
          : new Date(condition.since);
        satisfied = health.status === 'OK' && !Number.isNaN(lastRun.getTime()) && lastRun >= threshold;
        const criterion = dateOnly ? `${condition.since} 다음 날 00:00 KST 이후` : `${condition.since} 이후`;
        detail = `JobHealth ${condition.value}: 상태 ${health.status ?? '없음'}, 마지막 실행 ${health.lastRun ?? '없음'} (비교 기준 ${criterion})`;
      } else if (condition.type === 'commit') {
        git('git', ['merge-base', '--is-ancestor', condition.value, 'main'], { cwd: repoPath, stdio: 'ignore' });
        satisfied = true;
        detail = `저장소 main에 ${condition.value} 커밋 포함 확인`;
      } else if (condition.type === 'file') {
        const path = join(vaultRoot, condition.value);
        satisfied = existsSync(path) && realpathSync(path).startsWith(`${realpathSync(vaultRoot)}${sep}`);
        detail = `볼트 파일 ${condition.value} 존재 확인`;
      }
      else if (condition.type === 'launchd') {
        satisfied = launchctlList().split(/\r?\n/).some((line) => line.trim().split(/\s+/).at(-1) === condition.value);
        detail = `launchctl 목록에 ${condition.value} 로드 확인`;
      }
    } catch { satisfied = false; }
    return { ...condition, satisfied, detail };
  });
  return { satisfied: evidence.every((item) => item.satisfied), evidence };
}
