// 텔레그램 창구 전용 조회 도구(속도 개선 2차 B-6) — 소비·동선·통화·사진을 Node로 찾아 짧은 요약 줄로 돌려준다.
// 11-06 실측: 담당이 결제·기록을 Grep으로 넓게 훑느라 1~2분(미용실 109초). 정해진 정본만 읽어 몇 초 안에 끝낸다.
//
// 지키는 것:
// - 읽기만 한다. 볼트 상수(VAULT_REL·VAULT_PATHS) 경로만 쓴다. 금고는 보지 않는다(정본 폴더가 금고 밖).
// - 기간은 한도가 있다(소비 366일·동선 62일·통화·사진 366일). 결과는 최대 limit줄(기본 15, 최대 40)로 자르고 몇 건 더 있는지 적는다.
// - 데이터가 없으면 없다고 쓴다(추측 금지).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VAULT_PATHS, VAULT_REL, vaultAbs } from './vault-paths.mjs';
import { kstDate, nextDates } from './calendar-days.mjs';
import { spendingSummaryPath } from './spending-daily.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const won = (n) => `${Math.round(Math.abs(Number(n) || 0)).toLocaleString('ko-KR')}원`;
const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

// 순수 함수: 기간 검사·기본값(to=오늘, from=to-기본일수). 한도를 넘으면 오류.
export function searchRange({ from, to }, { now = new Date(), defaultDays, maxDays }) {
  const end = to ?? kstDate(now);
  const start = from ?? new Date(Date.parse(`${end}T00:00:00Z`) - (defaultDays - 1) * 86_400_000).toISOString().slice(0, 10);
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) throw new Error('from·to는 YYYY-MM-DD');
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days < 1) throw new Error('to가 from보다 앞입니다');
  if (days > maxDays) throw new Error(`한 번에 ${maxDays}일까지`);
  return { from: start, to: end, days };
}

function clip(lines, limit = 15) {
  const n = Math.min(Math.max(Number(limit) || 15, 1), 40);
  return lines.length > n ? [...lines.slice(0, n), `… 외 ${lines.length - n}건`] : lines;
}

function readJson(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; }
}

