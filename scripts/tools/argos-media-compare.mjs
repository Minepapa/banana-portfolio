// 미디어 병행 비교(결정 `아르고스-올림푸스-도입` 8항): Syncthing(Media/Inbox)과 아르고스(Media/Inbox-Argos)를
// 종류별로 대조한다. 전환(아르고스가 Inbox로 직접 넣고 Syncthing 끄기)은 "빠짐 0"이 이어질 때만 한다.
// 읽기 전용: 어떤 파일도 옮기거나 지우지 않는다.
//   node scripts/tools/argos-media-compare.mjs [--days 7] [--json]
// 비교 기준:
// - 기간은 "맥에 생긴 시각"(birthtime)으로 자른다. Syncthing은 폰의 옛 수정 시각을 그대로 두므로, 수정 시각으로
//   자르면 옮겨지거나 복원된 파일(아르고스가 놓치기 쉬운 바로 그 파일)이 비교에서 빠진다.
// - 하위 폴더까지 본다(media-archive도 Inbox를 하위 폴더까지 읽는다). 아르고스는 이름만으로 평평하게 둔다.
// - media-archive가 휴지통(Trash/{날짜}/{종류})으로 옮긴 파일도 Syncthing이 받은 것으로 센다.
// - 수정 시각이 다른 파일도 따로 센다(보관 잡이 EXIF 없는 파일의 날짜를 mtime으로 정한다).
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MEDIA_KINDS } from '../lib/argos-media.mjs';

function walk(dir, visit) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return; throw error; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile()) {
      // 비교 중에 지워지거나 바뀐 파일은 건너뛴다(한 파일 때문에 비교 전체가 죽지 않게).
      try { visit(entry.name.normalize('NFC'), lstatSync(full)); } catch { /* 경쟁 상황 */ }
    }
  }
}

function syncthingFiles(root, kind, sinceMs, bornAt) {
  const out = new Map();
  const add = (name, st) => { if (bornAt(st) >= sinceMs) out.set(name, { size: st.size, mtimeMs: st.mtimeMs }); };
  walk(join(root, 'Inbox', kind), add);
  let days = [];
  try { days = readdirSync(join(root, 'Trash')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // 날짜 폴더만(.DS_Store 같은 파일은 건너뛴다).
  for (const day of days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))) walk(join(root, 'Trash', day, kind), add);
  return out;
}

function argosFiles(root, kind) {
  const out = new Map();
  walk(join(root, 'Inbox-Argos', kind), (name, st) => out.set(name, { size: st.size, mtimeMs: st.mtimeMs }));
  return out;
}

/** bornAt: when the file appeared on the Mac (tests inject it; birthtime cannot be set on disk). */
export function compareMediaInboxes({ root = join(homedir(), 'Pantheon', 'Media'), sinceMs, bornAt = (st) => st.birthtimeMs }) {
  const report = [];
  for (const kind of MEDIA_KINDS) {
    const sync = syncthingFiles(root, kind, sinceMs, bornAt);
    const argos = argosFiles(root, kind);
    const missing = [];
    const sizeDiff = [];
    const timeDiff = [];
    // 같은 이름에 다른 바이트가 먼저 와 있으면 Syncthing 파일은 "이름 (n)"으로 저장된다: 그 사본도 본다.
    const sameBytes = (name, s) => {
      const exact = argos.get(name);
      if (exact && exact.size === s.size) return exact;
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      for (let n = 2; n < 1000; n += 1) {
        const copy = argos.get(`${stem} (${n})${ext}`);
        if (!copy) break;
        if (copy.size === s.size) return copy;
      }
      return exact;
    };
    for (const [name, s] of sync) {
      const a = sameBytes(name, s);
      if (!a) missing.push(name);
      else if (a.size !== s.size) sizeDiff.push(name);
      // 1초 안 차이는 파일 시스템 정밀도로 본다.
      else if (Math.abs(a.mtimeMs - s.mtimeMs) > 1000) timeDiff.push(name);
    }
    // "이름 (2).확장자"는 원래 이름이 아르고스에 있을 때만 충돌 사본으로 본다(진짜 이름에 (2)가 든 파일은 그대로 센다).
    const isConflictCopy = (name) => {
      const m = name.match(/^(.*) \((\d+)\)(\.[^.]+)$/);
      return Boolean(m && argos.has(`${m[1]}${m[3]}`));
    };
    const argosOnly = [...argos.keys()].filter((name) => !sync.has(name) && !isConflictCopy(name));
    report.push({ kind, syncthing: sync.size, argos: argos.size, missing, sizeDiff, timeDiff, argosOnly });
  }
  return report;
}

export function formatReport(report, days) {
  const lines = [`[미디어 병행 비교] 최근 ${days}일 (맥에 생긴 시각 기준)`];
  let gaps = 0;
  for (const r of report) {
    gaps += r.missing.length + r.sizeDiff.length + r.timeDiff.length;
    lines.push(`- ${r.kind}: Syncthing ${r.syncthing} · 아르고스 ${r.argos} · 빠짐 ${r.missing.length} · 크기 다름 ${r.sizeDiff.length} · 시각 다름 ${r.timeDiff.length} · 아르고스에만 ${r.argosOnly.length}`);
  }
  lines.push(gaps === 0 ? '결론: 빠짐 0' : `결론: 빠짐·불일치 ${gaps}건 — 전환하지 않는다`);
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const daysAt = args.indexOf('--days');
  const days = daysAt >= 0 ? Number(args[daysAt + 1]) : 7;
  if (!Number.isFinite(days) || days <= 0) { console.error('--days는 양수'); process.exit(1); }
  const report = compareMediaInboxes({ sinceMs: Date.now() - days * 86_400_000 });
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report, days));
}
