import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv, Env } from "../env";
import { isProduction } from "../env";
import { publicPage, redirectTo, safeInternalPath } from "./helpers";
import {
  authMessagePage,
  checkEmailPage,
  emailLoginPage,
  loginPage,
  registerPage,
  verifyConfirmPage,
} from "../views/auth";
import {
  clearSessionCookie,
  clientIp,
  hashIp,
  readForm,
  formValue,
  SESSION_COOKIE,
  setSessionCookie,
} from "../lib/http";
import {
  consumeEmailToken,
  createEmailToken,
  createSession,
  findOrCreateAccount,
  findUserByEmail,
  getUserById,
  loadSession,
  revokeSession,
  sessionTtlDays,
} from "../auth/session";
import { passwordHashForEmail, verifyPassword } from "../auth/password";
import { sendLoginEmail } from "../auth/email";
import { clearUnverifiedPassword, issueLoginOtp, markEmailVerified, verifyLoginOtp } from "../auth/otp";
import { verifyTurnstile } from "../auth/turnstile";
import { enforceRateLimit } from "../lib/rate-limit";
import { logError } from "../lib/logger";
import { recordSecurityEvent } from "../services/audit";
import { now } from "../lib/time";
import { first } from "../lib/db";
import { timingSafeEqual } from "../lib/core";

export const authRoutes = new Hono<AppEnv>();

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** OTP is temporarily disabled by default; set AUTH_OTP_ENABLED=true to restore it. */
function otpEnabled(env: Env): boolean {
  return (env.AUTH_OTP_ENABLED ?? "false").trim().toLowerCase() === "true";
}

function loginErrorPage(c: Parameters<typeof publicPage>[0], next: string, message: string, status = 400): Response {
  return publicPage(c, {
    title: "เข้าสู่ระบบ",
    description: "เข้าสู่ระบบด้วยอีเมลและรหัสผ่าน",
    body: loginPage({
      csrf: c.get("csrfToken") ?? "",
      next,
      siteKey: c.env.TURNSTILE_SITE_KEY ?? "",
      error: message,
    }),
    noIndex: true,
    status,
  });
}

/* -------------------------------------------------------------------------- */
/* Password login                                                             */
/* -------------------------------------------------------------------------- */

authRoutes.get("/login", (c) => {
  if (c.get("user")) return c.redirect("/app", 303);
  const next = safeInternalPath(c.req.query("next"), "/app");
  return publicPage(c, {
    title: "เข้าสู่ระบบ",
    description: "เข้าสู่ระบบด้วยอีเมลและรหัสผ่าน",
    body: loginPage({
      csrf: c.get("csrfToken") ?? "",
      next,
      siteKey: c.env.TURNSTILE_SITE_KEY ?? "",
    }),
    noIndex: true,
  });
});

