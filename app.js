// app.js — THP-aware RSS demonstrator (safe on small RAM)
// Run with: node --expose-gc app.js
// Env knobs (all optional):
//   STICKY_PRESET=1            -> many ~1–2MB buffers (good on 1–2 GB hosts)
//   ALLOC_OBJECTS=24           -> how many buffers per wave
//   ALLOC_SIZE_MB=64           -> size of each buffer (can be fractional, e.g. 1.5)
//   HOLD_MS=2500               -> hold time before free+GC
//   TARGET_UTIL=0.80           -> auto-throttle to % of cgroup/host limit
//   GLIBC_TUNABLES=glibc.malloc.arena_max=64  (optional: stickier RSS)
// Tip: A/B test THP on the host: `echo always|sudo tee .../enabled` vs `echo never|sudo tee .../enabled`

const fs = require('fs');

const MB = 1024 * 1024;
const PATHS = {
  thpEnabled: '/sys/kernel/mm/transparent_hugepage/enabled',
  smapsRollup: '/proc/self/smaps_rollup',
  smaps: '/proc/self/smaps',
  status: '/proc/self/status',
  meminfo: '/proc/meminfo',
  // cgroup v2
  cg2Max: '/sys/fs/cgroup/memory.max',
  cg2Cur: '/sys/fs/cgroup/memory.current',
  // cgroup v1 fallback
  cg1Max: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  cg1Cur: '/sys/fs/cgroup/memory/memory.usage_in_bytes',
};

function rd(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function mb(n) { return (n / MB).toFixed(1); }
function toInt(s, d=0){ const n = Number(s); return Number.isFinite(n) ? n : d; }

// ---------- Config (env) ----------
const STICKY_PRESET = (process.env.STICKY_PRESET || '0') === '1'; // many small buffers
const OBJ  = Number(process.env.ALLOC_OBJECTS ?? (STICKY_PRESET ? 120 : 8));
const SIZE_MB_RAW = Number(process.env.ALLOC_SIZE_MB ?? (STICKY_PRESET ? 1.5 : 16)); // fractional ok
const HOLD = Number(process.env.HOLD_MS ?? 1500);
const TARGET_UTIL = Math.min(Math.max(Number(process.env.TARGET_UTIL || 0.80), 0.10), 0.95); // 10–95%
const SIZE_BYTES = Math.max(1, Math.floor(SIZE_MB_RAW * MB));

// ---------- THP / cgroup ----------
function thpMode() {
  const t = rd(PATHS.thpEnabled) || '';
  if (/\[always\]/.test(t)) return 'always';
  if (/\[madvise\]/.test(t)) return 'madvise';
  if (/\[never\]/.test(t)) return 'never';
  return t.trim() || 'unknown';
}
function cgLimitBytes() {
  let v = rd(PATHS.cg2Max);
  if (v) return v.trim() === 'max' ? Infinity : toInt(v.trim(), Infinity);
  v = rd(PATHS.cg1Max);
  if (v) return toInt(v.trim(), Infinity);
  // bare metal / no limit
  return Infinity;
}
function cgCurrentBytes() {
  let v = rd(PATHS.cg2Cur);
  if (v) return toInt(v.trim(), 0);
  v = rd(PATHS.cg1Cur);
  if (v) return toInt(v.trim(), 0);
  // rough fallback
  return 0;
}

// ---------- memory reading ----------
function parseKeyKB(text, key) {
  const m = text && text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
  return m ? Number(m[1]) : 0;
}
function readMem() {
  const r = rd(PATHS.smapsRollup);
  if (r) return { rssKB: parseKeyKB(r, 'Rss'), anonHugeKB: parseKeyKB(r, 'AnonHugePages') };
  const s = rd(PATHS.smaps);
  if (s) {
    let rssKB = 0, anonHugeKB = 0;
    for (const line of s.split('\n')) {
      if (line.startsWith('Rss:')) rssKB += parseInt(line.split(/\s+/)[1] || '0', 10);
      else if (line.startsWith('AnonHugePages:')) anonHugeKB += parseInt(line.split(/\s+/)[1] || '0', 10);
    }
    return { rssKB, anonHugeKB };
  }
  const status = rd(PATHS.status);
  const meminfo = rd(PATHS.meminfo);
  return {
    rssKB: status ? parseKeyKB(status, 'VmRSS') : Math.round(process.memoryUsage().rss / 1024),
    anonHugeKB: meminfo ? parseKeyKB(meminfo, 'AnonHugePages') : 0,
  };
}

function printUsage(tag) {
  const mu = process.memoryUsage();
  const m = readMem();
  console.log(
    `[${new Date().toISOString()}] ${tag} | ` +
    `rss=${mb(mu.rss)}MB | heapUsed=${mb(mu.heapUsed)}MB | external=${mb(mu.external)}MB | ` +
    `AnonHugePages=${mb(m.anonHugeKB * 1024)}MB | RssRollup=${mb(m.rssKB * 1024)}MB`
  );
}

// touch pages to ensure commit (and let THP/khugepaged coalesce)
function touch(buf) {
  const page = 4096;
  for (let i = 0; i < buf.length; i += page) buf[i] = 1;
  if (buf.length % page) buf[buf.length - 1] = 1;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// plan objects so we don’t blow past cgroup/host limit
function planObjects(objects, sizeBytes) {
  const limit = cgLimitBytes();
  if (!Number.isFinite(limit) || limit <= 0) return objects;
  const cur = cgCurrentBytes();
  const headroom = Math.max(0, TARGET_UTIL * limit - cur);
  const fit = Math.max(1, Math.floor(headroom / sizeBytes));
  return Math.min(objects, fit);
}

async function wave({ objects = OBJ, sizeBytes = SIZE_BYTES, holdMs = HOLD }) {
  const planned = planObjects(objects, sizeBytes);
  if (planned < objects) {
    console.log(`[throttle] reducing objects ${objects} -> ${planned} (target util ${Math.round(TARGET_UTIL*100)}%)`);
  }
  objects = planned;

  const arr = new Array(objects);
  printUsage(`BEFORE allocate (${objects} x ${(sizeBytes/MB).toFixed(2)}MB)`);

  try {
    for (let i = 0; i < objects; i++) {
      arr[i] = Buffer.allocUnsafe(sizeBytes);
      touch(arr[i]);
    }
    printUsage('AFTER allocate');
  } catch (e) {
    console.error('[ERROR] Allocation failed:', e?.message || e);
  }

  await sleep(holdMs);

  for (let i = 0; i < objects; i++) arr[i] = null;

  if (!global.gc) {
    console.warn('[WARN] Run node with --expose-gc to force GC for clearer logs');
  } else {
    try { global.gc(); } catch {}
  }

  printUsage('AFTER free + GC');
  await sleep(1000);
}

// signal logs help diagnose 137 exits vs graceful
process.on('SIGTERM', () => { console.log('[SIGNAL] SIGTERM'); setTimeout(()=>process.exit(143), 10); });
process.on('SIGINT',  () => { console.log('[SIGNAL] SIGINT');  setTimeout(()=>process.exit(130), 10); });

(async () => {
  console.log('THP demo starting…');
  console.log(`THP mode: ${thpMode()}`);
  const lim = cgLimitBytes();
  console.log(`cgroup/host limit seen: ${Number.isFinite(lim) ? (mb(lim)+'MB') : 'unlimited'}`);
  printUsage('START');

  let w = 1;
  while (true) {
    console.log(`\n=== WAVE ${w++} ===`);
    await wave({});
  }
})();
