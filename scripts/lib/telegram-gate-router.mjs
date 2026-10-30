// 텔레그램 관문 라우터 — 받은 메시지 하나를 "어떤 처리기로 보낼지"만 정하는 순수 함수(2026-10-30, 관문 1단계).
// 처리 순서의 정본은 볼트 90_Delphi/Channels/텔레그램 입력 규칙 1절이고, 관문용 표는 설계 문서 5절이다.
// 원칙:
// - 해석 로직을 새로 만들지 않는다. 스위치·담당 호출·위키 답은 기존 파서(telegram-messages·wiki-question-queue)를 쓴다.
// - 정확히 맞는 입력만 결정론 처리로 보낸다. 조금이라도 다르면 대화(llm)로 넘긴다 — 잘못 실행하는 것보다 묻는 게 낫다.
// - 전달된 메시지(forward)·사진 캡션 속 글자는 명령으로 보지 않는다(설계 10-3, 프롬프트 인젝션 경계).
// - 허용 사용자(allowFrom)의 개인 채팅이 아니면 버린다. 그룹·채널·짝짓기 흐름은 없다.
// 1단계에서 LLM이 필요한 입력(자유 문장·담당 호출·기호 없는 사진·제안 승인·직접 주문)은 route 'llm'으로만 표시한다.
import { parseExecutionModeCommand, parseKillSwitchCommand, parseProposalModeCommand, parseDepartmentCall } from './telegram-messages.mjs';
import { parseExplicitWikiAnswers } from './wiki-question-queue.mjs';

const MEMO = '📜';
const PHOTO_MEMO = '📎';
const ONE_LINE = '🪶';
const WQ_LINE_RE = /^WQ-\d{8}-[0-9a-f]{8}\s+\S.{0,19}$/iu;
const EXEC_CONFIRM_RE = /^체결확인\s+(EC-\d{8}-[A-F0-9]+)\s+(\S+)$/u;
const PLACE_CANDIDATE_RE = /^장소\s+(C\d+)\s+(.+)$/u;
const PLACE_HERE_RE = /^지금\s*여기가\s+(.+?)(?:이야|야|이에요|예요|에요)[.!]?$/u;

export function isForwarded(message) {
  return Boolean(message?.forward_origin || message?.forward_from || message?.forward_from_chat || message?.forward_sender_name || message?.forward_date);
}

// 기호가 맨 앞에 있을 때만 인정하고, 기호와 바로 뒤 공백만 뗀다(입력 규칙 2절). 이모지 변형 선택자(U+FE0F)도 함께 뗀다.
export function stripLeadingSymbol(text, symbol) {
  const t = String(text ?? '');
  if (!t.startsWith(symbol)) return null;
  return t.slice(symbol.length).replace(/^️/, '').replace(/^\s+/, '');
}

function isWikiAnswerOnly(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => WQ_LINE_RE.test(l)) && parseExplicitWikiAnswers(text).length === lines.length;
}

// 처리 줄: 음성·사진은 내려받기·전사로 오래 걸릴 수 있어 따로 처리해 스위치·상태가 그 뒤에 묶이지 않게 한다(1단계 리뷰 HIGH).
export const MEDIA_ROUTES = new Set(['voice', 'photoMemo']);
export function laneOf(decision) {
  return decision.action === 'handle' && MEDIA_ROUTES.has(decision.route) ? 'media' : 'main';
}

// 허용 사용자의 개인 채팅이 아니면 원문을 대기열에 남기지 않는다(설계 10-1). update_id만 남겨 중복 제거·offset에 쓴다.
export function sanitizeUpdate(update, { allowFrom }) {
  const message = update?.message;
  const allowed = message && message.chat?.type === 'private' && message.from?.id !== undefined && allowFrom.has(String(message.from.id));
  return allowed ? update : { update_id: update?.update_id, dropped: true };
}

