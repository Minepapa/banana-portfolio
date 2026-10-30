// 질문 큐(95_Etna/Questions) 상태 정본 — import 없는 순수 상수(2026-10-30, 올림푸스 대시보드 서버가 발송 모듈 없이 읽도록 분리).
// 상태를 쓰는 쪽은 wiki-question-queue.mjs뿐이다. 새 상태를 만들면 여기 두 목록 중 하나에 넣는다(wiki-question-status.test.js가 강제).
// 묶음대기: 비긴급(urgent:false) 질문이 하루 두 번 묶음 발송(sendQuestionDigest)을 기다리는 상태(2026-10-09, D68).
export const ACTIVE_STATUSES = new Set(['묶음대기', '발송중', '발송결과불명', '재발송허용', '답변대기', '승인', '반영대기']);
// 더 진행하지 않는 상태. 보류·제외는 오너 답, 만료는 기한(30일) 경과, 처리완료·미적용은 반영 결과.
export const CLOSED_STATUSES = new Set(['보류', '제외', '만료', '처리완료', '미적용']);
export const ALL_STATUSES = new Set([...ACTIVE_STATUSES, ...CLOSED_STATUSES]);
