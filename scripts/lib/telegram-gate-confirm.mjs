// 텔레그램 관문 확인 대기 — 돈이 움직이는 지시(직접 주문·정정·취소·손절 재시도)를 LLM이 실행하지 않고 "접수 대기"로만
// 넘기고, 관문이 고정 문구로 다시 확인한 뒤 오너가 텍스트로 "응"이라고 답할 때만 실행하게 하는 상태(2026-10-30, 관문 2단계).
// 설계 5절 12~14행·결정 `텔레그램-관문` 8항(Q3).
//
// 불변식:
// - 확인 대기는 한 번에 1건. 새로 접수하면 이전 건은 대체된다.
// - 접수는 오너가 직접 친 텍스트 메시지(전달·음성·사진 아님)에서만 시작된다. LLM이 준 원본 message_id를 관문 수신 대기열에서
//   다시 찾아 확인한다 — LLM이 출처를 속일 수 없다.
// - 10분이 지나거나 다른 주제의 메시지가 오면 닫고 실행하지 않는다.
// - 실행 명령(request-id 포함)은 확인 대기 내용에서 코드가 만든다. 같은 원본 메시지는 request-id가 같아 다시 주문되지 않는다.
// - 2단계 관문 데몬은 가짜 실행기만 쓴다(실행 명령을 보여 주기만 함). 실제 실행 배선은 전환 전 별도 리뷰.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './state-writer.mjs';
import { foldInbox, parseInboxLines } from './telegram-gate-inbox.mjs';
import { isForwarded } from './telegram-gate-router.mjs';

export { CONFIRM_YES, CONFIRM_NO } from './telegram-gate-router.mjs';

export const CONFIRM_TTL_MS = 10 * 60 * 1000;
export const ORDER_ACTIONS = Object.freeze(['매수', '매도', '정정', '취소', '손절재시도']);

const ASSET_RE = /^[^\s\-][^\r\n]{0,39}$/u;
const CODE_RE = /^[0-9A-Z]{6}$/;
const ORDER_NO_RE = /^[0-9]{1,20}$/;
const POSITION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function positiveInt(v) { return Number.isSafeInteger(v) && v > 0; }
function positiveNumber(v) { return typeof v === 'number' && Number.isFinite(v) && v > 0; }

// 순수 함수: LLM이 넘긴 주문 내용을 검사해 정규화한다. 틀리면 이유와 함께 던진다.
export function validateOrderParams(action, params = {}) {
  if (!ORDER_ACTIONS.includes(action)) throw new Error(`지원하지 않는 확인 대기 종류: ${action}`);
  if (action === '매수' || action === '매도') {
    const asset = String(params.asset ?? '').trim();
    if (!ASSET_RE.test(asset)) throw new Error('종목명 또는 코드가 올바르지 않습니다');
    if (!positiveInt(params.quantity)) throw new Error('수량은 1 이상의 정수여야 합니다');
    if (params.price !== undefined && !positiveNumber(params.price)) throw new Error('지정가는 0보다 큰 숫자여야 합니다');
    return { asset, quantity: params.quantity, ...(params.price !== undefined ? { price: params.price } : {}) };
  }
  if (action === '정정' || action === '취소') {
    const orderNo = String(params.orderNo ?? '');
    if (!ORDER_NO_RE.test(orderNo)) throw new Error('원주문번호가 올바르지 않습니다');
    if (!['위탁', '금현물'].includes(params.account)) throw new Error('계좌는 위탁 또는 금현물');
    if (!CODE_RE.test(String(params.code ?? ''))) throw new Error('종목코드가 올바르지 않습니다');
    const name = String(params.name ?? '').trim();
    if (!ASSET_RE.test(name)) throw new Error('종목명이 올바르지 않습니다');
    if (!['매수', '매도'].includes(params.side)) throw new Error('매수·매도 구분이 필요합니다');
    if (action === '정정' && !positiveNumber(params.price)) throw new Error('정정은 가격이 필요합니다');
    return { orderNo, account: params.account, code: params.code, name, side: params.side, ...(action === '정정' ? { price: params.price } : {}) };
  }
  // 손절재시도: 포지션 하나만 지정한다(여러 포지션을 추정하지 않음).
  const hasCode = params.code !== undefined;
  const hasPosition = params.positionId !== undefined;
  if (hasCode === hasPosition) throw new Error('손절 재시도는 종목코드나 포지션 ID 중 하나만 지정합니다');
  if (hasCode && !/^[0-9]{6}$/.test(String(params.code))) throw new Error('종목코드는 6자리');
  if (hasPosition && !POSITION_ID_RE.test(String(params.positionId))) throw new Error('포지션 ID가 올바르지 않습니다');
  return hasCode ? { code: String(params.code) } : { positionId: String(params.positionId) };
}

