"""
ai_quiz.py
----------
단어 목록을 기반으로 시험 문제를 생성하고, 주관식 답안을 AI 로 채점하는 모듈.

지원하는 시험지 형식(format):
- toefl           : TOEFL Style — 문맥 문장 속 어휘 추론 (4지선다)
- sat             : SAT Style — 유의어/정의 기반 고난도 (4지선다)
- word_to_meaning : 단어 보고 뜻 선택 (4지선다)
- meaning_to_word : 뜻 보고 단어 선택 (4지선다)
- fill_meaning    : 단어만 보고 뜻 채워넣기 (주관식, AI 채점)

문제 스키마(통일):
{
  "type": "mc" | "written",     # 객관식 / 주관식
  "question": "...",
  "options": ["A","B","C","D"], # mc 일 때만
  "answer": "정답 텍스트",
  "explanation": "해설(한국어)"
}
"""

import os
import json
import re
import random
from datetime import date

import requests
from dotenv import load_dotenv

load_dotenv()
API_KEY = os.getenv("GOOGLE_API_KEY")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent"

# ── Gemini 하루 채점 한도 (유료 API 비용 제한) ───────────────────────────
# 하루에 Gemini로 채점할 수 있는 최대 주관식 '문제 수'. 환경변수 GEMINI_DAILY_LIMIT로 조절.
GEMINI_DAILY_LIMIT = int(os.getenv("GEMINI_DAILY_LIMIT", "100"))
_DATA_DIR = os.getenv("DATA_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
_USAGE_PATH = os.path.join(_DATA_DIR, "gemini_usage.json")


def _gemini_usage_today():
    """오늘 Gemini로 채점한 문제 수 (날짜가 바뀌면 0)."""
    today = date.today().isoformat()
    try:
        with open(_USAGE_PATH, encoding="utf-8") as f:
            d = json.load(f)
        if d.get("date") == today:
            return int(d.get("count", 0))
    except Exception:
        pass
    return 0


def _gemini_add_usage(n):
    """오늘 사용량에 n문제 추가(파일에 기록)."""
    today = date.today().isoformat()
    count = _gemini_usage_today() + n
    try:
        os.makedirs(os.path.dirname(_USAGE_PATH), exist_ok=True)
        with open(_USAGE_PATH, "w", encoding="utf-8") as f:
            json.dump({"date": today, "count": count}, f)
    except Exception:
        pass
    return count

# 형식별 사람이 읽는 라벨 + AI 프롬프트 지시문
FORMAT_LABELS = {
    "toefl": "TOEFL Style",
    "sat": "SAT Style",
    "word_to_meaning": "단어 보고 뜻 선택",
    "meaning_to_word": "뜻 보고 단어 선택",
    "fill_meaning": "단어 보고 뜻 채워넣기 (주관식)",
}

_FORMAT_INSTRUCTIONS = {
    "toefl": (
        "TOEFL-style questions. Each question is a natural academic sentence with the target "
        "word used in context, and a blank '____' replacing it OR asking the closest meaning. "
        "Options are 4 English words (1 correct + 3 plausible distractors). 'answer' is the correct English word."
    ),
    "sat": (
        "SAT-style vocabulary questions. Present a sophisticated sentence or a precise definition, "
        "and ask which word best fits. Options are 4 English words with challenging distractors "
        "(similar meaning or spelling). 'answer' is the correct English word."
    ),
    "word_to_meaning": (
        "Question shows an English word. Options are 4 Korean meanings (1 correct + 3 distractors). "
        "'answer' is the correct Korean meaning."
    ),
    "meaning_to_word": (
        "Question shows a Korean meaning. Options are 4 English words (1 correct + 3 distractors). "
        "'answer' is the correct English word."
    ),
}


def _gemini_json(prompt):
    """Gemini 에 프롬프트를 보내고 JSON(리스트/딕셔너리)을 파싱해 반환."""
    if not API_KEY:
        raise RuntimeError("GOOGLE_API_KEY 가 설정되지 않았습니다.")
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"response_mime_type": "application/json"},
    }
    resp = requests.post(f"{GEMINI_URL}?key={API_KEY}",
                         headers={"Content-Type": "application/json"},
                         data=json.dumps(payload), timeout=120)
    if resp.status_code != 200:
        raise RuntimeError(f"AI 오류: {resp.status_code}")
    raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
    cleaned = re.sub(r"```json", "", raw, flags=re.IGNORECASE).replace("```", "").strip()
    return json.loads(cleaned)


