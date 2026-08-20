#!/usr/bin/env bash
# ============================================================
# VoQuiz 자동 배포 감시 스크립트
#   origin/main 에 새 커밋이 있으면 자동으로 pull + 재배포한다.
#   서버 cron 에서 주기적으로 실행 (예: 2분마다).
#     */2 * * * * /usr/bin/flock -n /tmp/voquiz-deploy.lock /root/voquiz/auto-deploy.sh >> /var/log/voquiz-deploy.log 2>&1
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    exit 0   # 변경 없음 → 조용히 종료 (로그 안 남김)
fi

echo "[$(date '+%F %T')] 새 버전 감지 ${LOCAL:0:7} → ${REMOTE:0:7} · 재배포 시작"
git reset --hard origin/main
bash deploy.sh
echo "[$(date '+%F %T')] ✅ 재배포 완료"
