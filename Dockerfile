# VoQuiz (FastAPI + SQLite) — pdf2image + poppler(system)
FROM python:3.12-slim

# poppler-utils: pdf2image가 PDF를 이미지로 변환할 때 필요한 시스템 패키지
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 먼저 설치 (코드보다 앞에 둬서 레이어 캐시 활용)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 앱 코드 복사 (data/uploads/venv 등은 .dockerignore로 제외)
COPY . .

# 영속 데이터는 /data 볼륨에 저장 → 재배포(이미지 재빌드)해도 회원 데이터 보존
ENV DATA_DIR=/data \
    UPLOAD_DIR=/data/uploads \
    PORT=8080 \
    PYTHONUNBUFFERED=1
RUN mkdir -p /data/uploads

EXPOSE 8080

# progress.py가 메모리 기반이라 워커는 1개(단일 프로세스)로 실행
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips='*'"]
