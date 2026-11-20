# Aegishider 4.0.0

Server-side **anti-ESP / anti-base-ESP / anti-storage-ESP** for **Paper 1.21.1 – 26.3**
(Java 21; Paper 26.x runs on Java 25). Protected data is removed from outgoing packets
before a client can receive it, and item/entity visibility uses Paper's native per-player
visibility API.

Security model: **fail-closed for the packet/visibility path**. Errors, unknown worlds,
stale state, timeouts, missing PacketEvents and queue pressure keep protected data hidden.
The licence is a separate product gate (see below).

---

## Download and licence activation (required by default)

The shipped `platform.yml` uses `enforcement: enforce`. The plugin loads and exposes its
commands, but **protection stays disabled until this server is activated on the platform**:

1. Put the matching `Aegishider-4.0.0-mc<version>.jar` and **PacketEvents 2.14.0+** in `plugins/`.
2. Start the server. Protection is intentionally inactive.
3. Run `/aegishider license link`; the server registers an Ed25519 installation identity
   and prints a 16-character activation code plus the portal URL.
4. Sign in (free account) at the **Aegishider Control Platform** — website alias
   `https://aegishider-platform.audijuju1.workers.dev` (the API base is
   `https://basehider-platform.audijuju1.workers.dev`) — open **การเปิดใช้งาน** and enter the code.
5. Run `/aegishider license refresh`, then `/aegishider status`; `protection` must be `ACTIVE`.

The platform is free. Leases are Ed25519-signed, refresh in the background and use a 72-hour
offline grace. If the platform is unreachable at first start the plugin cannot activate and
protection stays off; that is deliberate. Server owners who do not want the gate can set
`enforcement: warn` (or `enabled: false`) in `plugins/Aegishider/platform/platform.yml`.

## Builds (separate jars)

| Jar suffix | Compiled against | Recommended for |
|---|---|---|
| `mc1.21.1` | paper-api 1.21.1 | Paper 1.21.1–1.21.4 |
| `mc1.21.4` | paper-api 1.21.4 | Paper 1.21.4 (full A–F harness build) |
| `mc1.21.5` | paper-api 1.21.5 | Paper 1.21.5–1.21.8 |
| `mc1.21.11` | paper-api 1.21.11 | Paper 1.21.9–1.21.11 (recommended 1.21.x) |
| `mc26.1` | paper-api 26.1.2 | Paper 26.1.x |
| `mc26.3` | paper-api 26.3 | Paper 26.2–26.3 |

Each jar is compiled against its target API and carries a generated `build.properties`
stamp (`target`, `paper`). `plugin.yml` keeps `api-version: '1.21'`, which Paper 26.x accepts.
Folia is not supported. PacketEvents 2.14.0+ is required for block/container protection;
without it the plugin still protects entities/items but block protection is reported
`INACTIVE` (never a send-then-patch fallback).

## 4.0.0 behaviour changes

- **Ghost blocks fixed.** Breaking a hidden container while it was rendered as filler used
  to have the air update rewritten back to the filler, so the block “came back” forever.
  Air removals are now passed through; Tunnel Shield still masks its own dug-block updates.
- **Monsters are occlusion-only by default.** Hostile mobs are hidden only when a wall,
  terrain or underground blocks the line of sight. Field of view and distance no longer
  hide monsters (distance cap 96 blocks, beyond normal entity tracking), so turning around
  no longer makes mobs pop in/out. Items, item frames, armour stands and storage minecarts
  keep the strict distance + FOV + occlusion policy. Configure with
  `item-protection.monster-occlusion-only` / `monster-max-distance`.
- **Block reveal distance 12 → 16 blocks.** Fewer close-range pop-in moments; everything
  beyond 16 blocks is still replaced before it reaches a client.
- **Licence gate**, pinned platform key, server-side release hash reporting and a periodic
  entity sweep for spawn paths that bypass Bukkit's spawn events.

## What it protects

- Dropped items/entities, optionally item frames, armour stands and storage minecarts.
- Configured tile-entity blocks (chests, barrels, shulkers, hoppers, furnaces, dispensers,
  spawners, trial spawners, vaults, ...) discovered from real chunk data.
- Tunnel / dug-hole shield (defaults off): player-mined blocks beyond 28 blocks are shown
  as their original material; walking close reveals the real tunnel.
