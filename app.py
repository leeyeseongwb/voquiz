"""
app.py
------
VoQuiz 백엔드 (FastAPI).

기능 흐름:
  회원가입/이메일 인증/로그인  →  단어장 PDF 업로드 & OCR 추출(진행바)
  →  단어장 저장(이름/설명)  →  단어 범위 선택 & 시험지 생성(진행바)
  →  시험지 저장  →  시험 응시(시간 제한 옵션)  →  AI 채점 & 결과 저장(이력)

모든 데이터는 SQLite(database.py)에 사용자별로 저장된다.
"""

import os
import json
import shutil
import threading
import secrets
import string
from datetime import datetime, timezone, date as _date, timedelta as _timedelta

from fastapi import FastAPI, File, UploadFile, Form, Request, Response, HTTPException, Depends
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import database as db
import auth
import progress
import ai_extract
import ai_quiz
import pdf_export

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# 배포(도커) 시 UPLOAD_DIR 환경변수(/data/uploads 볼륨)를 우선 사용, 로컬은 프로젝트 uploads 폴더.
UPLOAD_DIR = os.getenv("UPLOAD_DIR") or os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# 관리자 이메일 (파일럿 콘솔 접근). 서버 .env의 ADMIN_EMAILS(콤마구분)로만 설정 — 코드에 하드코딩하지 않음.
ADMIN_EMAILS = {e.strip().lower() for e in
                os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()}


def _is_admin_email(email):
    return (email or "").lower() in ADMIN_EMAILS

# HTTPS 배포 시 .env에 SESSION_SECURE=1 → 세션 쿠키를 HTTPS에서만 전송(보안)
SESSION_SECURE = os.getenv("SESSION_SECURE", "0") == "1"

# 베타 가입 키: 회원가입 시 이메일 인증에 더해 이 키가 필요. .env의 SIGNUP_KEY로만 설정.
# (비어 있으면 가입 키 게이트 없음 — 로컬 개발용. 운영 서버는 반드시 .env에 설정)
SIGNUP_KEY = os.getenv("SIGNUP_KEY", "")

app = FastAPI(title="VoQuiz")


@app.middleware("http")
async def _no_cache_static(request: Request, call_next):
    """정적 파일(HTML/JS/CSS)은 항상 재검증하도록 no-cache 헤더 부여.
    (배포 후 브라우저가 옛 app.js/index.html 을 캐시해 쓰는 문제 방지)"""
    resp = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith((".html", ".js", ".css")):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


@app.on_event("startup")
def _startup():
    db.init_db()
    if auth.DEV_MODE:          # 테스트 계정은 개발 모드(DEV_MODE=1)에서만 시드 (운영 서버엔 만들지 않음)
        auth.ensure_test_account()
    auth.ensure_admin_account()  # 관리자 계정(.env의 ADMIN_SEED_EMAIL/PW) 보장 — 통계 열람 전용
    print("✅ VoQuiz 서버 준비 완료. http://127.0.0.1:8000")


def _now():
    return datetime.now(timezone.utc).isoformat()


# ==================================================================
# 인증 의존성
# ==================================================================
def current_user(request: Request):
    """세션 쿠키로 로그인 사용자 확인. 없으면 401."""
    token = request.cookies.get("session")
    user = auth.get_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return user


# ==================================================================
# 인증 API
# ==================================================================
class SignupBody(BaseModel):
    email: str
    password: str
    key: str = ""  # 베타 가입 키


class VerifyBody(BaseModel):
    email: str
    code: str


class LoginBody(BaseModel):
    email: str
    password: str


@app.post("/api/signup")
def signup(body: SignupBody):
    if SIGNUP_KEY and (body.key or "").strip() != SIGNUP_KEY:
        raise HTTPException(403, "가입 키가 올바르지 않아요. 베타 키를 확인해주세요.")
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(400, "올바른 이메일 형식이 아닙니다.")
    pw_err = auth.validate_password(body.password)
    if pw_err:
        raise HTTPException(400, pw_err)

    existing = auth.get_user_by_email(email)
    if existing and existing["is_verified"]:
        raise HTTPException(400, "이미 가입된 이메일입니다.")

    # 미인증 상태로 계정 생성 후 인증 코드 발송
    if not existing:
        auth.create_user(email, body.password, verified=False)
    code = auth.issue_verification_code(email)
    auth.send_verification_email(email, code)

    resp = {"status": "success", "message": "인증 코드를 이메일로 보냈습니다."}
    if auth.DEV_MODE:
        # 개발 모드: 테스트 편의를 위해 코드 노출 (운영에서는 DEV_MODE=0)
        resp["dev_code"] = code
    return resp


@app.post("/api/verify")
def verify(body: VerifyBody, response: Response):
    email = body.email.strip().lower()
    if not auth.check_verification_code(email, body.code):
        raise HTTPException(400, "인증 코드가 올바르지 않거나 만료되었습니다.")
    auth.mark_verified(email)
    user = auth.get_user_by_email(email)
    token = auth.create_session(user["id"])
    response.set_cookie("session", token, httponly=True, samesite="lax", secure=SESSION_SECURE, max_age=60 * 60 * 24 * 30)
    return {"status": "success", "email": email}


