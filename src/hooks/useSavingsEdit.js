// 저축금(월별잔고!C) 직접 편집 워크플로 훅. usePortfolioEdits에서 분리 (동작 불변).
// 롱프레스 발화 시 beginSavingsEdit → 이번 달 행 값 로드 → 절대값 set 저장. 보유종목 편집의
// 델타 가산과 달리 여기선 절대값을 직접 쓴다. monthlyRowRef·setBalanceSyncMsg는 App이 소유·주입.
// 타이밍·제스처는 useLongPress가 소유(DashboardTab에서 연결).
import { useState } from "react";
import { parseNum } from '../lib/textFormat.js';

export function useSavingsEdit({ sheets, monthlyRowRef, setBalanceSyncMsg }) {
  const [showSavingsEdit, setShowSavingsEdit] = useState(false);
  const [savingsEditValue, setSavingsEditValue] = useState('');

  const beginSavingsEdit = async () => {
    const mr = monthlyRowRef.current;
    if (!mr) {
      setBalanceSyncMsg('이번 달 행 없음');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
      return;
    }
    try {
      const rows = await sheets.readRange(`월별잔고!C${mr}:C${mr}`);
      setSavingsEditValue(String(parseNum(rows[0]?.[0]) || ''));
    } catch {
      setSavingsEditValue('');
    }
    setShowSavingsEdit(true);
  };

  const saveSavingsEdit = async () => {
    const mr = monthlyRowRef.current;
    if (!mr) {
      setBalanceSyncMsg('이번 달 행 없음');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
      setShowSavingsEdit(false);
      return;
    }
    try {
      await sheets.writeRange(`월별잔고!C${mr}:C${mr}`, [parseFloat(savingsEditValue) || 0]);
      setBalanceSyncMsg('저축금 저장됨');
      setTimeout(() => setBalanceSyncMsg(''), 3000);
    } catch {
      setBalanceSyncMsg('저축금 저장 실패');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
    }
    setShowSavingsEdit(false);
  };

  return {
    showSavingsEdit, setShowSavingsEdit,
    savingsEditValue, setSavingsEditValue,
    beginSavingsEdit, saveSavingsEdit,
  };
}