- Optional player-vs-player shield (default off).

Server-side gameplay is unchanged: pickups, merging, physics, despawn timers, containers
and item stacks behave like vanilla. Hidden items can still be picked up.

## Commands / permissions

`/aegishider status|diag|viewer|export|deep|stats|verify|rescan|reload|license|help`
(alias `/ah`). Permissions: `aegishider.admin`, `aegishider.admin.license`,
`aegishider.admin.diagnostics`, `aegishider.bypass` (not granted to OPs by default).
Commands other than status/license/help are refused until protection is activated.

## Release protection layers

The shipped jars are built by the Sentinel Shield JAR pipeline from `D:\sentinel-shield`
plus a local ASM pass:

1. ProGuard 7.10 rename/shrink, source/line/local-variable stripping.
2. String-constant encryption for the ~99 plugin classes (ASM; FastUtil skipped).
3. `Record` attribute removal (component names no longer readable).
4. `META-INF/maven/**` and signature metadata removed from the shaded jar.
5. Per-build `build.properties` stamp (the six jars are not byte-identical).
6. Ed25519 per-entry signed manifest (sidecar `.sentinel.json`).
7. Secret scan of the input/output jar.
8. Runtime anti-debug gate: JDWP, `-Xdebug`, `-agentlib`, `-javaagent` and JMX remote stop
   protection from starting unless `security.allow-debug: true`.
9. Pinned platform Ed25519 key (`prod-1`, SPKI SHA-256 `7ba972af…`) so a rogue platform
   response cannot mint a trusted lease.
10. Server-side release verification: the plugin reports its actual jar SHA-256 on every
    heartbeat; the platform compares it to published release records.
11. Licence gate + Ed25519 installation identity, lease, refresh and offline grace.
12. Fail-closed packet/visibility paths and the periodic entity safety sweep.

These are real, testable layers — not “200 arbitrary transformations”. Client-side code can
never be made impossible to reverse; the goal is raising cost and detecting unlisted builds.

## Build / release

Requirements: JDK 21 and JDK 25, Maven 3.9+, ProGuard 7.10+, Sentinel Shield venv, ASM 9.8,
and an Ed25519 release key outside the repo.

```bash
cd aegishider-integrated
mvn -B test                                  # 124 tests
mvn -B -Pmc1211 -Dmaven.test.skip=true package
# or run the whole matrix + string encryption + ProGuard + manifests:
cd ..
SENTINEL_PY=/d/sentinel-shield/.venv/Scripts/python.exe bash scripts/release.sh
```

Artifacts: `dist/plain/` (plain), `dist/pre/` (string-encrypted), `dist/obf/` (final,
obfuscated, signed manifest sidecars) and `dist/obf/SHA256SUMS`. Private keys live in
`.release/keys/` and are never committed.

## Verification snapshot

- 124 unit tests, 0 failures.
- A–F packet harness PASS on Paper 1.21.4 (plain and ProGuard-obfuscated jar); the same
  harness detects A/C/D/E/F leaks in the legacy BaseHider 3.0.0 baseline.
- Smoke tests: Paper 1.21.1, 1.21.5, 1.21.11, 26.1.2 and 26.3 — PacketEvents gateway ACTIVE
  on `V_1_21_1`, `V_1_21_5`, `V_1_21_11`, `V_26_1_2`, `V_26_3`.
- Real-server behaviour test: an open zombie behind the player's back stays visible while a
  zombie behind a wall is hidden; a filler block that is mined becomes air (no ghost loop).
- Licence gate test: with no lease, `protection=WAITING_FOR_LICENSE`, gateway `NOT_STARTED`.

## Known limitations

- The licence gate needs one successful online activation; offline grace applies after that.
- The platform signing key is pinned; key rotation requires a plugin update or an additional
  `trusted-key-sha256` in `platform.yml`.
- String encryption hides literals but the embedded decoder key can be recovered by a
  determined reverse engineer; server-side SHA reporting is the detection layer.
- Tunnel history is memory-only; explosions/pistons are not tracked; bypass players see the
  real world. Player-vs-player hiding is opt-in and has the documented team/combat rules.
- Paper's plugin remapper and future Minecraft protocol changes can require a new build.