@app.post("/api/resend-code")
def resend_code(body: SignupBody):
    email = body.email.strip().lower()
    if not auth.get_user_by_email(email):
        raise HTTPException(400, "먼저 회원가입을 해주세요.")
    code = auth.issue_verification_code(email)
    auth.send_verification_email(email, code)
    resp = {"status": "success"}
    if auth.DEV_MODE:
        resp["dev_code"] = code
    return resp


@app.post("/api/login")
def login(body: LoginBody, response: Response):
    email = body.email.strip().lower()
    user = auth.get_user_by_email(email)
    if not user or not auth.verify_password(body.password, user["password_hash"]):
        raise HTTPException(400, "이메일 또는 비밀번호가 올바르지 않습니다.")
    if not user["is_verified"]:
        raise HTTPException(403, "이메일 인증이 필요합니다.")
    token = auth.create_session(user["id"])
    response.set_cookie("session", token, httponly=True, samesite="lax", secure=SESSION_SECURE, max_age=60 * 60 * 24 * 30)
    return {"status": "success", "email": email}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    auth.delete_session(request.cookies.get("session"))
    response.delete_cookie("session")
    return {"status": "success"}


@app.get("/api/me")
def me(user=Depends(current_user)):
    full = auth.get_user_full(user["id"])
    return {
        "id": full["id"],
        "email": full["email"],
        "nickname": full.get("nickname") or full["email"].split("@")[0],
        "avatar": full.get("avatar") or "",
        "explain_lang": full.get("explain_lang") or "ko",
        "is_admin": _is_admin_email(full["email"]),
    }


class PrefsBody(BaseModel):
    explain_lang: str


@app.post("/api/profile/prefs")
def update_prefs(body: PrefsBody, user=Depends(current_user)):
    """문제·해설 기본 언어 설정."""
    lang = body.explain_lang if body.explain_lang in ("ko", "en", "ja", "zh", "es", "fr", "de") else "ko"
    auth.set_explain_lang(user["id"], lang)
    return {"status": "success", "explain_lang": lang}


class ProfileBody(BaseModel):
    nickname: str


@app.post("/api/profile")
def update_profile(body: ProfileBody, user=Depends(current_user)):
    nickname = body.nickname.strip()
    if not (1 <= len(nickname) <= 20):
        raise HTTPException(400, "닉네임은 1~20자여야 합니다.")
    auth.update_profile(user["id"], nickname=nickname)
    return {"status": "success", "nickname": nickname}


@app.post("/api/profile/avatar")
def upload_avatar(user=Depends(current_user), file: UploadFile = File(...)):
    """프로필 사진을 data URL(base64)로 변환해 DB에 저장 (작은 이미지 가정)."""
    ext = os.path.splitext(file.filename)[1].lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".gif": "image/gif", ".webp": "image/webp"}.get(ext)
    if not mime:
        raise HTTPException(400, "이미지 파일(PNG/JPG/GIF/WEBP)만 지원합니다.")
    raw = file.file.read()
    if len(raw) > 2 * 1024 * 1024:
        raise HTTPException(400, "이미지는 2MB 이하만 업로드할 수 있습니다.")
    import base64
    data_url = f"data:{mime};base64,{base64.b64encode(raw).decode()}"
    auth.update_profile(user["id"], avatar=data_url)
    return {"status": "success", "avatar": data_url}


class AvatarDataBody(BaseModel):
    avatar: str  # data:image/...;base64,... (클라이언트에서 크롭/리사이즈된 이미지)


@app.post("/api/profile/avatar-crop")
def save_cropped_avatar(body: AvatarDataBody, user=Depends(current_user)):
    """클라이언트에서 크롭·리사이즈한 이미지(data URL)를 그대로 저장."""
    data = body.avatar
    if not data.startswith("data:image/"):
        raise HTTPException(400, "올바른 이미지 데이터가 아닙니다.")
    if len(data) > 700_000:  # 256px 정사각형이면 넉넉한 상한
        raise HTTPException(400, "이미지 용량이 너무 큽니다.")
    auth.update_profile(user["id"], avatar=data)
    return {"status": "success", "avatar": data}


class PasswordBody(BaseModel):
    current: str
    new: str


@app.post("/api/profile/password")
def change_password(body: PasswordBody, user=Depends(current_user)):
    """비밀번호 변경: 현재 비밀번호 확인 후 새 비밀번호로 교체."""
    full = db.query_one("SELECT password_hash FROM users WHERE id=?", (user["id"],))
    if not full or not auth.verify_password(body.current, full["password_hash"]):
        raise HTTPException(400, "현재 비밀번호가 올바르지 않습니다.")
    pw_err = auth.validate_password(body.new)
    if pw_err:
        raise HTTPException(400, pw_err)
    if body.current == body.new:
        raise HTTPException(400, "새 비밀번호가 기존과 동일합니다.")
    auth.update_password(user["id"], body.new)
    return {"status": "success"}


