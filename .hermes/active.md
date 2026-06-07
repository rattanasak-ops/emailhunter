---
project: EmailHunter
updated: 2026-06-07T13:43:00+07:00
limit_lines: 25
rule: เกินลิมิตให้ย้ายของเก่าลง progress.md
generator: hermes/project-card@v1
---

# สถานะปัจจุบัน · EmailHunter

> AI ต้องอ่านไฟล์นี้ก่อนตอบคำถามเชิงงานในโครงการนี้
> ความยาวรวมห้ามเกิน 25 บรรทัด (ไม่นับ frontmatter) · Stop hook ตัดให้อัตโนมัติ

## กำลังทำอะไรอยู่

- 2026-06-07 · local workspace ถูกกู้คืนแล้วจาก `codex/local-retirement-snapshot-20260606` commit `2e677f2`
- P0 guard · ห้าม AI ลบ project root / worktree root / `.env` / ignored local runtime state อีก เว้นแต่ owner ยืนยัน path แบบ explicit และมี restore drill ผ่านก่อน
- 05-16 22:19 · "ทำไมไม่ทำให้มันจบๆ ว่ะ มึงก็ทำได้ fuck" · 10 tools (Bash+mcp__hermes__hermes_update_active)
- 2026-05-16 · ปิด API_KEY auth บน VPS สำเร็จ · ssh เข้า myserver → backup .env → sed API_KEY= เปล่า → docker compose -p emailhunter up -d --force-recreate api → verify /api/stats 200 ไม่ต้องใส่ key · ระบบ queue เดิมรันครบหมดแล้ว pending 8,314 → 0

## blocker (ติดอะไรอยู่)

- ไม่มี · queue idle · ทุก service healthy

## next step (ถัดไปทำอะไร)

- local พร้อมใช้งานที่ path เดิม · VPS ยัง healthy · งานต่อไปคือ Hermes Agent ต้องทำ destructive workspace guard ให้เป็น hard gate

## หมายเหตุสั้น (≤ 3 ข้อ)

- final stat 2026-05-16 · processed 99,979 / found 12,486 / not_found 87,493 / success_rate 12.5%
- engine 8 ตัว healthy หมด · pattern __MX_FIRST__ 100% · pattern Thai keyword 12.6% นำสูงสุดในกลุ่ม
- local `.env` กู้จาก VPS shared env แล้วและถูก ignore/chmod 600 · ห้ามรายงานค่า secret
