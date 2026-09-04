#!/usr/bin/env bash
# Install the portal as a systemd service (native deployment — no Docker).
#
#   sudo bash service_manager/deploy/install-native.sh
#
# Idempotent: safe to re-run (re-installs the unit, restarts cleanly).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # service_manager/deploy
STACK="$(cd "$HERE/../.." && pwd)"                      # web_service
UNIT=lilak-portal.service
OWNER=cens-alpha-00

[ "$(id -u)" -eq 0 ] || { echo "sudo 로 실행해 주세요: sudo bash $0" >&2; exit 1; }
[ -x "$STACK/run-native.sh" ] || { echo "run-native.sh 없음: $STACK" >&2; exit 1; }

PORT="$(sed -n 's/^PORTAL_PORT=\(.*\)$/\1/p' "$STACK/.env" | tail -1)"
PORT="${PORT:-8025}"

echo "==> 1/6  Docker 컨테이너가 남아 있으면 정지 (포트 충돌 방지)"
if command -v docker >/dev/null && docker ps --format '{{.Names}}' | grep -q '^web_service-portal-1$'; then
  ( cd "$STACK" && docker compose stop portal )
else
  echo "    (이미 내려가 있음)"
fi

echo "==> 2/6  유닛 설치"
install -m644 "$HERE/$UNIT" /etc/systemd/system/
systemctl daemon-reload

echo "==> 3/6  부팅 시 자동시작 등록"
systemctl enable "$UNIT"

# 손으로 띄운 포탈과 그 포탈이 spawn 한 서비스들을 정리한다. 포트가 충돌하는 것도
# 문제지만, 더 중요한 건 유닛 밖에서 뜬 서비스는 유닛의 cgroup 밖에 있어서
# MemoryMax 가 그들을 덮지 못한다는 점이다. PID 를 정확히 짚어서 죽인다 —
# 이 호스트에는 다른 컨테이너(stark_daq, mfmhs)도 돌고 있어서 pkill -f 패턴
# 매칭은 남의 프로세스를 잡을 수 있다.
echo "==> 4/6  임시로 띄워둔 포탈 / 서비스 정리"
DATA="$(sed -n 's/^PORTAL_DATA_DIR=\(.*\)$/\1/p' "$STACK/.env" | tail -1)"
DATA="$(cd "$STACK/${DATA:-./portal-data}" && pwd)"
for pidfile in "$DATA"/*/.pid "$DATA"/*/projects/*/.pid; do
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  echo "    서비스 pid $pid  ($(dirname "$pidfile"))"
  kill "$pid" 2>/dev/null || true
done
for pid in $(pgrep -u "$OWNER" -f 'uvicorn app\.main:app' || true); do
  echo "    포탈 pid $pid"
  kill "$pid" 2>/dev/null || true
done
for _ in $(seq 30); do
  ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN || break
  sleep 0.5
done
if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then
  echo "    아직 $PORT 를 잡고 있어 강제 종료" >&2
  for pid in $(pgrep -u "$OWNER" -f 'uvicorn app\.main:app' || true); do kill -9 "$pid" 2>/dev/null || true; done
  sleep 1
fi

echo "==> 5/6  기동"
systemctl start "$UNIT"

echo "==> 6/6  확인"
for _ in $(seq 30); do
  curl -fsS -o /dev/null "http://localhost:$PORT/api/health" 2>/dev/null && break
  sleep 0.5
done
systemctl --no-pager --lines=0 status "$UNIT" || true
echo
echo "health: $(curl -fsS "http://localhost:$PORT/api/health" 2>&1 || echo '응답 없음 — journalctl -u lilak-portal -n 50')"
echo
echo "메모리 상한 적용 여부:"
systemctl show "$UNIT" -p MemoryMax -p MemorySwapMax -p OOMPolicy
echo
echo "다음부터는:  sudo systemctl {start|stop|restart|status} lilak-portal"
echo "로그:        journalctl -u lilak-portal -f"
