# BaseHider 3.6.1

Server-side **anti-ESP / anti-base-ESP / anti-storage-ESP** protection for **Paper 1.21.4**
(Java 21). BaseHider removes protected data from outgoing packets before it can reach a
client and uses Paper's native per-player entity visibility API for dropped items.

Security model: **fail-closed**. Anything that is not positively proven visible is hidden.
Errors, unknown worlds, stale state, timeouts, missing configuration and queue pressure all
keep data hidden — never the opposite.

3.6.1 is the 3.6.0 security core plus an optional signed licence/telemetry client for a
BaseHider Control Platform instance. 3.6.0 (JAR `bbb8da…`) remains the last build verified
on a live production server; 3.6.1 was verified on a Paper 1.21.4 staging server (enable,
packet gateway ACTIVE, license ACTIVE, lease verified, heartbeat accepted).

---

## Requirements

| Component | Version |
|---|---|
| Server | Paper **1.21.4** (this build enforces `V_1_21_4` for the packet gateway) |
| Java | **21** |
| PacketEvents plugin | **2.14.0+** — required for block/container/chunk protection |

Without PacketEvents the plugin still loads and protects items/entities with Paper's
native visibility API, but block protection is **disabled** and reported as `INACTIVE`
(no insecure "send then patch" fallback).

## Install

1. Put `BaseHider-3.6.1.jar` in `plugins/`.
2. Put `PacketEvents` 2.14.0+ in `plugins/` as well.
3. Start the server. `plugins/BaseHider/config.yml` is generated on first start.
4. Check `/basehider status` and `/basehider verify`.
5. Optional: configure `plugins/BaseHider/platform/platform.yml` for signed licences and telemetry.

Upgrading from 3.6.0: keep the existing `plugins/BaseHider/` data folder, stop the server,
replace the jar, start. The 3.6.1 changes are additive (platform client and command output);
the packet/security code is unchanged.

## What it protects

- **Dropped items** (all item entities: player/mob/block/natural, custom data/components,
  enchanted, shulker contents, merged stacks) — hidden by default, revealed only when
  close, inside the field of view and not occluded, or to the player who dropped them.
- **Storage blocks and other tile-entity blocks** configured in
  `worlds.<world>.block-protection.hidden-blocks` (chests, barrels, shulkers, hoppers,
  furnaces, dispensers, spawners, trial spawners, vaults, ...): removed from chunk data,
  block-change packets, block-entity data and block actions before send; revealed through
  the same distance/FOV/occlusion policy. Natural structures are discovered from real
  chunk data, so no per-world marking is needed.
- **Tunnel / Dug-hole Shield**: player-mined blocks are remembered (bounded, default
  50,000) and the original material is sent to viewers farther than `hide-radius` (28
  blocks) instead of the new air, in chunk packets and live block-change packets. Walking
  within 28 blocks reveals the real tunnel; walking away re-masks it. Hidden containers are
  not recorded (block shield owns them). Memory-only across a restart; player breaks only,
  not explosions/pistons; bypass players see the real world.
- **Configurable entity types** (`item-protection.hidden-entity-types`) — items by default;
  suitable for item frames, armor stands and storage minecarts. Player entities are
  intentionally not supported (would break teams/combat; documented limitation).

Server-side gameplay is not modified: pickups, merging, physics, despawn timers, item
stacks and containers behave exactly like vanilla. Hidden items can still be picked up.

## Commands

| Command | Description |
|---|---|
| `/basehider status` | module states, packet gateway, protected object counts, warnings |
| `/basehider diag` | live tick timing, raycast budget, engine queues, gateway counters (`tunnelMasked`, `tunnelTracked`) |
| `/basehider deep` | async diagnostics (never on the security path) |
| `/basehider stats` | security counters since start |
| `/basehider verify` | runtime invariant self-check (listener registration, tracked entity invariants, stale reveal markers) |
| `/basehider rescan` | immediately re-discover loaded chunks (admin tool) |
| `/basehider reload` | reload config, re-index loaded chunks, re-register protected entities |
| `/basehider license status` | licence state, installation UUID, lease expiry, telemetry buffer |
| `/basehider license link` | register this server and print the activation code for the portal |
| `/basehider license refresh` | fetch and verify a new signed lease immediately |
| `/basehider help` | command help |

Permissions: `basehider.admin` (commands), `basehider.bypass` (per-world configurable
`bypass-permission` string).

## Configuration notes

- `security.main-thread-budget-ms` — per-tick budget for reveal work (default 1.5 ms).
  Work is sliced; hidden data stays hidden while deferred.
- `security.raycast-budget-per-tick` — shared ray budget (default 300).
- `block-protection.hidden-blocks` — only tile-entity backed materials are accepted
  (they are discoverable from real chunks). Unsupported entries are rejected with a
  console warning instead of giving partial protection.
- `block-protection.reveal` / `item-protection.reveal` — distance, FOV and (blocks)
  keep-distance hysteresis.
- `worlds.<world>.tunnel-shield.enabled` / `hide-radius` / `max-tracked-breaks` — dug-hole
  masking (defaults: true / 28.0 / 50000).
