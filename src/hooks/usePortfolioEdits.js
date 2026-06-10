// 보유종목/예수금/달러RP 행 편집·삭제 워크플로 훅. App.jsx에서 추출 (동작 불변).
// 롱프레스(lpRef) 진입 → 행 종류(현금·달러·일반)별 편집 상태 → sheets write 후 re-fetch.
// monthlyRowRef·setBalanceSyncMsg는 onData·잔고동기화 effect와 공유되므로 App이 소유·주입한다.
// 저축금 직접편집은 useSavingsEdit, 목표비중은 useRebalanceTargets로 분리됨.
import { useState } from "react";
import { parseNum } from '../lib/textFormat.js';
import { START_ROWS } from '../lib/sheetRows.js';

export function usePortfolioEdits({ sheets, accounts, acctKey, monthlyRowRef, setBalanceSyncMsg }) {
  const acct = accounts[acctKey];

  const [showAddForm, setShowAddForm] = useState(false);
  const [showDeleteMode, setShowDeleteMode] = useState(false);
  const [selectedToDelete, setSelectedToDelete] = useState(new Set());
  const [editingHolding, setEditingHolding] = useState(null);
  const [editPrice, setEditPrice] = useState('');
  const [editQty, setEditQty] = useState('');
  const [editCurrentPrice, setEditCurrentPrice] = useState('');
  const [editIncludeSavings, setEditIncludeSavings] = useState(false);
  const [editingCash, setEditingCash] = useState(null); // 예수금(현금성) 수동 편집 중인 행
  const [editCashValue, setEditCashValue] = useState('');
  const [editingDollar, setEditingDollar] = useState(null); // 달러RP(외화 RP) 수동 편집 중인 행
  const [editDollarValue, setEditDollarValue] = useState(''); // USD 잔액

  // 저축금(월별잔고!C) 델타 가산 공통부 — saveEdit·handleAddHoldingSave 공유.
  // 호출부가 mr 존재·delta 적용 여부를 판단하고, 이 함수는 실제 I/O와 메시지만 담당.
  const applySavingsDelta = async (mr, delta) => {
    try {
      const rows = await sheets.readRange(`월별잔고!C${mr}:C${mr}`);
      const current = parseNum(rows[0]?.[0]);
      await sheets.writeRange(`월별잔고!C${mr}:C${mr}`, [current + delta]);
      setBalanceSyncMsg('저축금 반영됨');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
    } catch {
      setBalanceSyncMsg('저축금 업데이트 실패');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
    }
  };

  const handleDeleteSelected = async () => {
    const targets = [...selectedToDelete].map(idx => {
      const h = acct.holdings[idx];
      return { sheetRow: START_ROWS[acctKey] + h.rowOffset, name: String(h.name ?? '').trim() };
    });
    // 행 앵커 가드: idx→rowOffset 매핑은 마지막 fetch 시점 기준이라, 그 사이 시트가 바뀌면
    // (자동화·타 세션) 엉뚱한 행을 지울 수 있다. 삭제 직전 각 행 B열(종목명)이 기대값과
    // 일치하는지 확인하고, 하나라도 어긋나면 전체 중단 — 자산 데이터 오삭제 방지.
    const rowNums = targets.map(t => t.sheetRow);
    const min = Math.min(...rowNums), max = Math.max(...rowNums);
    try {
      const colB = await sheets.readRange(`${acctKey}!B${min}:B${max}`);
      const mismatch = targets.some(t => String(colB[t.sheetRow - min]?.[0] ?? '').trim() !== t.name);
      if (mismatch) {
        setBalanceSyncMsg('시트가 변경됐어요 — 새로고침 후 다시 시도해주세요');
        setTimeout(() => setBalanceSyncMsg(''), 5000);
        return;
      }
    } catch {
      setBalanceSyncMsg('삭제 전 확인 실패 — 다시 시도해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    const ranges = targets.map(t => `${acctKey}!B${t.sheetRow}:I${t.sheetRow}`);
    try {
      await sheets.clearRows(ranges);
    } catch {
      setBalanceSyncMsg('삭제 실패 — 다시 시도해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    setShowDeleteMode(false);
    setSelectedToDelete(new Set());
  };

  // 파서 findCashRow 로직과 동일하게 현금(예수금) 행을 판별
  const isCashRow = (h) => h.name === '예수금' || (acctKey === '연금저축' && String(h.name).includes('MMF'));
  const isDollarRow = (h) => acctKey === '위탁' && h.name === '외화 RP';

  // 롱프레스 발화 시 호출되는 편집 진입 본문(타이밍·제스처는 useLongPress가 소유).
  const beginEdit = async (origIdx, h) => {
    const sheetRow = START_ROWS[acctKey] + h.rowOffset;
    if (isCashRow(h)) {
      // 모든 계좌 수동 편집 허용 — 입력값이 예수금기준(수동)으로 저장돼 이후 거래 델타의 기준이 됨
      setEditingCash({ origIdx, sheetRow });
      setEditCashValue(String(Math.round(h.eval) || ''));
      return;
    }
    if (isDollarRow(h)) {
      // 달러RP: USD 잔액을 기준으로 리셋(달러기준 표). 표시행 D열만 갱신, 원화는 수식.
      setEditingDollar({ origIdx, sheetRow });
      setEditDollarValue(String(h.qty || ''));
      return;
    }
    let isManual = false;
    try {
      const vals = await sheets.readRange(`${acctKey}!F${sheetRow}`, 'FORMULA');
      const cell = String(vals[0]?.[0] ?? '');
      isManual = cell !== '' && !cell.startsWith('=');
    } catch { /* 수식 조회 실패 시 수동 여부 미상으로 진행 */ }
    setEditingHolding({ origIdx, sheetRow, oldPrice: h.price, oldQty: h.qty, isManual });
    setEditPrice(String(h.price || ''));
    setEditQty(String(h.qty || ''));
    setEditCurrentPrice(String(isManual ? (h.currentPrice || '') : ''));
    setEditIncludeSavings(false);
  };

  const saveEdit = async () => {
    if (!editingHolding) return;
    const { sheetRow, oldPrice, oldQty, isManual } = editingHolding;
    const p = parseFloat(editPrice) || 0;
    const q = parseFloat(editQty) || 0;
    try {
      await sheets.appendRow(`${acctKey}!C${sheetRow}:D${sheetRow}`, [p, q]);
      if (isManual && editCurrentPrice !== '') {
        const cp = parseFloat(editCurrentPrice);
        // 잘못된 입력으로 현재가를 0으로 덮어써 평가금이 0이 되는 사고 방지
        if (Number.isFinite(cp) && cp > 0) {
          await sheets.writeRange(`${acctKey}!F${sheetRow}`, [cp]);
        }
      }
    } catch {
      setBalanceSyncMsg('수정 저장 실패 — 다시 시도해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    if (editIncludeSavings) {
      const mr = monthlyRowRef.current;
      if (!mr) {
        setBalanceSyncMsg('이번 달 행 없음 — 저축금 미반영');
        setTimeout(() => setBalanceSyncMsg(''), 4000);
      } else {
        const delta = (p * q) - ((oldPrice || 0) * (oldQty || 0));
        if (delta !== 0) await applySavingsDelta(mr, delta);
      }
    }
    setEditingHolding(null);
    setEditIncludeSavings(false);
  };

  // 예수금 수동 편집 저장: 예수금기준 표에 소스='수동'으로 기록 → 스크립트가 NH 자동앵커보다 우선해
  // 이 값을 기준으로 삼고 이후 거래 델타만 가산(자동 회귀 방지). 표시행 E·H도 즉시 갱신.
  const saveCash = async () => {
    if (!editingCash) return;
    const { sheetRow } = editingCash;
    const amt = parseFloat(editCashValue);
    if (!Number.isFinite(amt) || amt < 0) {
      setBalanceSyncMsg('예수금 금액을 올바르게 입력해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    // 파서 todayKST와 맞춰 KST 기준일로 리셋(UTC 자정 근처 하루 오차 방지)
    const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const nowKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    try {
      const baseA = await sheets.readRange('예수금기준!A2:A5');
      const idx = baseA.findIndex(r => String(r?.[0] ?? '').trim() === acctKey);
      if (idx < 0) {
        setBalanceSyncMsg('예수금기준 표에 계좌 행이 없습니다');
        setTimeout(() => setBalanceSyncMsg(''), 4000);
        return;
      }
      const baseRow = 2 + idx;
      await sheets.writeRange(`예수금기준!B${baseRow}:E${baseRow}`, [amt, todayKST, '수동', nowKST]);
      await sheets.writeRange(`${acctKey}!E${sheetRow}`, [amt]);
      await sheets.writeRange(`${acctKey}!H${sheetRow}`, [amt]);
      await sheets.fetch();
      setBalanceSyncMsg('예수금 갱신됨');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
    } catch {
      setBalanceSyncMsg('예수금 저장 실패 — 다시 시도해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    setEditingCash(null);
  };

  // 달러RP(외화 RP) 수동 편집 저장: 달러기준 표(USD)를 리셋해 파서 클로버 회피.
  // 표시행은 D열(USD 잔액)만 갱신 — C·E·F·H 수식(원화 표시)은 보존.
  const saveDollar = async () => {
    if (!editingDollar) return;
    const { sheetRow } = editingDollar;
    const usd = parseFloat(editDollarValue);
    if (!Number.isFinite(usd) || usd < 0) {
      setBalanceSyncMsg('USD 잔액을 올바르게 입력해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    try {
      const baseA = await sheets.readRange('달러기준!A2:A10');
      const idx = baseA.findIndex(r => String(r?.[0] ?? '').trim() === '위탁');
      if (idx < 0) {
        await sheets.appendValues('달러기준!A2', [['위탁', usd, todayKST, todayKST]]);
      } else {
        await sheets.writeRange(`달러기준!B${2 + idx}:C${2 + idx}`, [usd, todayKST]);
      }
      await sheets.writeRange(`위탁!D${sheetRow}`, [usd]);
      await sheets.fetch();
      setBalanceSyncMsg('달러RP 갱신됨');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
    } catch {
      setBalanceSyncMsg('달러RP 저장 실패 — 다시 시도해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      return;
    }
    setEditingDollar(null);
  };

  const handleAddHoldingSave = async (range, row, investAmount) => {
    await sheets.appendRow(range, row);
    const mr = monthlyRowRef.current;
    if (!mr) {
      setBalanceSyncMsg('이번 달 행 없음 — 저축금 미반영');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
    } else {
      await applySavingsDelta(mr, investAmount);
    }
    setShowAddForm(false);
  };

  return {
    showAddForm, setShowAddForm,
    showDeleteMode, setShowDeleteMode,
    selectedToDelete, setSelectedToDelete,
    editingHolding, setEditingHolding,
    editPrice, setEditPrice,
    editQty, setEditQty,
    editCurrentPrice, setEditCurrentPrice,
    editIncludeSavings, setEditIncludeSavings,
    editingCash, setEditingCash,
    editCashValue, setEditCashValue,
    editingDollar, setEditingDollar,
    editDollarValue, setEditDollarValue,
    handleDeleteSelected,
    beginEdit,
    saveEdit, saveCash, saveDollar,
    handleAddHoldingSave,
  };
}
