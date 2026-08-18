// 실패한 15문항만 적응형(자동 분할) 채점 — v8 새로고침 후 콘솔에 붙여넣기
(async () => {
  const items = [{"id": 6, "question": "Trajectory", "user_ans": "이동 경로", "correct_ans": "궤적, 경로"}, {"id": 7, "question": "Trajectory", "user_ans": "괘적", "correct_ans": "궤적, 경로"}, {"id": 8, "question": "Trajectory", "user_ans": "속도", "correct_ans": "궤적, 경로"}, {"id": 9, "question": "Momentous", "user_ans": "중대한", "correct_ans": "대단히 중요한, 중대한"}, {"id": 10, "question": "Momentous", "user_ans": "매우 중요한", "correct_ans": "대단히 중요한, 중대한"}, {"id": 16, "question": "Genuine", "user_ans": "진실된", "correct_ans": "진짜의, 진실한"}, {"id": 17, "question": "Genuine", "user_ans": "가짜의", "correct_ans": "진짜의, 진실한"}, {"id": 18, "question": "Ephemeral", "user_ans": "순식간의", "correct_ans": "수명이 짧은, 순식간의"}, {"id": 19, "question": "Ephemeral", "user_ans": "덧없는", "correct_ans": "수명이 짧은, 순식간의"}, {"id": 20, "question": "Ephemeral", "user_ans": "영원한", "correct_ans": "수명이 짧은, 순식간의"}, {"id": 31, "question": "Inquiry", "user_ans": "문의", "correct_ans": "공식적인 조사, 문의"}, {"id": 32, "question": "Inquiry", "user_ans": "대답", "correct_ans": "공식적인 조사, 문의"}, {"id": 33, "question": "Legitimacy", "user_ans": "정당성", "correct_ans": "타당성, 정당성"}, {"id": 34, "question": "Legitimacy", "user_ans": "합법성", "correct_ans": "타당성, 정당성"}, {"id": 35, "question": "Legitimacy", "user_ans": "복잡성", "correct_ans": "타당성, 정당성"}];
  async function grade(chunk) {
    const payload = chunk.map(x => ({ question: x.question, user_ans: x.user_ans, correct_ans: x.correct_ans }));
    const r = await window.gradeWrittenOnDevice(payload);
    if (r && r.length === chunk.length)
      return chunk.map((x, j) => ({ id: x.id, correct: !!r[j].correct, solo: chunk.length === 1 }));
    if (chunk.length === 1) return [{ id: chunk[0].id, correct: null, solo: true }];
    const mid = Math.floor(chunk.length / 2);                 // 실패하면 반으로 쪼개 재귀
    return [...(await grade(chunk.slice(0, mid))), ...(await grade(chunk.slice(mid)))];
  }
  const grades = [];
  for (let i = 0; i < items.length; i += 5) {
    grades.push(...(await grade(items.slice(i, i + 5))));
    console.log('진행: ' + grades.length + '/' + items.length);
  }
  const out = JSON.stringify(grades.map(g => ({ id: g.id, correct: g.correct })));
  console.log('%c=== 추가 15문항 결과 — 아래 한 줄 복사 ===', 'font-weight:bold;color:#6c5ce7');
  console.log(out);
  try { await navigator.clipboard.writeText(out); } catch (e) {}
  console.log('개별채점(문맥없음):', JSON.stringify(grades.filter(g => g.solo).map(g => g.id)));
  console.log('실패:', JSON.stringify(grades.filter(g => g.correct === null).map(g => g.id)));
})();
