#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# EmailHunter — One-Click Deploy Script
# ============================================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║       EmailHunter — Deploy Script        ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

# ----------------------------------------------------------
# Step 1: ตรวจ Docker
# ----------------------------------------------------------
echo -e "${BLUE}[1/6] ตรวจสอบ Docker...${NC}"
if ! command -v docker &>/dev/null; then
    echo -e "${RED}ERROR: Docker ไม่ได้ติดตั้ง กรุณาติดตั้ง Docker ก่อน${NC}"
    exit 1
fi
if ! docker info &>/dev/null; then
    echo -e "${RED}ERROR: Docker daemon ไม่ทำงาน กรุณาเปิด Docker ก่อน${NC}"
    exit 1
fi
echo -e "${GREEN}  Docker พร้อมใช้งาน${NC}"

# ----------------------------------------------------------
# Step 2: สร้าง .env จาก .env.template
# ----------------------------------------------------------
echo -e "${BLUE}[2/6] สร้างไฟล์ .env...${NC}"
if [ -f "$PROJECT_DIR/.env" ]; then
    echo -e "${YELLOW}  .env มีอยู่แล้ว — ใช้ค่าเดิม${NC}"
else
    if [ ! -f "$PROJECT_DIR/.env.template" ]; then
        echo -e "${RED}ERROR: ไม่พบ .env.template${NC}"
        exit 1
    fi
    N8N_KEY=$(openssl rand -hex 32)
    SEARX_SECRET=$(openssl rand -hex 32)
    sed \
        -e "s|N8N_ENCRYPTION_KEY=__REPLACE_ME__|N8N_ENCRYPTION_KEY=${N8N_KEY}|" \
        -e "s|SEARXNG_SECRET=__REPLACE_ME__|SEARXNG_SECRET=${SEARX_SECRET}|" \
        "$PROJECT_DIR/.env.template" > "$PROJECT_DIR/.env"
    echo -e "${GREEN}  .env สร้างเสร็จ (secrets auto-generated)${NC}"
    echo -e "${YELLOW}  หมายเหตุ: LINE_NOTIFY_TOKEN ยังเป็นค่า default — กรุณาแก้ไขใน .env${NC}"
fi

# ----------------------------------------------------------
# Step 3: สร้าง data directory สำหรับ API
# ----------------------------------------------------------
echo -e "${BLUE}[3/6] สร้าง data directories...${NC}"
mkdir -p "$PROJECT_DIR/api"
echo -e "${GREEN}  data directories พร้อม${NC}"

# ----------------------------------------------------------
# Step 4: Build API Docker image
# ----------------------------------------------------------
echo -e "${BLUE}[4/6] Build API Docker image...${NC}"
cd "$PROJECT_DIR"
docker compose build
echo -e "${GREEN}  Build เสร็จสิ้น${NC}"

# ----------------------------------------------------------
# Step 5: Pull images & Start containers
# ----------------------------------------------------------
echo -e "${BLUE}[5/6] Pull images และ Start containers...${NC}"
cd "$PROJECT_DIR"
docker compose pull --ignore-buildable
docker compose up -d

# ----------------------------------------------------------
# Step 6: Health Check
# ----------------------------------------------------------
echo -e "${BLUE}[6/6] ตรวจสอบ Health ทุก service...${NC}"

check_service() {
    local name="$1"
    local url="$2"
    local max_wait="$3"
    local elapsed=0

    while [ $elapsed -lt "$max_wait" ]; do
        if curl -sf "$url" >/dev/null 2>&1; then
            echo -e "  ${GREEN}${name}: READY${NC}"
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    echo -e "  ${RED}${name}: NOT READY (timeout ${max_wait}s)${NC}"
    return 1
}

check_container() {
    local name="$1"
    local max_wait="$2"
    local elapsed=0

    while [ $elapsed -lt "$max_wait" ]; do
        if docker ps --format '{{.Names}}' | grep -q "^${name}$"; then
            local status
            status=$(docker inspect --format='{{.State.Status}}' "$name" 2>/dev/null)
            if [ "$status" = "running" ]; then
                echo -e "  ${GREEN}${name}: RUNNING${NC}"
                return 0
            fi
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    echo -e "  ${RED}${name}: NOT RUNNING${NC}"
    return 1
}

HEALTH_OK=true

check_container "emailhunter-redis" 30 || HEALTH_OK=false
check_container "emailhunter-api" 30 || HEALTH_OK=false
check_service "SearXNG (port 8888)" "http://localhost:8888" 60 || HEALTH_OK=false
check_service "n8n (port 5679)" "http://localhost:5679/healthz" 60 || HEALTH_OK=false
check_service "Dashboard (port 8890)" "http://localhost:8890" 30 || HEALTH_OK=false

echo ""
echo -e "${CYAN}══════════════════════════════════════════${NC}"
if [ "$HEALTH_OK" = true ]; then
    echo -e "${GREEN}  Deploy สำเร็จ! ทุก service พร้อมใช้งาน${NC}"
else
    echo -e "${YELLOW}  Deploy เสร็จ แต่บาง service อาจยังไม่พร้อม${NC}"
    echo -e "${YELLOW}  กรุณาตรวจสอบด้วย: docker compose ps${NC}"
fi
echo -e "${CYAN}══════════════════════════════════════════${NC}"
echo ""
echo -e "${GREEN}  n8n:       http://localhost:5679${NC}"
echo -e "${GREEN}  SearXNG:   http://localhost:8888${NC}"
echo -e "${GREEN}  Dashboard: http://localhost:8890${NC}"
echo ""
echo -e "${BLUE}คำสั่งที่ใช้บ่อย:${NC}"
echo "  docker compose ps          — ดูสถานะ containers"
echo "  docker compose logs -f     — ดู logs"
echo "  docker compose down        — หยุดทุก service"
echo "  docker compose restart     — restart ทุก service"
echo ""
echo -e "${YELLOW}LINE Notify:${NC}"
echo "  หากต้องการรับ notification ผ่าน LINE ให้ตั้งค่า LINE_NOTIFY_TOKEN ใน .env"
echo "  1. ไปที่ https://notify-bot.line.me/my/"
echo "  2. สร้าง Token ใหม่"
echo "  3. แก้ไข .env: LINE_NOTIFY_TOKEN=<your-token>"
echo "  4. รัน: docker compose restart api"
echo ""
