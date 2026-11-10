# TMH Ads Report (Google Apps Script)

Dashboard โฆษณา Meta ของ True Move H (2 บัญชีโฆษณา) พร้อม funnel Register / Connect จากชีต CRM และ Regis&Connect

แท็บ: **Active Ads Performance** · **Ad Calibration** · **Winning Performance Benchmark**

## ไฟล์
| ไฟล์ | หน้าที่ |
|---|---|
| `Code.gs` | ฝั่ง server: ดึง Meta Marketing API, อ่านชีต CRM, เก็บบันทึกสะสม (ledger) |
| `Index.html` | หน้า dashboard |
| `appsscript.json` | การตั้งค่าโปรเจ็กต์ (เขตเวลา, สิทธิ์, web app) |

> `Seed.gs` (บันทึกสะสมตั้งต้น) **ไม่อยู่ใน repo นี้** เพราะมีเลข SR และเลข asset

## ค่าลับ (ไม่อยู่ในโค้ด)
ตั้งใน Apps Script → การตั้งค่าโปรเจ็กต์ → พร็อพเพอร์ตี้ของสคริปต์
- `META_TOKEN` — System User token (สิทธิ์ `ads_read`)
- `LEDGER_SHEET_ID` — ID ของชีตเก็บบันทึกสะสม
- `META_API_VERSION` — ไม่บังคับ (ค่าเริ่มต้น `v26.0`)

**ห้าม commit token ลง repo**

## อัปเดตเวอร์ชันบน Apps Script
1. วางโค้ดใหม่ใน Apps Script แล้วบันทึก
2. การทำให้ใช้งานได้ → จัดการการทำให้ใช้งานได้ → ✏️ → เวอร์ชันใหม่ → ทำให้ใช้งานได้
3. commit ไฟล์เดียวกันขึ้น repo นี้

## กติกาการนับ (สรุป)
- Register = SR ช่องทาง Facebook ที่ Issue = "ปิดการขายได้" นับตาม Asset Number ไม่ซ้ำ (ไม่มี asset นับ 1 ต่อ SR) ใช้วันที่ Updated At
- Connect = asset เดียวกันที่ SUBS_STATUS = Connect ในชีต Regis&Connect ใช้วันที่ APPOINT_DAY (วันแรกสุด)
- ยึดเพจ/โฆษณาจาก `adsId`; SR ที่มีหลาย adsId ให้เครดิตเต็มทุกโฆษณา แต่ยอดรวมนับคนละครั้ง
- บันทึกสะสมไม่ลบของเก่า และไม่นับซ้ำ แม้ชีตต้นทางจะรีเซ็ตแถว
