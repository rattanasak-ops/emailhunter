#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# EmailHunter — Backup Script
# สำรอง n8n data + configs → tar.gz
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="backup_${TIMESTAMP}.tar.gz"

echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     EmailHunter — Backup Script      ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""

# สร้าง directory backup
mkdir -p "$BACKUP_DIR"

echo -e "${BLUE}[1/4] สำรอง n8n data volume...${NC}"
# Export n8n volume data
TEMP_DIR=$(mktemp -d)
docker cp emailhunter-n8n:/home/node/.n8n "$TEMP_DIR/n8n-data" 2>/dev/null || echo -e "${YELLOW}  ข้ามไป — n8n container อาจไม่ทำงาน${NC}"

echo -e "${BLUE}[2/4] สำรอง shared data...${NC}"
docker cp emailhunter-n8n:/home/node/shared "$TEMP_DIR/shared-data" 2>/dev/null || echo -e "${YELLOW}  ข้ามไป — shared data อาจไม่มี${NC}"

echo -e "${BLUE}[3/4] สำรอง config files...${NC}"
mkdir -p "$TEMP_DIR/configs"
cp -r "$PROJECT_DIR/docker-compose.yml" "$TEMP_DIR/configs/" 2>/dev/null || true
cp -r "$PROJECT_DIR/.env" "$TEMP_DIR/configs/" 2>/dev/null || true
cp -r "$PROJECT_DIR/searxng" "$TEMP_DIR/configs/" 2>/dev/null || true
cp -r "$PROJECT_DIR/n8n-workflows" "$TEMP_DIR/configs/" 2>/dev/null || true
cp -r "$PROJECT_DIR/dashboard" "$TEMP_DIR/configs/" 2>/dev/null || true
cp -r "$PROJECT_DIR/stats.json" "$TEMP_DIR/configs/" 2>/dev/null || true

echo -e "${BLUE}[4/4] สร้างไฟล์ backup...${NC}"
cd "$TEMP_DIR"
tar czf "$BACKUP_DIR/$BACKUP_FILE" . 2>/dev/null

# ลบ temp
rm -rf "$TEMP_DIR"

# ลบ backup เก่ากว่า 30 วัน
echo -e "${BLUE}ลบ backup เก่ากว่า 30 วัน...${NC}"
find "$BACKUP_DIR" -name "backup_*.tar.gz" -mtime +30 -delete 2>/dev/null || true

# แสดงผล
FILESIZE=$(du -h "$BACKUP_DIR/$BACKUP_FILE" | cut -f1)
echo ""
echo -e "${GREEN}สำรองข้อมูลสำเร็จ!${NC}"
echo -e "  ไฟล์: ${BLUE}$BACKUP_DIR/$BACKUP_FILE${NC}"
echo -e "  ขนาด: ${BLUE}$FILESIZE${NC}"
echo ""

# แสดง backup ทั้งหมด
echo -e "${BLUE}Backup ที่มี:${NC}"
ls -lh "$BACKUP_DIR"/backup_*.tar.gz 2>/dev/null | awk '{print "  " $5 "\t" $9}'
echo ""
