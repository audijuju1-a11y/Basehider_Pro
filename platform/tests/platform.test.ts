import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  CSRF,
  extractSetCookies,
  formRequest,
  issueLicenseFor,
  request,
  resetDatabase,
  seedInstallation,
  seedProduct,
  seedUser,
  sessionCookie,
  signedPost,
} from "./helpers";
import {
  bytesToBase64,
  ed25519Sign,
  ed25519Verify,
  generateEd25519KeyPair,
  importEd25519PublicKey,
  publicKeyFingerprint,
  sha256Hex,
} from "../src/lib/core";
import { processTelemetryMessage } from "../src/services/telemetry";
import { now } from "../src/lib/time";

function b64urlBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

beforeEach(async () => {
  await resetDatabase();
});

describe("public marketing", () => {
  it("renders the catalogue, product page and docs", async () => {
    await seedProduct();
    const plugins = await request("/plugins");
    expect(plugins.status).toBe(200);
    expect(await plugins.text()).toContain("Test Product");

    const product = await request("/plugins/test-product");
    expect(product.status).toBe(200);
    const productHtml = await product.text();
    expect(productHtml).toContain("คำโปรยทดสอบ");

    expect((await request("/docs/getting-started")).status).toBe(200);
    expect((await request("/status")).status).toBe(200);
    expect((await request("/plugins/does-not-exist")).status).toBe(404);
  });

  it("returns public API products and signing keys", async () => {
    await seedProduct();
    const products = await request("/api/v1/products");
    expect(products.status).toBe(200);
    const payload = (await products.json()) as { data: { products: Array<{ slug: string }> } };
    expect(payload.data.products.some((item) => item.slug === "test-product")).toBe(true);

    const keys = await request("/api/v1/license/keys");
    expect(keys.status).toBe(200);
    const keyPayload = (await keys.json()) as { data: { keys: Array<{ key_id: string; public_key: string }> } };
    expect(keyPayload.data.keys.length).toBeGreaterThan(0);
  });
});

