"""
planner.py
----------
망각곡선(Ebbinghaus forgetting curve)에 기반한 학습 플래너 스케줄러.

이론적 근거(참고 문헌):
- Ebbinghaus (1885): 기억 보유율 R(t) = exp(-t / S). 시간이 지날수록
  지수적으로 잊어버리며, S(기억 안정도)가 클수록 천천히 잊는다.
- 간격 효과(Spacing effect, Cepeda et al. 2006/2008): 복습 간격을 점점
  늘리는(expanding) 분산 학습이 벼락치기보다 장기 기억에 유리하다.
  최적 복습 간격은 목표 보유 기간의 대략 10~30%.
- Pimsleur(1967) graduated interval recall & Leitner(1972) 박스 시스템:
  성공적으로 회상할 때마다 다음 복습을 지수적으로 미룬다.
- SM-2 / SuperMemo (Woźniak 1990) & FSRS의 DSR 모델(Difficulty·Stability·
  Retrievability): 복습에 성공하면 안정도 S가 배수로 커지고, 다음 복습은
  보유율이 목표치(θ, 보통 0.9)로 떨어지는 시점에 배치한다.

이 모듈은 위 이론을 종합해 "각 단어를 언제 처음 배우고, 언제 복습할지"를
날짜별로 계산한다. 계획 단계에서는 제때 복습한다고 가정하므로 안정도는
고정 배수로 커진다고 보고, 확장 간격 수열로 근사한다.
"""

import math
from collections import defaultdict
from datetime import date, timedelta

# 목표 보유율(θ): 이 값으로 떨어지기 직전에 복습하는 것이 가장 효율적.
DEFAULT_TARGET_RETENTION = 0.9

# 첫 복습 간격(일)과 성공 시 안정도 성장 배수(EASE).
# 복습에 성공할 때마다 기억 안정도 S 가 EASE 배로 커지고(간격 효과),
# 다음 복습 간격도 그만큼 늘어난다 → 확장 수열 [1, 3, 7, 17, 39] 근사.
BASE_INTERVAL = 1.4       # days (첫 복습까지)
EASE = 2.3                # 안정도 성장 배수 (SM-2의 ease factor 계열)


def curve_intervals(reviews=5, target_retention=DEFAULT_TARGET_RETENTION):
    """
    망각곡선/간격 효과로부터 확장 복습 간격(일)을 유도한다.

    복습마다 기억 안정도 S 가 EASE 배로 커진다고 보면, 보유율이 목표치로
    떨어지는 시점(=다음 복습 간격)도 EASE 배씩 늘어난다.
    → [1, 3, 7, 17, 39] 같은 확장 수열(Leitner/Pimsleur/SM-2 계열).
    """
    intervals, iv = [], BASE_INTERVAL
    for _ in range(reviews):
        gap = max(1, round(iv))
        if intervals and gap <= intervals[-1]:   # 항상 확장되도록 보정
            gap = intervals[-1] + 1
        intervals.append(gap)
        iv *= EASE
    return intervals


def retention_after(days, stability=None):
    """에빙하우스 곡선상 days 일 뒤 예상 보유율(0~1). R(t)=exp(-t/S)."""
    S = stability if stability else BASE_INTERVAL / -math.log(DEFAULT_TARGET_RETENTION)
    return math.exp(-days / S)


def _iso(d):
    return d.isoformat()


