#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# EmailHunter — Server Migration Script
# ย้ายระบบไปเซิร์ฟเวอร์ใหม่
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   EmailHunter — Migration Script     ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""

# ถามข้อมูลเซิร์ฟเวอร์ใหม่
read -rp "IP เซิร์ฟเวอร์ใหม่: " NEW_IP
read -rp "Username: " NEW_USER
read -rp "Path ปลายทาง (default: /home/$NEW_USER/EmailHunter): " NEW_PATH
NEW_PATH="${NEW_PATH:-/home/$NEW_USER/EmailHunter}"

echo ""
echo -e "${YELLOW}ข้อมูลที่จะใช้:${NC}"
echo "  Server: $NEW_USER@$NEW_IP"
echo "  Path:   $NEW_PATH"
echo ""
read -rp "ยืนยัน? (y/n): " CONFIRM
if [ "$CONFIRM" != "y" ]; then
    echo -e "${RED}ยกเลิกการย้าย${NC}"
    exit 0
fi

# Step 1: Backup
echo ""
echo -e "${BLUE}[1/3] สำรองข้อมูลก่อนย้าย...${NC}"
bash "$PROJECT_DIR/scripts/backup.sh"

# หาไฟล์ backup ล่าสุด
LATEST_BACKUP=$(ls -t "$PROJECT_DIR/backups"/backup_*.tar.gz 2>/dev/null | head -1)
if [ -z "$LATEST_BACKUP" ]; then
    echo -e "${RED}ERROR: ไม่พบไฟล์ backup${NC}"
    exit 1
fi

# Step 2: SCP
echo -e "${BLUE}[2/3] ส่งไฟล์ไปเซิร์ฟเวอร์ใหม่...${NC}"
echo -e "  กำลังสร้าง directory ที่เซิร์ฟเวอร์ปลายทาง..."
ssh "$NEW_USER@$NEW_IP" "mkdir -p $NEW_PATH"

echo -e "  กำลังส่ง project files..."
scp -r "$PROJECT_DIR/docker-compose.yml" \
       "$PROJECT_DIR/.env.template" \
       "$PROJECT_DIR/deploy.sh" \
       "$PROJECT_DIR/stats.json" \
       "$PROJECT_DIR/GUIDE.md" \
       "$NEW_USER@$NEW_IP:$NEW_PATH/"

scp -r "$PROJECT_DIR/searxng" "$NEW_USER@$NEW_IP:$NEW_PATH/"
scp -r "$PROJECT_DIR/n8n-workflows" "$NEW_USER@$NEW_IP:$NEW_PATH/"
scp -r "$PROJECT_DIR/dashboard" "$NEW_USER@$NEW_IP:$NEW_PATH/"
scp -r "$PROJECT_DIR/scripts" "$NEW_USER@$NEW_IP:$NEW_PATH/"

echo -e "  กำลังส่งไฟล์ backup..."
scp "$LATEST_BACKUP" "$NEW_USER@$NEW_IP:$NEW_PATH/"

# Step 3: แสดงขั้นตอนถัดไป
echo ""
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo -e "${GREEN}  ส่งไฟล์สำเร็จ!${NC}"
echo -e "${GREEN}════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}ขั้นตอนถัดไปที่เซิร์ฟเวอร์ใหม่:${NC}"
echo ""
echo "  1. SSH เข้าเซิร์ฟเวอร์ใหม่:"
echo "     ssh $NEW_USER@$NEW_IP"
echo ""
echo "  2. เข้า directory:"
echo "     cd $NEW_PATH"
echo ""
echo "  3. ให้สิทธิ์ scripts:"
echo "     chmod +x deploy.sh scripts/*.sh"
echo ""
echo "  4. Deploy:"
echo "     bash deploy.sh"
echo ""
echo "  5. Restore n8n data (ถ้าต้องการ):"
echo "     BACKUP_FILE=\$(ls backup_*.tar.gz | head -1)"
echo "     mkdir -p /tmp/restore && tar xzf \$BACKUP_FILE -C /tmp/restore"
echo "     docker cp /tmp/restore/n8n-data/. emailhunter-n8n:/home/node/.n8n/"
echo "     docker compose restart emailhunter-n8n"
echo ""
echo "  6. ทดสอบ:"
echo "     bash scripts/test.sh"
echo ""
