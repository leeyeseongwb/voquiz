"""파일럿 데이터 내보내기.
사용법:  python scripts/export_pilot.py [db경로]   (기본: data/vocashot.db)
출력:    eval/pilot_attempts.json, eval/pilot_reports.json, eval/pilot_written_answers.json
        + 콘솔 요약(채점 모드 분포, 신고 수 등)
"""
import json
import os
import sqlite3
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else "data/vocashot.db"
OUT = "eval"
os.makedirs(OUT, exist_ok=True)

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row

# 1) 응시 기록 (채점 모드 포함)
attempts = []
written = []  # 주관식 답안만 따로 (벤치마크 업그레이드용)
for a in con.execute("SELECT * FROM attempts ORDER BY created_at"):
    results = json.loads(a["results"])
    attempts.append({
        "id": a["id"], "user_id": a["user_id"], "exam_id": a["exam_id"],
        "score": a["score"], "correct": a["correct"], "total": a["total"],
        "graded_by": a["graded_by"], "created_at": a["created_at"],
    })
    if a["graded_by"] in ("ondevice", "server"):  # 주관식 있는 응시만
        for r in results:
            written.append({
                "attempt_id": a["id"], "user_id": a["user_id"], "graded_by": a["graded_by"],
                "word": r.get("question", ""), "student_ans": r.get("user_ans", ""),
                "correct_ans": r.get("correct_ans", ""), "model_correct": bool(r.get("correct")),
            })

json.dump(attempts, open(f"{OUT}/pilot_attempts.json", "w"), ensure_ascii=False, indent=2)
json.dump(written, open(f"{OUT}/pilot_written_answers.json", "w"), ensure_ascii=False, indent=2)

# 2) 채점 신고
reports = [dict(r) for r in con.execute("SELECT * FROM grade_reports ORDER BY created_at")]
json.dump(reports, open(f"{OUT}/pilot_reports.json", "w"), ensure_ascii=False, indent=2)

# 3) 요약
from collections import Counter
modes = Counter(a["graded_by"] for a in attempts)
users = len({a["user_id"] for a in attempts})
print("=== 파일럿 데이터 요약 ===")
print(f"참가자(고유 user): {users}")
print(f"총 응시: {len(attempts)}")
print(f"채점 모드 분포: {dict(modes)}")
if attempts:
    on = modes.get("ondevice", 0)
    ai = on + modes.get("server", 0)
    if ai:
        print(f"주관식 응시 중 온디바이스 성공률: {on}/{ai} ({round(on/ai*100)}%)")
print(f"주관식 답안 수집: {len(written)}개 (벤치마크 업그레이드용)")
print(f"'이 채점 이상해요' 신고: {len(reports)}건")
print(f"\n저장: {OUT}/pilot_attempts.json, pilot_written_answers.json, pilot_reports.json")
