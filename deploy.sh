#!/usr/bin/env bash
# ============================================================
# VoQuiz 재배포 스크립트 (도커)
#   새 코드로 이미지를 다시 빌드하고 컨테이너를 교체한다.
#   회원 데이터(vocashot_data 볼륨의 /data)는 그대로 보존된다.
#
#   사용법(서버에서):  cd /root/vocashot && bash deploy.sh
# ============================================================
set -euo pipefail

NAME=vocashot          # 컨테이너 이름
IMAGE=vocashot         # 이미지 이름
VOLUME=vocashot_data   # 데이터 볼륨(→ /data)
PORT=8080              # 앱 포트
ENVFILE=/root/voquiz.env

echo "==> 1) 기존 컨테이너 설정 백업"
OLD_NET=bridge
OLD_RESTART=unless-stopped
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  # 앱 비밀 환경변수를 파일로 보존 (시스템/Dockerfile 변수는 제외). 최초 1회만 생성.
  if [ ! -f "$ENVFILE" ]; then
    docker inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' \
      | grep -vE '^(PATH|LANG|GPG_KEY|HOME|HOSTNAME|PYTHON_|DATA_DIR=|UPLOAD_DIR=|PORT=|PYTHONUNBUFFERED=)' \
      > "$ENVFILE" || true
    echo "    → 환경변수 저장: $ENVFILE"
  else
    echo "    → 기존 $ENVFILE 유지"
  fi
  OLD_NET=$(docker inspect "$NAME" --format '{{.HostConfig.NetworkMode}}')
  OLD_RESTART=$(docker inspect "$NAME" --format '{{.HostConfig.RestartPolicy.Name}}')
  # 롤백용으로 현재 이미지를 백업 태그
  docker image inspect "$IMAGE" >/dev/null 2>&1 && docker tag "$IMAGE" "${IMAGE}:backup" || true
else
  echo "    → 기존 컨테이너 없음(최초 배포)"
  : > "$ENVFILE"
fi
[ "$OLD_NET" = "default" ] && OLD_NET=bridge
if [ -z "$OLD_RESTART" ] || [ "$OLD_RESTART" = "no" ]; then OLD_RESTART=unless-stopped; fi

echo "==> 2) 새 기능 필수 환경변수 보장(없을 때만 추가)"
ensure(){ grep -q "^$1=" "$ENVFILE" || echo "$1=$2" >> "$ENVFILE"; }
ensure DEV_MODE 0
ensure SESSION_SECURE 1
ensure SIGNUP_KEY Voquiz-Beta-Wanbang
ensure GEMINI_DAILY_LIMIT 500
ensure ADMIN_EMAILS leeyeseongwb@gmail.com

echo "==> 3) 이미지 빌드 (기존 컨테이너는 계속 실행 → 빌드 중 무중단)"
docker build -t "$IMAGE" .

echo "==> 4) 컨테이너 교체 (볼륨/포트/네트워크/재시작정책 유지)"
docker stop "$NAME" 2>/dev/null || true
docker rm "$NAME" 2>/dev/null || true
docker run -d --name "$NAME" --restart "$OLD_RESTART" \
  --network "$OLD_NET" \
  -p ${PORT}:${PORT} \
  -v ${VOLUME}:/data \
  --env-file "$ENVFILE" \
  "$IMAGE"

echo "==> 5) 상태 확인"
sleep 3
docker ps --filter "name=$NAME"
echo "---- 로그(최근 25줄) ----"
docker logs "$NAME" --tail 25 || true
echo ""
echo "✅ 완료. https://voquiz.com/signup 에서 새 버전(가입 키 칸) 확인하세요."
echo "   문제 시 롤백:  docker rm -f $NAME && docker run -d --name $NAME --restart $OLD_RESTART --network $OLD_NET -p ${PORT}:${PORT} -v ${VOLUME}:/data --env-file $ENVFILE ${IMAGE}:backup"
