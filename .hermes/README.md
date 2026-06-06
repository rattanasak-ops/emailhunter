# .hermes/ · EmailHunter

> Project memory · managed by Hermes Center (standalone)

## โครงสร้าง

| ไฟล์/folder | หน้าที่ |
|---|---|
| `active.md` | งานปัจจุบัน · update ทุกครั้งก่อนปิด session |
| `context.md` | บริบทเฉพาะ project นี้ |
| `decisions.md` | decision log local |
| `borrowed/` | ของที่ pull มาจาก center (read-only · อย่าแก้) |
| `outbox/` | ของที่จะส่งไป center (push) |
| `notifications-seen.md` | id ที่อ่านแล้ว |

## คำสั่งที่ใช้บ่อย

```bash
hermes-center push <project>     # ส่ง outbox/ → center inbox
hermes-center pull <project>     # ดึงของใหม่จาก center → borrowed/
hermes-center status <project>   # ดูสถานะ
```

## Standalone

ระบบนี้ไม่ depend MCP server เก่า · ไม่อ่านของจาก Hermes Labs (เก่า)
