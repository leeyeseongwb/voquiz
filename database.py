"""
database.py
-----------
SQLite 데이터베이스 스키마 정의 및 접근 헬퍼.

VocaShot의 모든 영속 데이터(사용자, 단어장, 단어, 시험지, 응시 기록)를
하나의 SQLite 파일(data/vocashot.db)에 저장한다.

관계형으로 저장하는 이유:
- 여러 사용자를 안전하게 분리 (user_id 외래키)
- 단어장 → 단어, 시험지 → 응시기록 처럼 1:N 관계가 자연스럽게 표현됨
- 응시 기록을 여러 번 쌓아도(이력 보존) 조회/집계가 쉬움
"""

import os
import sqlite3
import threading
from contextlib import contextmanager

# DB 파일 경로 (프로젝트 루트의 data 폴더 안)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "vocashot.db")

# sqlite는 기본적으로 스레드 간 커넥션 공유가 안전하지 않으므로
# 요청마다 커넥션을 새로 열고 닫는 방식을 사용한다.
_write_lock = threading.Lock()


def _connect():
    """새 DB 커넥션 생성. row_factory 로 dict 처럼 접근 가능하게 설정."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")  # 외래키 제약 활성화
    return conn


@contextmanager
def get_db():
    """with 문으로 커넥션을 안전하게 열고 닫는 헬퍼."""
    conn = _connect()
    try:
        yield conn
    finally:
        conn.close()


# ------------------------------------------------------------------
# 스키마
# ------------------------------------------------------------------
SCHEMA = """
-- 사용자 계정
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,      -- pbkdf2 해시 (salt 포함)
    is_verified   INTEGER NOT NULL DEFAULT 0,  -- 이메일 인증 여부(0/1)
    created_at    TEXT NOT NULL
);

