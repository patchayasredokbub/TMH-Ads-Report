# TMH Ads Report (Google Apps Script)

Dashboard โฆษณา Meta ของ True Move H (2 บัญชีโฆษณา) รวมกับ funnel SR → Register → Connect จากชีต CRM และชีต Regis&Connect

แท็บ: **Active Ads Performance (FB)** · **Ad Calibration (FB)** · **Winning Performance Benchmark (FB)**

## ไฟล์ใน repo
| ไฟล์ | หน้าที่ |
|---|---|
| `Code.gs` | ฝั่ง server: ดึง Meta Marketing API, อ่านชีต CRM / Regis&Connect, เก็บบันทึกสะสม (ledger) |
| `Index.html` | หน้า dashboard |
| `appsscript.json` | การตั้งค่าโปรเจ็กต์ (เขตเวลา, สิทธิ์, web app) |

> `Seed.gs` (บันทึกสะสมตั้งต้น) **ไม่อยู่ใน repo นี้** เพราะมีเลข SR และเลข asset

## ค่าลับ (ไม่อยู่ในโค้ด)
ตั้งใน Apps Script → การตั้งค่าโปรเจ็กต์ → พร็อพเพอร์ตี้ของสคริปต์
- `META_TOKEN`: System User token (สิทธิ์ `ads_read`)
- `LEDGER_SHEET_ID`: ID ของชีตเก็บบันทึกสะสม
- `META_API_VERSION`: ไม่บังคับ (ค่าเริ่มต้น `v26.0`)

**ห้าม commit token ลง repo**

## ชีตบันทึกสะสม (ledger)
| แท็บ | เก็บอะไร |
|---|---|
| `ledger_sr` | SR ทุกตัวที่เคยเห็น พร้อม asset (แฮช), adsId, ช่องทาง, Unmatch |
| `ledger_subs` | asset ที่มีสถานะ Connect |
| `ledger_regs` | แถว TOL-REGISTER / TOL-CONNECT และภาค สำหรับหน้า Winning |
| `daily_<บัญชี>` | ตัวเลข Meta รายวัน |

ไม่ลบของเก่า และไม่นับซ้ำ แม้ชีตต้นทางจะลบหรือรีเซ็ตแถว (ยกเว้น Unmatch, adsId, ช่องทาง ที่ตามชีตล่าสุด)

## กติกาการนับ (สรุป)
**Active Ads / Ad Calibration (Facebook ทุก sub channel + LINE @ ทรูภาคใต้ / เน็ตบ้าน True Online)**
- SR = SR No ไม่ซ้ำ ไม่นับ Unmatch
- Register = Asset Number ใน SR (วันแรกที่เห็น) + 1 ต่อ SR ที่ Issue = "ปิดการขายได้" แต่ไม่มี asset
- Connect = asset เดียวกันที่ SUBS_STATUS = Connect ในชีต Regis&Connect (APPOINT_DAY แรกสุด)
- โฆษณา: ยึด `adsId`; SR ที่มีหลาย adsId ให้เครดิตเต็มทุกโฆษณา ยอดรวมนับครั้งเดียว
- Handling rate = SR ÷ Inbox · CTR = Link click ÷ Impression

**Winning Performance Benchmark**
- ตัวเลขหลัก = Facebook (ขอบเขตเดียวกับด้านบน) นับถึงเมื่อวาน
- "ทั้งหมดทุกช่องทาง": SR ทุกช่องทาง · Register = TOL-REGISTER (ไม่นับ Un-Complete) · Connect = TOL-CONNECT · เฉพาะภาคของทีม
- Target breakdown: เป้ารวม × (run rate Facebook ÷ run rate ทั้งหมด) = เป้า Facebook
- Calculator: งบที่เหลือ ÷ (เป้า Facebook − connect Facebook ที่ได้แล้ว)

**เกณฑ์ Ad Calibration** (CTR · Handling rate · ฿/register เทียบค่าเฉลี่ย/เป้า; ยังไม่มี register ใช้ยอดที่ใช้ไปแทน)
1. ดีที่สุด: ทั้ง 3 ตัวเท่ากับหรือดีกว่าค่าเฉลี่ย
2. ดี: อย่างน้อย 1 ตัวเท่ากับหรือดีกว่า และอีก 2 ตัวไม่แย่ (CTR/HR ไม่ต่ำกว่าเกิน 50%, ฿/register ไม่เกิน 1.5 เท่า)
3. มีแนวโน้ม: ทุกตัวไม่แย่
4. เฝ้าดู: มีตัวแย่ แต่ไม่ครบ 3 ตัว
5. ควรปิด: แย่ครบ 3 ตัว หรือ ฿/register เกิน 2 เท่า
6. ยังเก็บข้อมูล: ยังไม่มี register และใช้ไปไม่ถึงครึ่งของ ฿/register เฉลี่ย

## อัปเดตเวอร์ชันบน Apps Script
1. วางโค้ดใหม่ใน Apps Script แล้วบันทึก
2. ทดสอบด้วยลิงก์ /dev (การทำให้ใช้งานได้ → ทดสอบการทำให้ใช้งานได้)
3. การทำให้ใช้งานได้ → จัดการการทำให้ใช้งานได้ → ✏️ → เวอร์ชันใหม่ → ทำให้ใช้งานได้
4. commit ไฟล์เดียวกันขึ้น repo นี้
