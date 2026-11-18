-- Publish the BaseHider 3.6.1 release (3.6.0 security core + signed licence client)
-- for an existing local database. Safe to re-run.
UPDATE products SET
  description = 'BaseHider 3.6.1 คือปลั๊กอินสำหรับเซิร์ฟเวอร์ Paper 1.21.4 ที่ช่วยซ่อนหีบ กล่องเก็บของ และไอเท็มที่ตกอยู่ ไม่ให้คนอื่นมองเห็น — โดยไม่ส่งข้อมูลเหล่านั้นออกจากเซิร์ฟเวอร์ตั้งแต่แรก

ระบบตัดสินใจจากระยะทาง มุมมอง และสิ่งกีดขวาง ถ้าผู้เล่นอยู่ใกล้ มองเห็น และไม่มีอะไรบัง ก็จะเห็นของตามปกติ แต่ถ้าไม่แน่ใจ ระบบจะซ่อนไว้ก่อน

ทุกอย่างทำงานบนเซิร์ฟเวอร์ ผู้เล่นไม่ต้องติดตั้งมอด และมีชุดทดสอบบนเซิร์ฟเวอร์จริงยืนยันว่าไม่มีข้อมูลหลุด',
  features = '[{"title":"ซ่อนหีบจริง","description":"ข้อมูลหีบถูกถอดออกจากแผนที่ก่อนส่ง และแทนที่ด้วยหินธรรมดา"},{"title":"ซ่อนไอเท็มที่ตกอยู่","description":"ไม่มีข้อมูลไอเท็มถูกสร้างจนกว่าผู้เล่นจะอยู่ใกล้ ในมุมมอง และไม่มีอะไรบัง"},{"title":"เห็นของใกล้ตัวตามปกติ","description":"ใช้การยิงเส้นสายตาตรวจสิ่งกีดขวางจริง ทำให้เล่นได้เหมือนเดิมในระยะใกล้"},{"title":"ไม่แน่ใจ = ซ่อน","description":"ข้อผิดพลาด การตั้งค่าผิด หรือระบบทำงานไม่ทัน จบที่การซ่อนทุกครั้ง"},{"title":"ไม่ทำให้เซิร์ฟเวอร์กระตุก","description":"จำกัดงานไม่เกิน 1.5 มิลลิวินาทีต่อติ๊ก พร้อมตัวเลข p50/p95/p99 ให้ตรวจสอบ"},{"title":"ตรวจสอบได้ทุกเมื่อ","description":"คำสั่ง status, diag, verify และ export แสดงสถานะจริงของระบบ"},{"title":"ไคลเอนต์ไลเซนส์","description":"ลงทะเบียนเซิร์ฟเวอร์ รับ lease ที่ลงลายเซ็น Ed25519 และส่ง heartbeat โดยไม่แตะเธรดหลัก"}]',
  updated_at = (strftime('%s','now') * 1000)
WHERE id = 'prod_basehider';

INSERT OR REPLACE INTO product_releases (
  id, product_id, version, channel, status, notes, supported_minecraft, supported_java,
  supported_platforms, artifact_url, artifact_sha256, released_at, created_at
) VALUES (
  'rel_bh_361', 'prod_basehider', '3.6.1', 'stable', 'published',
  'BaseHider 3.6.1 — same security core and Tunnel/Dug-hole Shield as 3.6.0, plus the signed licence client: Ed25519 installation identity, activation pairing, offline lease verification, background refresh, bounded telemetry heartbeat, /basehider license commands. 102 unit tests; Paper 1.21.4 staging verified (enable, ACTIVE lease, heartbeat).',
  '["1.21.4"]', '["21"]', '["Paper"]',
  '/download/BaseHider-3.6.1.jar',
  'fba61fd3c446c5d708cf146ddf8ed485dbb47fb874292268c6b82b5cea7fcc5d',
  (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)
);

INSERT OR REPLACE INTO product_releases (
  id, product_id, version, channel, status, notes, supported_minecraft, supported_java,
  supported_platforms, artifact_url, artifact_sha256, released_at, created_at
) VALUES (
  'rel_bh_360', 'prod_basehider', '3.6.0', 'stable', 'published',
  'BaseHider 3.6.0 — Tunnel/Dug-hole Shield (hide player-dug tunnels beyond 28 blocks, re-mask on leave), Y-Shield, contextual filler and player ESP shield. 85 unit tests; verified running on a live Paper 1.21.4 server at TPS 20.0.',
  '["1.21.4"]', '["21"]', '["Paper"]',
  '/download/BaseHider-3.6.0.jar',
  'bbb8da5323b925a28e681dbff18b1828e084416e8a443be91f0001dc82f09eb5',
  ((strftime('%s','now') * 1000) - 3600000), ((strftime('%s','now') * 1000) - 3600000)
);

INSERT OR REPLACE INTO product_releases (
  id, product_id, version, channel, status, notes, supported_minecraft, supported_java,
  supported_platforms, artifact_url, artifact_sha256, released_at, created_at
) VALUES (
  'rel_bh_320', 'prod_basehider', '3.2.0', 'stable', 'published',
  'BaseHider 3.2.0 — startup warm-up, item spawn-storm priority lane, gateway watchdog, detected-position overflow alarm and async diagnostics snapshots. 75 unit tests, packet-level integration harness PASS on Paper 1.21.4.',
  '["1.21.4"]', '["21"]', '["Paper"]',
  '/download/BaseHider-3.2.0.jar',
  'cf3cc53e7529e35b7dbc801773eba3bf8c8d02dc7e0028cf89bbe3aa1191808c',
  ((strftime('%s','now') * 1000) - 2592000000), ((strftime('%s','now') * 1000) - 2592000000)
);