-- 이메일 인증 코드 (회원가입 시 발급)
CREATE TABLE IF NOT EXISTS verification_codes (
    email      TEXT PRIMARY KEY,      -- 이메일당 하나만 유지(재발급 시 덮어씀)
    code       TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- 로그인 세션 (쿠키 토큰 저장)
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 단어장 (업로드한 PDF 1건 = 단어장 1개)
CREATE TABLE IF NOT EXISTS wordbooks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    source_name TEXT DEFAULT '',      -- 원본 파일명
    created_at  TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 단어 (단어장에 속함)
CREATE TABLE IF NOT EXISTS words (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    wordbook_id INTEGER NOT NULL,
    seq         INTEGER NOT NULL,     -- 단어장 내 순번(번호)
    word        TEXT NOT NULL,
    meaning     TEXT DEFAULT '',      -- 한국어 뜻
    definition  TEXT DEFAULT '',      -- 영어 정의
    example     TEXT DEFAULT '',      -- 예문
    page        INTEGER DEFAULT 1,    -- 원본 PDF 페이지 번호
    FOREIGN KEY (wordbook_id) REFERENCES wordbooks(id) ON DELETE CASCADE
);

-- 시험지 (생성된 문제 세트)
CREATE TABLE IF NOT EXISTS exams (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    wordbook_id   INTEGER,            -- 어떤 단어장 기반인지(삭제돼도 시험지는 남김)
    name          TEXT NOT NULL,
    format        TEXT NOT NULL,      -- toefl / sat / word_to_meaning / meaning_to_word / fill_meaning
    questions     TEXT NOT NULL,      -- 문제 JSON 배열 (문자열로 저장)
    question_count INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (wordbook_id) REFERENCES wordbooks(id) ON DELETE SET NULL
);

-- 학부모 리포트 공유 (사용자당 토큰 하나로 읽기전용 리포트 링크 발급)
CREATE TABLE IF NOT EXISTS report_shares (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 응시 기록 (한 시험지를 여러 번 볼 수 있고, 모든 기록 보존)
CREATE TABLE IF NOT EXISTS attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id     INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    score       INTEGER NOT NULL,     -- 백분율 점수
    correct     INTEGER NOT NULL,
    total       INTEGER NOT NULL,
    time_taken  INTEGER DEFAULT 0,    -- 소요 시간(초)
    results     TEXT NOT NULL,        -- 문항별 채점 결과 JSON
    graded_by   TEXT DEFAULT '',      -- 채점 방식: local / ondevice / server (파일럿 계측)
    created_at  TEXT NOT NULL,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 파일럿: 학생이 "이 채점 이상해요"라고 신고한 문항 (AI 오채점 실사례 수집)
CREATE TABLE IF NOT EXISTS grade_reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id    INTEGER NOT NULL,
    user_id       INTEGER NOT NULL,
    idx           INTEGER,            -- 문항 번호(1-based)
    word          TEXT,
    student_ans   TEXT,
    correct_ans   TEXT,
    model_correct INTEGER,            -- 모델이 매긴 정오 (1/0)
    graded_by     TEXT,               -- ondevice / server
    created_at    TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 학원/교사 모드: 반(class)
CREATE TABLE IF NOT EXISTS classes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL,
    name       TEXT NOT NULL,
    join_code  TEXT UNIQUE NOT NULL,   -- 학생이 반에 참여할 때 입력하는 코드
    created_at TEXT NOT NULL,
    FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 반 구성원 (학생)
CREATE TABLE IF NOT EXISTS class_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id   INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    joined_at  TEXT NOT NULL,
    UNIQUE(class_id, student_id),
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 반에 배정된 시험지 (과제)
CREATE TABLE IF NOT EXISTS assignments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id    INTEGER NOT NULL,
    exam_id     INTEGER NOT NULL,
    assigned_at TEXT NOT NULL,
    UNIQUE(class_id, exam_id),
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
);

-- 로스터 학생 (선생님이 직접 등록 · Student ID + PIN 로그인)
CREATE TABLE IF NOT EXISTS roster_students (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id   INTEGER NOT NULL,
    teacher_id INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,          -- 학습/응시를 위한 백엔드 계정
    code       TEXT UNIQUE NOT NULL,      -- 학생에게 발급되는 Student ID (예: S-4821)
    pin        TEXT NOT NULL,             -- 로그인 PIN (평문 저장: 선생님이 재확인 가능)
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 반에 배정된 단어장
CREATE TABLE IF NOT EXISTS wordbook_assignments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id    INTEGER NOT NULL,
    wordbook_id INTEGER NOT NULL,
    assigned_at TEXT NOT NULL,
    UNIQUE(class_id, wordbook_id),
    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
    FOREIGN KEY (wordbook_id) REFERENCES wordbooks(id) ON DELETE CASCADE
);

-- 알림 (시험지 배정 등 → 학생에게 표시)
CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,       -- 알림을 받는 사용자
    type       TEXT DEFAULT 'info',    -- assign / info 등
    title      TEXT NOT NULL,
    body       TEXT DEFAULT '',
    is_read    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 학습 플래너 (망각곡선 기반 계획). 사용자당 활성 플랜 1개.
CREATE TABLE IF NOT EXISTS study_plans (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    name         TEXT NOT NULL,
    goal         TEXT DEFAULT '',
    start_date   TEXT NOT NULL,
    target_date  TEXT,
    daily_new    INTEGER NOT NULL DEFAULT 10,
    wordbook_ids TEXT DEFAULT '[]',    -- JSON 배열
    schedule     TEXT NOT NULL,        -- JSON: [{date, new:[...], review:[...]}]
    intervals    TEXT DEFAULT '[]',    -- 사용된 복습 간격(일) JSON
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 플랜의 특정 날짜 완료 표시 (오늘 할 일 체크)
CREATE TABLE IF NOT EXISTS plan_done (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id  INTEGER NOT NULL,
    user_id  INTEGER NOT NULL,
    date     TEXT NOT NULL,
    kind     TEXT NOT NULL,            -- new / review
    UNIQUE(plan_id, date, kind),
    FOREIGN KEY (plan_id) REFERENCES study_plans(id) ON DELETE CASCADE
);

-- AI 사용량 (월별 카운트). 무료 등급의 AI 사용 제한/예산 관리용.
CREATE TABLE IF NOT EXISTS ai_usage (
    user_id  INTEGER NOT NULL,
    ym       TEXT NOT NULL,            -- 'YYYY-MM'
    feature  TEXT NOT NULL,            -- 'planner' / 'credits' 등
    count    INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, ym, feature),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

"""


def init_db():
    """앱 시작 시 스키마를 생성(없을 때만)하고, 필요한 컬럼 마이그레이션 수행."""
    with get_db() as conn:
        conn.executescript(SCHEMA)
        conn.commit()
    _migrate()


def _migrate():
    """
    이미 존재하는 users 테이블에 뒤늦게 추가된 컬럼을 채워 넣는다.
    (SQLite 는 'ADD COLUMN IF NOT EXISTS' 가 없어 수동으로 확인)
    - nickname: 표시용 닉네임
    - avatar:   프로필 사진 (data URL 문자열)
    - tier:     회원 등급 (basic / premium)
    """
    with get_db() as conn:
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
        if "nickname" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN nickname TEXT DEFAULT ''")
        if "avatar" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''")
        if "tier" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN tier TEXT DEFAULT 'basic'")
        if "provider" not in cols:  # local / google (OAuth)
            conn.execute("ALTER TABLE users ADD COLUMN provider TEXT DEFAULT 'local'")
        if "explain_lang" not in cols:  # 문제·해설 언어 기본값 (ko/en/ja/zh...)
            conn.execute("ALTER TABLE users ADD COLUMN explain_lang TEXT DEFAULT 'ko'")

        # 응시 기록: 채점 방식(local/ondevice/server) — 파일럿 계측용
        at_cols = {row["name"] for row in conn.execute("PRAGMA table_info(attempts)")}
        if "graded_by" not in at_cols:
            conn.execute("ALTER TABLE attempts ADD COLUMN graded_by TEXT DEFAULT ''")

        # 단어장 언어 (en=영어, zh=중국어)
        wb_cols = {row["name"] for row in conn.execute("PRAGMA table_info(wordbooks)")}
        if "language" not in wb_cols:
            conn.execute("ALTER TABLE wordbooks ADD COLUMN language TEXT DEFAULT 'en'")
        if "meaning_lang" not in wb_cols:  # 단어 '뜻'의 언어 (ko/en/ja...)
            conn.execute("ALTER TABLE wordbooks ADD COLUMN meaning_lang TEXT DEFAULT 'ko'")

        # 단어 발음/병음 (중국어 pinyin 등)
        w_cols = {row["name"] for row in conn.execute("PRAGMA table_info(words)")}
        if "reading" not in w_cols:
            conn.execute("ALTER TABLE words ADD COLUMN reading TEXT DEFAULT ''")

        # 학습 플랜: 공부 안 하는 요일(JSON 배열, JS getDay 기준)
        sp_cols = {row["name"] for row in conn.execute("PRAGMA table_info(study_plans)")}
        if "exclude_weekdays" not in sp_cols:
            conn.execute("ALTER TABLE study_plans ADD COLUMN exclude_weekdays TEXT DEFAULT '[]'")

        # 로스터 학생: 반 안에서만 유일한 숫자 학생 ID (전역 코드 충돌 방지)
        rs_cols = {row["name"] for row in conn.execute("PRAGMA table_info(roster_students)")}
        if "sid" not in rs_cols:
            conn.execute("ALTER TABLE roster_students ADD COLUMN sid TEXT DEFAULT ''")

        # 애드온(일회성 구매): 추가 크레딧 · 반 슬롯 · 학생 슬롯
        for col in ("addon_credits", "addon_classes", "addon_students"):
            if col not in cols:
                conn.execute(f"ALTER TABLE users ADD COLUMN {col} INTEGER DEFAULT 0")

        conn.commit()


def execute(query, params=(), commit=False):
    """단일 쿼리 실행. commit=True 면 변경사항 반영하고 lastrowid 반환."""
    if commit:
        with _write_lock:
            with get_db() as conn:
                cur = conn.execute(query, params)
                conn.commit()
                return cur.lastrowid
    else:
        with get_db() as conn:
            cur = conn.execute(query, params)
            return cur.lastrowid


def query_one(query, params=()):
    """한 행 조회 → dict 또는 None."""
    with get_db() as conn:
        row = conn.execute(query, params).fetchone()
        return dict(row) if row else None


def query_all(query, params=()):
    """여러 행 조회 → list[dict]."""
    with get_db() as conn:
        rows = conn.execute(query, params).fetchall()
        return [dict(r) for r in rows]


def executemany(query, seq_of_params):
    """다건 삽입(단어 목록 저장 등)."""
    with _write_lock:
        with get_db() as conn:
            conn.executemany(query, seq_of_params)
            conn.commit()
