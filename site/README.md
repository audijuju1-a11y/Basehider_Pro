# BaseHider 3.6.1 — Landing Page

หน้าเว็บแนะนำและดาวน์โหลดปลั๊กอิน **BaseHider 3.6.1** สำหรับ Paper 1.21.4
เป็น static site ล้วน (HTML + CSS + JS ไม่มี build step) พร้อมอัปขึ้น **Cloudflare Pages**
ธีมหลักคือ “กลไกนาฬิกาแยกชิ้นส่วน” 38 ชั้น ซึ่งแทนสถาปัตยกรรมของปลั๊กอินจริง

```
site/
├─ public/                 ← โฟลเดอร์ที่ deploy (build output)
│  ├─ index.html
│  ├─ 404.html
│  ├─ _headers             ← security + cache headers ของ Cloudflare Pages
│  ├─ _redirects           ← /jar, /download → ไฟล์ไจาร์
│  ├─ site.webmanifest
│  ├─ robots.txt
│  ├─ download/
│  │  └─ BaseHider-3.6.1.jar
│  └─ assets/
│     ├─ css/style.css, fonts.css
│     ├─ js/layers.js, main.js
│     ├─ fonts/*.woff2      (self-hosted, OFL 1.1)
│     └─ img/favicon.svg, og.jpg
├─ scripts/fetch-fonts.py   ← ดาวน์โหลดฟอนต์ซ้ำได้ถ้าต้องการ
├─ wrangler.toml
└─ package.json
```

## หน้าเว็บมีอะไรบ้าง

| ลำดับ | ส่วน | สิ่งที่อธิบาย |
|---|---|---|
| 01 | กลไก 38 ชั้น | แยกชิ้นส่วนแบบอินเทอร์แอคทีฟ + สมุดชิ้นส่วนทั้ง 38 การ์ด |
| 02 | สถานการณ์จริง | 3 กรณี: หีบใกล้ตัว / หีบหลังกำแพง / ไอเท็มไกล |
| 03 | กติกาการมองเห็น | 4 คำถามที่ระบบใช้ตัดสิน (ระยะ / มุมมอง / สิ่งกีดขวาง / ความไม่แน่ใจ) |
| 04 | ทำไมต้องเปลี่ยน | เปรียบเทียบ “ส่งก่อนแล้วแก้” กับ “ซ่อนก่อนส่ง” พร้อมผลทดสอบ |
| 05 | สิ่งที่คุณได้ | 6 ความสามารถที่ผูกกับพฤติกรรมจริงของปลั๊กอิน |
| 06 | ตั้งค่า | 3 พรีเซ็ตตามขนาดเซิร์ฟเวอร์ + YAML + ตารางค่าที่ปรับบ่อย |
| 07 | ความเร็ว | p50/p95/p99, MSPT, อาการหน่วงตอนคนเข้า และวิธีวัด |
| 08 | หลักฐาน | ผลทดสอบ A/B/C, จำนวนเทสต์ และตัวเลขสรุป |
| 09 | ติดตั้ง | 5 ขั้นตอน, คำสั่ง, สิ่งที่ต้องมี, ตารางแก้ปัญหา |
| 10 | ข้อจำกัด | สิ่งที่ตั้งใจไม่ทำและยังไม่รองรับ |
| 11 | ศัพท์ที่ควรรู้ | 10 คำอธิบายด้วยภาษาคน |
| 12 | คำถาม | 12 คำถามพร้อมคำตอบละเอียด |
| 13 | เปลี่ยนอะไรใน 3.6.1 | ไทม์ไลน์การปรับปรุง |
| 14 | ดาวน์โหลด | ไฟล์, SHA-256, วิธีตรวจสอบ |

## ตรวจสอบก่อน deploy

```bash
node scripts/qa-static.mjs
```

สคริปต์จะตรวจไฟล์ที่อ้างถึงทั้งหมด, anchor, ไอคอน SVG, id ซ้ำ, ข้อความแปลกปลอม,
SHA-256 ของไจาร์ และไฟล์ OG image ให้อัตโนมัติ (ต้องรัน local server ที่พอร์ต 4321 ก่อน)