LANG_NAMES = {
    "en": "English",
    "zh": "Chinese (Hanzi, with the meaning in Korean)",
    "ja": "Japanese (with the meaning in Korean)",
    "es": "Spanish (with the meaning in Korean)",
    "fr": "French (with the meaning in Korean)",
    "de": "German (with the meaning in Korean)",
}


EXPLAIN_LANGS = {"ko": "Korean", "en": "English", "ja": "Japanese",
                 "zh": "Chinese", "es": "Spanish", "fr": "French", "de": "German"}


def generate_quiz(words, fmt, count, report, language="en", meaning_lang="ko", explain_lang="ko"):
    """
    단어 목록(words)으로 문제를 생성한다.
    - language: 대상 단어 언어 / meaning_lang: '뜻' 언어(ko/en)
    - explain_lang: 문제·해설을 쓸 언어 (ko/en/ja...)
    - report(percent, message, log): 진행 콜백
    - 반환: 문제 dict 리스트
    """
    explain_name = EXPLAIN_LANGS.get(explain_lang, "Korean")
    if fmt not in FORMAT_LABELS:
        raise ValueError(f"알 수 없는 형식: {fmt}")

    # 대상 단어 선택 (count 만큼 랜덤 샘플)
    pool = list(words)
    random.shuffle(pool)
    selected = pool[:count] if len(pool) > count else pool
    report(10, "단어 선택 완료", f"📋 {len(selected)}개 단어로 '{FORMAT_LABELS[fmt]}' 문제 생성")

    # '뜻' 자리에 영어(영영풀이)를 쓸지 한국어 뜻을 쓸지
    use_en_meaning = (meaning_lang == "en")

    def meaning_of(w):
        """뜻 표기 언어에 맞는 '뜻' 텍스트 (영어면 definition, 없으면 meaning 폴백)."""
        if use_en_meaning:
            return (w.get("definition") or "").strip() or w.get("meaning", "")
        return w.get("meaning", "")

    # 주관식(fill_meaning)은 AI 없이 로컬 생성 (단어→뜻)
    if fmt == "fill_meaning":
        report(40, "주관식 문제 구성 중...", "✏️ 주관식 문제를 만드는 중...")
        quiz = []
        for w in selected:
            quiz.append({
                "type": "written",
                "question": w["word"],
                "options": [],
                "answer": meaning_of(w),
                "explanation": w.get("example", "") or w.get("definition", ""),
                "word": w.get("word", ""),        # SRS/취약분석용 대상 단어
                "meaning": w.get("meaning", ""),  # 숙련도 캐시는 항상 한국어 뜻
            })
        report(95, "정리 중...", f"✅ 주관식 {len(quiz)}문항 생성")
        return quiz

    # 객관식: Gemini 로 생성
    report(30, "AI가 문제 생성 중...", "🤖 AI가 4지선다 문제를 만드는 중...")
    lang_name = LANG_NAMES.get(language, LANG_NAMES["en"])
    meaning_desc = "concise English definitions/synonyms" if use_en_meaning else "Korean meanings"
    # 뜻 표기 언어에 따라 형식 지시문을 동적으로 구성
    dyn_instructions = {
        "toefl": _FORMAT_INSTRUCTIONS["toefl"],
        "sat": _FORMAT_INSTRUCTIONS["sat"],
        "word_to_meaning": (
            f"Question shows an English word. Options are 4 {meaning_desc} "
            f"(1 correct + 3 distractors). 'answer' is the correct one."),
        "meaning_to_word": (
            f"Question shows a {('n English definition/synonym' if use_en_meaning else ' Korean meaning')}. "
            f"Options are 4 English words (1 correct + 3 distractors). 'answer' is the correct English word."),
    }
    prompt = f"""
You are an expert vocabulary quiz author. The vocabulary language is {lang_name}.
Create EXACTLY {len(selected)} multiple-choice questions using ONLY these words:
{json.dumps(selected, ensure_ascii=False)}

[STYLE]
{dyn_instructions[fmt]}
(Where the instruction says "English word", use the {lang_name} target word instead.)

[REQUIREMENTS]
1. Exactly 4 options per question.
2. The 'answer' string MUST be identical to one of the 4 options.
3. 'explanation' must be written in {explain_name}.
4. Do not repeat the same word twice.

[OUTPUT FORMAT] Valid JSON array ONLY:
[
  {{"type": "mc", "question": "...", "options": ["A","B","C","D"], "answer": "A", "explanation": "..."}}
]
"""
    data = _gemini_json(prompt)
    report(85, "문제 검증 중...", f"✅ {len(data)}문항 생성 완료")

    # 안전장치: 형식 정규화 + 대상 단어 매칭
    quiz = []
    for q in data:
        opts = q.get("options", [])
        if q.get("type") != "written" and len(opts) < 2:
            continue
        word, meaning = _match_source_word(q, selected)
        quiz.append({
            "type": "mc",
            "question": q.get("question", ""),
            "options": opts,
            "answer": q.get("answer", ""),
            "explanation": q.get("explanation", ""),
            "word": word,        # SRS/취약분석용 대상 단어
            "meaning": meaning,
        })
    report(95, "정리 중...", f"🎉 총 {len(quiz)}문항 완성")
    return quiz


