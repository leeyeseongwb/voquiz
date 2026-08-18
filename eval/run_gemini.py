"""Gemini로 벤치마크를 채점하고 사람 정답과 비교. 결과를 results_gemini.json에 저장."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ai_quiz

HERE = os.path.dirname(os.path.abspath(__file__))
bench = json.load(open(os.path.join(HERE, "benchmark.json")))

payload = [{"question": x["word"], "user_ans": x["student_ans"], "correct_ans": x["correct_ans"]} for x in bench]
results = ai_quiz._grade_written(payload)

if len(results) != len(bench):
    print(f"⚠️ 길이 불일치: 결과 {len(results)} vs 문항 {len(bench)}")

out = []
agree = 0
for x, r in zip(bench, results):
    g = bool(r.get("correct"))
    h = bool(x["human"])
    match = (g == h)
    agree += match
    out.append({**x, "gemini": g, "gemini_feedback": r.get("feedback", ""), "match_human": match})

json.dump(out, open(os.path.join(HERE, "results_gemini.json"), "w"), ensure_ascii=False, indent=2)

print(f"\n=== Gemini vs 사람 (총 {len(bench)}문항) ===")
print(f"일치: {agree}/{len(bench)}  ({round(agree/len(bench)*100)}%)")

# 불일치 항목
print("\n--- 불일치(Gemini ≠ 사람) ---")
for o in out:
    if not o["match_human"]:
        print(f"  #{o['id']:2d} [{o['category']:10s}] {o['word']:16s} '{o['student_ans']}' → 사람:{o['human']} / Gemini:{o['gemini']}")

# 카테고리별
from collections import defaultdict
cat = defaultdict(lambda: [0, 0])
for o in out:
    cat[o["category"]][0] += o["match_human"]
    cat[o["category"]][1] += 1
print("\n--- 카테고리별 일치율 ---")
for c, (a, t) in cat.items():
    print(f"  {c:11s}: {a}/{t}")

# 과잉관대(사람=틀림인데 Gemini=맞음) / 과잉엄격(사람=맞음인데 Gemini=틀림)
fp = sum(1 for o in out if o["gemini"] and not o["human"])
fn = sum(1 for o in out if not o["gemini"] and o["human"])
print(f"\n과잉 관대(틀린데 맞다 함): {fp}   과잉 엄격(맞는데 틀리다 함): {fn}")
