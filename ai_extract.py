"""
ai_extract.py
-------------
PDF / 이미지에서 단어 데이터를 추출하는 모듈 (OCR + Gemini).

기존 VoQuiz 의 extractor_gemini.py + pdf_processor.py 로직을 재사용하되,
진행 상황(progress)을 콜백으로 보고하도록 개선했다.

추출 필드: word / definition / meaning / example / page
- 이미지에 정의가 있으면 그 정의를 한국어로 번역해 meaning 에 넣는다.
- 정의가 없으면(단어만 있으면) Gemini 가 사전처럼 뜻/정의/예문을 생성한다.
- 아무 정보도 못 뽑으면 해당 항목은 결과에 포함하지 않는다.
"""

import os
import json
import base64
import re
import uuid
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from pdf2image import convert_from_path, pdfinfo_from_path
from dotenv import load_dotenv

load_dotenv()
API_KEY = os.getenv("GOOGLE_API_KEY")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent"

PROMPT_EN = """
You are an expert English-Korean Dictionary Editor.

[TASK]
Extract vocabulary words from the image.

[CRITICAL RULES FOR "MEANING"]
1. If the image has an English definition:
    - TRANSLATE that specific definition into Korean.
    - Do NOT just translate the word itself; consider the context of the definition.
    - Example: Word "Bank", Def "Sloping land" -> Meaning "둑" (Not 은행).
2. If the image has NO definition (Word only):
    - You act as a dictionary. GENERATE the most common Korean meaning.
    - GENERATE a simple English definition.
    - GENERATE a simple example sentence.

[OUTPUT FIELDS]
- "word": English word.
- "reading": "" (leave empty for English).
- "definition": English definition (Extracted or Generated).
- "meaning": Korean meaning (Translated from definition).
- "example": English sentence (Extracted or Generated).

If no vocabulary is present, return an empty array [].
Output: Valid JSON Array ONLY.
"""

PROMPT_ZH = """
You are an expert Chinese-Korean Dictionary Editor.

[TASK]
Extract Chinese vocabulary words from the image.

[RULES]
1. "word" is the Chinese word in Hanzi (Simplified if shown simplified).
2. "reading" is the Pinyin with tone marks (e.g., "xué xí").
3. "meaning" is the Korean meaning. If a definition exists in the image, translate it to Korean;
   otherwise generate the most common Korean meaning.
4. "definition" is a simple Chinese definition (extracted or generated).
5. "example" is a simple Chinese example sentence.

[OUTPUT FIELDS]
- "word": Chinese word (Hanzi).
- "reading": Pinyin.
- "definition": Chinese definition.
- "meaning": Korean meaning.
- "example": Chinese sentence.

If no vocabulary is present, return an empty array [].
Output: Valid JSON Array ONLY.
"""

PROMPTS = {"en": PROMPT_EN, "zh": PROMPT_ZH}

# '뜻(meaning)' 을 쓸 언어
MEANING_LANGS = {"ko": "Korean", "en": "English", "ja": "Japanese",
                 "zh": "Chinese", "es": "Spanish", "fr": "French", "de": "German"}


def _build_prompt(language, meaning_lang="ko"):
    """추출 프롬프트 + 뜻 언어 오버라이드."""
    base = PROMPTS.get(language, PROMPT_EN)
    if meaning_lang and meaning_lang != "ko":
        name = MEANING_LANGS.get(meaning_lang, "Korean")
        base += (f"\n\n[LANGUAGE OVERRIDE]\nWrite the 'meaning' field in {name} "
                 f"(NOT Korean). Keep other fields as instructed.")
    return base


def count_pdf_pages(pdf_path):
    try:
        return pdfinfo_from_path(pdf_path)["Pages"]
    except Exception:
        return 0


