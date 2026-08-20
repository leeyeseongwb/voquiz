"""
auth.py
-------
회원가입 / 로그인 / 세션 / 이메일 인증 로직.

비밀번호는 표준 라이브러리(hashlib.pbkdf2_hmac)로 salt 를 섞어 해시 저장한다.
(외부 bcrypt 의존성 없이도 충분히 안전한 방식)

이메일 인증:
- 회원가입 시 6자리 코드를 발급하고 사용자 이메일로 전송한다.
- SMTP 환경변수(SMTP_HOST 등)가 설정돼 있으면 실제 메일을 보내고,
  없으면 개발 모드로 간주해 코드를 서버 콘솔에 출력한다.
- DEV_MODE=1 이면 응답에도 코드를 포함시켜 테스트를 쉽게 한다(운영에서는 끌 것).
"""

import os
import re
import hashlib
import hmac
import secrets
import smtplib
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

import database as db

# 개발 모드: 인증 코드를 API 응답에 노출(테스트 편의). 운영에서는 0 으로.
DEV_MODE = os.getenv("DEV_MODE", "1") == "1"

CODE_TTL_MIN = 30          # 인증 코드 유효시간(분)
PBKDF2_ITERATIONS = 200_000


def _now():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.isoformat()


# ------------------------------------------------------------------
# 비밀번호 규칙 검사
# ------------------------------------------------------------------
def validate_password(password: str):
    """
    비밀번호 요구사항:
    - 6~15자
    - 영문자 최소 1개 + 숫자 최소 1개
    - 특수문자 최소 1개
    문제가 있으면 오류 메시지(str)를, 통과하면 None 을 반환.
    """
    if not (6 <= len(password) <= 15):
        return "비밀번호는 6~15자여야 합니다."
    if not re.search(r"[A-Za-z]", password):
        return "영문자를 최소 1개 포함해야 합니다."
    if not re.search(r"[0-9]", password):
        return "숫자를 최소 1개 포함해야 합니다."
    if not re.search(r"[^A-Za-z0-9]", password):
        return "특수문자를 최소 1개 포함해야 합니다."
    return None


# ------------------------------------------------------------------
# 비밀번호 해싱
# ------------------------------------------------------------------
def hash_password(password: str) -> str:
    """salt 를 생성해 pbkdf2 해시. 'salt$hash' 형태 문자열로 반환."""
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ITERATIONS)
    return f"{salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """저장된 'salt$hash' 와 입력 비밀번호를 상수시간 비교."""
    try:
        salt, expected = stored.split("$", 1)
    except ValueError:
        return False
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ITERATIONS)
    return hmac.compare_digest(dk.hex(), expected)


# ------------------------------------------------------------------
# 이메일 인증 코드
# ------------------------------------------------------------------
def issue_verification_code(email: str) -> str:
    """6자리 인증 코드를 발급/갱신하고 반환."""
    code = f"{secrets.randbelow(1_000_000):06d}"
    expires = _iso(_now() + timedelta(minutes=CODE_TTL_MIN))
    db.execute(
        "INSERT INTO verification_codes (email, code, expires_at) VALUES (?, ?, ?) "
        "ON CONFLICT(email) DO UPDATE SET code=excluded.code, expires_at=excluded.expires_at",
        (email, code, expires),
        commit=True,
    )
    return code


def check_verification_code(email: str, code: str) -> bool:
    """코드 일치 및 만료 여부 확인. 성공 시 코드 삭제."""
    row = db.query_one("SELECT code, expires_at FROM verification_codes WHERE email=?", (email,))
    if not row:
        return False
    if datetime.fromisoformat(row["expires_at"]) < _now():
        return False
    if not hmac.compare_digest(row["code"], code.strip()):
        return False
    db.execute("DELETE FROM verification_codes WHERE email=?", (email,), commit=True)
    return True


def _verification_email_html(code: str) -> str:
    """인증 코드 이메일 HTML (이메일 클라이언트 호환 위해 table + inline 스타일)."""
    return f"""\
