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
