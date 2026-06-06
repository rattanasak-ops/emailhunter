---
project: EmailHunter
format: ADR-Thai
append_only: true
generator: hermes/project-card@v1
---

# การตัดสินใจของโครงการ · EmailHunter

> เก็บการตัดสินใจสำคัญ · ตัดฟีเจอร์ไหน · เลือกทางไหน · เพราะอะไร
> รูปแบบ Thai-ADR · append-only (ห้ามลบของเก่า · เพิ่ม entry ใหม่เท่านั้น)
> entry ใหม่สุดอยู่บน · เก่าสุดอยู่ล่าง

---

## DEC-004 · ปิด API_KEY auth บน VPS dashboard ของ EmailHunter (single-user mode)

- วันที่: 2026-05-16
- บริบท: user ใช้ dashboard ที่ http://103.142.150.185:8890 คนเดียว และโดน prompt ใส่ API Key ทุกครั้งเพราะ key local กับ VPS ไม่ตรงกัน · เสียเวลาในการเข้างาน
- ทางที่เลือก: ตั้ง API_KEY= (เปล่า) ใน .env ของ VPS path /srv/projects/EmailHunter/main/.env แล้ว docker compose restart api · ใช้ backward-compat ที่ middleware (api/middleware/auth.js:14) skip auth เมื่อ key ว่าง
- ทางที่ตัดไป: (1) แก้ middleware เปิดเฉพาะ read endpoint · ต้อง redeploy + แก้ code (2) หา API_KEY ของ VPS มาใส่ localStorage browser · แก้แค่ session เดียว · กลับมาเจอเด้งอีกถ้า cache โดนลบ
- เหตุผล: เร็วที่สุด · 30 วินาที · ไม่ต้องแก้ code 9 ไฟล์ ไม่ต้อง redeploy · user ใช้เองคนเดียวและรับความเสี่ยง public IP เปิด dashboard แล้ว · backward-compat path มี test cover อยู่แล้ว
- อ้างอิง: user prompt 2026-05-16 · "ผมทำใช้เอง เอาแบบนี้ไปก่อน"

## DEC-003 · ถือ VPS production เป็น source of truth และใช้ public fallback ports

- วันที่: 2026-05-09
- บริบท: งานจริงของ EmailHunter รันบน VPS ไม่ใช่ localhost; port เดิม `8890/5680/8888` มี container listen แต่ external access บาง port ถูก refused จาก network policy/provider path
- ทางที่เลือก: ตรวจ/แก้ runtime ที่ VPS `103.142.150.185` path `/srv/projects/EmailHunter/main` branch `phase-13-oss-pipeline`; เพิ่ม public fallback ports dashboard `3068`, n8n `3069`, SearXNG `3070`
- ทางที่ตัดไป: ไม่ deploy local `main` ทับ production เพราะ production มี phase 10-13 และ local modifications ที่ใหม่กว่า GitHub main
- เหตุผล: ลดความเสี่ยงทับ production pipeline และให้ผู้ใช้ตรวจงาน online ได้จริง
- อ้างอิง: production verify 2026-05-09 · commits `b9f1cdc`, `ae3c64a` · dashboard `3068` 200 OK · n8n `3069` 200 OK · SearXNG `3070` reachable

## DEC-002 · ลด Disk Write จาก backup/export ตอน restart

- วันที่: 2026-05-05
- บริบท: Grafana แสดง Disk Write Rate ของ EmailHunter สูงระหว่างช่วง rebuild/restart และพบว่า API เดิม backup หลัง startup ทุกครั้งและ export CSV ตอน shutdown ทุกครั้ง
- ทางที่เลือก: ปิด startup backup เป็น default (`BACKUP_ON_START=false`), ปิด CSV export ตอน shutdown เป็น default (`CSV_EXPORT_ON_SHUTDOWN=false`), และเพิ่ม backup cooldown 30 นาที
- ทางที่ตัดไป: ไม่ลบ backup เก่าหรือ Docker cache อัตโนมัติในรอบนี้ เพราะเป็น destructive maintenance และไม่ใช่ root cause runtime
- เหตุผล: ลด write spike จาก deploy/restart โดยยังเก็บ manual backup และ scheduled backup ไว้
- อ้างอิง: `PHASE_REVIEW.md`

## DEC-001 · ใช้ API worker เป็น owner หลักของ queue และ readiness gate

- วันที่: 2026-05-05
- บริบท: n8n workflow legacy ยังอยู่ แต่ระบบต้องป้องกัน worker หยุดเอง, engine block, DB restore ระหว่าง run, และ notification error จาก placeholder
- ทางที่เลือก: ให้ API worker เป็น owner หลักของ queue processing; n8n endpoint legacy เป็น compatibility; readiness ต้องผ่าน phase 100% ก่อนปิดงาน
- ทางที่ตัดไป: ไม่ให้ n8n เขียนผลแข่งกับ API worker; ไม่ใช้ `xlsx` dependency ที่ audit พบ high severity; ไม่รองรับ `.xls` legacy ใน import path
- เหตุผล: ลด race condition, ลด runtime error, ลด security finding, และทำให้ deploy/review ตรวจได้ด้วย test + service health ที่ชัดเจน
- อ้างอิง: `PHASE_REVIEW.md`

## DEC-000 · ใช้ Hermes project card เป็นบัตรสถานะกลาง

- วันที่: 2026-04-24
- บริบท: โครงการ EmailHunter เข้าระบบ Hermes project card เพื่อให้ AI รู้สถานะทุก session
- ทางที่เลือก: `.hermes/` โฟลเดอร์ · 4 ไฟล์สั้น (brief · active · decisions · progress)
- ทางที่ตัดไป: ไม่สร้าง file ใหม่ทับ `.cursor/memory/` เดิม (ถ้ามี) · ใช้เป็น card สั้นชี้ไป
- เหตุผล: ไฟล์เดิมใหญ่เกิน 40KB · AI โหลดไม่ไหว · card สั้นอ่านทุก session ได้

<!-- ตัวอย่าง entry ใหม่เขียนต่อท้ายด้านบน section นี้ · เอาตัวอย่างนี้ออกได้ -->
<!--
## DEC-001 · <หัวข้อการตัดสินใจ>

- วันที่: YYYY-MM-DD
- บริบท: ...
- ทางที่เลือก: ...
- ทางที่ตัดไป: ...
- เหตุผล: ...
- อ้างอิง: INC-NNNN · หรือ commit hash
-->