// update → { action: 'drop', reason } | { action: 'handle', route, args, meta }
export function routeUpdate(update, { allowFrom }) {
  const message = update?.message;
  if (!message) return { action: 'drop', reason: '메시지 아닌 업데이트' };
  if (message.chat?.type !== 'private') return { action: 'drop', reason: '개인 채팅 아님' };
  const fromId = message.from?.id;
  if (fromId === undefined || !allowFrom.has(String(fromId))) return { action: 'drop', reason: '허용 사용자 아님' };

  const meta = {
    chatId: String(message.chat.id),
    messageId: message.message_id,
    date: message.date,
    replyTo: message.reply_to_message?.message_id ?? null,
    forwarded: isForwarded(message),
  };
  const text = typeof message.text === 'string' ? message.text : '';
  const caption = typeof message.caption === 'string' ? message.caption : '';
  const photo = Array.isArray(message.photo) && message.photo.length ? message.photo.at(-1) : null;
  const voice = message.voice ?? null;
  const handle = (route, args = {}) => ({ action: 'handle', route, args, meta });

  if (meta.forwarded) return handle('llm', { kind: 'forwarded', text: text || caption });

  if (voice) return handle('voice', { fileId: voice.file_id, fileSize: voice.file_size ?? null, duration: voice.duration ?? null, caption });

  if (photo) {
    // 📜·📎 + 사진 = 사진 메모(📜는 글 전용이라 사진이 붙으면 📎로 처리, 입력 규칙 2절).
    const memoText = stripLeadingSymbol(caption, PHOTO_MEMO) ?? stripLeadingSymbol(caption, MEMO);
    if (memoText !== null) return handle('photoMemo', { fileId: photo.file_id, fileSize: photo.file_size ?? null, text: memoText });
    return handle('llm', { kind: 'photo', fileId: photo.file_id, caption });
  }

  if (!text) return handle('llm', { kind: 'other', text: caption });
  const trimmed = text.trim();

  if (trimmed === '상태') return handle('status');
  if (trimmed === '취소') return handle('cancel', { all: false });
  if (trimmed === '취소 전부') return handle('cancel', { all: true });
  if (trimmed === '안녕') return handle('greeting');

  // risky: 늦게 실행되면 위험해지는 방향(브레이크를 푸는 쪽). 이 방향만 오래된 명령을 다시 묻는다.
  // 킬스위치 온·체결모드 오프·제안모드 오프는 늦게라도 실행하는 편이 안전하다(2026-10-30 1단계 리뷰 HIGH).
  const kill = parseKillSwitchCommand(trimmed);
  if (kill) return handle('switch', { tool: 'kill-switch-cli.mjs', text: trimmed, risky: kill === 'deactivate' });
  const execMode = parseExecutionModeCommand(trimmed);
  if (execMode) return handle('switch', { tool: 'execution-mode-cli.mjs', text: trimmed, live: execMode === 'live', risky: execMode === 'live' });
  const proposalMode = parseProposalModeCommand(trimmed);
  if (proposalMode) return handle('switch', { tool: 'proposal-mode-cli.mjs', text: trimmed, risky: proposalMode === 'allowed' });

  const memo = stripLeadingSymbol(text, MEMO);
  if (memo !== null) return memo.trim() ? handle('memo', { text: memo }) : handle('llm', { kind: 'text', text });
  const photoMemoWithoutPhoto = stripLeadingSymbol(text, PHOTO_MEMO);
  if (photoMemoWithoutPhoto !== null) return photoMemoWithoutPhoto.trim() ? handle('memo', { text: photoMemoWithoutPhoto }) : handle('llm', { kind: 'text', text });
  const oneLine = stripLeadingSymbol(text, ONE_LINE);
  if (oneLine !== null) return oneLine.trim() ? handle('oneLine', { text: oneLine }) : handle('llm', { kind: 'text', text });

  if (isWikiAnswerOnly(trimmed)) return handle('wiki', { answers: parseExplicitWikiAnswers(trimmed) });

  const exec = trimmed.match(EXEC_CONFIRM_RE);
  if (exec) return handle('execConfirm', { id: exec[1], account: exec[2] });

  const place = trimmed.match(PLACE_CANDIDATE_RE);
  if (place) {
    const name = place[2].trim();
    return handle('place', name === '제외' ? { candidate: place[1], exclude: true } : { candidate: place[1], name });
  }
  const here = trimmed.match(PLACE_HERE_RE);
  if (here && here[1].trim()) return handle('place', { here: true, name: here[1].trim() });

  const department = parseDepartmentCall(trimmed);
  return handle('llm', { kind: 'text', text, department: department?.department ?? null });
}
