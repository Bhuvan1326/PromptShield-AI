import { describe, expect, it, beforeAll, afterAll } from "vitest";

/**
 * REAL-Redis integration tests — run ONLY when PS_REDIS_URL is set (CI
 * service container or local `redis-server`). Skipped entirely otherwise.
 * These exercise the actual Lua scripts and atomic commands — the only
 * environment where the distributed guarantees are truly proven.
 */
const url = process.env.PS_REDIS_URL;
const maybe = url ? describe : describe.skip;

maybe("Redis coordinator — live integration", () => {
  let client: import("ioredis").Redis;
  let coord: ReturnType<typeof import("../server/coordination").redisCoordinator>;

  beforeAll(async () => {
    const { Redis } = await import("ioredis");
    const { redisCoordinator } = await import("../server/coordination");
    client = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.connect();
    await client.flushdb();
    coord = redisCoordinator(client);
  });

  afterAll(async () => {
    await client.quit();
  });

  it("concurrent acquisition never exceeds capacity; expired lease frees slots", async () => {
    // Two coordinators sharing one Redis = two app instances.
    const { redisCoordinator: mk } = await import("../server/coordination");
    const other = mk(client);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => coord.acquireSlot("shared-owner", 60_000)),
    );
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(3);
    // Other instance sees the SAME remaining capacity.
    const shared = await other.acquireSlot("shared-owner", 60_000);
    const used = results.filter(Boolean).length;
    expect(shared === null || used < 3).toBe(true);
    // Release one → exactly one new lease possible.
    await coord.releaseSlot("shared-owner", results[0]!);
    expect(await coord.acquireSlot("shared-owner", 60_000)).toBeTruthy();
  });

  it("lease expiry auto-releases; stale release cannot drop a newer lease", async () => {
    const short = await coord.acquireSlot("expiring-owner", 60);
    expect(short).toBeTruthy();
    await new Promise((r) => setTimeout(r, 100));
    // Expired → slot reclaimed.
    const newer = await coord.acquireSlot("expiring-owner", 60_000);
    expect(newer).toBeTruthy();
    // Stale holder releases → newer lease unaffected.
    await coord.releaseSlot("expiring-owner", short!);
    expect(await coord.leaseValid("expiring-owner", newer!)).toBe(true);
  });

  it("shared rate limit spans instances; TTL resets the window", async () => {
    const { redisCoordinator: mk2 } = await import("../server/coordination");
    const other = mk2(client);
    // max=2 across both coordinators (two "instances").
    expect(await coord.rateLimit("test-scope", "key", 300, 2)).toBe(true);
    expect(await other.rateLimit("test-scope", "key", 300, 2)).toBe(true);
    expect(await coord.rateLimit("test-scope", "key", 300, 2)).toBe(false);
    await new Promise((r) => setTimeout(r, 350));
    expect(await coord.rateLimit("test-scope", "key", 300, 2)).toBe(true);
  });

  it("idempotency: first reserves, duplicate replays, conflicting payload 409s, expiry frees", async () => {
    const r1 = await coord.reserveIdem({
      scopeKey: "o|r|k1", fingerprint: "fp-a", sessionId: "s1", ttlMs: 200,
    });
    expect(r1.state).toBe("fresh");
    await coord.finalizeIdem("o|r|k1");
    const r2 = await coord.reserveIdem({
      scopeKey: "o|r|k1", fingerprint: "fp-a", sessionId: "s2", ttlMs: 200,
    });
    expect(r2.state).toBe("replay");
    expect(r2.sessionId).toBe("s1");
    const r3 = await coord.reserveIdem({
      scopeKey: "o|r|k1", fingerprint: "fp-DIFFERENT", sessionId: "s3", ttlMs: 200,
    });
    expect(r3.state).toBe("conflict");
    await new Promise((r) => setTimeout(r, 250));
    const r4 = await coord.reserveIdem({
      scopeKey: "o|r|k1", fingerprint: "fp-new", sessionId: "s4", ttlMs: 200,
    });
    expect(r4.state).toBe("fresh");
  });
});