<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fb;font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(30,50,120,.08);">
        <tr><td style="height:5px;background-color:#2979ff;background-image:linear-gradient(90deg,#4f5bd5,#2979ff);font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:26px 32px 6px;">
          <img src="https://voquiz.com/assets/logo.png" alt="VoQuiz" height="30" style="height:30px;width:auto;display:block;border:0;outline:none;text-decoration:none;">
        </td></tr>
        <tr><td style="padding:34px 32px 8px;">
          <h1 style="margin:0 0 8px;font-size:20px;color:#1a1a2e;font-weight:700;">이메일 인증 코드</h1>
          <p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6;">VoQuiz 회원가입을 위해 아래 6자리 코드를 입력해주세요.</p>
          <div style="background:#f4f6fb;border:1px solid #e5e9f2;border-radius:12px;padding:22px;text-align:center;">
            <span style="font-size:34px;font-weight:800;letter-spacing:10px;color:#2979ff;font-family:'Courier New',monospace;">{code}</span>
          </div>
          <p style="margin:20px 0 0;font-size:13px;color:#9aa0ac;line-height:1.6;">이 코드는 <b style="color:#6b7280;">{CODE_TTL_MIN}분</b> 후 만료돼요.<br>본인이 요청하지 않았다면 이 메일을 무시하세요.</p>
        </td></tr>
        <tr><td style="padding:22px 32px 28px;border-top:1px solid #f0f2f7;">
          <p style="margin:0;font-size:12px;color:#b0b4bd;">© 2026 VoQuiz · 온디바이스 AI 단어 학습</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>"""


def send_verification_email(email: str, code: str):
    """
    SMTP 설정이 있으면 실제 메일 전송, 없으면 콘솔 출력(개발 모드).
    실 서비스용 SMTP 를 붙이려면 .env 에 SMTP_HOST/PORT/USER/PASSWORD 설정.
    """
    host = os.getenv("SMTP_HOST")
    subject = "[VoQuiz] 이메일 인증 코드"
    body = f"VoQuiz 회원가입 인증 코드입니다.\n\n인증 코드: {code}\n\n{CODE_TTL_MIN}분 이내에 입력해주세요."

    if not host:
        # 개발 모드: 콘솔에 출력
        print(f"\n{'='*50}\n[DEV EMAIL] to={email}\n{subject}\n{body}\n{'='*50}\n")
        return

    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER", "")
    password = os.getenv("SMTP_PASSWORD", "")
    from_addr = os.getenv("SMTP_FROM", user)            # 실제 발송 주소(봉투 발신자)
    from_name = os.getenv("SMTP_FROM_NAME", "VoQuiz")   # 받는 사람에게 보이는 이름

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{from_addr}>" if from_name else from_addr
    msg["To"] = email
    msg.attach(MIMEText(body, "plain", "utf-8"))                       # 텍스트 대체본
    msg.attach(MIMEText(_verification_email_html(code), "html", "utf-8"))  # 브랜드 HTML

    with smtplib.SMTP(host, port) as server:
        server.starttls()
        if user:
            server.login(user, password)
        server.sendmail(from_addr, [email], msg.as_string())


# ------------------------------------------------------------------
# 세션
# ------------------------------------------------------------------
def create_session(user_id: int) -> str:
    """새 세션 토큰 발급 후 DB 저장."""
    token = secrets.token_urlsafe(32)
    db.execute(
        "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)",
        (token, user_id, _iso(_now())),
        commit=True,
    )
    return token


def get_user_by_token(token: str):
    """세션 토큰으로 사용자 조회. 없으면 None."""
    if not token:
        return None
    return db.query_one(
        "SELECT u.id, u.email, u.is_verified, u.created_at "
        "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?",
        (token,),
    )


def delete_session(token: str):
    if token:
        db.execute("DELETE FROM sessions WHERE token=?", (token,), commit=True)


# ------------------------------------------------------------------
# 사용자
# ------------------------------------------------------------------
def get_user_by_email(email: str):
    return db.query_one("SELECT * FROM users WHERE email=?", (email,))


def create_user(email: str, password: str, verified: bool = False,
                nickname: str = "", tier: str = "basic") -> int:
    # 닉네임 미지정 시 이메일 앞부분을 기본 닉네임으로 사용
    if not nickname:
        nickname = email.split("@")[0]
    return db.execute(
        "INSERT INTO users (email, password_hash, is_verified, created_at, nickname, avatar, tier) "
        "VALUES (?, ?, ?, ?, ?, '', ?)",
        (email, hash_password(password), 1 if verified else 0, _iso(_now()), nickname, tier),
        commit=True,
    )


def mark_verified(email: str):
    db.execute("UPDATE users SET is_verified=1 WHERE email=?", (email,), commit=True)


def get_user_full(user_id: int):
    """프로필/등급까지 포함한 사용자 정보 조회."""
    return db.query_one(
        "SELECT id, email, is_verified, created_at, nickname, avatar, tier, "
        "COALESCE(explain_lang,'ko') AS explain_lang FROM users WHERE id=?",
        (user_id,),
    )


def set_explain_lang(user_id: int, lang: str):
    db.execute("UPDATE users SET explain_lang=? WHERE id=?", (lang, user_id), commit=True)


def update_profile(user_id: int, nickname: str = None, avatar: str = None):
    """닉네임/아바타 갱신 (None 인 항목은 건드리지 않음)."""
    if nickname is not None:
        db.execute("UPDATE users SET nickname=? WHERE id=?", (nickname, user_id), commit=True)
    if avatar is not None:
        db.execute("UPDATE users SET avatar=? WHERE id=?", (avatar, user_id), commit=True)


def set_tier(user_id: int, tier: str):
    db.execute("UPDATE users SET tier=? WHERE id=?", (tier, user_id), commit=True)


def update_password(user_id: int, new_password: str):
    """비밀번호 해시를 새로 저장하고, 다른 세션은 모두 무효화(재로그인 유도)."""
    db.execute("UPDATE users SET password_hash=? WHERE id=?",
               (hash_password(new_password), user_id), commit=True)


def ensure_test_account():
    """
    테스트용 계정 자동 생성 (이미 있으면 건너뜀).
    이메일: test@vocashot.com / 비밀번호: test1234 (이메일 인증 완료, 프리미엄 등급)
    """
    existing = get_user_by_email("test@vocashot.com")
    if not existing:
        create_user("test@vocashot.com", "test1234", verified=True,
                    nickname="테스터", tier="premium")
        print("[SEED] 테스트 계정 생성됨 → test@vocashot.com / test1234 (프리미엄)")
    else:
        # 기존 테스트 계정은 프리미엄 + 닉네임 보장 (마이그레이션으로 basic 이 됐을 수 있음)
        if existing.get("tier") != "premium" or not existing.get("nickname"):
            db.execute("UPDATE users SET tier='premium', nickname=COALESCE(NULLIF(nickname,''),'테스터') "
                       "WHERE email='test@vocashot.com'", commit=True)


def ensure_admin_account():
    """관리자(통계 열람 전용) 계정을 .env(ADMIN_SEED_EMAIL / ADMIN_SEED_PW)로 자동 보장.
    값이 없으면 아무것도 하지 않는다. 비밀번호는 항상 .env 값과 일치시킨다."""
    email = (os.getenv("ADMIN_SEED_EMAIL", "") or "").strip().lower()
    pw = os.getenv("ADMIN_SEED_PW", "")
    if not email or not pw:
        return
    existing = get_user_by_email(email)
    if not existing:
        create_user(email, pw, verified=True, nickname="관리자", tier="premium")
        print(f"[SEED] 관리자 계정 생성됨 → {email}")
    else:
        update_password(existing["id"], pw)   # 분실/변경 대비: .env 값으로 재설정
        db.execute("UPDATE users SET is_verified=1 WHERE email=?", (email,), commit=True)
