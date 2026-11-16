require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const compression = require('compression');
const { errorHandler } = require('./middleware');
const cache = require('./services/cache');
const backup = require('./services/backup');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(compression()); // JSON and the built JS/CSS shrink ~5-10x, a big win on a slow connection
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
  const origins = process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',').map((s) => s.trim()) : true;
  app.use(cors({ origin: origins }));
  app.use(express.json({ limit: '5mb' }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('tiny'));

  app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Try again in a few minutes.' } }));

  // Every successful write throws away the computed-screens cache and tells the backup scheduler there is something new to save.
  // (Read-only POSTs, like the live payment preview or a backup test, do not count as writes.)
  const READ_ONLY_POST = /^\/(auth\/login|payments\/preview|backup\/(run|test|audit))/;
  app.use('/api', (req, res, next) => {
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !READ_ONLY_POST.test(req.path);
    if (isWrite) {
      cache.bump(); // drop stale results before the write starts too, so nothing computed mid-write survives it
      res.on('finish', () => { if (res.statusCode < 400) { cache.bump(); backup.markDirty(); } });
    }
    next();
  });

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', require('./routes/admin'));
  app.use('/api', require('./routes/ops'));
  app.use('/api', require('./routes/reports'));
  app.use('/api', require('./routes/history'));
  app.use('/api', require('./routes/importer'));
  app.use('/api', require('./routes/backup'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // In production the Express server also serves the built React app.
  const dist = path.resolve(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    // hashed asset files never change, so browsers may keep them for a year; index.html must always be re-checked
    app.use('/assets', express.static(path.join(dist, 'assets'), { maxAge: '365d', immutable: true }));
    app.use(express.static(dist, { maxAge: '1h', setHeaders: (res, file) => { if (file.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
    app.get('/{*splat}', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(dist, 'index.html')); });
  }

  app.use(errorHandler);
  return app;
}

async function start() {
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    console.error('JWT_SECRET must be set in production');
    process.exit(1);
  }
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/emi_manager';
  await mongoose.connect(uri);
  // make sure unique indexes (phone, student+batch) exist
  await mongoose.syncIndexes();
  const port = process.env.PORT || 5000;
  createApp().listen(port, () => console.log(`EMI Manager API on http://localhost:${port}`));
  backup.startScheduler();
}

if (require.main === module) {
  start().catch((e) => {
    console.error('Failed to start:', e.message);
    process.exit(1);
  });
}

module.exports = { createApp };
