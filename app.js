// app.js
const fs = require('fs');
const path = '/proc/self/smaps_rollup';
const mb = n => (n / (1024 * 1024)).toFixed(1);

function readSmapsRollup() {
  try {
    const t = fs.readFileSync(path, 'utf8');
    const get = k => {
      const m = t.match(new RegExp(`^${k}:\\s+(\\d+) kB`, 'm'));
      return m ? Number(m[1]) : 0;
    };
    return { RssKB: get('Rss'), AnonHugePagesKB: get('AnonHugePages') };
  } catch { return null; }
}

function printUsage(tag) {
  const mu = process.memoryUsage();
  const sm = readSmapsRollup();
  const line = [
    `[${new Date().toISOString()}] ${tag}`,
    `rss=${mb(mu.rss)}MB`,
    `heapUsed=${mb(mu.heapUsed)}MB`,
    `external=${mb(mu.external)}MB`,
  ];
  if (sm) {
    line.push(`AnonHugePages=${mb(sm.AnonHugePagesKB * 1024)}MB`);
    line.push(`RssRollup=${mb(sm.RssKB * 1024)}MB`);
  }
  console.log(line.join(' | '));
}

function touch(buf) {
  const page = 4096;
  for (let i = 0; i < buf.length; i += page) buf[i] = 1;
  if (buf.length % page) buf[buf.length - 1] = 1;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OBJ  = Number(process.env.ALLOC_OBJECTS || 32);
const SIZE = Number(process.env.ALLOC_SIZE_MB || 32);
const HOLD = Number(process.env.HOLD_MS || 2000);

async function wave({ objects = OBJ, sizeMB = SIZE, holdMs = HOLD }) {
  const size = sizeMB * 1024 * 1024;
  const arr = new Array(objects);
  printUsage(`BEFORE allocate (${objects} x ${sizeMB}MB)`);
  for (let i = 0; i < objects; i++) {
    arr[i] = Buffer.allocUnsafe(size);
    touch(arr[i]);
  }
  printUsage('AFTER allocate');
  await sleep(holdMs);
  for (let i = 0; i < objects; i++) arr[i] = null;
  if (global.gc) global.gc();
  printUsage('AFTER free + GC');
  await sleep(2000);
}

(async () => {
  console.log('THP demo starting…');
  printUsage('START');
  // loop forever to keep graphs interesting
  let w = 1;
  while (true) {
    console.log(`\n=== WAVE ${w++} ===`);
    await wave({});
  }
})();
