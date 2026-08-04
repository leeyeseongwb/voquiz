"""
srs.py
------
간격 반복(Spaced Repetition) 스케줄링 + 단어별 숙련도 갱신 + 취약 단어 분석.

핵심 아이디어(망각곡선):
- 단어를 맞히면 다음 복습 간격을 점점 늘린다(1→2→4→8→16→35일).
- 틀리면 간격을 초기화해 내일 다시 물어본다.
- 이렇게 "잊을 때쯤 다시 묻는" 루프가 장기 기억(정착)을 만든다.

숙련도(mastery) 단계는 연속 정답 수(streak)로 판단:
- weak(취약):  streak 0  (틀린 적 있거나 아직 못 맞힘)
- learning:    streak 1~2
- mastered:    streak 3 이상
"""

from datetime import datetime, timezone, timedelta

import database as db

# 연속 정답 수에 따른 복습 간격(일). 인덱스가 streak.
INTERVALS = [1, 2, 4, 8, 16, 35]


def _today():
    return datetime.now(timezone.utc).date()


def _iso_date(d):
    return d.isoformat()


def mastery_level(streak: int, last_result) -> str:
    if last_result == 0 or streak == 0:
        return "weak"
    if streak < 3:
        return "learning"
    return "mastered"


def update_mastery(user_id: int, wordbook_id: int, word: str, meaning: str, correct: bool):
    """
    한 단어의 채점 결과를 반영해 숙련도/복습 스케줄을 갱신(upsert)한다.
    """
    if not word:
        return
    row = db.query_one(
        "SELECT * FROM word_mastery WHERE user_id=? AND wordbook_id=? AND word=?",
        (user_id, wordbook_id, word),
    )
    today = _today()

    if correct:
        streak = (row["streak"] + 1) if row else 1
        interval = INTERVALS[min(streak, len(INTERVALS) - 1)]
    else:
        streak = 0
        interval = 0  # 틀리면 즉시 복습 대상(오늘)

    next_review = _iso_date(today + timedelta(days=interval))
    last_review = _iso_date(today)

    if row:
        db.execute(
            "UPDATE word_mastery SET meaning=?, correct_count=correct_count+?, "
            "wrong_count=wrong_count+?, streak=?, interval_days=?, last_result=?, "
            "last_review=?, next_review=? WHERE id=?",
            (meaning or row["meaning"], 1 if correct else 0, 0 if correct else 1,
             streak, interval, 1 if correct else 0, last_review, next_review, row["id"]),
            commit=True,
        )
    else:
        db.execute(
            "INSERT INTO word_mastery (user_id, wordbook_id, word, meaning, correct_count, "
            "wrong_count, streak, interval_days, last_result, last_review, next_review) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, wordbook_id, word, meaning, 1 if correct else 0, 0 if correct else 1,
             streak, interval, 1 if correct else 0, last_review, next_review),
            commit=True,
        )


def record_results(user_id: int, wordbook_id: int, quiz: list, results: list):
    """
    채점 결과(results)를 문제(quiz)의 대상 단어와 짝지어 숙련도에 반영.
    각 문제에는 생성 시 부여된 'word'/'meaning' 필드가 있다고 가정(없으면 건너뜀).
    """
    if not wordbook_id:
        return
    for q, r in zip(quiz, results):
        if not r:
            continue
        word = q.get("word", "")
        meaning = q.get("meaning", "") or q.get("answer", "")
        if word:
            update_mastery(user_id, wordbook_id, word, meaning, bool(r.get("correct")))


def due_words(user_id: int, wordbook_id=None, limit: int = 20):
    """
    복습할 때가 된 단어 목록.
    조건: next_review <= 오늘 (틀렸거나 간격이 도래한 단어).
    최근에 틀린 것(weak) 우선.
    """
    today = _iso_date(_today())
    params = [user_id, today]
    wb_filter = ""
    if wordbook_id:
        wb_filter = "AND wordbook_id=? "
        params.append(wordbook_id)
    params.append(limit)
    return db.query_all(
        f"SELECT wordbook_id, word, meaning, streak, last_result FROM word_mastery "
        f"WHERE user_id=? AND next_review IS NOT NULL AND next_review<=? {wb_filter}"
        f"ORDER BY last_result ASC, streak ASC, next_review ASC LIMIT ?",
        tuple(params),
    )


def due_count(user_id: int) -> int:
    today = _iso_date(_today())
    return db.query_one(
        "SELECT COUNT(*) c FROM word_mastery WHERE user_id=? AND next_review<=?",
        (user_id, today),
    )["c"]


def analysis(user_id: int, wordbook_id=None):
    """
    취약 단어 분석: 숙련도 분포 + 취약 단어 상위 목록.
    """
    params = [user_id]
    wb_filter = ""
    if wordbook_id:
        wb_filter = "AND wordbook_id=? "
        params.append(wordbook_id)

    rows = db.query_all(
        f"SELECT word, meaning, correct_count, wrong_count, streak, last_result "
        f"FROM word_mastery WHERE user_id=? {wb_filter}",
        tuple(params),
    )
    dist = {"mastered": 0, "learning": 0, "weak": 0}
    weak_list = []
    for r in rows:
        lvl = mastery_level(r["streak"], r["last_result"])
        dist[lvl] += 1
        total = r["correct_count"] + r["wrong_count"]
        acc = round(r["correct_count"] / total * 100) if total else 0
        if lvl != "mastered":
            weak_list.append({
                "word": r["word"], "meaning": r["meaning"],
                "wrong": r["wrong_count"], "correct": r["correct_count"],
                "accuracy": acc, "level": lvl,
            })
    # 많이 틀리고 정확도 낮은 순
    weak_list.sort(key=lambda x: (-x["wrong"], x["accuracy"]))
    return {
        "seen": len(rows),
        "distribution": dist,
        "weak_words": weak_list[:30],
    }