@app.get("/api/stats")
def get_stats(user=Depends(current_user)):
    """대시보드용 학습 통계 집계."""
    uid = user["id"]
    wb = db.query_one("SELECT COUNT(*) c FROM wordbooks WHERE user_id=?", (uid,))["c"]
    words = db.query_one(
        "SELECT COUNT(*) c FROM words w JOIN wordbooks wb ON wb.id=w.wordbook_id WHERE wb.user_id=?",
        (uid,))["c"]
    ex = db.query_one("SELECT COUNT(*) c FROM exams WHERE user_id=?", (uid,))["c"]
    agg = db.query_one(
        "SELECT COUNT(*) c, COALESCE(ROUND(AVG(score)),0) avg, COALESCE(MAX(score),0) best "
        "FROM attempts WHERE user_id=?", (uid,))
    # 시험지별 성적 (최고/평균/응시횟수) — 대시보드 위젯용
    exam_scores = db.query_all(
        "SELECT e.id AS exam_id, e.name, COUNT(a.id) AS attempts, "
        "  MAX(a.score) AS best, ROUND(AVG(a.score)) AS avg "
        "FROM exams e JOIN attempts a ON a.exam_id=e.id AND a.user_id=? "
        "WHERE e.user_id=? GROUP BY e.id ORDER BY MAX(a.created_at) DESC LIMIT 8", (uid, uid))

    # 이번 주 학습 요약 (최근 7일 응시 수)
    week_ago = (datetime.now(timezone.utc) - _timedelta(days=7)).isoformat()
    week_attempts = db.query_one(
        "SELECT COUNT(*) c FROM attempts WHERE user_id=? AND created_at >= ?", (uid, week_ago))["c"]
    # 최근 응시 기록 (최신순 6개)
    recent = db.query_all(
        "SELECT a.id, a.score, a.correct, a.total, a.created_at, e.name AS exam_name "
        "FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.user_id=? "
        "ORDER BY a.created_at DESC LIMIT 6", (uid,))
    return {
        "totals": {"wordbooks": wb, "words": words, "exams": ex, "attempts": agg["c"]},
        "avg_score": agg["avg"],
        "best_score": agg["best"],
        "exam_scores": exam_scores,
        "week_attempts": week_attempts,
        "recent": recent,
    }


@app.post("/api/stats/reset")
def reset_stats(user=Depends(current_user)):
    """학습 통계 초기화: 응시 기록 + 단어 숙련도를 모두 삭제(단어장·시험지는 유지)."""
    uid = user["id"]
    db.execute("DELETE FROM attempts WHERE user_id=?", (uid,), commit=True)
    return {"status": "success"}


