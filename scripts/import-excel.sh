#!/usr/bin/env bash
set -euo pipefail

# EmailHunter — Excel Import Script
# Usage: ./scripts/import-excel.sh /path/to/companies.xlsx

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════════╗"
echo -e "║     EmailHunter — Excel Import Script    ║"
echo -e "╚══════════════════════════════════════════╝${NC}"

if [ -z "${1:-}" ]; then
    echo -e "${RED}ERROR: กรุณาระบุไฟล์ Excel${NC}"
    echo "Usage: $0 /path/to/companies.xlsx"
    exit 1
fi

FILE="$1"
if [ ! -f "$FILE" ]; then
    echo -e "${RED}ERROR: ไม่พบไฟล์ $FILE${NC}"
    exit 1
fi

# Check file extension
EXT="${FILE##*.}"
if [[ "$EXT" != "xlsx" && "$EXT" != "xls" ]]; then
    echo -e "${RED}ERROR: รองรับเฉพาะไฟล์ .xlsx หรือ .xls${NC}"
    exit 1
fi

FILE_SIZE=$(du -h "$FILE" | cut -f1)
echo -e "${BLUE}ไฟล์: $FILE ($FILE_SIZE)${NC}"
echo -e "${YELLOW}กำลัง upload... (อาจใช้เวลาสักครู่สำหรับไฟล์ขนาดใหญ่)${NC}"

# Upload via API
RESPONSE=$(curl -s -w "\n%{http_code}" \
    -F "file=@$FILE" \
    http://localhost:8890/api/import \
    --max-time 600)

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}Import สำเร็จ!${NC}"
    echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
else
    echo -e "${RED}Import ล้มเหลว (HTTP $HTTP_CODE)${NC}"
    echo "$BODY"
    exit 1
fi

echo ""
echo -e "${GREEN}เสร็จสิ้น! ตรวจสอบผลลัพธ์ที่ Dashboard: http://localhost:8890${NC}"