## 1. ทดลองในเครื่อง

```bash
cd site
python -m http.server 4321 --directory public
# เปิด http://127.0.0.1:4321
```

หรือ `npm run serve` (ต้องมี Python) — เปิดผ่าน `file://` ไม่ได้ เพราะ path และ module จะทำงานไม่ครบ

## 2. Deploy ขึ้น Cloudflare Pages

### วิธี A — Wrangler (แนะนำ)

```bash
cd site
npx wrangler login
npx wrangler pages deploy public --project-name basehider
```

ได้ URL แบบ `https://basehider.pages.dev`

### วิธี B — อัปโหลดผ่าน Dashboard

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**
2. ตั้งชื่อโปรเจกต์ `basehider`
3. อัปโหลด **เนื้อหาในโฟลเดอร์ `public/`** (ไม่ใช่โฟลเดอร์ `site/`)
4. กด Deploy

### วิธี C — Git integration

ถ้าเก็บโปรเจกต์ใน Git ให้ตั้งค่า:

| ค่า | ใช้ |
|---|---|
| Framework preset | None |
| Build command | *(เว้นว่าง)* |
| Build output directory | `site/public` |

> ข้อจำกัด Cloudflare Pages: ไฟล์ละไม่เกิน 25 MiB และไม่เกิน 20,000 ไฟล์ต่อ deployment
> ไจาร์ขนาด 6.8 MB จึงผ่านเกณฑ์ comfortably

## 3. โดเมนจริงและ OG image

- หลังผูกโดเมน (`basehider.example.com`) ให้แก้ `og:image` / `twitter:image` ใน `index.html`
  จาก path สัมพัทธ์เป็น URL เต็ม เช่น `https://basehider.example.com/assets/img/og.jpg`
  (Open Graph ต้องการ absolute URL ตามสเปก)
- `assets/img/og.jpg` ถูกสร้างจากหน้าเว็บจริงขนาด 1200×630

## 4. อัปเดตไจาร์เวอร์ชันใหม่

```powershell
Copy-Item ..\dist\BaseHider-3.6.1.jar .\public\download\ -Force
# แก้ href / ข้อความเวอร์ชันใน index.html และ _headers (Content-Disposition)
# อัปเดตค่า SHA-256 ใน index.html ด้วย
Get-FileHash .\public\download\BaseHider-3.6.1.jar -Algorithm SHA256
```

ไฟล์ `public/_headers` ตั้ง `Content-Disposition: attachment` ให้กับทุกไฟล์ใน `/download/`
ดังนั้นเบราว์เซอร์จะดาวน์โหลดแทนการเปิดไฟล์

## 5. ตรวจสอบก่อน deploy

```bash
# ตรวจว่าไฟล์ครบและไจาร์ไม่เสียหาย
python - <<'PY'
import hashlib, pathlib
p = pathlib.Path("public/download/BaseHider-3.6.1.jar")
print(p.stat().st_size, hashlib.sha256(p.read_bytes()).hexdigest())
PY
```

ค่า SHA-256 ที่ถูกต้อง:
`fba61fd3c446c5d708cf146ddf8ed485dbb47fb874292268c6b82b5cea7fcc5d`

## 6. หมายเหตุด้านเทคนิค

- ไม่มี framework, ไม่มี build step, ไม่มี third-party script — CSP ใน `_headers` จึงเข้มได้
  (`script-src 'self'`)
- ฟอนต์ Anuphan (variable) และ IBM Plex Mono ถูก self-host อยู่ใน `assets/fonts`
  อยู่ภายใต้ SIL Open Font License 1.1
- แอนิเมชันและ 3D ทั้งหมดเป็น CSS transform (ไม่ใช้ WebGL) และเคารพ `prefers-reduced-motion`
- โหมดตรวจภาพสำหรับ QA: `/?static=1` (ปิด sticky) และ `/?p=0.75` (ตรึงระดับการแยกชิ้นส่วน)
