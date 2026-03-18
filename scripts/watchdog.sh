#!/bin/bash
# ─────────────────────────────────────────────────────────────
# EmailHunter Watchdog — ตรวจสอบ container ทุก 5 นาที
# ถ้า container ตาย → restart + แจ้ง Lark/LINE
# ติดตั้ง: crontab -e → */5 * * * * /path/to/watchdog.sh
# ─────────────────────────────────────────────────────────────

COMPOSE_DIR="/Users/rattanasak/Documents/Cursor Project/EmailHunter"
LOG_FILE="$COMPOSE_DIR/logs/watchdog.log"

# สร้าง log directory
mkdir -p "$COMPOSE_DIR/logs"

# โหลด notification helper
source "$COMPOSE_DIR/scripts/notify.sh"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# เช็คว่า Docker daemon รันอยู่ไหม
if ! docker info > /dev/null 2>&1; then
  log "ERROR: Docker daemon is not running!"
  send_alert \
    "EmailHunter ALERT - Docker Down" \
    "**Docker daemon ไม่ทำงาน!**\nกรุณาเปิด OrbStack/Docker Desktop\nServer: $(hostname)" \
    "red"

  # พยายามเปิด OrbStack
  if command -v open &> /dev/null; then
    open -a OrbStack 2>/dev/null
    log "Attempted to start OrbStack"
  fi
  exit 1
fi

# รายชื่อ container ที่ต้องรัน
REQUIRED_CONTAINERS="emailhunter-api emailhunter-dashboard emailhunter-searxng emailhunter-n8n emailhunter-redis"
DOWN_CONTAINERS=""

for CONTAINER in $REQUIRED_CONTAINERS; do
  STATUS=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)

  if [ "$STATUS" != "running" ]; then
    DOWN_CONTAINERS="$DOWN_CONTAINERS $CONTAINER"
    log "DETECTED: $CONTAINER is $STATUS (not running)"
  fi
done

# ถ้ามี container ตาย → docker compose up -d
if [ -n "$DOWN_CONTAINERS" ]; then
  log "Restarting containers:$DOWN_CONTAINERS"

  cd "$COMPOSE_DIR"
  docker compose up -d 2>> "$LOG_FILE"
  RESULT=$?

  if [ $RESULT -eq 0 ]; then
    log "docker compose up -d SUCCESS"
  else
    log "docker compose up -d FAILED (exit code: $RESULT)"
  fi

  # รอ 10 วินาทีแล้วเช็คอีกครั้ง
  sleep 10

  STILL_DOWN=""
  for CONTAINER in $DOWN_CONTAINERS; do
    STATUS=$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null)
    if [ "$STATUS" != "running" ]; then
      STILL_DOWN="$STILL_DOWN $CONTAINER"
    fi
  done

  # แจ้งเตือน Lark + LINE
  if [ -n "$STILL_DOWN" ]; then
    send_alert \
      "EmailHunter CRITICAL - Restart Failed" \
      "**Container ตายและ restart ไม่สำเร็จ!**\n\nตาย:$DOWN_CONTAINERS\nยังตาย:$STILL_DOWN\n\nต้องเข้าไปแก้ไขด้วยตัวเอง!" \
      "red"
    log "CRITICAL: Still down after restart:$STILL_DOWN"
  else
    send_alert \
      "EmailHunter RECOVERED" \
      "**Container ถูก restart สำเร็จ**\n\nที่ตาย:$DOWN_CONTAINERS\nสถานะ: กลับมาทำงานแล้ว" \
      "yellow"
    log "RECOVERED: All containers back online"
  fi
else
  # ทุกอย่างปกติ — log แค่ทุกชั่วโมง (นาทีที่ 0)
  MINUTE=$(date '+%M')
  if [ "$MINUTE" -lt 5 ]; then
    log "OK: All containers running"
  fi
fi

# Rotate log (เก็บแค่ 1000 บรรทัดล่าสุด)
if [ -f "$LOG_FILE" ] && [ $(wc -l < "$LOG_FILE") -gt 1000 ]; then
  tail -500 "$LOG_FILE" > "$LOG_FILE.tmp"
  mv "$LOG_FILE.tmp" "$LOG_FILE"
  log "Log rotated"
fi
