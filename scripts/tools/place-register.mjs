#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_PATHS, VAULT_REL } from '../lib/vault-paths.mjs';
import { readCandidates, saveCandidates } from '../lib/place-candidates.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { checkNote, parseRegistry } from '../lib/vault-registry.mjs';
import { readDayPoints, haversineM, loadPlaces, matchPlace } from '../lib/location-stays.mjs';
import { createCachedGeocoder } from '../lib/kakao-geocode.mjs';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const dayInKst = (date) => new Date(date.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
const previousDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const recentLocationError = '최근 위치가 부족함 — OwnTracks에서 업로드(↑) 후 다시 시도';

export function validPlaceName(name) {
  return typeof name === 'string' && name.trim() === name && name.length > 0 && name.length <= 80
    && !name.startsWith('.') && !/[. ]$/.test(name)
    && !/[\/:\\#|^\[\]\u0000-\u001f\u007f\u2028\u2029]/.test(name);
}
function prepareNote({ name, lat, lon, address, body, root, rules, today, allowSameCoordinates = false }) {
  const path = join(root, VAULT_REL.places, `${name}.md`);
  if (existsSync(path)) {
    const existing = parseFrontmatter(readFileSync(path, 'utf8'));
    if (!allowSameCoordinates || Number(existing.lat) !== Number(lat.toFixed(5)) || Number(existing.lon) !== Number(lon.toFixed(5))) {
      throw new Error('같은 이름의 장소가 이미 있습니다');
    }
  }
  const description = address ? `${address} 근처 장소` : `${name} 장소`;
  const content = buildFrontmatter({ type: 'place', category: `[[${VAULT_REL.homeDir}/100 나]]`, description,
    sensitivity: '개인', sources: [], status: '초안', model: 'place-register', created: today, modified: today,
    lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)), radius: 150 }) + `# ${name}\n\n${body}\n`;
  const problems = checkNote(`${VAULT_REL.places}/${name}.md`, content, rules);
  if (problems.length) throw new Error(`등록부 위반: ${problems.join(' / ')}`);
  return { path, content };
}

async function registerHere(name, { root, dryRun, rules, today, now, geocode }) {
  if (!validPlaceName(name)) throw new Error('장소 이름 형식 오류');
  const points = [previousDay(today), today].flatMap((date) => readDayPoints(date, { root }).points)
    .filter((point) => point.tst * 1000 <= now.getTime() && now.getTime() - point.tst * 1000 <= 30 * 60_000);
  if (points.length < 3 || Math.max(...points.map((point) => point.tst)) * 1000 < now.getTime() - 30 * 60_000) {
    throw new Error(recentLocationError);
  }
  const center = { lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lon: points.reduce((sum, point) => sum + point.lon, 0) / points.length };
  if (points.some((point) => haversineM(point, center) > 150)) throw new Error('이동 중이라 현재 위치를 등록할 수 없습니다');
  const registered = matchPlace(center, loadPlaces(root));
  if (registered) throw new Error(`이미 등록된 장소 근처: ${registered.name}`);

  let address = '주소 미조회';
  if (!dryRun) {
    const lookup = geocode ?? createCachedGeocoder({ root });
    try {
      const result = await lookup(center.lat, center.lon);
      address = (typeof result === 'string' ? result : result?.address) || address;
      await lookup.flush?.();
    } catch { /* 주소 조회 실패는 장소 등록을 막지 않는다. */ }
  }
  const { path, content } = prepareNote({ name, ...center, address: address === '주소 미조회' ? '' : address,
    body: `${address} · 등록 ${today}(현재 위치)`, root, rules, today });
  if (!dryRun) {
    mkdirSync(join(root, VAULT_REL.places), { recursive: true });
    writeFileSync(path, content, { flag: 'wx' });
    const candidates = readCandidates(root);
    let changed = false;
    for (const candidate of candidates) {
      if (['관찰', '물음'].includes(candidate.status) && haversineM(candidate, center) <= 150) {
        candidate.status = '등록';
        changed = true;
      }
    }
    if (changed) saveCandidates(root, candidates);
  }
  return `${name} 등록(현재 위치, 주소: ${address})${dryRun ? ' (dry-run)' : ''}`;
}

export function registerPlace({ candidate: id, here = false, name, exclude = false }, { root = VAULT_PATHS.root, dryRun = false,
  rules = parseRegistry(readFileSync(join(root, VAULT_REL.registryFile), 'utf8')), now = new Date(),
  today = dayInKst(now), geocode } = {}) {
  if (here) {
    if (id !== undefined) throw new Error('candidate와 here를 함께 사용할 수 없습니다');
    if (exclude) throw new Error('현재 위치는 제외할 수 없습니다');
    return registerHere(name, { root, dryRun, rules, today, now, geocode });
  }
  const candidates = readCandidates(root);
  const candidate = candidates.find((item) => item.id === id);
  if (!candidate || !['물음', '등록중'].includes(candidate.status)) throw new Error('등록 대기 후보가 아닙니다');
  if (exclude && candidate.status === '등록중') throw new Error('등록 진행 중 후보는 제외할 수 없습니다');
  if (!exclude && !validPlaceName(name)) throw new Error('장소 이름 형식 오류');
  let path;
  let content;
  if (!exclude) {
    ({ path, content } = prepareNote({ name, lat: candidate.lat, lon: candidate.lon, address: candidate.address,
      body: `${candidate.address || '주소 미조회'} · 첫 방문 ${candidate.visits[0]} · 방문 ${candidate.visits.length}회`,
      root, rules, today, allowSameCoordinates: true }));
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
    console.log(await registerPlace(JSON.parse(input), { dryRun: process.argv.includes('--dry-run') }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
