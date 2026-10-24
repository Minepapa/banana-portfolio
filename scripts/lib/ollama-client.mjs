// 맥 미니 로컬 Ollama 호출 — 미네 기록 판단의 1차 엔진(결정 `미네-감정-분류` §1, 기억 판단 체계 §10·§15).
// 헤드리스 Claude(`headless-claude.mjs`)와 같은 자리에 끼우는 공용 모듈이다. 잡은 엔진만 바꿔 끼우고
// 기준 프롬프트·검증·노트 쓰기는 그대로 쓴다.
//
// 지키는 것:
// - 집 밖으로 보내지 않는다. 통화·녹음 전사와 미네 사진이 들어가므로 127.0.0.1/localhost만 허용한다.
//   주소를 바꿔 끼울 수는 있어도(시험용) 밖 주소면 호출 전에 막는다.
// - 같은 입력 → 같은 답. temperature 0·seed 42가 기본이고, 호출부가 덮어쓰지 못하게 마지막에 합친다.
// - 형식 실패는 따로 표시한다(`error.formatFailure`). 기억 판단 체계 §10.4의 "JSON 형식 2회 실패 → Claude"를
//   잡이 셀 수 있게 하기 위해서다. Ollama 자체가 없을 때(연결 실패·모델 없음 404·과부하 503·응답 깨짐)만
//   `error.unavailable` — 이때 잡은 그 회차를 멈추고 다음 날 이어서 한다(조용히 Claude로 넘기지 않는다).
//   시간 초과와 그 밖의 HTTP 오류는 그 기록 하나의 실패로 둔다. 한 기록 때문에 매일 회차 전체가 멈추지 않게
//   잡이 실패로 세어 보류한다(2026-10-24 리뷰).
// - 리다이렉트는 따라가지 않는다(본문이 다른 주소로 다시 보내지지 않게).
// - 답 모양은 JSON 스키마로 강제한다(필수). 2026-10-24 실측: 이미지 모델에 형식을 "json"으로만 주면 빈 `{}`를
//   돌려줘 형식 검사를 그냥 통과했다. 스키마를 주면 정상으로 답했다.
// - 두 모델을 동시에 올리지 않는다(16GB). 텍스트 → 이미지로 바꿀 때 `unloadOllamaModel`로 먼저 내린다.

export const OLLAMA_URL = 'http://127.0.0.1:11434';
// 기준 모델(2026-10-18 오너 지시: 한국어에 강한 모델, 기억 판단 체계 §10.1). 바꾸면 판단 기록의 모델 이름도 바뀐다.
export const OLLAMA_MODELS = Object.freeze({
  text: 'exaone3.5:7.8b-instruct-q8_0',
  vision: 'qwen3-vl:8b-instruct',
});
// 판단 결과가 흔들리지 않게 고정하는 값. num_ctx는 기준 요약본 + 기록 하나가 들어가는 크기(§10.1).
export const OLLAMA_FIXED_OPTIONS = Object.freeze({ temperature: 0, seed: 42 });
export const OLLAMA_DEFAULT_OPTIONS = Object.freeze({ num_ctx: 16384 });
export const OLLAMA_TIMEOUT_MS = 5 * 60_000;
// 배치 동안은 모델을 올려 둔다(첫 올리기가 10초 넘게 걸림 — 2026-10-24 실측 13초).
export const OLLAMA_KEEP_ALIVE = '10m';

// 이름(localhost)은 hosts 파일에 따라 다른 곳으로 풀릴 수 있어 주소만 허용한다.
const LOCAL_HOSTS = new Set(['127.0.0.1', '[::1]']);

export function assertLocalUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(`Ollama 주소 오류: ${url}`); }
  if (parsed.protocol !== 'http:' || !LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`Ollama는 이 맥 안(127.0.0.1)만 부른다: ${parsed.host}`);
  }
  return parsed.origin;
}

function failure(message, flags = {}) {
  return Object.assign(new Error(message), flags);
}