authRoutes.post("/login", async (c) => {
  const values = await readForm(c);
  const email = formValue(values, "email", 200).trim().toLowerCase();
  const password = formValue(values, "password", 200);
  const next = safeInternalPath(values["next"], "/app");
  const ip = clientIp(c);
  const ipHash = await hashIp(c.env, ip);
  const emailHash = await hashIp(c.env, `email:${email}`);

  if (!emailPattern.test(email)) return loginErrorPage(c, next, "อีเมลไม่ถูกต้อง");
  if (!password) return loginErrorPage(c, next, "กรุณากรอกรหัสผ่าน");
  await enforceRateLimit(c.env, `pwlogin:ip:${ipHash}`, 10, 900);
  await enforceRateLimit(c.env, `pwlogin:email:${emailHash}`, 5, 900);
  await verifyTurnstile(c.env, values["cf-turnstile-response"], ip);

  const stored = await passwordHashForEmail(c.env, email);
  const ok = stored ? await verifyPassword(password, stored) : false;
  if (!ok) {
    await recordSecurityEvent(c.env, {
      eventType: "auth.login_failed",
      severity: "warning",
      ipHash,
      details: { method: "password", reason: stored ? "bad_password" : "no_password" },
    });
    return loginErrorPage(
      c,
      next,
      "อีเมลหรือรหัสผ่านไม่ถูกต้อง — บัญชีเดิมที่ยังไม่เคยตั้งรหัสผ่านสามารถเข้าด้วยลิงก์อีเมลแล้วตั้งรหัสในหน้าบัญชี",
    );
  }

  const user = await findUserByEmail(c.env, email);
  if (!user) return loginErrorPage(c, next, "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
  const verifiedAt = await first<{ email_verified_at: number | null }>(
    c.env.DB,
    `SELECT email_verified_at FROM users WHERE id = ?`,
    user.id,
  );
  if (verifiedAt?.email_verified_at == null) {
    // The password is correct but the address was never proven. That is exactly the state
    // an attacker creates by registering somebody else's email, so the link goes to the
    // real mailbox instead of opening a session.
    const token = await createEmailToken(c.env, user.id, "login", 15, ipHash);
    let devLink: string | null = null;
    try {
      const sent = await sendLoginEmail(c.env, email, token, next, "", 15);
      devLink = sent.preview ? sent.link : null;
    } catch (error) {
      logError("auth.login_verify_email_failed", error);
    }
    await recordSecurityEvent(c.env, {
      eventType: "auth.login_blocked_unverified",
      severity: "warning",
      userId: user.id,
      ipHash,
      details: { method: "password" },
    });
    return publicPage(c, {
      title: "ตรวจสอบอีเมลก่อนเข้าสู่ระบบ",
      description: "บัญชีนี้ยังไม่ได้ยืนยันอีเมล",
      body: checkEmailPage({
        email,
        next,
        csrf: c.get("csrfToken") ?? "",
        devLink,
        devCode: null,
        otpEnabled: false,
      }),
      noIndex: true,
    });
  }
  const session = await createSession(c.env, user.id, {
    ipHash,
    userAgent: c.req.header("user-agent") ?? null,
  });
  setSessionCookie(c, session.token, sessionTtlDays(c.env) * 86400);
  await recordSecurityEvent(c.env, {
    eventType: "auth.login",
    severity: "info",
    userId: user.id,
    ipHash,
    details: { method: "password" },
  });
  return c.redirect(next, 303);
});

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

authRoutes.get("/register", (c) => {
  if (c.get("user")) return c.redirect("/app", 303);
  const next = safeInternalPath(c.req.query("next"), "/app");
  return publicPage(c, {
    title: "สมัครบัญชี",
    description: "สมัครบัญชีฟรีด้วยอีเมล แล้วตั้งรหัสผ่านหลังยืนยันอีเมล",
    body: registerPage({
      csrf: c.get("csrfToken") ?? "",
      next,
      siteKey: c.env.TURNSTILE_SITE_KEY ?? "",
    }),
    noIndex: true,
  });
});

authRoutes.post("/register", async (c) => {
  const values = await readForm(c);
  const email = formValue(values, "email", 200).trim().toLowerCase();
  const next = safeInternalPath(values["next"], "/app");
  const ip = clientIp(c);
  const ipHash = await hashIp(c.env, ip);
  const renderError = (message: string) =>
    publicPage(c, {
      title: "สมัครบัญชี",
      description: "สมัครบัญชีฟรีด้วยอีเมล แล้วตั้งรหัสผ่านหลังยืนยันอีเมล",
      body: registerPage({
        csrf: c.get("csrfToken") ?? "",
        next,
        siteKey: c.env.TURNSTILE_SITE_KEY ?? "",
        error: message,
      }),
      noIndex: true,
      status: 400,
    });

  if (!emailPattern.test(email)) return renderError("อีเมลไม่ถูกต้อง");
  await enforceRateLimit(c.env, `signup:ip:${ipHash}`, 5, 3600);
  await verifyTurnstile(c.env, values["cf-turnstile-response"], ip);

  if (await findUserByEmail(c.env, email)) {
    return renderError("อีเมลนี้มีบัญชีแล้ว กรุณาเข้าสู่ระบบ หรือใช้ลิงก์อีเมลหากยังไม่เคยตั้งรหัสผ่าน");
  }
  const account = await findOrCreateAccount(c.env, email);
  if (!account.created) {
    return renderError("อีเมลนี้มีบัญชีแล้ว กรุณาเข้าสู่ระบบ");
  }

  // Sign-up deliberately collects no password: accepting one before the address is proven
  // is the pre-account-takeover primitive (anyone could claim victim@example.com with
  // their own password). The owner sets the password after following the link, from
  // /app/account, so the credential is always bound to a verified mailbox.
  const token = await createEmailToken(c.env, account.user.id, "login", 15, ipHash);
  let devLink: string | null = null;
  try {
    const sent = await sendLoginEmail(c.env, email, token, next, "", 15);
    devLink = sent.preview ? sent.link : null;
  } catch (error) {
    logError("auth.register_email_failed", error);
    return publicPage(c, {
      title: "ตรวจสอบอีเมล",
      body: authMessagePage({
        title: "สร้างบัญชีแล้ว แต่ส่งอีเมลยืนยันไม่ได้",
        message:
          "ระบบยังส่งอีเมลยืนยันไม่ได้ในขณะนี้ บัญชีจะใช้งานได้หลังยืนยันอีเมล กรุณาติดต่อทีมงาน",
        ctaHref: "/auth/login",
        ctaLabel: "ไปหน้าเข้าสู่ระบบ",
      }),
      noIndex: true,
      status: 503,
    });
  }
  await recordSecurityEvent(c.env, {
    eventType: "auth.register",
    severity: "info",
    userId: account.user.id,
    ipHash,
    details: { method: "email", verification: "email" },
  });
  return publicPage(c, {
    title: "ตรวจสอบอีเมล",
    description: "ยืนยันอีเมลก่อนเข้าสู่ระบบ",
    body: checkEmailPage({
      email,
      next,
      csrf: c.get("csrfToken") ?? "",
      devLink,
      devCode: null,
      otpEnabled: false,
    }),
    noIndex: true,
  });
});

/* -------------------------------------------------------------------------- */
/* Email-link login (OTP temporarily disabled)                                */
/* -------------------------------------------------------------------------- */

authRoutes.get("/email", (c) => {
  if (c.get("user")) return c.redirect("/app", 303);
  const next = safeInternalPath(c.req.query("next"), "/app");
  return publicPage(c, {
    title: "เข้าสู่ระบบด้วยลิงก์อีเมล",
    description: "ขอลิงก์เข้าใช้งานทางอีเมล",
    body: emailLoginPage({
      csrf: c.get("csrfToken") ?? "",
      next,
      siteKey: c.env.TURNSTILE_SITE_KEY ?? "",
    }),
    noIndex: true,
  });
});

authRoutes.post("/email", async (c) => {
  const values = await readForm(c);
  const email = formValue(values, "email", 200).trim().toLowerCase();
  const next = safeInternalPath(values["next"], "/app");
  const ip = clientIp(c);
  const ipHash = await hashIp(c.env, ip);
  const emailHash = await hashIp(c.env, `email:${email}`);
  const renderError = (message: string) =>
    publicPage(c, {
      title: "เข้าสู่ระบบด้วยลิงก์อีเมล",
      description: "ขอลิงก์เข้าใช้งานทางอีเมล",
      body: emailLoginPage({
        csrf: c.get("csrfToken") ?? "",
        next,
        siteKey: c.env.TURNSTILE_SITE_KEY ?? "",
        error: message,
      }),
      noIndex: true,
      status: 400,
    });

  if (!emailPattern.test(email)) return renderError("อีเมลไม่ถูกต้อง");
  await enforceRateLimit(c.env, `login:ip:${ipHash}`, 10, 900);
  await enforceRateLimit(c.env, `login:email:${emailHash}`, 5, 900);
  await verifyTurnstile(c.env, values["cf-turnstile-response"], ip);

  const account = await findOrCreateAccount(c.env, email);
  const token = await createEmailToken(c.env, account.user.id, "login", 15, ipHash);
  const withOtp = otpEnabled(c.env);
  const otp = withOtp ? await issueLoginOtp(c.env, email) : null;
  let devLink: string | null = null;
  try {
    const sent = await sendLoginEmail(c.env, email, token, next, otp?.code ?? "", 15);
    devLink = sent.preview ? sent.link : null;
  } catch (error) {
    logError("auth.email_failed", error);
    return renderError("ไม่สามารถส่งอีเมลได้ในขณะนี้ กรุณาลองใหม่ภายหลัง");
  }

  await recordSecurityEvent(c.env, {
    eventType: "auth.login_link_requested",
    severity: "info",
    userId: account.user.id,
    ipHash,
    details: { new_account: account.created, otp: withOtp },
  });

  return publicPage(c, {
    title: "ตรวจสอบอีเมล",
    description: "ลิงก์เข้าใช้งานถูกส่งไปทางอีเมลแล้ว",
    body: checkEmailPage({
      email,
      next,
      csrf: c.get("csrfToken") ?? "",
      devLink,
      devCode: otp?.code ?? null,
      otpEnabled: withOtp,
    }),
    noIndex: true,
  });
});

authRoutes.post("/verify-otp", async (c) => {
  if (!otpEnabled(c.env)) {
    return publicPage(c, {
      title: "OTP ปิดชั่วคราว",
      description: "OTP ถูกปิดใช้งานชั่วคราว",
      body: authMessagePage({
        title: "OTP ปิดชั่วคราว",
        message: "ระบบรหัส OTP ถูกปิดใช้งานชั่วคราว กรุณาเข้าสู่ระบบด้วยรหัสผ่าน หรือใช้ลิงก์ในอีเมล",
        ctaHref: "/auth/login",
        ctaLabel: "ไปหน้าเข้าสู่ระบบ",
      }),
      noIndex: true,
      status: 404,
    });
  }
  const values = await readForm(c);
  const email = formValue(values, "email", 200).toLowerCase();
  const code = formValue(values, "code", 12);
  const next = safeInternalPath(values["next"], "/app");
  const ip = clientIp(c);
  const ipHash = await hashIp(c.env, ip);
  const emailHash = await hashIp(c.env, `email:${email}`);
  const renderError = (message: string) =>
    publicPage(c, {
      title: "ตรวจสอบอีเมล",
      description: "กรอกรหัส OTP จากอีเมล",
      body: checkEmailPage({
        email,
        next,
        csrf: c.get("csrfToken") ?? "",
        error: message,
        otpEnabled: true,
      }),
      noIndex: true,
      status: 400,
    });
  if (!emailPattern.test(email)) return renderError("อีเมลไม่ถูกต้อง");
  await enforceRateLimit(c.env, `otp:ip:${ipHash}`, 20, 900);
  await enforceRateLimit(c.env, `otp:email:${emailHash}`, 10, 900);
  const result = await verifyLoginOtp(c.env, email, code);
  if (!result.ok) {
    const messages = {
      missing: "กรอกอีเมลและรหัส 6 หลักให้ครบ",
      expired: "รหัสหมดอายุแล้ว กรุณาขอรหัสใหม่",
      invalid: "รหัสไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง",
      locked: "พยายามหลายครั้งเกินไป กรุณาขอรหัสใหม่",
    } as const;
    return renderError(messages[result.reason]);
  }
  const account = await findOrCreateAccount(c.env, email);
  await clearUnverifiedPassword(c.env, account.user.id);
  await markEmailVerified(c.env, account.user.id);
  const session = await createSession(c.env, account.user.id, {
    ipHash,
    userAgent: c.req.header("user-agent") ?? null,
  });
  setSessionCookie(c, session.token, sessionTtlDays(c.env) * 86400);
  await recordSecurityEvent(c.env, {
    eventType: "auth.login",
    severity: "info",
    userId: account.user.id,
    ipHash,
    details: { method: "email_otp", new_account: account.created },
  });
  return c.redirect(next, 303);
});

function verifyInvalidPage(c: Parameters<typeof publicPage>[0]): Response {
  return publicPage(c, {
    title: "ลิงก์ไม่ถูกต้อง",
    description: "ลิงก์เข้าใช้งานไม่ถูกต้องหรือหมดอายุ",
    body: authMessagePage({
      title: "ลิงก์ไม่ถูกต้องหรือหมดอายุ",
      message: "ลิงก์เข้าใช้งานใช้ได้ครั้งเดียวและมีอายุ 15 นาที กรุณาขอลิงก์ใหม่จากหน้าเข้าสู่ระบบ",
      ctaHref: "/auth/email",
      ctaLabel: "ขอลิงก์ใหม่",
    }),
    noIndex: true,
    status: 400,
  });
}

authRoutes.get("/verify", (c) => {
  const token = (c.req.query("token") ?? "").trim();
  const next = safeInternalPath(c.req.query("next"), "/app");
  if (!token) return verifyInvalidPage(c);
  // A bare GET must not create a session: otherwise an attacker can mail a victim a link
  // that silently signs them into the attacker's account (login CSRF). The link only
  // renders a CSRF-protected confirmation form; the token is consumed by the POST.
  return publicPage(c, {
    title: "ยืนยันการเข้าสู่ระบบ",
    description: "กดยืนยันเพื่อเข้าสู่ระบบ",
    body: verifyConfirmPage({ token, next, csrf: c.get("csrfToken") ?? "" }),
    noIndex: true,
  });
});

authRoutes.post("/verify", async (c) => {
  const values = await readForm(c);
  const token = formValue(values, "token", 200).trim();
  const next = safeInternalPath(values["next"], "/app");
  const ipHash = await hashIp(c.env, clientIp(c));
  await enforceRateLimit(c.env, `verify:ip:${ipHash}`, 30, 900);
  const userId = token ? await consumeEmailToken(c.env, token, "login") : null;
  if (!userId) return verifyInvalidPage(c);

  const user = await getUserById(c.env, userId);
  if (!user) {
    return publicPage(c, {
      title: "ไม่พบบัญชี",
      body: authMessagePage({ title: "ไม่พบบัญชีนี้", message: "บัญชีอาจถูกปิดใช้งาน กรุณาติดต่อทีมงาน" }),
      noIndex: true,
      status: 400,
    });
  }

  // Proving the mailbox cancels any password set by somebody who squatted the address.
  await clearUnverifiedPassword(c.env, user.id);
  await markEmailVerified(c.env, user.id);
  const session = await createSession(c.env, user.id, {
    ipHash,
    userAgent: c.req.header("user-agent") ?? null,
  });
  setSessionCookie(c, session.token, sessionTtlDays(c.env) * 86400);
  await recordSecurityEvent(c.env, {
    eventType: "auth.login",
    severity: "info",
    userId: user.id,
    ipHash,
    details: { method: "email_link" },
  });
  return c.redirect(next, 303);
});

authRoutes.post("/logout", async (c) => {
  await readForm(c);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const session = await loadSession(c.env, token);
    if (session) {
      await revokeSession(c.env, session.sessionId);
      await recordSecurityEvent(c.env, {
        eventType: "auth.logout",
        severity: "info",
        userId: session.user.id,
        ipHash: await hashIp(c.env, clientIp(c)),
      });
    }
  }
  clearSessionCookie(c);
  return c.redirect("/?ok=logged-out", 303);
});

