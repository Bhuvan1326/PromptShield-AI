/**
 * Local, bounded performance smoke — synthetic workload, in-process fetch.
 * Methodology: warmup excluded; p50/p95/p99 from 60 samples per endpoint.
 * Numbers are LOCAL measurements, not guarantees — hardware-dependent.
 * Requires: server running on :8787 (deterministic mode for stable numbers).
 */
const BASE = "http://localhost:8787";
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(1);
};

// Warmup
await fetch(`${BASE}/api/health/status`);

// Run with a relaxed limiter (PS_RL_RUNS_MAX=500, PS_RL_WINDOW_MS=1000) —
// this measures latency, not limiting (limit behavior is tested elsewhere).
async function timedPost(path, body, n) {
  const times = [];
  let nonOk = 0;
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    const r = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) nonOk++;
    times.push(performance.now() - t);
  }
  return { times, nonOk };
}

const fw = await timedPost("/api/firewall/evaluate", { tool: "lookup_ticket", args: { ticketId: "T-1" } }, 60);
console.log(
  `firewall/evaluate n=60 ok=${60 - fw.nonOk}  p50=${pct(fw.times, 50)}ms  p95=${pct(fw.times, 95)}ms  p99=${pct(fw.times, 99)}ms`,
);

const health = [];
for (let i = 0; i < 60; i++) {
  const t = performance.now();
  await fetch(`${BASE}/api/health/status`);
  health.push(performance.now() - t);
}
console.log(`health/status    n=60  p50=${pct(health, 50)}ms  p95=${pct(health, 95)}ms  p99=${pct(health, 99)}ms`);

// Agent session duration (quick preset, fast pacing) — pause for rate window.
await new Promise((r) => setTimeout(r, 500));
const t0 = performance.now();
const createdRes = await fetch(`${BASE}/api/agent/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ environment: "baseline", preset: "quick" }),
});
const created = await createdRes.json();
if (!created.id) throw new Error(`agent session create failed: HTTP ${createdRes.status}`);
let sess = created;
while (sess.status === "running") {
  await new Promise((r) => setTimeout(r, 120));
  sess = await (await fetch(`${BASE}/api/agent/sessions/${sess.id}`)).json();
}
console.log(
  `agent quick session (baseline): ${(performance.now() - t0).toFixed(0)}ms, ` +
    `${sess.budget.stepsUsed} steps, ${sess.trace.length} trace events, stop=${sess.stopReason}`,
);

// Run creation + persistence cost (full suite = 10 executions + JSON write)
const runT = [];
for (let i = 0; i < 8; i++) {
  const t = performance.now();
  await fetch(`${BASE}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ environment: "baseline", suiteId: "full" }),
  });
  runT.push(performance.now() - t);
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`POST /api/runs (10 tests + persist) n=8  p50=${pct(runT, 50)}ms  max=${Math.max(...runT).toFixed(1)}ms`);

const mem = process.memoryUsage();
console.log(`process memory (measurement host): rss=${(mem.rss / 1048576).toFixed(0)}MB heap=${(mem.heapUsed / 1048576).toFixed(0)}MB`);