def build_schedule(words, start_date, daily_new, target_date=None,
                   reviews=5, target_retention=DEFAULT_TARGET_RETENTION,
                   max_reviews_per_day=None, exclude_weekdays=None):
    """
    단어 목록으로 날짜별 학습/복습 계획을 만든다.

    - words: [{word, meaning, reading, example, definition, wordbook_id}, ...]
    - start_date: date — 시작일
    - daily_new: 하루에 새로 배우는 단어 수
    - target_date: date|None — 목표 기간의 끝(있으면 그 전에 모든 복습을 몰아줌)
    - reviews: 단어당 복습 횟수
    - exclude_weekdays: {int} — 공부 안 하는 요일(파이썬 weekday: 월0~일6). 이 요일은 건너뜀
    반환: [{date, new:[...], review:[...]}] (날짜 오름차순), 그리고 intervals
    """
    intervals = curve_intervals(reviews, target_retention)
    sched_new = defaultdict(list)
    sched_review = defaultdict(list)

    exclude = set(exclude_weekdays or [])
    if len(exclude) >= 7:          # 모든 요일 제외는 무의미 → 무시
        exclude = set()

    def next_ok(d):                # d 이후(포함) 첫 학습 가능 요일
        while d.weekday() in exclude:
            d += timedelta(days=1)
        return d

    def prev_ok(d):                # d 이전(포함) 마지막 학습 가능 요일
        while d.weekday() in exclude:
            d -= timedelta(days=1)
        return d

    # 목표 기간이 있으면, 마지막 배치도 최소 2회는 복습되도록 하루 신규량을 늘려 앞당긴다.
    if target_date:
        avail = sum(1 for i in range((target_date - start_date).days)
                    if (start_date + timedelta(days=i)).weekday() not in exclude)
        span = max(1, avail - intervals[1 if len(intervals) > 1 else 0])
        need_per_day = math.ceil(len(words) / span) if span else len(words)
        daily_new = max(daily_new, need_per_day)

    daily_new = max(1, int(daily_new))

    # 새 단어 배치별 시작일(학습 가능 요일만 사용)
    num_batches = math.ceil(len(words) / daily_new) if words else 0
    intro_dates = []
    d = next_ok(start_date)
    for _ in range(num_batches):
        intro_dates.append(d)
        d = next_ok(d + timedelta(days=1))

    for idx, w in enumerate(words):
        batch = idx // daily_new
        intro = intro_dates[batch]
        sched_new[intro].append(w)
        last_review_day = intro
        for iv in intervals:
            rday = next_ok(intro + timedelta(days=iv))   # 제외 요일이면 다음 학습일로 밀기
            if target_date and rday >= target_date:
                break
            sched_review[rday].append(w)
            last_review_day = rday
        # 목표일 하루 전 마무리 복습(벼락치기 방지용 최종 점검)
        if target_date:
            cram = prev_ok(target_date - timedelta(days=1))
            if cram > intro and cram != last_review_day:
                sched_review[cram].append(w)

    # 날짜별로 합치기 (복습 단어 중복 제거)
    all_days = sorted(set(sched_new) | set(sched_review))
    schedule = []
    for d in all_days:
        seen = set()
        reviews_list = []
        for w in sched_review.get(d, []):
            key = (w.get("word"), w.get("wordbook_id"))
            if key in seen:
                continue
            seen.add(key)
            reviews_list.append({"word": w.get("word", ""), "meaning": w.get("meaning", ""),
                                 "wordbook_id": w.get("wordbook_id")})
        news = [{"word": w.get("word", ""), "meaning": w.get("meaning", ""),
                 "reading": w.get("reading", ""), "example": w.get("example", ""),
                 "definition": w.get("definition", ""), "wordbook_id": w.get("wordbook_id")}
                for w in sched_new.get(d, [])]
        schedule.append({"date": _iso(d), "new": news, "review": reviews_list})

    return {"schedule": schedule, "intervals": intervals,
            "daily_new": daily_new, "total_days": len(all_days)}


def plan_stats(schedule):
    """계획 요약: 총 학습일 수, 총 복습 횟수, 하루 최대 부담."""
    total_new = sum(len(d["new"]) for d in schedule)
    total_review = sum(len(d["review"]) for d in schedule)
    peak = max((len(d["new"]) + len(d["review"]) for d in schedule), default=0)
    return {"total_new": total_new, "total_review": total_review, "peak_load": peak}


def ai_recommend(goal_text, word_count, days_until_target=None, use_ai=True):
    """
    사용자의 목표(자연어)를 해석해 추천 파라미터 + 격려 문구를 만든다.
    - use_ai=False 이면 AI 호출 없이 규칙 기반으로만 계산(무료 등급 제한/예산 절감).
    AI 실패/미설정 시에도 규칙 기반으로 폴백하므로 항상 값이 반환된다.
    반환: {daily_new, reviews, summary, source}
    """
    # 규칙 기반 폴백 값
    if days_until_target and days_until_target > 0:
        fallback_daily = max(5, math.ceil(word_count / max(1, days_until_target * 0.7)))
    else:
        fallback_daily = 10 if word_count > 40 else max(3, word_count // 3)
    fallback = {
        "daily_new": int(fallback_daily),
        "reviews": 5,
        "summary": ("에빙하우스 망각곡선에 따라 1·3·7·17·39일 간격으로 복습하도록 계획했어요. "
                    "하루 조금씩 꾸준히 하는 분산 학습이 벼락치기보다 오래 기억에 남습니다."),
        "source": "rule",
    }
    if not use_ai:
        return fallback
    try:
        import ai_quiz  # 지연 임포트(순환 의존 방지)
        prompt = f"""
You are a study-planning coach who knows the science of memory
(Ebbinghaus forgetting curve, spaced repetition, the spacing effect).
A learner wants to study {word_count} vocabulary words.
Their goal (may be empty): "{goal_text}"
Days until their target date: {days_until_target if days_until_target else "not set"}.

Recommend a realistic daily NEW-word count and number of spaced reviews per word.
Write a short, warm Korean summary (2~3 sentences) explaining the plan and WHY
spaced repetition along the forgetting curve helps.

Return JSON ONLY:
{{"daily_new": <int 3-40>, "reviews": <int 3-6>, "summary": "<Korean>"}}
"""
        r = ai_quiz._gemini_json(prompt)
        if isinstance(r, dict) and r.get("daily_new"):
            return {
                "daily_new": max(1, min(60, int(r["daily_new"]))),
                "reviews": max(3, min(6, int(r.get("reviews", 5)))),
                "summary": r.get("summary") or fallback["summary"],
                "source": "ai",
            }
    except Exception:
        pass
    return fallback
