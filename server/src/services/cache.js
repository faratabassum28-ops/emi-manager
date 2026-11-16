// A tiny in-process cache for the expensive "load everything and compute" screens.
//
// Why: Home, the batch dashboard, the EMI Tracker, the sidebar badges and the Students tab all used to
// reload every student, instalment and payment from MongoDB and recompute everything on EVERY request
// (the sidebar alone did it every 60 s for every signed-in person). Now the first request computes it
// and the rest reuse it until something is written.
//
// Correctness: any successful write (POST / PUT / DELETE on the API) calls bump(), which throws the whole
// cache away. A short TTL is a second safety net (e.g. when another server instance wrote the data, or
// when the date rolls over). In-flight computations are shared, so ten people opening Home at once cost
// one computation, not ten.

let version = 0;
let dirtySince = 0;
const store = new Map();
const MAX_ENTRIES = 60;

function bump() {
  version += 1;
  dirtySince = Date.now();
  store.clear();
}

const currentVersion = () => version;
const lastWriteAt = () => dirtySince;

async function memo(key, ttlMs, compute) {
  const hit = store.get(key);
  if (hit && hit.v === version && Date.now() - hit.at < ttlMs) return hit.promise;
  const v = version;
  const promise = Promise.resolve().then(compute);
  const entry = { v, at: Date.now(), promise };
  store.set(key, entry);
  if (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
  try {
    return await promise;
  } catch (e) {
    if (store.get(key) === entry) store.delete(key); // never cache a failure
    throw e;
  }
}

function stats() {
  return { version, entries: store.size };
}

module.exports = { bump, memo, currentVersion, lastWriteAt, stats };
