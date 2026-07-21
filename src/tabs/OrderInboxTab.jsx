// 주문 탭(주문함): order-proposals 잡이 만든 "완성된 주문서"를 승인/기각/보류.
// 승인 = 실행 대기(증권사 앱에 그대로 입력) → parse-notifications가 체결 매칭해 실행완료.
// 상태 문자열·컬럼(K상태 L응답 M기각사유)은 scripts/lib/sheet-contracts.mjs PROPOSAL_* 계약.
// 승인/기각은 PreferenceTab 패턴(writeRange → fetch) — K:M 한 번에 써서 부분쓰기 방지.
import { useState } from 'react';
import { SectionTitle, DeptBadge } from '../lib/primitives.jsx';
import { PROFIT_POS, PROFIT_NEG } from '../lib/colors.js';
import { MONO } from '../lib/theme.js';

const SRC_COLOR = { '리밸런싱': '#141414', '급락O': '#E5484D', '논리훼손B': '#E0A000', '평가🟢': '#159E52', '회전': '#7C5CBF' };

export default function OrderInboxTab({ proposals, accounts, sheets, fmt, baseFont }) {
  const [busy, setBusy] = useState(null);          // rowNum 처리 중
  const [rejecting, setRejecting] = useState(null); // rowNum 기각사유 입력 중
  const [reason, setReason] = useState('');

  const pending = proposals.filter(p => p.status === '제안');
  const approved = proposals.filter(p => p.status === '승인');
  const recent = proposals.filter(p => ['실행완료', '기각', '만료'].includes(p.status)).slice(0, 10);

  const nowStr = () => new Date(Date.now() + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 16);

  // K(상태)·L(응답일시)·M(기각사유) 한 범위로 — 개별 셀 3회보다 부분쓰기 위험 낮음
  const respond = async (p, status, rejectReason = '') => {
    if (busy) return;
    setBusy(p.rowNum);
    try {
      await sheets.writeRange(`주문제안!K${p.rowNum}:M${p.rowNum}`, [status, nowStr(), rejectReason]);
      await sheets.fetch();
    } finally {
      setBusy(null); setRejecting(null); setReason('');
    }
  };

  if (sheets.auth !== 'signed-in') {
    return <div style={{ padding: 32, textAlign: 'center', color: '#6B675C', fontSize: 12 }}>로그인하면 주문서가 표시됩니다.</div>;
  }

  const sideColor = (side) => side === '매수' ? PROFIT_POS : PROFIT_NEG;
  const acctChip = (acct) => {
    const c = accounts?.[acct]?.color || '#aaa';
    return <span style={{ fontSize: 9, background: c + '33', color: c, padding: '2px 5px', flexShrink: 0 }}>{accounts?.[acct]?.label || acct}</span>;
  };

  const OrderLine = ({ p, big }) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      {acctChip(p.acct)}
      <span style={{ fontSize: big ? 15 : 13, fontWeight: 800, color: sideColor(p.side) }}>{p.side}</span>
      <span style={{ fontSize: big ? 15 : 13, fontWeight: 700, color: '#141414' }}>{p.name}</span>
      <span style={{ fontSize: big ? 14 : 12, fontFamily: MONO, color: '#141414' }}>
        {fmt(p.qty)}주 × ₩{fmt(p.price)} ≈ <b>₩{fmt(p.amount)}</b>
      </span>
    </div>
  );

  const Checks = ({ checks }) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {(checks || []).map((c, i) => (
        <span key={i} title={c.d} style={{
          fontSize: 10, padding: '2px 7px', border: `1px solid ${c.ok === false ? PROFIT_POS : '#141414'}`,
          color: c.ok === false ? PROFIT_POS : '#159E52', background: c.ok === false ? '#FBE3E4' : '#FFFFFF',
        }}>
          {c.ok === false ? '✗' : '✓'} {c.k}
        </span>
      ))}
    </div>
  );

  const Rationale = ({ r }) => {
    const facts = Object.entries(r?.facts || {});
    return (
      <div style={{ marginTop: 8, background: '#EAE6DA', padding: '8px 10px', fontSize: 11, lineHeight: 1.6, color: '#141414' }}>
        {r?.text && <div style={{ marginBottom: facts.length ? 6 : 0 }}>{r.text}</div>}
        {facts.map(([k, v]) => (
          <div key={k} style={{ color: '#6B675C' }}><b style={{ color: '#141414' }}>{k}</b> · {String(v)}</div>
        ))}
      </div>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <SectionTitle mb={14} sub="신호를 실행 가능한 주문서로 — 승인하면 증권사 앱에 그대로 입력만">주문함</SectionTitle>
        <DeptBadge dept="athena" />
      </div>

      {/* ① 대기 주문서 */}
      <div style={{ fontSize: 10, letterSpacing: 2, color: '#6B675C', marginBottom: 8 }}>대기 주문서 ({pending.length})</div>
      {pending.length === 0 && (
        <div style={{ background: '#FFFFFF', border: '1px solid #141414', padding: 20, textAlign: 'center', color: '#6B675C', fontSize: 11, marginBottom: 18 }}>
          대기 중인 주문서 없음 — 주간(일요일)·급락 시 자동 생성됩니다
        </div>
      )}
      {pending.map(p => (
        <div key={p.rowNum} style={{ background: '#FFFFFF', border: '2px solid #141414', boxShadow: '4px 4px 0 #141414', padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, color: '#fff', background: SRC_COLOR[p.source] || '#6B675C', padding: '2px 6px' }}>{p.source}</span>
            <span style={{ fontSize: 9, color: '#6B675C' }}>{p.date}</span>
          </div>
          <OrderLine p={p} big />
          <Checks checks={p.checks} />
          <Rationale r={p.rationale} />
          {rejecting === p.rowNum ? (
            <div style={{ marginTop: 10 }}>
              <input value={reason} onChange={e => setReason(e.target.value)} placeholder="기각 사유 (성향 학습에 활용)"
                style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', border: '1px solid #141414', fontSize: 12, fontFamily: baseFont, marginBottom: 8 }} />
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => { setRejecting(null); setReason(''); }} style={btn('#6B675C')}>취소</button>
                <button disabled={busy === p.rowNum} onClick={() => respond(p, '기각', reason.trim())} style={btnFill('#E5484D')}>기각 확정</button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button disabled={busy === p.rowNum} onClick={() => respond(p, '승인')} style={{ ...btnFill('#141414'), flex: 1 }}>
                {busy === p.rowNum ? '처리 중…' : '✓ 승인 — 실행 대기로'}
              </button>
              <button disabled={busy === p.rowNum} onClick={() => setRejecting(p.rowNum)} style={btn('#E5484D')}>기각</button>
            </div>
          )}
        </div>
      ))}

      {/* ② 실행 대기 (승인됨) */}
      {approved.length > 0 && (
        <>
          <div style={{ fontSize: 10, letterSpacing: 2, color: '#159E52', margin: '18px 0 8px' }}>실행 대기 — 증권사 앱에서 이대로 입력 ({approved.length})</div>
          {approved.map(p => (
            <div key={p.rowNum} style={{ background: '#DDF3E4', border: '2px solid #159E52', padding: 12, marginBottom: 10 }}>
              <OrderLine p={p} big />
              <div style={{ fontSize: 9, color: '#6B675C', marginTop: 6 }}>
                {p.responded} 승인 · 체결 알림이 오면 자동으로 완료 처리됩니다
              </div>
            </div>
          ))}
        </>
      )}

      {/* ③ 최근 처리 */}
      {recent.length > 0 && (
        <>
          <div style={{ fontSize: 10, letterSpacing: 2, color: '#6B675C', margin: '18px 0 8px' }}>최근 처리 ({recent.length})</div>
          {recent.map(p => (
            <div key={p.rowNum} style={{ background: '#FFFFFF', borderBottom: '1px solid #EAE6DA', padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8, opacity: 0.75 }}>
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '2px 6px', flexShrink: 0,
                color: p.status === '실행완료' ? '#159E52' : '#6B675C',
                border: `1px solid ${p.status === '실행완료' ? '#159E52' : '#6B675C'}`,
              }}>{p.status}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <OrderLine p={p} />
                {p.rejectReason && <div style={{ fontSize: 10, color: '#6B675C', marginTop: 2 }}>사유: {p.rejectReason}</div>}
              </div>
            </div>
          ))}
        </>
      )}

      <div style={{ fontSize: 9, color: '#6B675C', textAlign: 'center', marginTop: 16, lineHeight: 1.6 }}>
        주문서 = Node 결정론 계산 + AI 선별 · 최종 실행 결정은 항상 나의 몫 · 미응답 주문서는 7일 후 만료
      </div>
    </div>
  );
}

const btn = (color) => ({ padding: '8px 14px', minHeight: 36, border: `1px solid ${color}`, background: 'transparent', color, cursor: 'pointer', fontSize: 12, fontWeight: 700 });
const btnFill = (color) => ({ padding: '8px 14px', minHeight: 36, border: 'none', background: color, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700 });