def _match_source_word(q, selected):
    """
    생성된 문제가 어떤 원본 단어를 다루는지 추정한다.
    - 대부분 정답 또는 질문이 그 영어 단어이므로 우선 정확히 대조.
    - 실패 시 질문/정답 텍스트 안에 등장하는 단어를 부분 대조.
    반환: (word, meaning)
    """
    by_word = {w["word"].strip().lower(): w for w in selected if w.get("word")}
    ans = str(q.get("answer", "")).strip().lower()
    ques = str(q.get("question", "")).strip().lower()

    if ans in by_word:
        w = by_word[ans]
        return w["word"], w.get("meaning", "")
    if ques in by_word:
        w = by_word[ques]
        return w["word"], w.get("meaning", "")
    # 부분 대조: 문장 안에 단어가 통째로 등장하는 경우
    for key, w in by_word.items():
        if key and (key in ques or key in ans):
            return w["word"], w.get("meaning", "")
    return "", ""


def check_usage(word, meaning, sentence, language="en", explain_lang="ko"):
    """
    학생이 쓴 예문에서 단어가 문맥·용법에 맞게 쓰였는지 AI가 첨삭한다.
    - explain_lang: 피드백을 쓸 언어
    반환: {correct, feedback, correction}
    """
    lang = LANG_NAMES.get(language, "English")
    fb_lang = EXPLAIN_LANGS.get(explain_lang, "Korean")
    prompt = f"""
You are a friendly, encouraging {lang} teacher.
The student is practicing the word "{word}" (meaning: {meaning}).
The student wrote this sentence:
"{sentence}"

Judge whether the target word is used correctly and naturally in this sentence
(grammar, meaning, collocation, context).

Return JSON ONLY (write 'feedback' in {fb_lang}):
{{
  "correct": true or false,
  "feedback": "short warm feedback in {fb_lang} (1~2 sentences)",
  "correction": "the corrected sentence if wrong, empty string if correct"
}}
"""
    try:
        r = _gemini_json(prompt)
        if isinstance(r, dict):
            return {"correct": bool(r.get("correct")),
                    "feedback": r.get("feedback", ""),
                    "correction": r.get("correction", "")}
    except Exception:
        pass
    return {"correct": False, "feedback": "첨삭에 실패했어요. 잠시 후 다시 시도해주세요.", "correction": ""}


