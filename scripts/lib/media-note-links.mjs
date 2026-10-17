// D95: 녹음·통화 노트 개명이 참조하는 허용 폴더와 Obsidian 링크 변환.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { VAULT_REL } from './vault-paths.mjs';

const LINK_ROOTS = [VAULT_REL.inboxRoot, VAULT_REL.homeDir, VAULT_REL.periodicRoot,
  VAULT_REL.recordsRoot, VAULT_REL.knowledge, VAULT_REL.projectsRoot,
  VAULT_REL.outputsRoot, VAULT_REL.knowledgeMeta];
function walkMarkdown(root, rel = '') {
  const path = join(root, rel);
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walkMarkdown(root, child);
    return entry.isFile() && entry.name.endsWith('.md') ? [child] : [];
  });
}
export function linkSnapshot(root) {
  return new Map(LINK_ROOTS.flatMap((name) => walkMarkdown(root, name))
    .map((rel) => [rel, { current: readFileSync(join(root, rel), 'utf8') }]));
}
export function replaceLinks(content, oldRel, newRel) {
  const oldTarget = oldRel.replace(/\.md$/, '');
  const newTarget = newRel.replace(/\.md$/, '');
  const oldBase = basename(oldTarget);
  const newBase = basename(newTarget);
  return content.replace(/\[\[([^\]]+?)\]\]/g, (whole, inner) => {
    const separator = inner.indexOf('\\|') >= 0 ? inner.indexOf('\\|') : inner.indexOf('|');
    const target = separator < 0 ? inner : inner.slice(0, separator);
    const alias = separator < 0 ? '' : inner.slice(separator);
    const anchorAt = target.search(/[#^]/);
    const path = anchorAt < 0 ? target : target.slice(0, anchorAt);
    const anchor = anchorAt < 0 ? '' : target.slice(anchorAt);
    const key = path.replace(/\.md$/i, '').normalize('NFC').toLocaleLowerCase();
    if (key === oldTarget.normalize('NFC').toLocaleLowerCase()) return `[[${newTarget}${anchor}${alias}]]`;
    if (key === oldBase.normalize('NFC').toLocaleLowerCase()) return `[[${newBase}${anchor}${alias}]]`;
    return whole;
  });
}
export function hasSuspectLink(content, oldRel) {
  const oldBase = basename(oldRel, '.md').normalize('NFC').toLocaleLowerCase();
  const targets = [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => {
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
  });
  return targets.some((target) => target.normalize('NFC').toLocaleLowerCase().includes(oldBase));
}