# ==================================================================
# 진행 상황 폴링
# ==================================================================
@app.get("/api/progress/{job_id}")
def get_progress(job_id: str, user=Depends(current_user)):
    job = progress.get(job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없습니다.")
    return job


# ==================================================================
# 단어장: 업로드 & 추출
# ==================================================================
@app.post("/api/upload")
def upload_file(user=Depends(current_user), file: UploadFile = File(...)):
    """파일을 서버 uploads/ 에 저장하고 페이지 수를 반환."""
    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in (".pdf", ".jpg", ".jpeg", ".png"):
        raise HTTPException(400, "PDF 또는 이미지 파일만 지원합니다.")
    safe_name = f"u{user['id']}_{int(datetime.now().timestamp())}{ext}"
    dest = os.path.join(UPLOAD_DIR, safe_name)
    with open(dest, "wb") as f:
        shutil.copyfileobj(file.file, f)
    pages = ai_extract.count_pdf_pages(dest) if ext == ".pdf" else 1
    return {"status": "success", "filename": safe_name,
            "original_name": file.filename, "page_count": pages}


class ExtractBody(BaseModel):
    filename: str
    start_page: int = 1
    end_page: int = 1
    language: str = "en"
    meaning_lang: str = "ko"


@app.post("/api/extract-start")
def extract_start(body: ExtractBody, user=Depends(current_user)):
    """추출 작업을 백그라운드로 시작하고 job_id 반환 (진행바용)."""
    path = os.path.join(UPLOAD_DIR, os.path.basename(body.filename))
    if not os.path.exists(path):
        raise HTTPException(404, "업로드된 파일을 찾을 수 없습니다.")

    job_id = progress.create_job()

    def report(percent, message, log):
        progress.update(job_id, percent=percent, message=message, log=log)

    def worker():
        try:
            words = ai_extract.extract_words(path, body.start_page, body.end_page, report,
                                             body.language, body.meaning_lang)
            if not words:
                progress.fail(job_id, "추출된 단어가 없습니다.")
                return
            progress.finish(job_id, {"words": words})
        except Exception as e:
            progress.fail(job_id, str(e))

    threading.Thread(target=worker, daemon=True).start()
    return {"status": "success", "job_id": job_id}


class SaveWordbookBody(BaseModel):
    name: str
    description: str = ""
    source_name: str = ""
    words: list
    language: str = "en"
    meaning_lang: str = "ko"


@app.post("/api/wordbooks")
def save_wordbook(body: SaveWordbookBody, user=Depends(current_user)):
    """추출된 단어를 단어장으로 저장."""
    if not body.name.strip():
        raise HTTPException(400, "단어장 이름을 입력해주세요.")
    if not body.words:
        raise HTTPException(400, "저장할 단어가 없습니다.")

    lang = body.language if body.language in ("en", "zh", "ja", "es", "fr", "de") else "en"
    mlang = body.meaning_lang if body.meaning_lang in ("ko", "en", "ja", "zh", "es", "fr", "de") else "ko"
    wb_id = db.execute(
        "INSERT INTO wordbooks (user_id, name, description, source_name, created_at, language, meaning_lang) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user["id"], body.name.strip(), body.description.strip(), body.source_name, _now(), lang, mlang),
        commit=True,
    )
    rows = [
        (wb_id, i + 1, w.get("word", ""), w.get("reading", ""), w.get("meaning", ""),
         w.get("definition", ""), w.get("example", ""), int(w.get("page", 1) or 1))
        for i, w in enumerate(body.words)
    ]
    db.executemany(
        "INSERT INTO words (wordbook_id, seq, word, reading, meaning, definition, example, page) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    return {"status": "success", "wordbook_id": wb_id, "word_count": len(rows)}


@app.get("/api/wordbooks")
def list_wordbooks(user=Depends(current_user)):
    return {"wordbooks": db.query_all(
        "SELECT wb.id, wb.name, wb.description, wb.source_name, wb.created_at, wb.language, "
        "  (SELECT COUNT(*) FROM words w WHERE w.wordbook_id = wb.id) AS word_count, "
        "  (SELECT COUNT(*) FROM exams e WHERE e.wordbook_id = wb.id) AS exam_count "
        "FROM wordbooks wb WHERE wb.user_id = ? ORDER BY wb.created_at DESC",
        (user["id"],),
    )}


@app.get("/api/wordbooks/{wb_id}")
def get_wordbook(wb_id: int, user=Depends(current_user)):
    wb = db.query_one("SELECT * FROM wordbooks WHERE id=? AND user_id=?", (wb_id, user["id"]))
    if not wb:
        raise HTTPException(404, "단어장을 찾을 수 없습니다.")
    words = db.query_all("SELECT * FROM words WHERE wordbook_id=? ORDER BY seq", (wb_id,))
    src = wb.get("source_name") or ""
    wb["has_source"] = bool(src) and os.path.exists(os.path.join(UPLOAD_DIR, os.path.basename(src)))
    return {"wordbook": wb, "words": words}


@app.get("/api/wordbooks/{wb_id}/source")
def download_wordbook_source(wb_id: int, user=Depends(current_user)):
    """단어장의 원본 업로드 파일(PDF/이미지) 다운로드."""
    wb = db.query_one("SELECT name, source_name FROM wordbooks WHERE id=? AND user_id=?", (wb_id, user["id"]))
    if not wb:
        raise HTTPException(404, "단어장을 찾을 수 없습니다.")
    src = os.path.basename(wb.get("source_name") or "")
    path = os.path.join(UPLOAD_DIR, src)
    if not src or not os.path.exists(path):
        raise HTTPException(404, "원본 파일이 없습니다.")
    ext = os.path.splitext(src)[1] or ".pdf"
    mime = {".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg"}.get(ext.lower(), "application/octet-stream")
    return FileResponse(path, filename=f"{wb['name']}_원본{ext}", media_type=mime)


@app.delete("/api/wordbooks/{wb_id}")
def delete_wordbook(wb_id: int, user=Depends(current_user)):
    wb = db.query_one("SELECT id FROM wordbooks WHERE id=? AND user_id=?", (wb_id, user["id"]))
    if not wb:
        raise HTTPException(404, "단어장을 찾을 수 없습니다.")
    # 이 단어장으로 만든 시험지도 함께 삭제 (FK 는 SET NULL 이라 명시적으로 제거)
    exams = db.query_all("SELECT id FROM exams WHERE wordbook_id=? AND user_id=?", (wb_id, user["id"]))
    for e in exams:
        db.execute("DELETE FROM exams WHERE id=?", (e["id"],), commit=True)
    db.execute("DELETE FROM wordbooks WHERE id=?", (wb_id,), commit=True)
    return {"status": "success", "deleted_exams": len(exams)}


@app.get("/api/wordbooks/{wb_id}/exam-count")
def wordbook_exam_count(wb_id: int, user=Depends(current_user)):
    """단어장 삭제 확인용: 함께 삭제될 시험지 개수."""
    c = db.query_one("SELECT COUNT(*) c FROM exams WHERE wordbook_id=? AND user_id=?", (wb_id, user["id"]))["c"]
    return {"exam_count": c}


# ==================================================================
# 시험지: 생성 & 저장
# ==================================================================
class GenerateBody(BaseModel):
    words: list          # 선택된 단어 목록
    format: str          # toefl / sat / word_to_meaning / meaning_to_word / fill_meaning
    count: int = 10
    language: str = "en"
    meaning_lang: str = "ko"       # ko(한국어 뜻) / en(영영풀이)
    explain_lang: str | None = None  # 문제·해설 언어 (없으면 설정값)


@app.post("/api/exams/generate-start")
def generate_start(body: GenerateBody, user=Depends(current_user)):
    """문제 생성을 백그라운드로 시작하고 job_id 반환 (진행바용)."""
    if not body.words:
        raise HTTPException(400, "선택된 단어가 없습니다.")
    if body.format not in ai_quiz.FORMAT_LABELS:
        raise HTTPException(400, "알 수 없는 시험지 형식입니다.")

    full = auth.get_user_full(user["id"])
    explain_lang = body.explain_lang or full.get("explain_lang") or "ko"
    job_id = progress.create_job()

    def report(percent, message, log):
        progress.update(job_id, percent=percent, message=message, log=log)

    def worker():
        try:
            quiz = ai_quiz.generate_quiz(body.words, body.format, max(1, body.count), report,
                                         body.language, body.meaning_lang, explain_lang)
            if not quiz:
                progress.fail(job_id, "문제 생성에 실패했습니다.")
                return
            progress.finish(job_id, {"questions": quiz})
        except Exception as e:
            progress.fail(job_id, str(e))

    threading.Thread(target=worker, daemon=True).start()
    return {"status": "success", "job_id": job_id}


class SaveExamBody(BaseModel):
    name: str
    format: str
    questions: list
    wordbook_id: int | None = None


@app.post("/api/exams")
def save_exam(body: SaveExamBody, user=Depends(current_user)):
    if not body.name.strip() or not body.questions:
        raise HTTPException(400, "시험지 이름과 문제가 필요합니다.")

    exam_id = db.execute(
        "INSERT INTO exams (user_id, wordbook_id, name, format, questions, question_count, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (user["id"], body.wordbook_id, body.name.strip(), body.format,
         json.dumps(body.questions, ensure_ascii=False), len(body.questions), _now()),
        commit=True,
    )
    return {"status": "success", "exam_id": exam_id}


@app.get("/api/exams")
def list_exams(user=Depends(current_user)):
    # attempt_count / best_score 는 '현재 사용자 본인'의 응시 기준 (내 시험지 = 내 결과)
    rows = db.query_all(
        "SELECT e.id, e.name, e.format, e.question_count, e.created_at, wb.name AS wordbook_name, "
        "  (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND a.user_id = ?) AS attempt_count, "
        "  (SELECT MAX(a.score) FROM attempts a WHERE a.exam_id = e.id AND a.user_id = ?) AS best_score "
        "FROM exams e LEFT JOIN wordbooks wb ON wb.id = e.wordbook_id "
        "WHERE e.user_id = ? ORDER BY e.created_at DESC",
        (user["id"], user["id"], user["id"]),
    )
    for r in rows:
        r["format_label"] = ai_quiz.FORMAT_LABELS.get(r["format"], r["format"])
    return {"exams": rows}


def _exam_visible_to(user_id: int, exam_id: int):
    """본인이 소유한 시험지면 접근 허용."""
    return db.query_one("SELECT * FROM exams WHERE id=? AND user_id=?", (exam_id, user_id))


@app.get("/api/exams/{exam_id}")
def get_exam(exam_id: int, user=Depends(current_user)):
    exam = _exam_visible_to(user["id"], exam_id)
    if not exam:
        raise HTTPException(404, "시험지를 찾을 수 없습니다.")
    exam["questions"] = json.loads(exam["questions"])
    exam["format_label"] = ai_quiz.FORMAT_LABELS.get(exam["format"], exam["format"])
    return {"exam": exam}


@app.delete("/api/exams/{exam_id}")
def delete_exam(exam_id: int, user=Depends(current_user)):
    exam = db.query_one("SELECT id FROM exams WHERE id=? AND user_id=?", (exam_id, user["id"]))
    if not exam:
        raise HTTPException(404, "시험지를 찾을 수 없습니다.")
    db.execute("DELETE FROM exams WHERE id=?", (exam_id,), commit=True)
    return {"status": "success"}


# ==================================================================
# 응시 & 채점
# ==================================================================
@app.get("/api/grade-config")
def grade_config():
    """채점 설정(Gemini 하루 한도/오늘 사용량). 우측 상단 상태 배지용. 로그인 불필요."""
    return {
        "gemini_daily_limit": ai_quiz.GEMINI_DAILY_LIMIT,
        "gemini_used_today": ai_quiz._gemini_usage_today(),
    }


class GradeBody(BaseModel):
    exam_id: int
    answers: dict           # {"0": "답", "1": "답", ...}
    time_taken: int = 0
    ai_pregraded: list | None = None


@app.post("/api/attempts/grade-start")
def grade_start(body: GradeBody, user=Depends(current_user)):
    """채점을 백그라운드로 시작(주관식은 AI 채점). 완료 시 응시 기록 저장."""
    exam = _exam_visible_to(user["id"], body.exam_id)
    if not exam:
        raise HTTPException(404, "시험지를 찾을 수 없습니다.")
    quiz = json.loads(exam["questions"])

    job_id = progress.create_job()

    def report(percent, message, log):
        progress.update(job_id, percent=percent, message=message, log=log)

    def worker():
        try:
            report(10, "채점 시작...", "📝 답안 채점을 시작합니다.")
            outcome = ai_quiz.grade(quiz, body.answers, report, body.ai_pregraded)
            attempt_id = db.execute(
                "INSERT INTO attempts (exam_id, user_id, score, correct, total, time_taken, results, graded_by, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (body.exam_id, user["id"], outcome["score"], outcome["correct"],
                 outcome["total"], body.time_taken,
                 json.dumps(outcome["results"], ensure_ascii=False),
                 outcome.get("graded_by", ""), _now()),
                commit=True,
            )
            outcome["attempt_id"] = attempt_id
            progress.finish(job_id, outcome)
        except Exception as e:
            progress.fail(job_id, str(e))

    threading.Thread(target=worker, daemon=True).start()
    return {"status": "success", "job_id": job_id}


