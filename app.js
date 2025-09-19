// app.js (robust)
const fs = require('fs');

const MB = 1024 * 1024;
const PATH_SMAPS_ROLLUP = '/proc/self/smaps_rollup';
const PATH_STATUS = '/proc/self/status';
const PATH_SMAPS = '/proc/self/smaps';
const PATH_MEMINFO = '/proc/meminfo';

const OBJ  = Number(process.env.ALLOC_OBJECTS || 8);    // safer defaults
const SIZE = Number(process.env.ALLOC_SIZE_MB || 16);   // 8*16MB = 128MB per wave
const HOLD = Number(process.env.HOLD_MS || 1500);

function mb(n) { return (n / MB).toFixed(1); }
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

function parseKeyKB(text, key) {
  const m = text && text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
  return m ? Number(m[1]) : 0;
}

// Try smaps_rollup; else sum smaps; else fall back to status + meminfo
function readMem() {
  const roll = readFileSafe(PATH_SMAPS_ROLLUP);
  if (roll) {
    return {
      rssKB: parseKeyKB(roll, 'Rss'),
      anonHugeKB: parseKeyKB(roll, 'AnonHugePages'),
    };
  }
  // sum /proc/self/smaps (slower but robust)
  const smaps = readFileSafe(PATH_SMAPS);
  if (smaps) {
    let rssKB = 0, anonHugeKB = 0;
    for (const line of smaps.split('\n')) {
      if (line.startsWith('Rss:')) rssKB += parseInt(line.split(/\s+/)[1] || '0', 10);
      else if (line.startsWith('AnonHugePages:')) anonHugeKB += parseInt(line.split(/\s+/)[1] || '0', 10);
    }
    return { rssKB, anonHugeKB };
  }
  // last resort: process.rss + system AnonHugePages
  const status = readFileSafe(PATH_STATUS);
  const meminfo = readFileSafe(PATH_MEMINFO);
  return {
    rssKB: status ? parseKeyKB(status, 'VmRSS') : Math.round(process.memoryUsage().rss / 1024),
    anonHugeKB: meminfo ? parseKeyKB(meminfo, 'AnonHugePages') : 0,
  };
}

function printUsage(tag) {
  const mu = process.memoryUsage();
  const m = readMem();
  const parts = [
    `[${new Date().toISOString()}] ${tag}`,
    `rss=${mb(mu.rss)}MB`,
    `heapUsed=${mb(mu.heapUsed)}MB`,
    `external=${mb(mu.external)}MB`,
    `AnonHugePages=${mb(m.anonHugeKB * 1024)}MB`,
    `RssRollup=${mb(m.rssKB * 1024)}MB`,
  ];
  console.log(parts.join(' | '));
}

function touch(buf) {
  const page = 4096;
  for (let i = 0; i < buf.length; i += page) buf[i] = 1;
  if (buf.length % page) buf[buf.length - 1] = 1;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wave({ objects = OBJ, sizeMB = SIZE, holdMs = HOLD }) {
  const size = sizeMB * MB;
  const arr = new Array(objects);
  printUsage(`BEFORE allocate (${objects} x ${sizeMB}MB)`);

  try {
    for (let i = 0; i < objects; i++) {
      arr[i] = Buffer.allocUnsafe(size);
      touch(arr[i]);              // fault pages in so RSS truly rises
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

(async () => {
  console.log('THP demo starting…');
  printUsage('START');
  let w = 1;
  while (true) {
    console.log(`\n=== WAVE ${w++} ===`);
    await wave({});
  }
})();
