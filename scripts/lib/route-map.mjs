// 하루 동선 지도(D90) — OSM 타일 배경 위에 경로·머문 곳 번호 핀·축척을 그린 SVG.
// 플러그인 없이 맥·폰 Obsidian에서 보이도록 타일을 SVG 안에 base64로 넣어 한 파일로 만든다.
// 계획·그리기는 순수함수이고, 타일 받기와 파일 쓰기만 renderRouteMapFile이 한다.
// 도로 맞춤(map matching)은 하지 않는다 — 점을 시간순으로 이은 선이다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VAULT_REL } from './vault-paths.mjs';

export const MAP_WIDTH = 640;
export const MAP_HEIGHT = 480;
const TILE_SIZE = 256;
const PADDING = 48;
const MIN_ZOOM = 3;
const MAX_ZOOM = 17;
// 체류 판정과 같은 기준: 정확도가 이보다 나쁜 점은 경로에서도 뺀다.
const MAX_ACCURACY_M = 200;
const SCALE_STEPS_M = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];

export function worldPixel(lon, lat, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: ((lon + 180) / 360) * scale, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale };
}

// 동선 칸의 번호와 지도 핀 번호는 같은 함수로 매긴다. 이동 줄에는 번호가 없다.
export function circledNumber(index) {
  return index >= 1 && index <= 20 ? String.fromCodePoint(0x2460 + index - 1) : `(${index})`;
}

export function numberedPlaces(route) {
  return route.filter((entry) => entry.kind !== 'move');
}

export function routePathPoints(points, date) {
  const start = Date.parse(`${date}T00:00:00+09:00`) / 1000;
  return points.filter((point) => point.tst >= start && point.tst < start + 86_400
    && Number.isFinite(point.lat) && Number.isFinite(point.lon) && !((point.acc ?? 0) > MAX_ACCURACY_M))
    .sort((first, second) => first.tst - second.tst);
}

// 모든 점과 핀이 여백 안에 들어가는 가장 큰 확대 수준을 고른다.
export function planMap(coordinates, { width = MAP_WIDTH, height = MAP_HEIGHT } = {}) {
  if (!coordinates.length) return null;
  let zoom = MAX_ZOOM;
  for (; zoom > MIN_ZOOM; zoom -= 1) {
    const pixels = coordinates.map(({ lat, lon }) => worldPixel(lon, lat, zoom));
    const spanX = Math.max(...pixels.map((p) => p.x)) - Math.min(...pixels.map((p) => p.x));
    const spanY = Math.max(...pixels.map((p) => p.y)) - Math.min(...pixels.map((p) => p.y));
    if (spanX <= width - 2 * PADDING && spanY <= height - 2 * PADDING) break;
  }
  const pixels = coordinates.map(({ lat, lon }) => worldPixel(lon, lat, zoom));
  const centerX = (Math.max(...pixels.map((p) => p.x)) + Math.min(...pixels.map((p) => p.x))) / 2;
  const centerY = (Math.max(...pixels.map((p) => p.y)) + Math.min(...pixels.map((p) => p.y))) / 2;
  const originX = centerX - width / 2;
  const originY = centerY - height / 2;
  const tiles = [];
  const limit = 2 ** zoom;
  for (let y = Math.floor(originY / TILE_SIZE); y <= Math.floor((originY + height - 1) / TILE_SIZE); y += 1) {
    if (y < 0 || y >= limit) continue;
    for (let x = Math.floor(originX / TILE_SIZE); x <= Math.floor((originX + width - 1) / TILE_SIZE); x += 1) {
      tiles.push({ z: zoom, x: ((x % limit) + limit) % limit, y, left: x * TILE_SIZE - originX, top: y * TILE_SIZE - originY });
    }
  }
  return { zoom, originX, originY, width, height, tiles };
}

function scaleBar(plan, latitude) {
  const metersPerPixel = (156_543.033_92 * Math.cos((latitude * Math.PI) / 180)) / 2 ** plan.zoom;
  const meters = [...SCALE_STEPS_M].reverse().find((step) => step / metersPerPixel <= 120) ?? SCALE_STEPS_M[0];
  return { pixels: meters / metersPerPixel, label: meters >= 1000 ? `${meters / 1000}km` : `${meters}m` };
}

const fixed = (value) => Number(value.toFixed(1));
// 핀 지름(22px)보다 가까우면 한 핀으로 합친다. 집에서 나갔다 돌아온 하루는 ①과 마지막 번호가 같은 자리에 겹친다.
const PIN_MERGE_PX = 22;

export function groupPins(pixels) {
  const pins = [];
  pixels.forEach((pixel, index) => {
    const near = pins.find((pin) => Math.hypot(pin.x - pixel.x, pin.y - pixel.y) < PIN_MERGE_PX);
    if (near) near.numbers.push(index + 1);
    else pins.push({ x: pixel.x, y: pixel.y, numbers: [index + 1] });
  });
  return pins;
}

