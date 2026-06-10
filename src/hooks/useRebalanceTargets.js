// 리밸런싱 목표비중(자산분배!B) 일괄 편집 워크플로 훅. usePortfolioEdits에서 분리 (동작 불변).
// 합계 100% 검증 후 계좌별 시작행(REBAL_TARGET_START)부터 비중을 소수로 일괄 기록.
import { useState } from "react";
import { REBAL_TARGET_START } from '../lib/constants.js';

export function useRebalanceTargets({ sheets, acctKey, setBalanceSyncMsg }) {
  const [editingAllTargets, setEditingAllTargets] = useState(false);
  const [allTargetInputs, setAllTargetInputs] = useState([]);

  const saveAllTargets = async () => {
    const sum = allTargetInputs.reduce((s, v) => s + (parseFloat(v) || 0), 0);
    if (Math.abs(sum - 100) > 0.1) {
      alert(`합계가 ${sum.toFixed(1)}%입니다. 100%가 되어야 합니다.`);
      return;
    }
    setEditingAllTargets(false);
    const startRow = REBAL_TARGET_START[acctKey];
    try {
      await sheets.writeRangeMulti(
        `자산분배!B${startRow}:B${startRow + allTargetInputs.length - 1}`,
        allTargetInputs.map(v => [(parseFloat(v) || 0) / 100])
      );
      await sheets.fetch();
    } catch {
      setBalanceSyncMsg('목표비중 저장 실패 — 다시 시도해주세요');
      setTimeout(() => setBalanceSyncMsg(''), 4000);
    }
  };

  return {
    editingAllTargets, setEditingAllTargets,
    allTargetInputs, setAllTargetInputs,
    saveAllTargets,
  };
}
