# Context · EmailHunter

> บริบทเฉพาะของ project นี้ · AI ทุก session ต้องอ่านก่อนตอบคำแรก

## Project identity
- **name**: EmailHunter
- **path**: /Users/rattanasak/Documents/Viber Project/Tech Tools/EmailHunter
- **category**: Tools
- **stack**: docker-compose, hermes-managed, production VPS

## Owners / stakeholders
-

## Goals (ทำเพื่ออะไร)
- ให้ EmailHunter online runtime บน VPS ทำงานต่อได้จริงและตรวจงานผ่าน public URL ได้

## Constraints (ห้ามทำอะไร)
- งาน action/runtime จริงไม่ได้รันบน localhost; localhost ใช้แค่ dev/check local เท่านั้น
- ก่อนตอบ URL/status ต้อง SSH ไปตรวจ VPS `myserver` / `103.142.150.185`
- ห้าม push/deploy จาก local main ทับ production โดยตรง; production อยู่ `/srv/projects/EmailHunter/main` branch `phase-13-oss-pipeline`

## Notes
- Production URLs: dashboard `http://103.142.150.185:3068`, n8n `http://103.142.150.185:3069`, SearXNG `http://103.142.150.185:3070`
- Old ports `8890/5680/8888` ยังมีใน compose แต่ external access ไม่ reliable; ใช้ fallback public ports ด้านบน