class SentenceCheckBody(BaseModel):
    word: str
    meaning: str = ""
    sentence: str
    language: str = "en"


@app.post("/api/learn/check-sentence")
def check_sentence(body: SentenceCheckBody, user=Depends(current_user)):
    """플래시카드 예문 AI 첨삭."""
    if not body.sentence.strip():
        raise HTTPException(400, "예문을 입력해주세요.")
    ex_lang = auth.get_user_full(user["id"]).get("explain_lang") or "ko"
    return ai_quiz.check_usage(body.word, body.meaning, body.sentence, body.language, ex_lang)


# ==================================================================
# 학부모 리포트 (읽기전용 공유 링크)
# ==================================================================
def _build_report(uid: int):
    """공유용 진도 리포트 데이터 집계."""
    u = auth.get_user_full(uid)
    if not u:
        return None
    wb = db.query_one("SELECT COUNT(*) c FROM wordbooks WHERE user_id=?", (uid,))["c"]
    words = db.query_one(
        "SELECT COUNT(*) c FROM words w JOIN wordbooks wb ON wb.id=w.wordbook_id WHERE wb.user_id=?",
        (uid,))["c"]
    ex = db.query_one("SELECT COUNT(*) c FROM exams WHERE user_id=?", (uid,))["c"]
    agg = db.query_one(
        "SELECT COUNT(*) c, COALESCE(ROUND(AVG(score)),0) avg, COALESCE(MAX(score),0) best "
        "FROM attempts WHERE user_id=?", (uid,))
    trend = list(reversed(db.query_all(
        "SELECT score, created_at FROM attempts WHERE user_id=? ORDER BY created_at DESC LIMIT 20", (uid,))))
    recent = db.query_all(
        "SELECT a.score, a.correct, a.total, a.created_at, e.name AS exam_name "
        "FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE a.user_id=? "
        "ORDER BY a.created_at DESC LIMIT 8", (uid,))
    return {
        "nickname": u.get("nickname") or u["email"].split("@")[0],
        "generated_at": _now(),
        "totals": {"wordbooks": wb, "words": words, "exams": ex, "attempts": agg["c"]},
        "avg_score": agg["avg"], "best_score": agg["best"],
        "trend": trend, "recent": recent,
    }


