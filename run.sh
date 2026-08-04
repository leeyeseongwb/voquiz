#!/bin/bash
# VocaShot 실행 스크립트
# 사용법: ./run.sh
set -e
cd "$(dirname "$0")"

# 가상환경이 없으면 생성 후 의존성 설치
if [ ! -d "venv" ]; then
    echo "🔧 가상환경 생성 중..."
    python3 -m venv venv
    ./venv/bin/pip install -q -r requirements.txt
fi

# 기존 8000 포트 프로세스 정리
lsof -ti :8000 | xargs kill -9 2>/dev/null || true

echo "🚀 VocaShot 서버 시작 → http://127.0.0.1:8000"
./venv/bin/uvicorn app:app --reload --port 8000