/**
 * Development-only bootstrap: signs in the first ADMIN_EMAILS address and grants
 * super_admin. Disabled entirely in production (404).
 */
authRoutes.get("/dev-admin", async (c) => {
  // Two independent switches: an explicit opt-in (DEV_BOOTSTRAP=1) plus a shared token
  // (DEV_ADMIN_TOKEN). Checking ENVIRONMENT alone meant a staging/preview deploy that
  // forgot ENVIRONMENT=production handed super_admin to anyone who opened the URL.
  const expected = c.env.DEV_ADMIN_TOKEN ?? "";
  const provided = c.req.header("x-dev-admin-token") ?? c.req.query("token") ?? "";
  const enabled =
    !isProduction(c.env) && c.env.DEV_BOOTSTRAP === "1" && expected.length >= 16 && provided.length > 0;
  if (!enabled || !timingSafeEqual(provided, expected)) {
    if (provided) {
      await recordSecurityEvent(c.env, {
        eventType: "auth.dev_admin_denied",
        severity: "warning",
        ipHash: await hashIp(c.env, clientIp(c)),
        details: { reason: enabled ? "bad_token" : "disabled" },
      });
    }
    return publicPage(c, {
      title: "ไม่พบหน้านี้",
      body: authMessagePage({ title: "ไม่พบหน้านี้", message: "หน้านี้ใช้ได้เฉพาะในโหมดพัฒนา" }),
      status: 404,
      noIndex: true,
    });
  }
  const email = (c.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)[0];
  if (!email) {
    return publicPage(c, {
      title: "ยังไม่ได้ตั้งค่า ADMIN_EMAILS",
      body: authMessagePage({
        title: "ยังไม่ได้ตั้งค่าผู้ดูแล",
        message: "เพิ่ม ADMIN_EMAILS ใน .dev.vars แล้วรีสตาร์ท dev server",
        ctaHref: "/",
        ctaLabel: "กลับหน้าแรก",
      }),
      status: 400,
      noIndex: true,
    });
  }
  const account = await findOrCreateAccount(c.env, email);
  await c.env.DB.prepare(`UPDATE users SET role = 'super_admin', updated_at = ? WHERE id = ?`)
    .bind(now(), account.user.id)
    .run();
  const session = await createSession(c.env, account.user.id, {
    ipHash: await hashIp(c.env, clientIp(c)),
    userAgent: c.req.header("user-agent") ?? null,
  });
  setSessionCookie(c, session.token, sessionTtlDays(c.env) * 86400);
  await recordSecurityEvent(c.env, {
    eventType: "auth.dev_admin_login",
    severity: "warning",
    userId: account.user.id,
    details: { email },
  });
  return c.redirect(safeInternalPath(c.req.query("next"), "/admin"), 303);
});

authRoutes.get("/", (c) => redirectTo(c, "/auth/login"));
