#!/usr/bin/env bash
set -uo pipefail

# ============================================================
# EmailHunter — Test All Services
# ============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0

echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║    EmailHunter — Service Test         ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
echo ""

test_service() {
    local name="$1"
    local cmd="$2"
    local expect="$3"

    echo -n "  Testing $name... "
    result=$(eval "$cmd" 2>&1) || true

    if echo "$result" | grep -qi "$expect"; then
        echo -e "${GREEN}PASS${NC}"
        PASS=$((PASS + 1))
    else
        echo -e "${RED}FAIL${NC}"
        echo -e "    ${YELLOW}Expected: $expect${NC}"
        echo -e "    ${YELLOW}Got: $(echo "$result" | head -1)${NC}"
        FAIL=$((FAIL + 1))
    fi
}

# ทดสอบ Containers Running
echo -e "${BLUE}[1] Container Status${NC}"
for cname in emailhunter-searxng emailhunter-redis emailhunter-n8n emailhunter-api emailhunter-dashboard; do
    status=$(docker inspect --format='{{.State.Status}}' "$cname" 2>/dev/null || echo "not found")
    if [ "$status" = "running" ]; then
        echo -e "  ${GREEN}PASS${NC} $cname: running"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}FAIL${NC} $cname: $status"
        FAIL=$((FAIL + 1))
    fi
done

echo ""

# ทดสอบ Services
echo -e "${BLUE}[2] Service Health${NC}"
test_service "SearXNG (port 8888)" \
    "curl -sf 'http://localhost:8888/healthz' --max-time 10 || docker exec emailhunter-searxng wget -qO- 'http://127.0.0.1:8080/healthz'" \
    "OK"

test_service "API (internal health)" \
    "docker exec emailhunter-api wget -qO- 'http://127.0.0.1:3456/api/health'" \
    "ok"

test_service "n8n (port 5680)" \
    "curl -sf 'http://localhost:5680/healthz' --max-time 10 || docker exec emailhunter-n8n wget -qO- 'http://127.0.0.1:5678/healthz'" \
    "ok"

test_service "Dashboard (port 8890)" \
    "curl -sf 'http://localhost:8890' --max-time 10 || docker exec emailhunter-dashboard wget -qO- 'http://127.0.0.1'" \
    "EmailHunter"

test_service "Redis (PING)" \
    "docker exec emailhunter-redis redis-cli ping" \
    "PONG"

echo ""

# ทดสอบ Network
echo -e "${BLUE}[3] Network${NC}"
NETWORK_NAME=$(docker inspect --format='{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' emailhunter-api 2>/dev/null || true)
NETWORK=$(docker network inspect "$NETWORK_NAME" --format='{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || echo "not found")
if [ -n "$NETWORK_NAME" ] && [ "$NETWORK" != "not found" ]; then
    echo -e "  ${GREEN}PASS${NC} Network subnet: $NETWORK"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}FAIL${NC} Network subnet: $NETWORK (network: ${NETWORK_NAME:-not found})"
    FAIL=$((FAIL + 1))
fi

echo ""

# ทดสอบ Resource Usage
echo -e "${BLUE}[4] Resource Usage${NC}"
echo "  $(docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}' 2>/dev/null | grep emailhunter || echo 'Cannot read stats')"

echo ""

# สรุป
echo -e "${BLUE}══════════════════════════════════════${NC}"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
    echo -e "${GREEN}  ALL TESTS PASSED: $PASS/$TOTAL${NC}"
else
    echo -e "${YELLOW}  RESULTS: $PASS PASS / $FAIL FAIL (total $TOTAL)${NC}"
fi
echo -e "${BLUE}══════════════════════════════════════${NC}"
echo ""
