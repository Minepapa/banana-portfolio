#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { readCandidates, saveCandidates } from '../lib/place-candidates.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';

export function validPlaceName(name) {
  return typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= 80
    && !name.startsWith('.') && !/[. ]$/.test(name)
    && !/[\/:\\#|^\[\]\u0000-\u001f\u007f\u2028\u2029]/.test(name);
}
export function registerPlace({ candidate: id, name, exclude = false }, { root = VAULT_PATHS.root, dryRun = false,
  rules = parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8')), today = new Date().toISOString().slice(0, 10) } = {}) {
  const candidates = readCandidates(root);
  const candidate = candidates.find((item) => item.id === id);
  if (!candidate || !['물음', '등록중'].includes(candidate.status)) throw new Error('등록 대기 후보가 아닙니다');
  if (exclude && candidate.status === '등록중') throw new Error('등록 진행 중 후보는 제외할 수 없습니다');
  if (!exclude && !validPlaceName(name)) throw new Error('장소 이름 형식 오류');
  let path;
  let content;
  if (!exclude) {
    path = join(root, VAULT_REL.places, `${name}.md`);
    if (existsSync(path)) {
      const existing = parseFrontmatter(readFileSync(path, 'utf8'));
      if (Number(existing.lat) !== Number(candidate.lat.toFixed(5)) || Number(existing.lon) !== Number(candidate.lon.toFixed(5))) {
        throw new Error('같은 이름의 장소가 이미 있습니다');
      }
    }
    const description = candidate.address ? `${candidate.address} 근처 장소` : `${name} 장소`;
    content = buildFrontmatter({ type: 'place', category: `[[${VAULT_REL.homeDir}/100 나]]`, description,
      sensitivity: '개인', sources: [], status: '초안', model: 'place-register', created: today, modified: today,
      lat: Number(candidate.lat.toFixed(5)), lon: Number(candidate.lon.toFixed(5)), radius: 150 })
      + `# ${name}\n\n${candidate.address || '주소 미조회'} · 첫 방문 ${candidate.visits[0]} · 방문 ${candidate.visits.length}회\n`;
    const problems = checkNote(`${VAULT_REL.places}/${name}.md`, content, rules);
    if (problems.length) throw new Error(`등록부 위반: ${problems.join(' / ')}`);
  }
  if (!dryRun) {
    if (path) {
      candidate.status = '등록중';
      saveCandidates(root, candidates);
      mkdirSync(join(root, VAULT_REL.places), { recursive: true });
      if (!existsSync(path)) writeFileSync(path, content, { flag: 'wx' });
    }
    candidate.status = exclude ? '제외' : '등록';
    saveCandidates(root, candidates);
  }
  return `${id} ${exclude ? '제외' : `${name} 등록`}${dryRun ? ' (dry-run)' : ''}`;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (!process.argv.includes('--json=-')) throw new Error('--json=- 필요');
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    console.log(registerPlace(JSON.parse(input), { dryRun: process.argv.includes('--dry-run') }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