def grade(quiz, user_answers, report=None, ai_pregraded = None):
    """
    응시 답안을 채점한다.
    - quiz: 문제 리스트
    - user_answers: {문항index(str/int): 답안}
    - 객관식은 로컬 비교, 주관식은 AI 채점(의미가 유사하면 정답 처리).
    - 반환: {score, correct, total, results:[{...}]}
    """
    total = len(quiz)
    results = [None] * total

    # 주관식 문항 모으기 (AI 일괄 채점)
    written_idx = [i for i, q in enumerate(quiz) if q.get("type") == "written"]
    graded_by = "local"  # 채점 방식 기록: local(주관식 없음) / ondevice / server(Gemini)

    # 1) 객관식 로컬 채점
    for i, q in enumerate(quiz):
        if q.get("type") == "written":
            continue
        ua = str(user_answers.get(str(i), user_answers.get(i, "")) or "").strip()
        is_correct = (ua == str(q.get("answer", "")).strip())
        results[i] = {
            "idx": i + 1,
            "question": q["question"],
            "user_ans": ua or "(미응답)",
            "correct_ans": q.get("answer", ""),
            "correct": is_correct,
            "feedback": q.get("explanation", ""),
        }

    # 2) 주관식 AI 채점
    if written_idx:
        if report:
            report(50, "AI가 주관식 채점 중...", "🤖 주관식 답안을 AI가 채점하는 중...")
        payload = [{
            "question": quiz[i]["question"],
            "user_ans": str(user_answers.get(str(i), user_answers.get(i, "")) or ""),
            "correct_ans": quiz[i].get("answer", ""),
        } for i in written_idx]

        # 분기: 온디바이스(ai_pregraded) 사용 가능하면 그걸, 아니면 서버(Gemini)
        if (ai_pregraded and len(ai_pregraded) == len(payload)):
            ai_results = ai_pregraded
            graded_by = "ondevice"
        else:
            ai_results = _grade_written(payload)
            graded_by = "server"

        for n, i in enumerate(written_idx):
            r = ai_results[n] if n < len(ai_results) else {"correct": False, "feedback": ""}
            results[i] = {
                "idx": i + 1,
                "question": quiz[i]["question"],
                "user_ans": payload[n]["user_ans"] or "(미응답)",
                "correct_ans": quiz[i].get("answer", ""),
                "correct": bool(r.get("correct")),
                "feedback": r.get("feedback", ""),
            }

    correct = sum(1 for r in results if r and r["correct"])
    score = round(correct / total * 100) if total else 0
    if report:
        report(100, "채점 완료", f"🎯 {correct}/{total} 정답 ({score}%)")
    return {"score": score, "correct": correct, "total": total, "results": results, "graded_by": graded_by}

# 이 부분을 온디바이스로 사용하게 되는 경우 프롬프트 만들기, 모델 전송 및 결과 값 리턴 2가지 함수로 나뉘어진다.
def _grade_written(payload):
    """주관식 답안을 Gemini 로 채점. 하루 한도 초과 또는 실패 시 단순 문자열 비교로 폴백."""
    # 하루 Gemini 채점 한도 확인 (유료 API 비용 제한). 온디바이스 채점은 여기까지 오지 않음.
    over_limit = _gemini_usage_today() + len(payload) > GEMINI_DAILY_LIMIT
    if not over_limit:
        try:
            prompt = f"""
You are a warm, encouraging English teacher grading a Korean student's vocabulary answers.

[Data] {json.dumps(payload, ensure_ascii=False)}

[Rules]
1. Compare 'user_ans' with 'correct_ans'.
2. If the meaning is essentially correct (even if wording differs / synonyms), mark correct=true.
3. If wrong or empty, correct=false.
4. 'feedback' must be short and in Korean.

[Output] JSON array, same length and order as input:
[{{"correct": true, "feedback": "정확해요!"}}]
"""
            result = _gemini_json(prompt)  # ← 모델 호출
            if isinstance(result, list):
                _gemini_add_usage(len(payload))  # 성공 시 오늘 사용량 기록
                return result  # ← 성공하면 Gemini 결과
        except Exception:
            pass
    # 폴백: 한도 초과이거나 Gemini 실패 → 규칙 기반(정확 일치)
    fallback = []
    for item in payload:
        ok = item["user_ans"].strip() and item["user_ans"].strip() == item["correct_ans"].strip()
        fb = "정확해요!" if ok else f"정답은 '{item['correct_ans']}' 입니다."
        if over_limit:
            fb += " · 오늘 Gemini 채점 한도에 도달했어요. 제한 없는 온디바이스 AI 사용을 권장해요."
        fallback.append({"correct": bool(ok), "feedback": fb})
    return fallback  # ← 한도 초과/실패 시 폴백
