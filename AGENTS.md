<!-- HERMES_OWNER_RULES_START -->
> **Hermes Owner Rules (ใช้ทุกโปรเจกต์)**
>
> กฎนี้อยู่เหนือกฎภาษาเดิมในไฟล์โปรเจกต์ ถ้าขัดกันให้ใช้กฎนี้ก่อน

## กติกากลางที่ AI ต้องทำตาม

1. ใช้ภาษาของผู้ใช้ก่อนเสมอ ถ้าผู้ใช้พิมพ์ไทย ให้ตอบไทยทั้งคำอธิบาย สรุป ความเสี่ยง และขั้นตอนถัดไป
2. ถ้าจำเป็นต้องใช้ศัพท์เทคนิค ให้แปลเป็นภาษาคนทันที เช่น `registry` = สมุดทะเบียนติดตาม, `traceability` = ร่องรอยว่าเอาไปใช้ที่ไหนแล้ว, `adapter` = ไฟล์เชื่อมบริบทให้ AI อ่าน
3. ถ้าผู้ใช้ส่งลิงก์ บทความ โพสต์ วิดีโอ หรือข้อมูลให้เรียนรู้ ให้สรุปและเสนอทางเลือกในแชทก่อน แล้วรอเจ้าของงานเลือกก่อนบันทึกลงไฟล์ ความจำถาวร สมุดทะเบียนติดตาม หรือระบบความรู้ เว้นแต่เจ้าของงานสั่งชัดว่าให้เลือกและทำได้เลยในรอบนั้น
4. ถ้าต้องแก้หลายไฟล์หรือหลายเฟส ให้ทำงานเป็นระบบ แยกเฟส ตรวจงานจริง และรายงานผลเป็นภาษาคนที่เจ้าของงานตัดสินใจต่อได้
5. ถ้าผู้ใช้เรียก Shortcut เช่น `Use Act-As`, `Use Comply`, `Use Business Plan`, `Use Viber Structure`, `Use Viber Audit`, `Use WOW Resource`, `Go to Sleep`, `Review Chat` หรือชื่อย่อที่ใกล้เคียง ต้องเปิดไฟล์ทะเบียน Shortcut และ Prompt เต็มก่อนใช้ ห้ามเดาหรือใช้จากความจำ
6. ห้ามสรุปงานด้วยภาษาเครื่องมืออย่างเดียว เช่น `parse passed`, `promoted`, `registry updated` ต้องบอกความหมายและผลกระทบเป็นภาษาไทยด้วย

## ไฟล์ความจำกลางที่ต้องอ้างอิง

- `/Users/rattanasak/ObsidianVault/HermesAgent/AI_MEMORY.md`
- `/Users/rattanasak/ObsidianVault/HermesAgent/ai-context/global-context.md`
- `/Users/rattanasak/ObsidianVault/HermesAgent/ai-context/prompt-shortcut-registry.md`
- `/Users/rattanasak/ObsidianVault/HermesAgent/memory/profile/user-language-first.md`
- `/Users/rattanasak/ObsidianVault/HermesAgent/memory/profile/knowledge-intake-review-before-write.md`

อย่าโหลดทั้ง vault ถ้าไม่จำเป็น อ่านไฟล์กลางข้างบนก่อน แล้วค่อยค้นเพิ่มเฉพาะเมื่อข้อมูลไม่พอ
<!-- HERMES_OWNER_RULES_END -->

# AGENTS.md · EmailHunter

<!-- HERMES_MANAGED · auto-generated · ห้ามแก้ตรงนี้ · regenerate ผ่าน hermes export-agents-md -->

## โครงการคืออะไร

ยังไม่ได้กรอก · user กรอกที่นี่

## ผู้ใช้ / ลูกค้า

ยังไม่ได้กรอก

## Stack หลัก

- ภาษา/runtime: unknown
- ฐานข้อมูล: -
- framework: -

## สถานะปัจจุบัน (สด)

- ยังไม่ได้ระบุ · user หรือ AI update ที่นี่

**Next step:** ยังไม่ได้ระบุ

## การตัดสินใจล่าสุด (top 5)

- **DEC-000** · ใช้ Hermes project card เป็นบัตรสถานะกลาง _(2026-04-24)_
  - เหตุผล: ไฟล์เดิมใหญ่เกิน 40KB · AI โหลดไม่ไหว · card สั้นอ่านทุก session ได้

## ไฟล์ที่ต้องอ่านเพิ่มเมื่อต้อง deep

- `.hermes/brief.md` · ภาพรวมโครงการ
- `.hermes/active.md` · สถานะสด · update โดย Stop hook ทุก turn
- `.hermes/decisions.md` · ADR ฉบับเต็ม
- `.hermes/progress.md` · milestone ย้อนหลัง

## กฎสำหรับ AI agent ที่อ่านไฟล์นี้

1. อ่าน `.hermes/active.md` ก่อนตอบงานในโครงการนี้ (สถานะสดกว่าไฟล์นี้)
2. เมื่อตัดสินใจสำคัญ · บันทึกผ่าน MCP tool `hermes_save_decision`
3. เมื่อทำงานสำคัญเสร็จ · บันทึกผ่าน MCP tool `hermes_update_active`
4. **ห้ามแก้ AGENTS.md โดยตรง** · แก้ที่ `.hermes/` แล้ว regenerate ผ่าน Hermes

<!-- /HERMES_MANAGED -->