// tileImages: 'z/x/y' → PNG Buffer 또는 null. 없는 칸은 회색 바탕으로 둔다.
export function renderMapSvg(plan, { pathPoints, places, tileImages = new Map() }) {
  const local = ({ lat, lon }) => {
    const pixel = worldPixel(lon, lat, plan.zoom);
    return { x: fixed(pixel.x - plan.originX), y: fixed(pixel.y - plan.originY) };
  };
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${plan.width}" height="${plan.height}" viewBox="0 0 ${plan.width} ${plan.height}">`,
    `<rect width="${plan.width}" height="${plan.height}" fill="#e5e3df"/>`];
  for (const tile of plan.tiles) {
    const image = tileImages.get(`${tile.z}/${tile.x}/${tile.y}`);
    if (image) parts.push(`<image x="${fixed(tile.left)}" y="${fixed(tile.top)}" width="${TILE_SIZE}" height="${TILE_SIZE}" href="data:image/png;base64,${image.toString('base64')}"/>`);
  }
  if (pathPoints.length > 1) {
    const line = pathPoints.map(local).map(({ x, y }) => `${x},${y}`).join(' ');
    parts.push(`<polyline points="${line}" fill="none" stroke="#ffffff" stroke-width="7" stroke-linejoin="round" stroke-linecap="round" opacity="0.8"/>`,
      `<polyline points="${line}" fill="none" stroke="#1a73e8" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  for (const pin of groupPins(places.map(local))) {
    const label = pin.numbers.join('·');
    // 숫자 하나는 원, 여럿(같은 곳에 다시 온 경우)은 글자 수만큼 넓힌 둥근 사각형.
    const halfWidth = Math.max(11, label.length * 3.6 + 5);
    parts.push(`<rect x="${fixed(pin.x - halfWidth)}" y="${fixed(pin.y - 11)}" width="${fixed(halfWidth * 2)}" height="22" rx="11" fill="#d93025" stroke="#ffffff" stroke-width="2"/>`,
      `<text x="${pin.x}" y="${fixed(pin.y + 4)}" font-family="sans-serif" font-size="12" font-weight="bold" fill="#ffffff" text-anchor="middle">${label}</text>`);
  }
  const anchor = places[0] ?? pathPoints[0];
  const bar = scaleBar(plan, anchor.lat);
  const barY = plan.height - 18;
  parts.push(`<rect x="8" y="${barY - 16}" width="${fixed(bar.pixels + 16)}" height="26" fill="#ffffff" opacity="0.8"/>`,
    `<path d="M16 ${barY} h${fixed(bar.pixels)}" stroke="#202124" stroke-width="2"/>`,
    `<path d="M16 ${barY - 5} v5 M${fixed(16 + bar.pixels)} ${barY - 5} v5" stroke="#202124" stroke-width="2"/>`,
    `<text x="16" y="${barY - 6}" font-family="sans-serif" font-size="11" fill="#202124">${bar.label}</text>`,
    `<rect x="${plan.width - 176}" y="${plan.height - 18}" width="176" height="18" fill="#ffffff" opacity="0.8"/>`,
    `<text x="${plan.width - 6}" y="${plan.height - 5}" font-family="sans-serif" font-size="11" fill="#202124" text-anchor="end">© OpenStreetMap contributors</text>`,
    '</svg>');
  return `${parts.join('\n')}\n`;
}

export const routeMapRel = (date) => `${VAULT_REL.locationMaps}/${date.slice(0, 4)}/${date}.svg`;

// 지도를 그려 저장하고 { rel, missingTiles }를 돌려준다. 그릴 것이 없으면 null.
// 같은 내용이면 다시 쓰지 않는다(LiveSync가 같은 파일의 연속 쓰기를 섞지 않게, 재계산이 겹쳐도 한 번만).
export async function renderRouteMapFile({ date, route, points, root, fetcher, write }) {
  if (!Array.isArray(route) || !route.length) return null;
  const pathPoints = routePathPoints(points, date);
  const places = numberedPlaces(route).filter((place) => Number.isFinite(place.lat) && Number.isFinite(place.lon));
  const plan = planMap([...pathPoints, ...places]);
  if (!plan) return null;
  const tileImages = new Map();
  for (const tile of plan.tiles) tileImages.set(`${tile.z}/${tile.x}/${tile.y}`, await fetcher.get(tile));
  const missingTiles = [...tileImages.values()].filter((image) => !image).length;
  const rel = routeMapRel(date);
  const path = join(root, rel);
  const svg = renderMapSvg(plan, { pathPoints, places, tileImages });
  if (!existsSync(path) || readFileSync(path, 'utf8') !== svg) {
    mkdirSync(dirname(path), { recursive: true });
    write(path, svg);
  }
  return { rel, missingTiles };
}
