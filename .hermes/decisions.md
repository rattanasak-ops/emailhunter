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