describe("authentication", () => {
  function csrfFrom(response: Response): { cookie: string; token: string } {
    const cookies = extractSetCookies(response).map((value) => value.split(";")[0]);
    const csrfCookie = cookies.find((value) => value.startsWith("bh_csrf="));
    expect(csrfCookie).toBeTruthy();
    return { cookie: csrfCookie!, token: csrfCookie!.split("=")[1]! };
  }

  it("registers and logs in with email + password", async () => {
    await seedProduct();
    const registerPage = await request("/auth/register");
    const csrf = csrfFrom(registerPage);
    const email = "owner-password@example.com";
    const password = "Basehider2026";

    const registered = await request("/auth/register", {
      method: "POST",
      headers: { cookie: csrf.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf.token, email, password, confirm: password, next: "/app" }).toString(),
    });
    expect(registered.status).toBe(303);
    const registeredCookies = extractSetCookies(registered).map((value) => value.split(";")[0]);
    const session = registeredCookies.find((value) => value.startsWith("bh_session="));
    expect(session).toBeTruthy();
    expect((await request("/app", { headers: { cookie: `${session}; ${csrf.cookie}` } })).status).toBe(200);

    const loginPage = await request("/auth/login");
    const loginCsrf = csrfFrom(loginPage);
    const wrong = await request("/auth/login", {
      method: "POST",
      headers: { cookie: loginCsrf.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: loginCsrf.token, email, password: "WrongPass2026", next: "/app" }).toString(),
    });
    expect(wrong.status).toBe(400);

    const correct = await request("/auth/login", {
      method: "POST",
      headers: { cookie: loginCsrf.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: loginCsrf.token, email, password, next: "/app" }).toString(),
    });
    expect(correct.status).toBe(303);
    const loginCookies = extractSetCookies(correct).map((value) => value.split(";")[0]);
    const loginSession = loginCookies.find((value) => value.startsWith("bh_session="));
    expect(loginSession).toBeTruthy();
    expect((await request("/app", { headers: { cookie: `${loginSession}; ${loginCsrf.cookie}` } })).status).toBe(200);
  });

  it("rejects non-form content types with 415 instead of 500", async () => {
    const json = await request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.co", password: "whatever1" }),
    });
    expect(json.status).toBe(415);
    const text = await request("/auth/login", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    expect(text.status).toBe(415);
  });

  it("keeps the email-link login and disables OTP verification", async () => {
    await seedProduct();
    const loginPage = await request("/auth/email");
    const csrf = csrfFrom(loginPage);
    const email = "link-user@example.com";
    const posted = await request("/auth/email", {
      method: "POST",
      headers: { cookie: csrf.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf.token, email, next: "/app" }).toString(),
    });
    expect(posted.status).toBe(200);
    expect(await posted.text()).toContain("ตรวจสอบอีเมล");

    const outbox = await env.CACHE.get("dev:email:last", "json");
    expect(outbox).toBeTruthy();
    const link = (outbox as { text: string }).text.match(/https?:\/\/[^\s]+\/auth\/verify\?[^\s]+/)?.[0];
    expect(link).toBeTruthy();
    const token = new URL(link!).searchParams.get("token");
    expect(token).toBeTruthy();
    const verified = await request(`/auth/verify?token=${token}&next=/app`, { headers: { cookie: csrf.cookie } });
    expect([302, 303]).toContain(verified.status);
    const session = extractSetCookies(verified)
      .map((value) => value.split(";")[0])
      .find((value) => value.startsWith("bh_session="));
    expect(session).toBeTruthy();
    expect((await request("/app", { headers: { cookie: `${session}; ${csrf.cookie}` } })).status).toBe(200);

    const otp = await request("/auth/verify-otp", {
      method: "POST",
      headers: { cookie: csrf.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf.token, email, code: "123456", next: "/app" }).toString(),
    });
    expect(otp.status).toBe(404);
    expect(await otp.text()).toContain("OTP ปิดชั่วคราว");
  });

  it("lets a signed-in legacy account set a password and then use it", async () => {
    await seedProduct();
    const user = await seedUser({ email: "legacy@example.com" });
    const cookie = await sessionCookie(user.id);
    const account = await request("/app/account", { headers: { cookie } });
    expect(account.status).toBe(200);
    expect(await account.text()).toContain("ตั้งรหัสผ่าน");

    const changed = await formRequest(
      "/app/account/password",
      { new_password: "Basehider2026", confirm_password: "Basehider2026" },
      cookie,
    );
    expect(changed.status).toBe(303);

    const loginPage = await request("/auth/login");
    const csrf = csrfFrom(loginPage);
    const login = await request("/auth/login", {
      method: "POST",
      headers: { cookie: csrf.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: csrf.token, email: "legacy@example.com", password: "Basehider2026", next: "/app" }).toString(),
    });
    expect(login.status).toBe(303);
  });
});

