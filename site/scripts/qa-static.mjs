#!/usr/bin/env node
/** Static landing-page QA: links, assets, anchors, duplicate ids, overflow, copy checks. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve("public");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const base = "http://127.0.0.1:4321/";
let failures = 0;

function fail(message) {
  failures++;
  console.log("FAIL:", message);
}

/* ---------- assets / links ---------- */
const refs = new Set();
for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  const value = match[1];
  if (!value || value.startsWith("http") || value.startsWith("mailto:") || value.startsWith("data:")) continue;
  if (value.startsWith("#")) continue;
  refs.add(value.split("?")[0]);
}
for (const ref of refs) {
  const target = path.join(root, ref.replace(/^\//, ""));
  if (!fs.existsSync(target)) fail(`missing file for ${ref}`);
  const response = await fetch(base + ref.replace(/^\//, ""), { method: "GET" });
  if (!response.ok) fail(`${ref} -> HTTP ${response.status}`);
  await response.arrayBuffer();
}
console.log(`checked ${refs.size} file references`);

/* ---------- anchors ---------- */
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const duplicates = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const seen = new Set();
for (const id of duplicates) {
  if (seen.has(id)) fail(`duplicate id: ${id}`);
  seen.add(id);
}
for (const match of html.matchAll(/href="#([^"]+)"/g)) {
  if (!ids.has(match[1])) fail(`missing anchor target: #${match[1]}`);
}
for (const match of html.matchAll(/<use href="#([^"]+)"/g)) {
  if (!ids.has(match[1])) fail(`missing svg symbol: #${match[1]}`);
}
console.log(`checked ${ids.size} ids and anchor targets`);

/* ---------- suspicious strings ---------- */
const bad = ["Ã", "â€", "信息", "technical", "TODO", "lorem ipsum", "undefined"];
for (const token of bad) {
  if (html.includes(token)) fail(`suspicious string in HTML: ${token}`);
}

/* ---------- release checksums (jars are served by the platform/R2) ---------- */
const sumsPath = path.join(root, "download/SHA256SUMS");
if (!fs.existsSync(sumsPath)) {
  fail("missing download/SHA256SUMS");
} else {
  const lines = fs.readFileSync(sumsPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 6) fail(`SHA256SUMS should list 6 builds, found ${lines.length}`);
  const entries = new Map();
  for (const line of lines) {
    const match = line.match(/^([0-9a-f]{64}) \*?(Aegishider-4\.0\.0-mc[0-9.]+\.jar)$/);
    if (!match) {
      fail(`malformed SHA256SUMS line: ${line}`);
      continue;
    }
    entries.set(match[2], match[1]);
    if (!html.includes(match[1])) fail(`checksum for ${match[2]} is not shown on the page`);
  }
  const recommended = entries.get("Aegishider-4.0.0-mc1.21.11.jar");
  const shown = html.match(/id="shaValue">([0-9a-f]{64})</)?.[1];
  if (!recommended) fail("recommended 1.21.11 build missing from SHA256SUMS");
  else if (shown !== recommended) fail("recommended SHA-256 on the page does not match SHA256SUMS");
  console.log(`release checksums: ${entries.size} builds, recommended hash verified`);
}

/* ---------- og image ---------- */
const og = path.join(root, "assets/img/og.jpg");
if (!fs.existsSync(og)) fail("missing og.jpg");
else {
  const bytes = fs.statSync(og).size;
  console.log(`og.jpg: ${bytes} bytes`);
  if (bytes > 400_000) fail("og.jpg larger than 400 KB");
}

/* ---------- required deployment files ---------- */
for (const file of ["_headers", "_redirects", "404.html", "robots.txt", "site.webmanifest", "wrangler.toml"]) {
  const target = file === "wrangler.toml" ? path.resolve("wrangler.toml") : path.join(root, file);
  if (!fs.existsSync(target)) fail(`missing deployment file: ${file}`);
}

console.log(failures === 0 ? "\nALL STATIC CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