const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;

// 순수 함수: 오너에게 다시 물을 때 보일 한 줄(코드가 만든다 — LLM 문장 아님).
export function describeOrder(action, p) {
  if (action === '매수' || action === '매도') return `${p.asset} ${p.quantity}주 ${action}(${p.price ? `지정가 ${won(p.price)}` : '현재가 지정가'})`;
  if (action === '정정') return `${p.account} ${p.name}(${p.code}) ${p.side} 원주문 ${p.orderNo} → ${won(p.price)}로 정정`;
  if (action === '취소') return `${p.account} ${p.name}(${p.code}) ${p.side} 원주문 ${p.orderNo} 취소`;
  return `돌파매매 손절주문 재시도(${p.code ? `종목 ${p.code}` : `포지션 ${p.positionId}`})`;
}

// 순수 함수: 확인된 건 → 실행할 기존 도구와 인자(입력 규칙 4-8~4-10과 같은 플래그).
export function buildOrderCommand(confirm) {
  const p = confirm.params;
  if (confirm.action === '매수' || confirm.action === '매도') {
    return { tool: 'place-nh-direct-order.mjs', args: [`--side=${confirm.action}`, `--asset=${p.asset}`, `--quantity=${p.quantity}`,
      `--request-id=telegram:${confirm.sourceChatId}:${confirm.sourceMessageId}`, ...(p.price ? [`--price=${p.price}`] : [])] };
  }
  if (confirm.action === '정정' || confirm.action === '취소') {
    return { tool: 'modify-cancel-nh-order.mjs', args: [`--action=${confirm.action}`, `--order-no=${p.orderNo}`, `--account=${p.account}`,
      `--code=${p.code}`, `--name=${p.name}`, `--side=${p.side}`, ...(p.price ? [`--price=${p.price}`] : [])] };
  }
  return { tool: 'retry-breakout-protection.mjs', args: [p.code ? `--code=${p.code}` : `--position-id=${p.positionId}`] };
}

// 순수 함수: 원본 메시지가 오너가 직접 친 텍스트이고 지금 처리 중인 대화 묶음에 들어 있는지(관문 수신 대기열 기준).
// "처리중"만 인정한다 — 대화 줄이 지금 넘긴 메시지라는 뜻이다. 예전 메시지를 끌어다 접수하지 못한다(2단계 리뷰 MEDIUM).
// activeBatch(선택): 대화 줄이 지금 넘긴 message_id 목록. 있으면 그 안의 메시지만 인정한다(main 줄 메시지 제외, 2단계 재리뷰 LOW).
export function findSourceMessage(inboxRecords, sourceMessageId, { activeBatch = null } = {}) {
  for (const item of foldInbox(inboxRecords).values()) {
    const message = item.update?.message;
    if (!message || message.message_id !== sourceMessageId) continue;
    if (item.status !== '처리중') throw new Error('지금 처리 중인 오너 메시지가 아니라 접수하지 않습니다');
    if (activeBatch && !activeBatch.includes(message.message_id)) throw new Error('지금 대화로 넘긴 메시지가 아니라 접수하지 않습니다');
    if (isForwarded(message)) throw new Error('전달된 메시지로는 주문을 접수하지 않습니다');
    if (typeof message.text !== 'string' || !message.text.trim()) throw new Error('글 메시지가 아닌 입력(음성·사진)으로는 주문을 접수하지 않습니다');
    return { chatId: String(message.chat.id), messageId: message.message_id, updateId: item.updateId, text: message.text, replyTo: message.reply_to_message?.message_id ?? null };
  }
  throw new Error('원본 메시지를 관문 수신 기록에서 찾지 못했습니다');
}

