// Backup & restore API. Admin only: a backup contains every student, phone number and payment.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { Setting } = require('../models');
const { HttpError, h, auth, role, logActivity } = require('../middleware');
const B = require('../services/backup');
const cache = require('../services/cache');

const router = express.Router();
const adminOnly = role('Admin');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } }); // a backup with proofs can be big

router.get('/backup/status', auth, adminOnly, h(async (req, res) => res.json(await B.status())));

// Light version for the sidebar chip (any signed-in Admin/Manager).
router.get('/backup/health', auth, role('Admin', 'Manager'), h(async (req, res) => {
  const s = await B.status();
  res.json({ health: s.health, age_minutes: s.age_minutes, running: s.running });
}));

router.put('/backup/settings', auth, adminOnly, h(async (req, res) => {
  const current = await B.readConfig();
  const body = req.body || {};
  const next = B.cleanConfig(body, current);
  if (body.generate_secret) next.secret = crypto.randomBytes(24).toString('hex');
  await Setting.findOneAndUpdate({ key: 'main' }, { $set: { backup: next } }, { upsert: true });
  await logActivity(req.user, 'Settings', 'backup', 'update', { enabled: next.enabled, interval_minutes: next.interval_minutes, daily_hour: next.daily_hour, keep_copies: next.keep_copies, url_set: !!next.url });
  cache.bump();
  res.json(await B.status());
}));

// The Apps Script with this site's secret already filled in, ready to paste.
router.get('/backup/apps-script', auth, adminOnly, h(async (req, res) => {
  const cfg = await B.readConfig();
  if (!cfg.secret) throw new HttpError(400, 'Generate a secret key first');
  const src = fs.readFileSync(path.join(__dirname, '..', 'sheet', 'EmiBackup.gs'), 'utf8').replace('__SECRET_KEY__', cfg.secret);
  res.type('text/plain').send(src);
}));

router.post('/backup/test', auth, adminOnly, h(async (req, res) => {
  const cfg = await B.readConfig();
  if (!cfg.url) throw new HttpError(400, 'Paste the Google Script link first');
  if (!cfg.secret) throw new HttpError(400, 'Generate a secret key first');
  try {
    const out = await B.scriptCall(cfg, { action: 'ping' }, { tries: 2, waitMs: 1500, timeoutMs: 45000 });
    res.json({ ok: true, sheet_name: out.name, sheet_url: out.url, has_backup: out.has_backup });
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}));

router.post('/backup/run', auth, adminOnly, h(async (req, res) => {
  const out = await B.runBackup({ trigger: 'manual', by: req.user.name });
  if (!out.ok) throw new HttpError(502, out.error || 'The backup did not finish');
  await logActivity(req.user, 'Settings', 'backup', 'backup_run', { counts: out.counts });
  res.json({ ok: true, counts: out.counts, ms: out.ms, sheet: out.sheet });
}));

// Download everything as one JSON file (?files=1 adds payment proofs and agreements).
router.get('/backup/download', auth, adminOnly, h(async (req, res) => {
  const bundle = await B.buildBundle({ includeFiles: req.query.files === '1' });
  const stamp = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  await logActivity(req.user, 'Settings', 'backup', 'backup_download', { counts: bundle.counts, with_files: req.query.files === '1' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="emi-manager-backup-${stamp}.json"`);
  res.send(JSON.stringify(bundle));
}));

/* ---- restore: always a preview first (dry run), then the real thing with the typed word RESTORE ---- */
router.post('/backup/restore', auth, adminOnly, upload.single('file'), h(async (req, res) => {
  const mode = String(req.body.mode || 'missing');
  const dry = req.body.confirm !== 'RESTORE';
  const source = String(req.body.source || 'file');
  let bundle;
  if (source === 'sheet') {
    const cfg = await B.readConfig();
    if (!cfg.url || !cfg.secret) throw new HttpError(400, 'Connect the Google Sheet first');
    try { bundle = await B.pullFromSheet(cfg); } catch (e) { throw e.status ? e : new HttpError(502, e.message); }
  } else {
    if (!req.file) throw new HttpError(400, 'Choose a backup file');
    bundle = B.parseBundle(req.file.buffer);
  }
  const out = await B.restoreBundle(bundle, { mode, dryRun: dry });
  if (!dry) await logActivity(req.user, 'Settings', 'backup', 'restore', { mode, source, report: out.report });
  res.json({ ...out, source, created_at: bundle.created_at || null });
}));

router.get('/backup/audit', auth, adminOnly, h(async (req, res) => res.json(await B.audit())));

module.exports = router;
