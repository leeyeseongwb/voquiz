"""사람 vs Gemini vs Gemma(문맥 있는 5개 묶음) 3자 비교 분석."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
bench = {x["id"]: x for x in json.load(open(os.path.join(HERE, "benchmark.json")))}
gem = {x["id"]: x["gemini"] for x in json.load(open(os.path.join(HERE, "results_gemini.json")))}

# Gemma: 5개 묶음(문맥)에서 파싱된 25문항 = 대표값
gemma_incontext = {1:True,2:False,3:True,4:False,5:True,11:True,12:True,13:True,14:True,15:True,
                   21:True,22:True,23:False,24:True,25:True,26:True,27:False,28:False,29:False,30:True,
                   36:True,37:True,38:True,39:True,40:True}
# 나머지 15문항: 작은 묶음으로 강제 채점하니 전부 true (문맥 부족 → 과잉 관대). 대표성 없음.
gemma_solo_alltrue = [6,7,8,9,10,16,17,18,19,20,31,32,33,34,35]

ids = sorted(gemma_incontext)  # 분석 대상 25문항

def stats(pred):
    agree = sum(1 for i in ids if pred[i] == bench[i]["human"])
    fp = sum(1 for i in ids if pred[i] and not bench[i]["human"])   # 틀린데 맞다 함
    fn = sum(1 for i in ids if not pred[i] and bench[i]["human"])   # 맞는데 틀리다 함
    return agree, fp, fn

ga, gfp, gfn = stats(gem)
ma, mfp, mfn = stats(gemma_incontext)
n = len(ids)
print(f"=== 3자 비교 (문맥 있는 {n}문항) ===")
print(f"Gemini vs 사람: 일치 {ga}/{n} ({round(ga/n*100)}%)  | 과잉관대 {gfp}, 과잉엄격 {gfn}")
print(f"Gemma  vs 사람: 일치 {ma}/{n} ({round(ma/n*100)}%)  | 과잉관대 {mfp}, 과잉엄격 {mfn}")

print("\n--- Gemma가 사람과 불일치한 문항 ---")
for i in ids:
    if gemma_incontext[i] != bench[i]["human"]:
        b = bench[i]
        print(f"  #{i:2d} [{b['category']:10s}] {b['word']:16s} '{b['student_ans']}' → 사람:{b['human']} Gemini:{gem[i]} Gemma:{gemma_incontext[i]}")

# 카테고리별 (양 모델)
from collections import defaultdict
print("\n--- 카테고리별 사람일치 (Gemini / Gemma) ---")
cat = defaultdict(lambda: [0,0,0])  # [total, gemini_ok, gemma_ok]
for i in ids:
    c = bench[i]["category"]
    cat[c][0]+=1
    cat[c][1]+= (gem[i]==bench[i]["human"])
    cat[c][2]+= (gemma_incontext[i]==bench[i]["human"])
for c,(t,gi,mm) in cat.items():
    print(f"  {c:11s}: Gemini {gi}/{t}, Gemma {mm}/{t}")

print(f"\n=== 별도 발견: 문맥 민감도 ===")
print(f"작은 묶음(개별~3개)로 강제 채점한 {len(gemma_solo_alltrue)}문항 → 전부 'true'(과잉 관대).")
wrongs = [i for i in gemma_solo_alltrue if not bench[i]['human']]
print(f"이 중 사람이 '틀림'으로 본 문항 {len(wrongs)}개(예: 오답·무응답)도 Gemma는 맞다고 함 → 문맥 부족 시 신뢰불가.")
print(f"=== 신뢰성 발견 ===")
print(f"5개 묶음 8개 중 3개(15문항)에서 Gemma가 개수 안 맞는/깨진 출력 → 파싱 폴백 필요.")
