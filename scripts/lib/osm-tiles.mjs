// OpenStreetMap 타일 받기(D90 동선 지도 배경). 타일 이용 정책을 지킨다:
// - 식별 가능한 User-Agent(저장소 주소), 순차 요청(병렬 없음), 실행당 받기 상한, 받은 타일은 맥미니에 캐시해 다시 받지 않는다.
// - 보내는 것은 타일 번호(z/x/y)뿐이다. 경로 좌표 자체는 외부로 나가지 않는다.
// 무인 잡 안에서 돌므로 느린 서버가 데일리 노트를 붙잡지 않게 한다: 요청마다 시간 제한을 두고,
// 한 번 실패하면 그 실행에서는 더 받지 않는다(남은 칸은 회색으로 두고 다음 실행에서 다시 그린다).
// 캐시는 다시 받을 수 있는 파일이라 볼트·저장소 밖(~/.cache)에 둔다.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const TILE_URL = 'https://tile.openstreetmap.org';
export const TILE_USER_AGENT = 'banana-portfolio-v2 daily-route-map (personal, low volume, cached; https://github.com/Minepapa/banana-portfolio)';
export const DEFAULT_TILE_CACHE = join(homedir(), '.cache', 'banana-portfolio-v2', 'osm-tiles');
// 하루 지도 한 장은 최대 4×3=12칸이다. 넉넉히 두 장 분량까지만 한 번에 받는다.
export const MAX_DOWNLOADS_PER_RUN = 24;
export const TILE_TIMEOUT_MS = 10_000;
// 지도 배경이 계속 옛 모습으로 남지 않게 반년 지난 타일은 다시 받는다(받기 실패하면 옛 타일을 쓴다).
export const TILE_REFRESH_MS = 180 * 86_400_000;

const validTile = ({ z, x, y }) => [z, x, y].every(Number.isInteger) && z >= 0 && z <= 19
  && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;

export function createTileFetcher({ cacheDir = DEFAULT_TILE_CACHE, fetchImpl = globalThis.fetch,
  maxDownloads = MAX_DOWNLOADS_PER_RUN, timeoutMs = TILE_TIMEOUT_MS, now = Date.now } = {}) {
  let downloads = 0;
  let failures = 0;
  let broken = false;
  return {
    // 캐시 → 없으면 받기. 실패·상한 초과·차단 상태는 null(지도는 그 칸만 비운 채 그린다).
    async get(tile) {
      if (!validTile(tile)) return null;
      const path = join(cacheDir, String(tile.z), String(tile.x), `${tile.y}.png`);
      const cached = existsSync(path) ? readFileSync(path) : null;
      if (cached && now() - statSync(path).mtimeMs < TILE_REFRESH_MS) return cached;
      if (broken || downloads >= maxDownloads) return cached;
      downloads += 1;
      try {
        const response = await fetchImpl(`${TILE_URL}/${tile.z}/${tile.x}/${tile.y}.png`,
          { headers: { 'User-Agent': TILE_USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer());
        // PNG 서명이 아니면 캐시에 남기지 않는다(오류 페이지가 영구 타일이 되지 않게).
        if (body.length < 8 || body.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, body);
        renameSync(temporary, path);
        return body;
      } catch {
        failures += 1;
        broken = true;
        return cached;
      }
    },
    downloadCount: () => downloads,
    failureCount: () => failures,
  };
}