describe("licensing and signed requests", () => {
  it("issues a verifiable lease, accepts heartbeat and rejects tampered signatures", async () => {
    await seedProduct();
    const user = await seedUser({ email: "licensee@example.com" });
    const licenseId = await issueLicenseFor(user);
    const installation = await seedInstallation({ user, licenseId });

    const leaseBody = JSON.stringify({ plugin_version: "3.3.0" });
    const leaseResponse = await signedPost("/api/v1/installations/lease", leaseBody, installation);
    expect(leaseResponse.status).toBe(200);
    const leasePayload = (await leaseResponse.json()) as {
      data: { lease: string; key_id: string; keys: Array<{ key_id: string; public_key: string }> };
    };
    const [payloadB64, signatureB64] = leasePayload.data.lease.split(".");
    const payloadBytes = b64urlBytes(payloadB64);
    const signature = b64urlBytes(signatureB64);
    const publicKey = leasePayload.data.keys.find((key) => key.key_id === leasePayload.data.key_id);
    expect(publicKey).toBeTruthy();
    const cryptoKey = await importEd25519PublicKey(publicKey!.public_key);
    expect(await ed25519Verify(cryptoKey, signature, payloadBytes)).toBe(true);
    const claims = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
    expect(claims.installation_uuid).toBe(installation.installationUuid);
    expect(claims.license_id).toBe(licenseId);

    const heartbeatBody = JSON.stringify({
      schema_version: 1,
      plugin_version: "3.3.0",
      minecraft_version: "1.21.4",
      platform: "Paper",
      java_version: "21",
      enabled_modules: ["block-protection"],
      metrics: { tps: 19.9, mspt_p50: 0.2, mspt_p95: 0.8, mspt_p99: 2.9, plugin_ms_avg: 0.2, errors: 0, players_online: 5 },
      occurred_at: Math.floor(Date.now() / 1000),
    });
    const heartbeat = await signedPost("/api/v1/installations/heartbeat", heartbeatBody, installation);
    expect(heartbeat.status).toBe(202);
    const heartbeatPayload = (await heartbeat.json()) as { data: { event_id: string; received_at: number } };
    const latest = await env.DB.prepare(`SELECT payload FROM heartbeat_latest WHERE installation_id = ?`)
      .bind(installation.installationId)
      .first<{ payload: string }>();
    expect(latest?.payload).toContain("\"tps\":19.9");

    await processTelemetryMessage(env, {
      kind: "heartbeat",
      id: heartbeatPayload.data.event_id,
      installationId: installation.installationId,
      receivedAt: heartbeatPayload.data.received_at,
    });
    const rollups = await env.DB.prepare(`SELECT COUNT(*) AS count FROM telemetry_rollups WHERE installation_id = ?`)
      .bind(installation.installationId)
      .first<{ count: number }>();
    expect(rollups?.count).toBe(1);
    const archived = await env.ARCHIVE.list({ prefix: "telemetry/" });
    expect(archived.objects.length).toBeGreaterThan(0);

    // Tampered signature must fail closed
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = "dGFtcGVyZWQtbm9uY2UtMTIzNDU2Nzg5MDEyMzQ1Ng";
    const canonical = ["POST", "/api/v1/installations/lease", installation.installationUuid, String(timestamp), nonce, await sha256Hex(leaseBody)].join("\n");
    const signatureBytes = await ed25519Sign(installation.privateKey, new TextEncoder().encode(canonical));
    const tampered = "A" + bytesToBase64(signatureBytes).slice(1);
    const rejected = await request("/api/v1/installations/lease", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bh-installation": installation.installationUuid,
        "x-bh-timestamp": String(timestamp),
        "x-bh-nonce": nonce,
        "x-bh-signature": tampered,
      },
      body: leaseBody,
    });
    expect(rejected.status).toBe(401);
  });

  it("denies a lease when the license is revoked", async () => {
    await seedProduct();
    const user = await seedUser({ email: "revoked@example.com" });
    const licenseId = await issueLicenseFor(user);
    const installation = await seedInstallation({ user, licenseId });
    await env.DB.prepare(`UPDATE licenses SET status = 'revoked', revoked_at = ? WHERE id = ?`).bind(now(), licenseId).run();
    const response = await signedPost("/api/v1/installations/lease", "{}", installation);
    expect(response.status).toBe(403);
  });
});

describe("tenant isolation and admin", () => {
  it("keeps customer data scoped to the owning organization", async () => {
    await seedProduct();
    const alice = await seedUser({ email: "alice@example.com" });
    const bob = await seedUser({ email: "bob@example.com" });
    const licenseId = await issueLicenseFor(alice);
    const installation = await seedInstallation({ user: alice, licenseId });
    const aliceSession = await sessionCookie(alice.id);
    const bobSession = await sessionCookie(bob.id);

    expect((await request("/app/licenses", { headers: { cookie: aliceSession } })).status).toBe(200);
    const bobLicense = await request(`/app/licenses/${licenseId}`, { headers: { cookie: bobSession } });
    expect(bobLicense.status).toBe(404);
    const bobServer = await request(`/app/servers/${installation.installationId}`, { headers: { cookie: bobSession } });
    expect(bobServer.status).toBe(404);
    expect((await request("/admin", { headers: { cookie: bobSession } })).status).toBe(403);
  });

  it("lets staff manage products and records an audit trail", async () => {
    await seedProduct();
    const admin = await seedUser({ email: "staff@example.com", role: "super_admin" });
    const cookie = await sessionCookie(admin.id);
    expect((await request("/admin", { headers: { cookie } })).status).toBe(200);

    const created = await formRequest(
      "/admin/products",
      {
        name: "Second Product",
        slug: "second-product",
        tagline: "สินค้าที่สอง",
        description: "รายละเอียด",
        category: "security",
        status: "published",
        price_cents: "0",
        currency: "THB",
        compatibility: '{"minecraft":["1.21.4"]}',
        features: "[]",
        docs_url: "",
        purchase_url: "",
      },
      cookie,
    );
    expect(created.status).toBe(303);
    const publicPage = await request("/plugins/second-product");
    expect(publicPage.status).toBe(200);

    const audit = await env.DB.prepare(`SELECT COUNT(*) AS count FROM admin_audit_events WHERE action = 'product.create'`).first<{ count: number }>();
    expect(audit?.count).toBe(1);
  });

});

