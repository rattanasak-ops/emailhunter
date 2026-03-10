# EmailHunter — คู่มือใช้งาน

## ระบบนี้ทำอะไร

EmailHunter เป็นระบบค้นหา email บริษัทอัตโนมัติ รับรายชื่อบริษัท 300,000 รายการจาก Google Sheet ค้นหาผ่าน SearXNG (Google/Bing/DuckDuckGo) ดึง email ด้วย regex กรอง junk email ออก แล้วบันทึกผลกลับ Google Sheet พร้อม Dashboard แสดงสถิติ real-time

---

## สถาปัตยกรรมระบบ (Architecture)

```
┌──────────────────────────────────────────────────────┐
│                    Server (Ubuntu)                     │
│                                                        │
│  ┌─────────────── EmailHunter Network ──────────────┐ │
│  │              (172.21.0.0/16)                      │ │
│  │                                                    │ │
│  │  ┌──────────┐    ┌──────────┐    ┌────────────┐  │ │
│  │  │  SearXNG  │◄───│   n8n    │───►│  Google     │  │ │
│  │  │  :8888    │    │  :5679   │    │  Sheets API │  │ │
│  │  └────┬─────┘    └────┬─────┘    └────────────┘  │ │
│  │       │               │                            │ │
│  │  ┌────┴─────┐    ┌────┴─────┐                     │ │
│  │  │  Redis   │    │ Dashboard │                     │ │
│  │  │ (internal)│    │  :8890   │                     │ │
│  │  └──────────┘    └──────────┘                     │ │
│  └────────────────────────────────────────────────────┘ │
│                                                        │
│  ┌─────────────── OpenClaw Network ─────────────────┐ │
│  │              (172.20.0.0/16)                      │ │
│  │  ports: 18789, 5678, 8080  ← ห้ามแตะ!            │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

---

## ตาราง Port (ไม่ชนกับ OpenClaw)

| Service | Port | หมายเหตุ |
|---------|------|----------|
| n8n | 5679 | OpenClaw ใช้ 5678 |
| SearXNG | 8888 | - |
| Dashboard | 8890 | OpenClaw ใช้ 8080 |
| Redis | internal | ไม่ expose ออกนอก |

---

## ขั้นตอนติดตั้ง

### 1. SSH เข้า Server

```bash
ssh linux-nat@147.50.253.148
```

### 2. Clone หรือ Copy ไฟล์ไปที่ Server

```bash
mkdir -p /home/linux-nat/EmailHunter
cd /home/linux-nat/EmailHunter
# Copy ไฟล์ทั้งหมดมาไว้ที่นี่
```

### 3. ให้สิทธิ์ Scripts

```bash
chmod +x deploy.sh scripts/*.sh
```

### 4. Deploy ด้วยคำสั่งเดียว

```bash
bash deploy.sh
```

สคริปต์จะ:
- ตรวจ Docker
- สร้าง `.env` อัตโนมัติ (generate secrets)
- Pull Docker images
- Start ทุก container
- Health check ทุก service

### 5. ตรวจสอบว่าทุกอย่างทำงาน

```bash
bash scripts/test.sh
```

---

## ตั้งค่า Google Sheet

### สร้าง Google Sheet ใหม่พร้อม Header ตามนี้:

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| row_number | company_name | status | email | all_emails | source_url | processed_date |
| 2 | บริษัท ปตท จำกัด (มหาชน) | pending | | | | |
| 3 | ธนาคารกสิกรไทย | pending | | | | |
| 4 | บริษัท ซีพี ออลล์ จำกัด (มหาชน) | pending | | | | |

**สำคัญ**:
- Column A (`row_number`): ใส่เลขแถวจริง เริ่มจาก 2
- Column C (`status`): ใส่ "pending" ทุกแถวที่ยังไม่ประมวลผล
- ชื่อ Sheet: `Sheet1`

---

## ตั้งค่า n8n Workflow

### 1. เปิด n8n

เข้า `http://YOUR_SERVER_IP:5679` ในเบราว์เซอร์

### 2. สร้าง Google Sheets Credential

1. ไปที่ **Settings** → **Credentials** → **Add Credential**
2. เลือก **Google Sheets OAuth2**
3. ใส่ Client ID และ Client Secret จาก Google Cloud Console
4. กด **Connect** แล้วอนุญาตสิทธิ์

### 3. Import Workflow

1. ไปที่หน้าหลัก → กดปุ่ม **Import from File**
2. เลือกไฟล์ `n8n-workflows/email-hunter.json`
3. Workflow จะปรากฏในหน้า editor

### 4. แก้ไข Workflow

1. เปิด node **Google Sheets Read** → เลือก Credential ที่สร้างไว้ → ใส่ Google Sheet ID
2. เปิด node **Google Sheets Update** → เลือก Credential เดิม → ใส่ Google Sheet ID เดียวกัน
3. กด **Save**

### 5. ทดสอบ

1. กด **Test Workflow** เพื่อทดสอบ
2. ดูผลลัพธ์ในแต่ละ node
3. เมื่อพอใจ กด **Active** เพื่อเปิดให้ทำงานอัตโนมัติ (ทุกวัน 02:00)

---

## เปิด Dashboard ดูผล

เปิดเบราว์เซอร์ไปที่:
```
http://YOUR_SERVER_IP:8890
```

Dashboard จะแสดง:
- จำนวนบริษัททั้งหมด / ประมวลผลแล้ว / เจอ email / ไม่เจอ
- Progress bar แสดงความคืบหน้า
- กราฟ Daily Trend (14 วัน)
- Donut chart แสดง Success Rate
- ตาราง Recent Activity (20 รายการล่าสุด)
- Error Log

Dashboard อัปเดตอัตโนมัติทุก 30 วินาที

---

## คำสั่งที่ใช้บ่อย

```bash
# เข้า directory โปรเจค
cd /home/linux-nat/EmailHunter

# ดูสถานะ containers
docker compose ps

# ดู logs ทั้งหมด
docker compose logs -f

# ดู logs เฉพาะ n8n
docker compose logs -f emailhunter-n8n

# ดู logs เฉพาะ SearXNG
docker compose logs -f emailhunter-searxng

# หยุดทุก service
docker compose down

# เปิดทุก service
docker compose up -d

# restart ทุก service
docker compose restart

# restart เฉพาะ service
docker compose restart emailhunter-n8n

# ดู resource usage
docker stats --no-stream | grep emailhunter

# ทดสอบ SearXNG
curl "http://localhost:8888/search?q=test&format=json"

# ทดสอบ n8n
curl http://localhost:5679/healthz

# สำรองข้อมูล
bash scripts/backup.sh
```

---

## ย้ายเซิร์ฟเวอร์

```bash
# 1. สำรองข้อมูล
bash scripts/backup.sh

# 2. ใช้สคริปต์ย้าย
bash scripts/migrate.sh
# ระบุ IP, username, path ของเซิร์ฟเวอร์ใหม่

# 3. ที่เซิร์ฟเวอร์ใหม่
cd /path/to/EmailHunter
tar xzf backup_YYYYMMDD_HHMMSS.tar.gz
bash deploy.sh
```

---

## Troubleshooting (ปัญหาที่พบบ่อย)

### 1. SearXNG ค้นหาไม่ได้ / ไม่มีผลลัพธ์
- **สาเหตุ**: อาจโดน Google block ชั่วคราว
- **แก้ไข**: รอ 10-15 นาที แล้วลองใหม่ ระบบจะใช้ Bing/DuckDuckGo เป็นตัวสำรอง

### 2. n8n ไม่ทำงาน / workflow หยุด
- **สาเหตุ**: หน่วยความจำเต็ม หรือ credential หมดอายุ
- **แก้ไข**: `docker compose restart emailhunter-n8n` แล้วตรวจ credential

### 3. Dashboard แสดง "Offline"
- **สาเหตุ**: stats.json ยังไม่ถูกสร้าง หรือ n8n ยังไม่เริ่มทำงาน
- **แก้ไข**: รอให้ n8n ประมวลผลอย่างน้อย 1 บริษัท

### 4. Google Sheets API Limit
- **สาเหตุ**: เกินโควต้า API (100 requests/100 seconds)
- **แก้ไข**: Workflow มี Wait 3 วินาทีอยู่แล้ว ปกติไม่เกินโควต้า

### 5. RAM เต็ม
- **สาเหตุ**: container ใช้เกิน limit
- **แก้ไข**: `docker stats --no-stream | grep emailhunter` ดู usage แล้ว restart container ที่กิน RAM มาก

### 6. Port ชนกับ OpenClaw
- **สาเหตุ**: ไม่ควรเกิดถ้าใช้ docker-compose.yml ตามที่กำหนด
- **แก้ไข**: ตรวจ `ss -tlnp | grep -E '5679|8888|8890'`
