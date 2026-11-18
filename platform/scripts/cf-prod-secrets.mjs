import fs from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";

const turnstileSecret = process.argv[2] ?? "";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const secrets = {
  LICENSE_KEY_PEPPER: randomBytes(32).toString("hex"),
  LICENSE_SIGNING_KEY: pkcs8,
  LICENSE_PUBLIC_KEY: spki,
  LICENSE_SIGNING_KEY_ID: "prod-1",
  OTP_PEPPER: randomBytes(32).toString("hex"),
  TURNSTILE_SECRET: turnstileSecret,
};
fs.writeFileSync(".prod-secrets.json", JSON.stringify(secrets, null, 2), { mode: 0o600 });
console.log("wrote .prod-secrets.json with", Object.keys(secrets).length, "secrets");