describe("telemetry events", () => {
  it("stores signed events idempotently and creates a security event for errors", async () => {
    await seedProduct();
    const user = await seedUser({ email: "events@example.com" });
    const licenseId = await issueLicenseFor(user);
    const installation = await seedInstallation({ user, licenseId });
    const eventId = crypto.randomUUID();
    const eventBody = JSON.stringify({
      events: [
        {
          event_id: eventId,
          type: "runtime.error",
          severity: "error",
          occurred_at: Math.floor(Date.now() / 1000),
          message: "packet handler failed safely",
          attributes: { module: "packet" },
        },
      ],
    });
    const first = await signedPost("/api/v1/installations/events", eventBody, installation);
    expect(first.status).toBe(202);
    const duplicate = await signedPost("/api/v1/installations/events", eventBody, installation);
    expect(duplicate.status).toBe(202);
    const duplicatePayload = (await duplicate.json()) as { data: { accepted: number; duplicates: number } };
    expect(duplicatePayload.data.accepted).toBe(0);
    expect(duplicatePayload.data.duplicates).toBe(1);

    const stored = await env.DB.prepare(`SELECT id, severity FROM telemetry_events WHERE id = ?`).bind(eventId).first<{ id: string; severity: string }>();
    expect(stored?.severity).toBe("error");

    await processTelemetryMessage(env, {
      kind: "event",
      id: eventId,
      installationId: installation.installationId,
      receivedAt: now(),
    });
    const security = await env.DB.prepare(`SELECT COUNT(*) AS count FROM security_events WHERE id = ?`).bind(`sec_${eventId}`).first<{ count: number }>();
    expect(security?.count).toBe(1);
  });
});

