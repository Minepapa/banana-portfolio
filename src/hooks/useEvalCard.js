// 평가 카드 워크플로 훅: JSON 붙여넣기 적재 + 평가요청 큐 추가/재시도. App.jsx에서 추출 (동작 불변).
// evalQueue(파싱 표시 데이터)는 App의 onData가 set하므로 여기서 소유하지 않는다 — 워크플로 상태/핸들러만 캡슐화.
import { useState, useCallback } from "react";

export function useEvalCard({ sheets }) {
  const [evalIngestOpen, setEvalIngestOpen] = useState(false);
  const [evalIngestRaw, setEvalIngestRaw] = useState('');
  const [evalIngestParsed, setEvalIngestParsed] = useState(null);
  const [evalIngestMsg, setEvalIngestMsg] = useState('');
  const [evalIngestBusy, setEvalIngestBusy] = useState(false);
  const [evalQueueOpen, setEvalQueueOpen] = useState(false);
  const [evalQueueName, setEvalQueueName] = useState('');
  const [evalQueueMarket, setEvalQueueMarket] = useState('KR');
  const [evalQueueMemo, setEvalQueueMemo] = useState('');
  const [evalQueueBusy, setEvalQueueBusy] = useState(false);
  const [evalQueueMsg, setEvalQueueMsg] = useState('');
  const [requeueBusyIdx, setRequeueBusyIdx] = useState(null); // 재시도 진행 중인 큐 행 rowIndex

  // ── 평가 카드 JSON 파싱·적재 ────────────────────────────────────────────
  const tryParseEvalJson = useCallback((raw) => {
    if (!raw || !raw.trim()) return { ok: false, error: '입력이 비어있습니다.' };
    // ```json ... ``` 펜스 우선 추출
    const fence = raw.match(/```json\s*([\s\S]*?)\s*```/i) || raw.match(/```\s*([\s\S]*?)\s*```/);
    let candidate = fence ? fence[1] : raw;
    // 가장 바깥 { ... } 추출
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first < 0 || last < 0 || last < first) return { ok: false, error: 'JSON 블록을 찾지 못했습니다.' };
    candidate = candidate.slice(first, last + 1);
    try {
      const obj = JSON.parse(candidate);
      const required = ['date', 'name', 'conclusion'];
      const missing = required.filter(k => !obj[k]);
      if (missing.length) return { ok: false, error: `필수 필드 누락: ${missing.join(', ')}` };
      const grades = obj.grades || {};
      return { ok: true, data: {
        date:       String(obj.date ?? ''),
        name:       String(obj.name ?? ''),
        ticker:     String(obj.ticker ?? ''),
        market:     String(obj.market ?? ''),
        conclusion: String(obj.conclusion ?? ''),
        grades: {
          수익성:     String(grades.수익성 ?? ''),
          안정성:     String(grades.안정성 ?? ''),
          밸류에이션: String(grades.밸류에이션 ?? ''),
          현금흐름:   String(grades.현금흐름 ?? ''),
          모멘텀:     String(grades.모멘텀 ?? ''),
        },
        reasons:    Array.isArray(obj.reasons) ? obj.reasons.map(String) : [],
        risks:      Array.isArray(obj.risks)   ? obj.risks.map(String)   : [],
        actions:    Array.isArray(obj.actions) ? obj.actions.map(String) : [],
        frankMemo:  String(obj.frankMemo ?? ''),
        status:     String(obj.status ?? '보류'),
        buyDate:    String(obj.buyDate ?? ''),
        buyPrice:   String(obj.buyPrice ?? ''),
        targetTerm: String(obj.targetTerm ?? ''),
        targetRet:  String(obj.targetRet ?? ''),
        aiNote:     String(obj.aiNote ?? ''),
        axisItems:  obj.axisItems && typeof obj.axisItems === 'object' ? obj.axisItems : null,
      }};
    } catch (e) {
      return { ok: false, error: `JSON 파싱 실패: ${e.message}` };
    }
  }, []);

  const buildEvalRow = useCallback((d) => {
    const joinNumbered = (arr) => (arr || []).map((s, i) => `${i + 1}) ${s}`).join(' ');
    return [
      d.date, d.name, d.ticker, d.market,
      d.conclusion,
      d.grades.수익성, d.grades.안정성, d.grades.밸류에이션, d.grades.현금흐름, d.grades.모멘텀,
      joinNumbered(d.reasons),
      joinNumbered(d.risks),
      joinNumbered(d.actions),
      d.frankMemo,
      d.status,
      d.buyDate, d.buyPrice,
      d.targetTerm, d.targetRet,
      d.aiNote,
      d.axisItems ? JSON.stringify(d.axisItems) : '',
    ];
  }, []);

  const submitEvalQueue = useCallback(async () => {
    const name = evalQueueName.trim();
    if (!name) { setEvalQueueMsg('⚠️ 종목명을 입력해주세요.'); return; }
    setEvalQueueBusy(true);
    setEvalQueueMsg('큐에 추가 중...');
    try {
      const _now = new Date();
      const requestedAt = `${_now.getFullYear()}-${String(_now.getMonth()+1).padStart(2,'0')}-${String(_now.getDate()).padStart(2,'0')} ${String(_now.getHours()).padStart(2,'0')}:${String(_now.getMinutes()).padStart(2,'0')}`;
      const row = [requestedAt, name, evalQueueMarket, '대기', '', evalQueueMemo.trim()];
      await sheets.appendValues('평가요청!A2:F', [row]);
      setEvalQueueMsg('✓ 큐에 추가됨');
      setTimeout(() => {
        setEvalQueueOpen(false);
        setEvalQueueName('');
        setEvalQueueMemo('');
        setEvalQueueMsg('');
      }, 1500);
    } catch (e) {
      setEvalQueueMsg(`큐 추가 실패: ${e.message || e}`);
    } finally {
      setEvalQueueBusy(false);
    }
  }, [evalQueueName, evalQueueMarket, evalQueueMemo, sheets]);

  // 오류 난 평가요청을 다시 '대기'로 돌려 다음 drain 때 재처리.
  // F열(메모)은 보존 — '매도 평가' 같은 의미 트리거가 들어 있을 수 있어 지우면 안 됨.
  const requeueEval = async (entry) => {
    setRequeueBusyIdx(entry.rowIndex);
    setEvalQueueMsg('');
    try {
      const sheetRow = entry.rowIndex + 2; // A2:F → rowIndex 0 = 시트 2행
      await sheets.writeRange(`평가요청!D${sheetRow}:E${sheetRow}`, ['대기', '']);
      await sheets.fetch();
    } catch {
      setEvalQueueMsg('재시도 등록 실패 — 잠시 후 다시 시도해주세요');
      setTimeout(() => setEvalQueueMsg(''), 4000);
    } finally {
      setRequeueBusyIdx(null);
    }
  };

  const ingestEvaluation = useCallback(async () => {
    if (!evalIngestParsed) return;
    setEvalIngestBusy(true);
    setEvalIngestMsg('적재 중...');
    try {
      const row = buildEvalRow(evalIngestParsed);
      await sheets.appendValues('종목투자노트!A2:U', [row]);
      setEvalIngestMsg('✓ 적재 완료 — 카드 갱신됨');
      setTimeout(() => {
        setEvalIngestOpen(false);
        setEvalIngestRaw('');
        setEvalIngestParsed(null);
        setEvalIngestMsg('');
      }, 1200);
    } catch (e) {
      setEvalIngestMsg(`적재 실패: ${e.message || e}`);
    } finally {
      setEvalIngestBusy(false);
    }
  }, [evalIngestParsed, buildEvalRow, sheets]);

  return {
    evalIngestOpen, setEvalIngestOpen,
    evalIngestRaw, setEvalIngestRaw,
    evalIngestParsed, setEvalIngestParsed,
    evalIngestMsg, setEvalIngestMsg,
    evalIngestBusy,
    evalQueueOpen, setEvalQueueOpen,
    evalQueueName, setEvalQueueName,
    evalQueueMarket, setEvalQueueMarket,
    evalQueueMemo, setEvalQueueMemo,
    evalQueueMsg, setEvalQueueMsg,
    evalQueueBusy,
    requeueBusyIdx,
    tryParseEvalJson,
    ingestEvaluation,
    submitEvalQueue,
    requeueEval,
  };
}