async function post(url, path, body, { fetchImpl, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(`${assertLocalUrl(url)}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw failure(`로컬 모델 시간 초과(${limitText(timeoutMs)})`, { timeout: true });
    if (error.message.startsWith('Ollama는 이 맥 안')) throw error;
    throw failure(`Ollama 연결 실패: ${error.message}`, { unavailable: true });
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    // 404 = 모델 없음(받기 전이거나 이름이 틀림), 503 = 과부하. 사람이 봐야 하는 일이라 회차를 멈춘다.
    throw failure(`Ollama 요청 실패 (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
      { unavailable: [404, 503].includes(response.status), status: response.status });
  }
  try { return await response.json(); } catch (error) {
    if (error.name === 'TimeoutError') throw failure(`로컬 모델 시간 초과(${limitText(timeoutMs)})`, { timeout: true });
    throw failure(`Ollama 응답 본문 오류: ${error.message}`, { unavailable: true });
  }
}

const limitText = (timeoutMs) => timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}초` : `${timeoutMs}ms`;

// 한 번 묻고 JSON 하나를 받는다. schema(JSON 스키마, 필수)로 Ollama가 그 모양으로만 답하게 강제한다.
// images는 base64 문자열 목록(이미지 모델만). 돌려주는 값: { json, text, model, usage }.
export async function runOllama({
  model, prompt, system, images, schema,
  options = {}, timeoutMs = OLLAMA_TIMEOUT_MS, keepAlive = OLLAMA_KEEP_ALIVE,
  url = OLLAMA_URL, fetchImpl = fetch, usageLogger,
} = {}) {
  if (!model || typeof model !== 'string') throw new Error('Ollama 모델 이름 없음');
  if (!prompt || typeof prompt !== 'string') throw new Error('Ollama 프롬프트 없음');
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Ollama 답 모양(JSON 스키마) 없음');
  if (images !== undefined && (!Array.isArray(images) || images.some((image) => typeof image !== 'string' || !image))) {
    throw new Error('Ollama 이미지는 base64 문자열 목록이어야 함');
  }
  const user = { role: 'user', content: prompt };
  if (images?.length) user.images = images;
  const body = {
    model, stream: false, keep_alive: keepAlive,
    format: schema,
    options: { ...OLLAMA_DEFAULT_OPTIONS, ...options, ...OLLAMA_FIXED_OPTIONS },
    messages: [...(system ? [{ role: 'system', content: system }] : []), user],
  };
  const data = await post(url, '/api/chat', body, { fetchImpl, timeoutMs });
  const text = data?.message?.content;
  const usage = {
    promptTokens: data?.prompt_eval_count ?? null, outputTokens: data?.eval_count ?? null,
    totalMs: Number.isFinite(data?.total_duration) ? Math.round(data.total_duration / 1e6) : null,
    loadMs: Number.isFinite(data?.load_duration) ? Math.round(data.load_duration / 1e6) : null,
  };
  if (usageLogger) usageLogger(`[ollama] ${model} usage ${JSON.stringify(usage)}`);
  // 출력 상한에 걸려 잘린 답은 JSON이 닫히지 않는다 — 형식 실패로 센다.
  if (data?.done_reason === 'length') throw failure('로컬 모델 답이 길이 상한에서 잘림', { formatFailure: true, text });
  if (typeof text !== 'string' || !text.trim()) throw failure('로컬 모델 빈 답', { formatFailure: true, text });
  let json;
  try { json = JSON.parse(text); }
  catch { throw failure('로컬 모델 답이 JSON이 아님', { formatFailure: true, text: text.slice(0, 300) }); }
  return { json, text, model: data.model ?? model, usage };
}

// 메모리에서 모델을 내린다(keep_alive 0). 텍스트 → 이미지로 바꿔 싣기 전에 부른다.
export async function unloadOllamaModel(model, { url = OLLAMA_URL, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  if (!model) throw new Error('Ollama 모델 이름 없음');
  await post(url, '/api/generate', { model, keep_alive: 0 }, { fetchImpl, timeoutMs });
}