@app.post("/api/report/share")
def create_share(user=Depends(current_user)):
    """공유 토큰 발급(이미 있으면 재사용)."""
    row = db.query_one("SELECT token FROM report_shares WHERE user_id=?", (user["id"],))
    if row:
        token = row["token"]
    else:
        token = secrets.token_urlsafe(12)
        db.execute("INSERT INTO report_shares (token, user_id, created_at) VALUES (?, ?, ?)",
                   (token, user["id"], _now()), commit=True)
    return {"token": token, "path": f"/app/report.html?t={token}"}


@app.get("/api/report/share")
def get_share(user=Depends(current_user)):
    row = db.query_one("SELECT token FROM report_shares WHERE user_id=?", (user["id"],))
    return {"token": row["token"] if row else None,
            "path": f"/app/report.html?t={row['token']}" if row else None}


@app.delete("/api/report/share")
def revoke_share(user=Depends(current_user)):
    db.execute("DELETE FROM report_shares WHERE user_id=?", (user["id"],), commit=True)
    return {"status": "success"}


@app.get("/api/public/report/{token}")
def public_report(token: str):
    """토큰만 있으면 로그인 없이 볼 수 있는 리포트 (학부모용)."""
    row = db.query_one("SELECT user_id FROM report_shares WHERE token=?", (token,))
    if not row:
        raise HTTPException(404, "리포트를 찾을 수 없습니다.")
    data = _build_report(row["user_id"])
    if not data:
        raise HTTPException(404, "리포트를 찾을 수 없습니다.")
    return data


@app.get("/api/exams/{exam_id}/attempts")
def list_attempts(exam_id: int, user=Depends(current_user)):
    # 본인 소유 시험지만 접근 허용
    if not _exam_visible_to(user["id"], exam_id):
        raise HTTPException(404, "시험지를 찾을 수 없습니다.")
    return {"attempts": db.query_all(
        "SELECT id, score, correct, total, time_taken, created_at "
        "FROM attempts WHERE exam_id=? AND user_id=? ORDER BY created_at DESC", (exam_id, user["id"]),
    )}