// 소비: 하루 소비 요약(알림 수집분) + 뱅크샐러드 분류 보고서(내보낸 기간). 가게 이름·분류에 query가 들어간 지출을 최근 순으로.
export function spendingSearch({ query = '', from, to, minAmount, limit } = {}, { now = new Date(), readSummary = (d) => readJson(spendingSummaryPath(d)),
  banksaladReports = defaultBanksaladReports } = {}) {
  const range = searchRange({ from, to }, { now, defaultDays: 365, maxDays: 366 });
  const q = norm(query);
  const min = Number(minAmount) || 0;
  const rows = new Map(); // 날짜+가게+금액 → 한 줄(알림·뱅크샐러드 중복을 합친다)
  const add = (date, time, merchant, amount, source) => {
    if (date < range.from || date > range.to) return;
    if (q && !norm(merchant).includes(q)) return;
    if (Math.abs(amount) < min) return;
    const key = `${date}|${norm(merchant)}|${Math.abs(amount)}`;
    if (!rows.has(key)) rows.set(key, { date, time: time ?? '', text: `${date}${time ? ` ${time}` : ''} ${won(amount)} ${merchant}`, sources: new Set() });
    rows.get(key).sources.add(source);
  };
  for (const date of nextDates(range.from, range.days)) {
    const s = readSummary(date);
    for (const e of s?.entries ?? []) {
      if (e.status !== 'expense') continue;
      const at = Date.parse(e.at ?? '');
      add(date, Number.isFinite(at) ? new Date(at + 9 * 3_600_000).toISOString().slice(11, 16) : '', `${e.merchant ?? e.category ?? '?'}`, e.amount, '알림');
    }
  }
  for (const report of banksaladReports()) {
    for (const t of report.transactions ?? []) {
      if (Number(t.signed_amount) >= 0) continue; // 지출만(음수)
      const label = [t.description, t.original_subcategory].filter(Boolean).join(' · ');
      add(String(t.date ?? '').slice(0, 10), String(t.time ?? '').slice(0, 5), label, t.signed_amount, '뱅크샐러드');
    }
  }
  const lines = [...rows.values()].sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`))
    .map((r) => `${r.text} (${[...r.sources].join('·')})`);
  const head = `소비 검색 ${range.from}~${range.to}${query ? ` "${query}"` : ''}: ${lines.length}건`;
  return [head, ...(lines.length ? clip(lines, limit) : ['찾은 지출 없음(알림 수집은 2026-10 이후, 그 전은 뱅크샐러드 보고서 기간만)'])].join('\n');
}

function defaultBanksaladReports() {
  const dir = VAULT_PATHS.spending ? join(VAULT_PATHS.spending, 'Banksalad') : vaultAbs(`${VAULT_REL.spending}/Banksalad`);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => readJson(join(dir, name, 'classified-report.json'))).filter(Boolean);
}

// 동선: 하루 동선 파일(머문 곳). 장소 이름·표시에 query가 들어간 체류를 최근 순으로.
export function locationSearch({ query = '', from, to, limit } = {}, { now = new Date(), readDay = (d) => readJson(join(vaultAbs(VAULT_REL.locationDays), d.slice(0, 4), `${d}.json`)) } = {}) {
  const range = searchRange({ from, to }, { now, defaultDays: 30, maxDays: 62 });
  const q = norm(query);
  const lines = [];
  let missing = 0;
  for (const date of nextDates(range.from, range.days).reverse()) {
    const day = readDay(date);
    if (!day) { missing += 1; continue; }
    for (const e of day.entries ?? []) {
      if (e.kind && e.kind !== 'stay') continue;
      const name = e.placeName || e.label || '';
      if (q && !norm(name).includes(q)) continue;
      lines.push(`${date} ${e.start ?? '?'}~${e.end ?? '?'} ${name || '(이름 없는 곳)'}${e.minutes ? ` ${e.minutes}분` : ''}`);
    }
  }
  const head = `동선 검색 ${range.from}~${range.to}${query ? ` "${query}"` : ''}: ${lines.length}건${missing ? `(동선 파일 없는 날 ${missing}일)` : ''}`;
  return [head, ...(lines.length ? clip(lines, limit) : ['찾은 체류 없음'])].join('\n');
}

// 날짜 노트 폴더({YYYY}/YYYY-MM-DD 제목.md)에서 기간·query로 찾는다. 제목·설명·사람에 더해 본문에서도 찾고, 본문에서만 맞으면
// 맞은 줄 앞뒤를 짧게 붙인다(11-06 재측정: 제목만 보면 "미네 좋아하는 노래"를 못 찾음). 통화·녹음 전사·사진 순간·기록 노트.
function noteSearch(rel, { query = '', from, to, limit } = {}, { now, listNotes, label }) {
  const range = searchRange({ from, to }, { now, defaultDays: 90, maxDays: 366 });
  const q = norm(query);
  const lines = [];
  for (const { date, title, front, body } of listNotes(rel, range)) {
    const people = Array.isArray(front.people) ? front.people.join(' ') : String(front.people ?? '');
    const hay = norm(`${title} ${front.description ?? ''} ${people}`);
    let snippet = '';
    if (q && !hay.includes(q)) {
      const bodyLine = String(body ?? '').split('\n').find((l) => norm(l).includes(q));
      if (!bodyLine) continue;
      snippet = ` [본문: ${bodyLine.trim().slice(0, 80)}]`;
    }
    lines.push(`${date} ${title}${front.description ? ` — ${String(front.description).slice(0, 80)}` : ''}${snippet}`);
  }
  lines.sort((a, b) => b.localeCompare(a));
  const head = `${label} ${range.from}~${range.to}${query ? ` "${query}"` : ''}: ${lines.length}건`;
  return [head, ...(lines.length ? clip(lines, limit) : [`찾은 ${label} 없음`])].join('\n');
}

function defaultListNotes(rel, range) {
  const out = [];
  for (let year = Number(range.from.slice(0, 4)); year <= Number(range.to.slice(0, 4)); year += 1) {
    const dir = join(vaultAbs(rel), String(year));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const m = name.match(/^(\d{4}-\d{2}-\d{2}) (.+)\.md$/);
      if (!m || m[1] < range.from || m[1] > range.to) continue;
      let front = {};
      let body = '';
      try {
        const text = readFileSync(join(dir, name), 'utf8');
        front = parseFrontmatter(text) ?? {};
        body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
      } catch { /* 읽기 실패 노트는 건너뛴다 */ }
      out.push({ date: m[1], title: m[2], front, body });
    }
  }
  return out;
}

export function callSearch(args = {}, { now = new Date(), listNotes = defaultListNotes } = {}) {
  return noteSearch(VAULT_REL.mediaConversations, args, { now, listNotes, label: '통화·녹음' });
}

export function mediaSearch(args = {}, { now = new Date(), listNotes = defaultListNotes } = {}) {
  return noteSearch(VAULT_REL.mediaMoments, args, { now, listNotes, label: '사진·영상 순간' });
}

// 기록 노트(20_Records/21_Notes — 📜 메모·오너 기록): 미네·가족 일화 같은 질문의 1차 출처.
export function recordSearch(args = {}, { now = new Date(), listNotes = defaultListNotes } = {}) {
  return noteSearch(VAULT_REL.recordsNotes, args, { now, listNotes, label: '기록 노트' });
}