describe("free licensing and activation guard", () => {
  it("registers a server name, issues a 16-character code and auto-provisions a 240-bit free licence", async () => {
    await seedProduct();
    const user = await seedUser({ email: "owner@example.com" });
    const cookie = await sessionCookie(user.id);
    const keyPair = await generateEd25519KeyPair();
    const installationUuid = crypto.randomUUID();
    const fingerprint = await publicKeyFingerprint(keyPair.publicKeyBase64);

    const registered = await request("/api/v1/installations/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        product: "test-product",
        installation_uuid: installationUuid,
        public_key: keyPair.publicKeyBase64,
        fingerprint_sha256: fingerprint,
        plugin_version: "3.6.1",
        minecraft_version: "1.21.4",
        platform: "Paper",
        server_name: "Siam SMP",
        java_version: "21",
      }),
    });
    expect(registered.status).toBe(201);
    const registration = (await registered.json()) as {
      data: { activation_code: string; installation_id: string };
    };
    expect(registration.data.activation_code).toMatch(/^[2-9A-HJ-NP-Z]{16}$/);

    const installation = await env.DB.prepare(
      `SELECT server_name, display_name FROM installations WHERE id = ?`,
    )
      .bind(registration.data.installation_id)
      .first<{ server_name: string | null; display_name: string | null }>();
    expect(installation?.server_name).toBe("Siam SMP");
    expect(installation?.display_name).toBe("Siam SMP");

    // The owner has no licence yet: claiming the code must create one for free
    // and return a long random key.
    const claimed = await formRequest(
      "/app/activations",
      { code: registration.data.activation_code },
      cookie,
    );
    expect(claimed.status).toBe(303);

    const licence = await env.DB.prepare(
      `SELECT id, key_prefix, plan_id, expires_at FROM licenses LIMIT 1`,
    ).first<{ id: string; key_prefix: string; plan_id: string | null; expires_at: number | null }>();
    expect(licence).toBeTruthy();
    expect(licence?.plan_id).toBeNull();
    expect(licence?.expires_at).toBeNull();
    expect(licence?.key_prefix).toHaveLength(10);

    const rawKey = await env.CACHE.get(`newlic:${licence!.id}`);
    expect(rawKey).toBeTruthy();
    expect(rawKey).toMatch(/^BH-([2-9A-HJ-NP-Z]{6}-){7}[2-9A-HJ-NP-Z]{6}$/);
    expect(rawKey!.replace(/-/g, "").length).toBe(50);

    const activation = await env.DB.prepare(
      `SELECT status, license_id FROM activations WHERE installation_id = ?`,
    )
      .bind(registration.data.installation_id)
      .first<{ status: string; license_id: string }>();
    expect(activation?.status).toBe("active");
    expect(activation?.license_id).toBe(licence!.id);

    const page = await request("/app/licenses", { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ฟรี 100%");
  });

  it("escalates activation lockouts: 5 failures -> 5 minutes, 10 failures -> 10 minutes", async () => {
    const code = await import("../src/services/activation-guard");
    const ip = "test-ip-hash-guard";
    await code.noteActivationRegistration(env, ip, {
      pluginSlug: "test-product",
      serverName: "SMP-A",
      installationId: "ins_a",
    });
    for (let attempt = 1; attempt <= 5; attempt++) {
      await code.recordActivationFailure(env, ip, {});
    }
    let guard = await env.DB.prepare(`SELECT * FROM activation_guard WHERE ip_hash = ?`)
      .bind(ip)
      .first<{ failures: number; locked_until: number }>();
    expect(guard?.failures).toBe(5);
    expect((guard?.locked_until ?? 0) - now()).toBeGreaterThan(4 * 60 * 1000);
    await expect(code.assertActivationAllowed(env, ip)).rejects.toMatchObject({ status: 429 });

    // Simulate the lock expiring, then five more failures must double the lock.
    await env.DB.prepare(`UPDATE activation_guard SET locked_until = ? WHERE ip_hash = ?`)
      .bind(now() - 1000, ip)
      .run();
    for (let attempt = 6; attempt <= 10; attempt++) {
      await code.recordActivationFailure(env, ip, {});
    }
    guard = await env.DB.prepare(`SELECT failures, locked_until FROM activation_guard WHERE ip_hash = ?`)
      .bind(ip)
      .first<{ failures: number; locked_until: number }>();
    expect(guard?.failures).toBe(10);
    expect((guard?.locked_until ?? 0) - now()).toBeGreaterThan(9 * 60 * 1000);

    await code.noteActivationRegistration(env, ip, { serverName: "SMP-B", installationId: "ins_b" });
    const guards = await code.listActivationGuards(env);
    expect(guards[0]?.server_names).toEqual(["SMP-A", "SMP-B"]);
  });
});

describe("admin analytics", () => {
  it("renders the 14-day graphs, detection panels and lockout table", async () => {
    await seedProduct();
    const admin = await seedUser({ email: "admin-dash@example.com", role: "super_admin" });
    const cookie = await sessionCookie(admin.id);

    const dashboard = await request("/admin", { headers: { cookie } });
    expect(dashboard.status).toBe(200);
    const dashboardHtml = await dashboard.text();
    expect(dashboardHtml).toContain("ข้อมูลเชิงลึก 14 วัน");
    expect(dashboardHtml).toContain("IP ที่กำลังถูกล็อก");
    expect(dashboardHtml).toContain("การตรวจพบตามประเภท");

    const security = await request("/admin/security", { headers: { cookie } });
    expect(security.status).toBe(200);
    expect(await security.text()).toContain("การป้องกันการเดารหัสเปิดใช้งาน");
  });
});
