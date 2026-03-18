#!/bin/bash
# ─────────────────────────────────────────────────────────────
# EmailHunter — ติดตั้ง cron jobs ทั้งหมด
# รันครั้งเดียว: bash scripts/setup-cron.sh
# ─────────────────────────────────────────────────────────────

SCRIPT_DIR="/Users/rattanasak/Documents/Cursor Project/EmailHunter/scripts"

# ทำให้ scripts executable
chmod +x "$SCRIPT_DIR/watchdog.sh"
chmod +x "$SCRIPT_DIR/daily-backup.sh"

echo "=== EmailHunter Cron Setup ==="
echo ""

# สร้าง cron entries
CRON_ENTRIES="
# ─── EmailHunter Automated Tasks ───
# Watchdog: เช็ค container ทุก 5 นาที
*/5 * * * * $SCRIPT_DIR/watchdog.sh >> /dev/null 2>&1

# Backup: ก่อน session เริ่ม (00:50)
50 0 * * * $SCRIPT_DIR/daily-backup.sh pre-session >> /dev/null 2>&1

# Backup: หลัง session จบ (09:10)
10 9 * * * $SCRIPT_DIR/daily-backup.sh post-session >> /dev/null 2>&1
# ─── End EmailHunter ───"

# เช็คว่ามี cron ของ EmailHunter อยู่แล้วหรือยัง
EXISTING=$(crontab -l 2>/dev/null)

if echo "$EXISTING" | grep -q "EmailHunter"; then
  echo "⚠️  พบ cron ของ EmailHunter อยู่แล้ว"
  echo "   ลบของเก่าแล้วเพิ่มใหม่..."
  # ลบ entries เก่า
  CLEANED=$(echo "$EXISTING" | sed '/EmailHunter/d' | sed '/watchdog.sh/d' | sed '/daily-backup.sh/d')
  echo "$CLEANED
$CRON_ENTRIES" | crontab -
else
  # เพิ่มใหม่
  (echo "$EXISTING"; echo "$CRON_ENTRIES") | crontab -
fi

echo ""
echo "✅ Cron jobs ติดตั้งเรียบร้อย:"
echo ""
echo "   */5 * * * *  watchdog.sh      — เช็ค container ทุก 5 นาที"
echo "   50 0 * * *   daily-backup.sh  — backup ก่อน session (00:50)"
echo "   10 9 * * *   daily-backup.sh  — backup หลัง session (09:10)"
echo ""
echo "=== ตรวจสอบ cron ปัจจุบัน ==="
crontab -l 2>/dev/null | grep -A1 "EmailHunter\|watchdog\|backup"
echo ""
echo "=== OrbStack Auto-Start ==="
echo "เปิด OrbStack → Settings → General → ✅ Start at login"
echo ""
