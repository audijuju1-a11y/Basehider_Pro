import type { Env } from "../env";
import { getSetting, setSetting } from "../services/audit";

export interface SiteContent {
  announcement: string;
  heroEyebrow: string;
  heroTitle: string;
  heroTitleAccent: string;
  heroLead: string;
  primaryCta: string;
  secondaryCta: string;
  supportEmail: string;
  pricingNote: string;
}

export const DEFAULT_SITE_CONTENT: SiteContent = {
  announcement: "",
  heroEyebrow: "PLUGIN COMMERCE PLATFORM",
  heroTitle: "ขายปลั๊กอิน Minecraft",
  heroTitleAccent: "ด้วยไลเซนส์จริง",
  heroLead:
    "BaseHider Control Platform รวมหน้าร้าน พอร์ทัลลูกค้า กระเป๋าเงิน และคอนโซลผู้ดูแลไว้ในระบบเดียว — ใบอนุญาตลงลายเซ็น Ed25519 ตรวจสอบได้ทุกใบ",
  primaryCta: "ดูผลิตภัณฑ์",
  secondaryCta: "เริ่มต้นใช้งาน",
  supportEmail: "support@basehider.local",
  pricingNote: "ทุกแผนเป็นรายเดือน · ใช้ได้หลายเซิร์ฟเวอร์ตามจำนวนที่กำหนด · ยกเลิกได้ทุกเมื่อ",
};

export async function getSiteContent(env: Env): Promise<SiteContent> {
  const raw = await getSetting(env, "site.content");
  if (!raw) return DEFAULT_SITE_CONTENT;
  try {
    const parsed = JSON.parse(raw) as Partial<SiteContent>;
    return {
      ...DEFAULT_SITE_CONTENT,
      ...Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === "string"),
      ),
    } as SiteContent;
  } catch {
    return DEFAULT_SITE_CONTENT;
  }
}

export async function saveSiteContent(env: Env, content: SiteContent): Promise<void> {
  await setSetting(env, "site.content", JSON.stringify(content));
}