export function createConfirmStore({ stateDir, now = () => new Date() }) {
  const path = join(stateDir, 'confirm.json');
  const inboxPath = join(stateDir, 'inbox.jsonl');
  const batchPath = join(stateDir, 'llm-batch.json');
  const readBatch = () => {
    if (!existsSync(batchPath)) return null;
    try { return JSON.parse(readFileSync(batchPath, 'utf8')).messageIds ?? null; } catch { return null; }
  };
  return {
    path,
    read() {
      if (!existsSync(path)) return null;
      try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
    },
    // LLM(관문 MCP 도구)이 부른다. 검사를 통과해야만 쓴다.
    // 관문 수신 기록에서 지금 처리 중인 오너 원본 메시지를 찾는다(제안 답장 도구도 쓴다).
    source(sourceMessageId) {
      if (!Number.isSafeInteger(sourceMessageId)) throw new Error('원본 message_id가 필요합니다');
      const records = existsSync(inboxPath) ? parseInboxLines(readFileSync(inboxPath, 'utf8')) : [];
      return findSourceMessage(records, sourceMessageId, { activeBatch: readBatch() });
    },
    // 대화 줄이 실행을 시작·끝낼 때 부른다(관문 MCP 도구가 출처를 이 묶음으로 좁힌다).
    setActiveBatch(messageIds) {
      if (messageIds) writeAtomic(batchPath, `${JSON.stringify({ messageIds })}\n`);
      else { try { unlinkSync(batchPath); } catch { /* 없음 */ } }
    },
    stage({ action, params, sourceMessageId }) {
      const normalized = validateOrderParams(action, params);
      if (!Number.isSafeInteger(sourceMessageId)) throw new Error('원본 message_id가 필요합니다');
      const source = this.source(sourceMessageId);
      const createdAt = now();
      // 이미 오너에게 물은 확인 대기를 새 접수가 대체하면 그 사실을 남긴다(관문이 새 확인 질문에 함께 알린다, 2단계 재리뷰 LOW).
      const previous = this.read();
      const replaced = previous && previous.status === '대기' && previous.announced ? { id: previous.id, summary: previous.summary } : null;
      const confirm = {
        id: `CF-${randomUUID().slice(0, 8)}`,
        action,
        params: normalized,
        summary: describeOrder(action, normalized),
        sourceChatId: source.chatId,
        sourceMessageId: source.messageId,
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + CONFIRM_TTL_MS).toISOString(),
        status: '대기',
        announced: false,
        ...(replaced ? { replaced } : {}),
      };
      writeAtomic(path, `${JSON.stringify(confirm)}\n`);
      return confirm;
    },
    // id를 주면 그 건일 때만 바꾼다(실행기가 도는 동안 새 접수가 들어와도 새 건을 덮지 않게, 2단계 리뷰 MEDIUM).
    update(fields, { id = null } = {}) {
      const current = this.read();
      if (!current || (id && current.id !== id)) return null;
      const next = { ...current, ...fields };
      writeAtomic(path, `${JSON.stringify(next)}\n`);
      return next;
    },
    clear() {
      try { unlinkSync(path); } catch { /* 없음 */ }
    },
    // 대기 중이고 만료 전인 건만.
    pending(at = now()) {
      const c = this.read();
      if (!c || c.status !== '대기') return null;
      return Date.parse(c.expiresAt) > at.getTime() ? c : null;
    },
    expired(at = now()) {
      const c = this.read();
      return c && c.status === '대기' && Date.parse(c.expiresAt) <= at.getTime() ? c : null;
    },
  };
}

// 순수 함수: 이 메시지를 확인 대기의 답으로 인정할지(2단계 리뷰 HIGH-1).
// 관문이 확인 질문을 실제로 보낸 뒤(announcedAt)에 오너가 보낸 메시지만 인정한다. Telegram 메시지 시각은 초 단위라
// 질문을 보낸 그 초에 찍힌 메시지는 질문 전일 수 있어 인정하지 않는다(엄격히 뒤, 2단계 재리뷰 LOW·제우스 방향).
export function confirmOpenSinceSec(confirm) {
  return confirm?.announced && confirm.announcedAt ? Math.floor(Date.parse(confirm.announcedAt) / 1000) : null;
}

export function isAnswerToConfirm(confirm, messageDateSec) {
  if (!confirm || confirm.status !== '대기') return false;
  const since = confirmOpenSinceSec(confirm);
  return since !== null && Number.isFinite(messageDateSec) && messageDateSec > since;
}

// 순수 함수: 다시 묻는 고정 문구(가는 선, 스크립트 사실).
export function confirmPromptBody(confirm, { live }) {
  return [
    ...(confirm.replaced ? [`앞서 물은 확인(${confirm.replaced.summary})은 이 건으로 바뀌었습니다.`] : []),
    `접수할까요? ${confirm.summary}`,
    live ? '체결모드가 실전이라 "응"이면 바로 실제 주문이 나갑니다.' : '체결모드가 섀도우라 실제 주문은 나가지 않습니다.',
    '· 접수: 응 · 취소: 아니',
    '· 10분 안에 답이 없거나 다른 이야기를 하면 접수하지 않습니다.',
    '· 음성·전달 메시지로는 접수하지 않습니다.',
  ].join('\n');
}
