---
project: EmailHunter
updated: 2026-05-16T15:19:54.650Z
limit_lines: 25
rule: เกินลิมิตให้ย้ายของเก่าลง progress.md
generator: hermes/project-card@v1
---

# สถานะปัจจุบัน · EmailHunter

> AI ต้องอ่านไฟล์นี้ก่อนตอบคำถามเชิงงานในโครงการนี้
> ความยาวรวมห้ามเกิน 25 บรรทัด (ไม่นับ frontmatter) · Stop hook ตัดให้อัตโนมัติ

## กำลังทำอะไรอยู่

- 05-16 22:19 · "ทำไมไม่ทำให้มันจบๆ ว่ะ มึงก็ทำได้ fuck" · 10 tools (Bash+mcp__hermes__hermes_update_active)
- 2026-05-16 · ปิด API_KEY auth บน VPS สำเร็จ · ssh เข้า myserver → backup .env → sed API_KEY= เปล่า → docker compose -p emailhunter up -d --force-recreate api → verify /api/stats 200 ไม่ต้องใส่ key · ระบบ queue เดิมรันครบหมดแล้ว pending 8,314 → 0

## blocker (ติดอะไรอยู่)

- ไม่มี · queue idle · ทุก service healthy

## next step (ถัดไปทำอะไร)

- user สามารถเปิด http://103.142.150.185:8890 ได้โดยไม่เด้งถาม key · งานต่อไป (รอ user สั่ง) · (1) ตัดสินใจ 24 ไฟล์ uncommitted บน local main (2) เติม queue ใหม่ถ้าจะรัน batch ต่อ (3) แก้ Lark secret + Google CSE permission

## หมายเหตุสั้น (≤ 3 ข้อ)

- final stat 2026-05-16 · processed 99,979 / found 12,486 / not_found 87,493 / success_rate 12.5%
- engine 8 ตัว healthy หมด · pattern __MX_FIRST__ 100% · pattern Thai keyword 12.6% นำสูงสุดในกลุ่ม
- .env backup ไว้ที่ /srv/projects/EmailHunter/main/.env.bak-2026-05-16 · ถ้าจะคืน auth · cp กลับ + recreate api