def _encode_image(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def _clean_json(text):
    text = re.sub(r"```json", "", text, flags=re.IGNORECASE).replace("```", "").strip()
    match = re.search(r"\[.*\]", text, re.DOTALL)
    return match.group(0) if match else text


def _gemini_extract_image(image_path, language="en", meaning_lang="ko"):
    """이미지 한 장을 Gemini 에 보내 단어 배열을 받아온다."""
    if not API_KEY:
        return []
    try:
        b64 = _encode_image(image_path)
    except Exception:
        return []

    payload = {
        "contents": [{"parts": [
            {"text": _build_prompt(language, meaning_lang)},
            {"inline_data": {"mime_type": "image/jpeg", "data": b64}},
        ]}],
        "generationConfig": {"temperature": 0.1, "response_mime_type": "application/json"},
    }
    try:
        resp = requests.post(f"{GEMINI_URL}?key={API_KEY}",
                             headers={"Content-Type": "application/json"},
                             data=json.dumps(payload), timeout=120)
        if resp.status_code == 200:
            raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(_clean_json(raw))
        return []
    except Exception:
        return []


def _process_page(page_image, page_num, language="en", meaning_lang="ko"):
    """PDF 페이지 이미지를 임시 파일로 저장 후 추출, 페이지 번호 태깅."""
    tmp = os.path.join(tempfile.gettempdir(), f"voquiz_tmp_{uuid.uuid4().hex}.jpg")
    try:
        page_image.save(tmp, "JPEG")
        data = _gemini_extract_image(tmp, language, meaning_lang) or []
        for item in data:
            item["page"] = page_num
        return data
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except Exception:
                pass


def extract_words(file_path, start_page, end_page, report, language="en", meaning_lang="ko"):
    """
    파일에서 단어를 추출한다.
    - report(percent, message, log): 진행 상황 콜백 (progress.update 래핑)
    - language: 대상 단어 언어 / meaning_lang: '뜻' 언어
    - 반환: 단어 dict 리스트 (seq 부여됨)
    """
    is_pdf = file_path.lower().endswith(".pdf")

    if not is_pdf:
        # 단일 이미지(jpg/png) 처리
        report(20, "이미지 분석 중...", "🖼️ 이미지에서 단어 추출 중...")
        data = _gemini_extract_image(file_path, language, meaning_lang)
        for item in data:
            item.setdefault("page", 1)
        report(90, "정리 중...", f"✅ {len(data)}개 단어 발견")
        return _finalize(data)

    # PDF 처리
    report(5, "PDF 페이지 변환 중...", "📂 PDF를 이미지로 변환하는 중...")
    try:
        pages = convert_from_path(file_path, dpi=300, first_page=start_page, last_page=end_page)
    except Exception as e:
        raise RuntimeError(f"PDF 변환 실패: {e}")

    total = len(pages)
    if total == 0:
        return []

    report(15, f"{total}페이지 분석 준비...", f"⚡ 총 {total}페이지 병렬 처리 시작")

    results = []
    done = 0
    # 5페이지씩 병렬 처리 (속도 향상)
    with ThreadPoolExecutor(max_workers=5) as executor:
        future_to_page = {
            executor.submit(_process_page, img, start_page + i, language, meaning_lang): start_page + i
            for i, img in enumerate(pages)
        }
        for future in as_completed(future_to_page):
            page_num = future_to_page[future]
            done += 1
            try:
                page_data = future.result()
                if page_data:
                    results.extend(page_data)
                    report(
                        15 + int(done / total * 75),
                        f"{done}/{total} 페이지 완료",
                        f"   ✅ P.{page_num}: {len(page_data)}개 단어",
                    )
                else:
                    report(
                        15 + int(done / total * 75),
                        f"{done}/{total} 페이지 완료",
                        f"   ⚠️ P.{page_num}: 단어 없음",
                    )
            except Exception as exc:
                report(None, None, f"   🚨 P.{page_num} 오류: {exc}")

    # 페이지 순서대로 정렬 후 순번 부여
    results.sort(key=lambda x: x.get("page", 0))
    report(95, "결과 정리 중...", f"🎉 총 {len(results)}개 단어 추출 완료")
    return _finalize(results)


def _finalize(words):
    """빈 항목 제거 + seq(순번) 부여."""
    clean = []
    for w in words:
        if not w.get("word"):
            continue
        clean.append({
            "word": str(w.get("word", "")).strip(),
            "reading": str(w.get("reading", "")).strip(),
            "meaning": str(w.get("meaning", "")).strip(),
            "definition": str(w.get("definition", "")).strip(),
            "example": str(w.get("example", "")).strip(),
            "page": int(w.get("page", 1) or 1),
        })
    for i, w in enumerate(clean):
        w["seq"] = i + 1
    return clean