- `analytics.*` — optional, non-enforcing mining/raid analytics (disabled by default).
  They never change visibility and never ban/kick.

## Platform licensing and telemetry (optional)

The 3.6.1 build includes a client for a BaseHider Control Platform (Cloudflare) instance.
It is isolated from the security path and can never make protection fail open.

Configuration: `plugins/BaseHider/platform/platform.yml`

```yaml
enabled: true
api-base-url: https://your-platform.example.com
product: basehider
enforcement: warn
trial-days: 7
lease-refresh-minutes: 60
heartbeat-minutes: 3
telemetry:
  enabled: true
```

Pairing:

1. Set `api-base-url`, then restart the server.
2. Run `/basehider license link`. The server registers an Ed25519 identity and prints an
   8-character activation code plus the portal URL.
3. In the platform portal (`/app/activations`), enter the code and choose a licence.
4. Run `/basehider license refresh`. The client fetches a lease, verifies the Ed25519
   signature locally with the published key, and caches it.
5. Leases renew in the background. If the platform is unreachable, the last valid lease
   plus the configured offline grace keeps the server running.

Files created under `plugins/BaseHider/platform/`: `identity.json` (UUID, public key,
fingerprint), `private.key` (PKCS#8 Ed25519, owner-only where the filesystem supports it),
`platform.yml`, and the cached lease. Back up `identity.json` and `private.key` with the
plugin data; deleting them creates a new installation and requires a new activation.

Telemetry is aggregate-only: versions, enabled modules, TPS, players online, error count.
No player names, IPs, inventories, chat or coordinates are sent.

`enforcement: warn` is the default: licence problems are logged and shown in
`/basehider license status`, but the security core keeps protecting the server. This is a
deliberate choice for an anti-ESP plugin; do not let licensing take down protection.

## Build

```
mvn -B clean verify
```

Requires JDK 21 and Maven 3.9+. Produces `target/BaseHider-3.6.1.jar` (shaded/relocated
FastUtil). Test suite: 102 tests (security engines, config, packet sanitization and the
platform client: JSON, canonical signing string, identity, lease verification, config).

## What's new in 3.6.1

- Signed licence client: Ed25519 installation identity, activation pairing, offline lease
  verification, background refresh, bounded telemetry buffer and heartbeat.
- New commands `/basehider license status|link|refresh`; all network I/O runs on a
  dedicated daemon executor, never on the main thread.
- Command replies are sent synchronously on the main thread, so RCON/console output is
  captured correctly; async callbacks are scheduled back on the main thread.
- Version strings in the enable/disable log are read from `plugin.yml`.
- Security core and Tunnel Shield unchanged from 3.6.0; licence/telemetry failures are
  logged and can never disable or fail open protection.
- 102 tests pass; Paper 1.21.4 staging verification PASS.

## What's new in 3.6.0

- Tunnel / Dug-hole Shield: hide player-dug tunnels and holes beyond 28 blocks, re-mask
  when the viewer leaves, in both chunk and block-change packets.
- Y-Shield, contextual filler and player ESP shield; gateway diagnostics include
  `tunnelMasked` and `tunnelTracked`.
- 85 unit tests; verified running on a live Paper 1.21.4 server at TPS 20.0.

## Delivery / verification snapshot

- Built jar (this source tree): `target/BaseHider-3.6.1.jar`
  sha256 `fba61fd3c446c5d708cf146ddf8ed485dbb47fb874292268c6b82b5cea7fcc5d`,
  6,877,057 bytes.
- `mvn package`: BUILD SUCCESS, 102 tests.
- Paper 1.21.4 staging (fresh data folder, PacketEvents 2.14.0, ViaVersion 5.12.2):
  plugin enabled, packet gateway ACTIVE, block/item protection ACTIVE, Tunnel Shield
  present (`tunnelMasked`/`tunnelTracked` in diag), platform registration -> activation ->
  lease signature verified -> heartbeat accepted, clean shutdown with no exceptions.
- 3.6.0 (`bbb8da…`) remains the last build verified on a live production server; the
  3.6.1 changes are additive and do not touch packet paths.

## Known limitations

- Tunnel history is memory-only: a restart forgets old player-dug holes. Explosions and
  pistons are not tracked. Re-sent original materials use the default block state (log/
  stairs orientation may differ). Bypass players see the real world.
- Player-vs-player hiding is out of scope; other Paper 1.21.x builds need a
  rebuild/verification before the packet gateway activates; ViaVersion clients older than
  1.18 have sensitive chunk packets cancelled (fail-closed).
- `enforcement: warn` is the default and never disables protection. A server with an
  invalid licence is reported in `/basehider license status` but keeps protecting players.
- Revocation takes effect on the next successful lease refresh; an offline server can keep
  running through the 72-hour offline grace.
- Deleting `plugins/BaseHider/platform/identity.json` or `private.key` creates a new
  installation and requires a new activation.
- The 3.2.0/3.6.0 jars distributed before 3.6.1 do not contain the client; ship 3.6.1 or
  later for platform licensing.
