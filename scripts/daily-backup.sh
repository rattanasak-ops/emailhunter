#!/bin/bash
# ─────────────────────────────────────────────────────────────
# EmailHunter Daily Backup — สำรอง database ทุกวัน
# รันก่อน session เริ่ม (00:50) และหลังจบ session (09:10)
# ติดตั้ง: crontab -e →
#   50 0 * * * /path/to/daily-backup.sh pre-session
#   10 9 * * * /path/to/daily-backup.sh post-session
# ─────────────────────────────────────────────────────────────

COMPOSE_DIR="/Users/rattanasak/Documents/Cursor Project/EmailHunter"
BACKUP_DIR="$COMPOSE_DIR/backups"
LOG_FILE="$COMPOSE_DIR/logs/backup.log"
CONTAINER="emailhunter-api"
DB_PATH="/data/emailhunter.db"
KEEP_DAYS=30

# สร้าง directories
mkdir -p "$BACKUP_DIR" "$COMPOSE_DIR/logs"

# โหลด notification helper
source "$COMPOSE_DIR/scripts/notify.sh"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

TYPE="${1:-daily}"
DATE=$(date '+%Y-%m-%d')
TIME=$(date '+%H%M')
FILENAME="emailhunter_${TYPE}_${DATE}_${TIME}.db"

log "Starting $TYPE backup..."

# เช็คว่า container รันอยู่
if ! docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null | grep -q running; then
  log "ERROR: $CONTAINER is not running, cannot backup"
  send_alert \
    "EmailHunter Backup FAILED" \
    "**Container $CONTAINER ไม่ทำงาน**\nไม่สามารถ backup ได้\nType: $TYPE" \
    "red"
  exit 1
fi

# Backup โดยใช้ SQLite .backup command (safe สำหรับ WAL mode)
docker exec "$CONTAINER" sqlite3 "$DB_PATH" ".backup '/data/backups/$FILENAME'" 2>> "$LOG_FILE"
RESULT=$?

if [ $RESULT -eq 0 ] && [ -f "$BACKUP_DIR/$FILENAME" ]; then
  SIZE=$(du -h "$BACKUP_DIR/$FILENAME" | cut -f1)
  log "SUCCESS: $FILENAME ($SIZE)"

  # Export CSV ด้วย (สำหรับ recovery ง่าย)
  CSV_FILE="emailhunter_${TYPE}_${DATE}_${TIME}.csv"
  docker exec "$CONTAINER" sqlite3 -header -csv "$DB_PATH" \
    "SELECT id, company_name, email, status, source_url, processed_date, created_at, updated_at FROM companies" \
    > "$BACKUP_DIR/$CSV_FILE" 2>> "$LOG_FILE"

  ROWS=0
  CSV_SIZE="0"
  if [ -f "$BACKUP_DIR/$CSV_FILE" ]; then
    CSV_SIZE=$(du -h "$BACKUP_DIR/$CSV_FILE" | cut -f1)
    ROWS=$(wc -l < "$BACKUP_DIR/$CSV_FILE")
  fi

  log "CSV exported: $CSV_FILE ($CSV_SIZE, $ROWS rows)"

  send_alert \
    "EmailHunter Backup OK" \
    "**Type:** $TYPE\n**DB:** $FILENAME ($SIZE)\n**CSV:** $CSV_FILE ($ROWS rows)\n**Keep:** $KEEP_DAYS days" \
    "green"
else
  log "ERROR: Backup failed (exit: $RESULT)"
  send_alert \
    "EmailHunter Backup FAILED" \
    "**Type:** $TYPE\n**Error code:** $RESULT\n**File:** $FILENAME" \
    "red"
  exit 1
fi

# ลบ backup เก่ากว่า KEEP_DAYS วัน
DELETED=$(find "$BACKUP_DIR" -name "emailhunter_*.db" -mtime +$KEEP_DAYS -delete -print | wc -l)
DELETED_CSV=$(find "$BACKUP_DIR" -name "emailhunter_*.csv" -mtime +$KEEP_DAYS -delete -print | wc -l)
if [ "$DELETED" -gt 0 ] || [ "$DELETED_CSV" -gt 0 ]; then
  log "Cleaned up: $DELETED old db + $DELETED_CSV old csv backups (older than $KEEP_DAYS days)"
fi

# Rotate log
if [ -f "$LOG_FILE" ] && [ $(wc -l < "$LOG_FILE") -gt 500 ]; then
  tail -250 "$LOG_FILE" > "$LOG_FILE.tmp"
  mv "$LOG_FILE.tmp" "$LOG_FILE"
fi