@app.get("/api/attempts/{attempt_id}")
def get_attempt(attempt_id: int, user=Depends(current_user)):
    att = db.query_one("SELECT * FROM attempts WHERE id=? AND user_id=?", (attempt_id, user["id"]))
    if not att:
        raise HTTPException(404, "응시 기록을 찾을 수 없습니다.")
    att["results"] = json.loads(att["results"])
    return {"attempt": att}


class GradeReportBody(BaseModel):
    idx: int           # 신고할 문항 번호 (results의 idx, 1-based)
    comment: str = ""  # 학생이 남긴 설명(선택)


@app.post("/api/attempts/{attempt_id}/report-grade")
def report_grade_issue(attempt_id: int, body: GradeReportBody, user=Depends(current_user)):
    """학생이 '이 채점 이상해요'로 신고한 문항 기록 (파일럿: AI 오채점 실사례 수집)."""
    att = db.query_one("SELECT * FROM attempts WHERE id=? AND user_id=?", (attempt_id, user["id"]))
    if not att:
        raise HTTPException(404, "응시 기록을 찾을 수 없습니다.")
    results = json.loads(att["results"])
    item = next((r for r in results if r.get("idx") == body.idx), None)
    if not item:
        raise HTTPException(400, "문항을 찾을 수 없습니다.")
    db.execute(
        "INSERT INTO grade_reports (attempt_id, user_id, idx, word, student_ans, correct_ans, "
        "model_correct, graded_by, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (attempt_id, user["id"], body.idx, item.get("question", ""), item.get("user_ans", ""),
         item.get("correct_ans", ""), 1 if item.get("correct") else 0, att["graded_by"],
         (body.comment or "").strip()[:1000], _now()),
        commit=True)
    return {"status": "success"}


class PilotDeviceBody(BaseModel):
    webgpu: bool | None = None
    model_loaded: bool | None = None
    load_ms: int | None = None


@app.post("/api/pilot/device")
def pilot_device(body: PilotDeviceBody, request: Request, user=Depends(current_user)):
    """참가자 기기/접근성 기록(WebGPU·모델로딩·로딩시간). 필드별 upsert."""
    ua = (request.headers.get("user-agent") or "")[:300]
    wb = None if body.webgpu is None else (1 if body.webgpu else 0)
    ml = None if body.model_loaded is None else (1 if body.model_loaded else 0)
    db.execute(
        "INSERT INTO pilot_devices (user_id, webgpu, model_loaded, load_ms, user_agent, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(user_id) DO UPDATE SET "
        "webgpu=COALESCE(excluded.webgpu, webgpu), "
        "model_loaded=COALESCE(excluded.model_loaded, model_loaded), "
        "load_ms=COALESCE(excluded.load_ms, load_ms), "
        "user_agent=COALESCE(excluded.user_agent, user_agent), "
        "updated_at=excluded.updated_at",
        (user["id"], wb, ml, body.load_ms, ua, _now()), commit=True)
    return {"status": "success"}


@app.get("/api/admin/pilot")
def admin_pilot(user=Depends(current_user)):
    """관리자 콘솔: 파일럿 데이터(채점 모드 분포·온디바이스 성공률·오채점 신고)."""
    full = auth.get_user_full(user["id"])
    if not _is_admin_email(full["email"]):
        raise HTTPException(403, "관리자만 접근할 수 있습니다.")
    modes = db.query_all(
        "SELECT COALESCE(NULLIF(graded_by,''),'(none)') m, COUNT(*) c FROM attempts GROUP BY m")
    mode_map = {m["m"]: m["c"] for m in modes}
    on, sv = mode_map.get("ondevice", 0), mode_map.get("server", 0)
    written = on + sv

    # 기기/접근성 (IRR '접근 격차' 실증)
    devices = db.query_all(
        "SELECT d.user_id, d.webgpu, d.model_loaded, d.load_ms, d.user_agent, u.email "
        "FROM pilot_devices d LEFT JOIN users u ON u.id=d.user_id ORDER BY d.updated_at DESC")
    load_times = [d["load_ms"] for d in devices if d["load_ms"]]
    device = {
        "total": len(devices),
        "webgpu_yes": sum(1 for d in devices if d["webgpu"]),
        "loaded_yes": sum(1 for d in devices if d["model_loaded"]),
        "avg_load_s": round(sum(load_times) / len(load_times) / 1000, 1) if load_times else None,
        "list": devices,
    }

    # 참가자별 집계
    per = db.query_all(
        "SELECT a.user_id, u.email, COUNT(*) attempts, "
        "SUM(CASE WHEN a.graded_by='ondevice' THEN 1 ELSE 0 END) ondevice, "
        "SUM(CASE WHEN a.graded_by='server' THEN 1 ELSE 0 END) server, "
        "ROUND(AVG(a.score)) avg_score "
        "FROM attempts a LEFT JOIN users u ON u.id=a.user_id GROUP BY a.user_id ORDER BY attempts DESC")
    rep_by_user = {r["user_id"]: r["c"] for r in db.query_all(
        "SELECT user_id, COUNT(*) c FROM grade_reports GROUP BY user_id")}
    for p in per:
        p["reports"] = rep_by_user.get(p["user_id"], 0)

    reports = db.query_all(
        "SELECT gr.idx, gr.word, gr.student_ans, gr.correct_ans, gr.model_correct, gr.graded_by, "
        "gr.comment, gr.created_at, u.email FROM grade_reports gr LEFT JOIN users u ON u.id=gr.user_id "
        "ORDER BY gr.created_at DESC LIMIT 300")
    return {
        "modes": mode_map,
        "ondevice_rate": round(on / written * 100) if written else None,
        "written_attempts": written,
        "gemini_fallback": sv,
        "total_attempts": db.query_one("SELECT COUNT(*) c FROM attempts")["c"],
        "participants": db.query_one("SELECT COUNT(DISTINCT user_id) c FROM attempts")["c"],
        "report_count": db.query_one("SELECT COUNT(*) c FROM grade_reports")["c"],
        "device": device,
        "per_participant": per,
        "reports": reports,
    }


