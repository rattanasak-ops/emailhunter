#!/bin/bash
# Restore CSV data back into EmailHunter DB
# Usage: ./scripts/restore-csv.sh <csv-file>

set -e

CSV_FILE="${1:-}"
API_URL="http://localhost:3456"

if [ -z "$CSV_FILE" ]; then
  echo "Usage: $0 <csv-file>"
  echo "Example: $0 ~/Downloads/emailhunter_export_2026-03-13.csv"
  exit 1
fi

if [ ! -f "$CSV_FILE" ]; then
  echo "ERROR: File not found: $CSV_FILE"
  exit 1
fi

echo "=== EmailHunter CSV Restore ==="
echo "File: $CSV_FILE"
echo "Size: $(du -h "$CSV_FILE" | cut -f1)"
echo "Lines: $(wc -l < "$CSV_FILE")"
echo ""

# Check API is running
echo "Checking API..."
HEALTH=$(docker exec emailhunter-api wget -qO- http://127.0.0.1:3456/api/health 2>/dev/null || echo "FAIL")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo "API is healthy: $HEALTH"
else
  echo "ERROR: API is not running. Start with: docker compose up -d"
  exit 1
fi

echo ""
echo "Uploading CSV to /api/restore..."

# Copy CSV into container and curl from inside
docker cp "$CSV_FILE" emailhunter-api:/tmp/restore.csv

RESULT=$(docker exec emailhunter-api sh -c '
  wget -qO- --post-file=/tmp/restore.csv \
    --header="Content-Type: multipart/form-data" \
    http://127.0.0.1:3456/api/health
' 2>/dev/null || echo "")

# Use curl from host instead (more reliable for multipart)
# First check if the API port is exposed
API_PORT=$(docker port emailhunter-api 3456 2>/dev/null | head -1 || echo "")

if [ -z "$API_PORT" ]; then
  echo "API port not exposed. Using docker exec approach..."
  # Install curl in container and use it
  RESULT=$(docker exec emailhunter-api sh -c "
    cd /tmp && \
    wget -qO- --post-file=restore.csv \
      --header='Content-Type: text/csv' \
      'http://127.0.0.1:3456/api/restore' 2>&1 || echo 'UPLOAD_FAILED'
  ")
else
  # Use curl from host
  RESULT=$(curl -s -X POST \
    -F "file=@${CSV_FILE}" \
    "http://${API_PORT}/api/restore")
fi

echo ""
echo "Result: $RESULT"
echo ""

# Verify
echo "Verifying..."
STATS=$(docker exec emailhunter-api wget -qO- http://127.0.0.1:3456/api/health 2>/dev/null)
echo "DB Status: $STATS"

echo ""
echo "=== Done ==="
