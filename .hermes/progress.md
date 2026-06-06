---
project: EmailHunter
updated: 2026-05-09T23:44:20+07:00
limit_lines: 80
generator: hermes/project-card@v1
---

# Milestone Log · EmailHunter

> ที่เก็บของที่ "ทำเสร็จแล้ว" และ "ตัดออกจาก scope"
> ของสดอยู่ active.md · ของย้อนหลังอยู่ที่นี่ · ห้ามเกิน 80 บรรทัด

## เสร็จแล้ว (DONE)

- URLs: dashboard primary `http://103.142.150.185:8890` · fallback `:3068` · n8n `:3069` · SearXNG `:3070` (จาก active)
- 05-09 23:44 · EmailHunter success-rate recovery deployed to VPS; real queue run started
  - Root cause work: News/Job/Directory cache trap reduced via search result source classification/ranking
  - Added official recovery search before `not_found`: contact/official website queries with `-job -ข่าว`
  - Crawler upgraded: stricter email normalization, Cloudflare email decode, `at/dot` obfuscation, HTML entity decode, same-host contact link discovery
  - Worker upgraded: uses source URL that actually contained email, crawls when search email is noise, stores finer crawl rejection reasons
  - Stats/Dashboard upgraded: `/api/stats` includes `pipeline_diagnostics`; dashboard has Pipeline Diagnostics panel
  - Runtime override: `DAILY_LIMIT_OVERRIDE=10000` set on VPS to continue run after today already exceeded old daily limit
  - Verification before deploy: local Jest 42/42, npm audit 0 vulnerabilities, compose config OK, local service test 11/11
  - Verification after deploy: VPS service test 11/11; dashboard/API/n8n/SearXNG health all 200
  - Last live run check: processed 91,665; found 11,926; pending 8,314; phase working; session 4 processed / 1 found
  - Known non-critical issues: Lark app secret invalid; Google CSE project lacks Custom Search JSON API access; some SearXNG engines suspend temporarily
- 05-03 18:12 · "ทำเลย" · 10 tools (Bash) (จาก active)
- 05-03 18:08 · "มึงทำได้เลย" · 10 tools (Bash) (จาก active)
- 05-03 17:51 · "เหมือนคุณไม่ได้เช็ค ว่า ระบบนี้ run อยู่บนไหน ip, vps อะไรใช่ไหม ได้อ่าน .env หร" · 10 tools (Bash+Read) (จาก active)
- 05-03 17:27 · "continue" · 10 tools (Agent+Bash+Edit) (จาก active)
- 05-03 17:09 · "(ไม่มี user prompt)" · 10 tools (Bash+Edit+Read) (จาก active)
- 05-03 16:49 · "IP เดียว → ต้องใช้ Tor pool + free SOCKS rotate (ฟรีแต่ช้า + IP คุณภาพปานกลาง)" · 10 tools (Agent+Bash+Read) (จาก active)
- 05-03 16:49 · "จากภาพ ช่วยวิเคราะห์ root cause ว่าทำไมตัว GodsEye ถึงใช้ RAM, CPU และทุกสิ่งทุก" · 0 tools (no-tools) (จาก active)
- 05-03 16:40 · "ระบบนี้อยู่บนตัว Plugbox อยู่แล้วอ่านในดัดเยียดวีดาม ต้องการพบเรทสูงสุดประมาณ 60" · 10 tools (Bash+Read) (จาก active)
- 05-03 15:57 · "คุณว่า Project นี้คืออะไร? เป้าหมายของโปรเจกต์นี้คืออะไร? ส่วนที่คุณเสนอมาเรื่อง" · 10 tools (Bash+Read) (จาก active)
- 05-03 15:37 · "(ไม่มี user prompt)" · 10 tools (Bash+Read) (จาก active)
- ยังไม่ได้ระบุ · user หรือ AI update ที่นี่ (จาก active)
- 2026-04-04 · feat: deep crawl — homepage/footer + mailto/obfuscated extraction
- 2026-04-04 · feat: SMTP RCPT TO verification + enhanced domain guessing
- 2026-04-04 · feat: smart retry — directory patterns + all_filtered recovery crawl
- 2026-04-04 · fix: scoring balance + all_filtered bug — target 20-22% found rate
- 2026-04-04 · fix: anti-blocking tuning — raise delays, pin SearXNG, drop Tor

## ยังไม่ทำ / รออยู่ (TODO)

- ยังไม่ได้กรอก

## ตัดออกจาก scope (CUT)

- ยังไม่ได้กรอก

## commit ล่าสุด (อ้างอิงจาก git log)

- ccdb686 feat: deep crawl — homepage/footer + mailto/obfuscated extraction (2026-04-04)
- b79e90b feat: SMTP RCPT TO verification + enhanced domain guessing (2026-04-04)
- 7d1d838 feat: smart retry — directory patterns + all_filtered recovery crawl (2026-04-04)
- 6606669 fix: scoring balance + all_filtered bug — target 20-22% found rate (2026-04-04)
- 87ae5c2 fix: anti-blocking tuning — raise delays, pin SearXNG, drop Tor (2026-04-04)
- 5e45b70 v4.0: Modular architecture, email quality overhaul, auth, tests (2026-04-01)
- a7d506d v3.0: Human-like Work Cycle engine, Lark notifications, adaptive delay (2026-03-18)
- b333458 Improve upload UX: clear Thai messages, status icons, smart result display (2026-03-18)
- dbbf2cd Fix UNIQUE index creation: defer to migration, handle missing index case (2026-03-18)
- eec95d6 Fix UNIQUE migration: remove duplicate company names before creating index (2026-03-18)