# ==================================================================
# PDF 다운로드
# ==================================================================
@app.post("/api/report/pdf")
def download_progress_pdf(user=Depends(current_user)):
    """전체 학습 진도 리포트 PDF."""
    uid = user["id"]
    full = auth.get_user_full(uid)
    agg = db.query_one("SELECT COUNT(*) c, COALESCE(ROUND(AVG(score)),0) avg, COALESCE(MAX(score),0) best "
                       "FROM attempts WHERE user_id=?", (uid,))
    week_ago = (datetime.now(timezone.utc) - _timedelta(days=7)).isoformat()
    week = db.query_one("SELECT COUNT(*) c FROM attempts WHERE user_id=? AND created_at>=?", (uid, week_ago))["c"]
    exams = db.query_all(
        "SELECT e.name, MAX(a.score) best, ROUND(AVG(a.score)) avg, COUNT(a.id) attempts "
        "FROM exams e JOIN attempts a ON a.exam_id=e.id AND a.user_id=? WHERE e.user_id=? "
        "GROUP BY e.id ORDER BY MAX(a.created_at) DESC LIMIT 12", (uid, uid))
    data = {
        "name": full.get("nickname") or full["email"].split("@")[0],
        "avg": agg["avg"], "best": agg["best"], "attempts": agg["c"], "week": week,
        "exams": exams,
    }
    out = os.path.join(UPLOAD_DIR, f"progress_{uid}.pdf")
    pdf_export.create_progress_pdf(data, out)
    return FileResponse(out, filename="학습리포트.pdf", media_type="application/pdf")


class PdfOptions(BaseModel):
    title: str | None = None
    font: str = "round"        # round(둥근고딕) | serif(명조) | sans(기본고딕)
    font_size: int = 10        # 문항 글자 크기(pt)
    columns: int = 1           # 1 | 2 단
    spacing: int = 8           # 문항 간격
    answer_key: bool = True     # (사용 안함) 정답지는 별도 파일로
    header_fields: bool = True  # 이름/날짜/점수 칸
    show_school: bool = True    # 상단 브랜드 문구
    kind: str = "quiz"          # quiz(문제지) | answers(정답·해설지, 별도 PDF)


@app.post("/api/exams/{exam_id}/pdf")
def download_exam_pdf(exam_id: int, user=Depends(current_user), opts: PdfOptions | None = None):
    exam = db.query_one("SELECT * FROM exams WHERE id=? AND user_id=?", (exam_id, user["id"]))
    if not exam:
        raise HTTPException(404, "시험지를 찾을 수 없습니다.")
    o = (opts or PdfOptions()).dict()
    kind = o.get("kind", "quiz")
    o["kind"] = kind
    o["watermark"] = False
    o["title"] = (o.get("title") or exam["name"]).strip() or exam["name"]
    suffix = "_answers" if kind == "answers" else ""
    out = os.path.join(UPLOAD_DIR, f"quiz_{exam_id}{suffix}.pdf")
    pdf_export.create_quiz_pdf(json.loads(exam["questions"]), out, options=o)
    fname = f"{o['title']}{'_정답' if kind == 'answers' else ''}.pdf"
    return FileResponse(out, filename=fname, media_type="application/pdf")


@app.post("/api/attempts/{attempt_id}/pdf")
def download_report_pdf(attempt_id: int, user=Depends(current_user)):
    att = db.query_one("SELECT * FROM attempts WHERE id=? AND user_id=?", (attempt_id, user["id"]))
    if not att:
        raise HTTPException(404, "응시 기록을 찾을 수 없습니다.")
    data = {"score": att["score"], "correct": att["correct"], "total": att["total"],
            "results": json.loads(att["results"])}
    out = os.path.join(UPLOAD_DIR, f"report_{attempt_id}.pdf")
    pdf_export.create_report_pdf(data, out)
    return FileResponse(out, filename=f"report_{attempt_id}.pdf", media_type="application/pdf")


# ==================================================================
# 정적 파일 (프론트엔드)
# ==================================================================
app.mount("/", StaticFiles(directory="static", html=True), name="static")
