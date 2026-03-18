#!/bin/bash
# ─────────────────────────────────────────────────────────────
# EmailHunter — Notification Helper
# ส่งแจ้งเตือนผ่าน Lark + LINE (ถ้ามี token)
# ใช้: source scripts/notify.sh แล้วเรียก send_alert "title" "message"
# ─────────────────────────────────────────────────────────────

COMPOSE_DIR="/Users/rattanasak/Documents/Cursor Project/EmailHunter"
ENV_FILE="$COMPOSE_DIR/.env"

# โหลด .env
if [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | grep -v '^\s*$' | xargs)
fi

# ส่ง Lark Webhook
send_lark() {
  local TITLE="$1"
  local BODY="$2"
  local COLOR="$3"  # green, red, yellow

  if [ -z "$LARK_WEBHOOK_URL" ] || [ "$LARK_WEBHOOK_URL" = "__REPLACE_ME__" ]; then
    return 1
  fi

  # เลือกสี template
  local TEMPLATE_COLOR="green"
  case "$COLOR" in
    red)    TEMPLATE_COLOR="red" ;;
    yellow) TEMPLATE_COLOR="yellow" ;;
    *)      TEMPLATE_COLOR="green" ;;
  esac

  # ส่งผ่าน Lark Interactive Message Card
  curl -s -X POST "$LARK_WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -d "{
      \"msg_type\": \"interactive\",
      \"card\": {
        \"header\": {
          \"title\": {
            \"tag\": \"plain_text\",
            \"content\": \"$TITLE\"
          },
          \"template\": \"$TEMPLATE_COLOR\"
        },
        \"elements\": [
          {
            \"tag\": \"markdown\",
            \"content\": \"$BODY\"
          },
          {
            \"tag\": \"note\",
            \"elements\": [
              {
                \"tag\": \"plain_text\",
                \"content\": \"EmailHunter Watchdog | $(date '+%Y-%m-%d %H:%M:%S')\"
              }
            ]
          }
        ]
      }
    }" > /dev/null 2>&1
}

# ส่ง LINE Notify
send_line_notify() {
  local MSG="$1"

  if [ -z "$LINE_NOTIFY_TOKEN" ] || [ "$LINE_NOTIFY_TOKEN" = "__REPLACE_ME__" ]; then
    return 1
  fi

  curl -s -X POST https://notify-api.line.me/api/notify \
    -H "Authorization: Bearer $LINE_NOTIFY_TOKEN" \
    -d "message=$MSG" > /dev/null 2>&1
}

# ส่งทั้ง Lark + LINE
send_alert() {
  local TITLE="$1"
  local BODY="$2"
  local COLOR="${3:-green}"

  send_lark "$TITLE" "$BODY" "$COLOR"
  send_line_notify "
$TITLE
$BODY"
}
