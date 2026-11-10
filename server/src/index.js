require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const { errorHandler } = require('./middleware');

function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
  const origins = process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',').map((s) => s.trim()) : true;
  app.use(cors({ origin: origins }));
  app.use(express.json({ limit: '5mb' }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('tiny'));

  app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Try again in a few minutes.' } }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', require('./routes/admin'));
  app.use('/api', require('./routes/ops'));
  app.use('/api', require('./routes/reports'));
  app.use('/api', require('./routes/importer'));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // In production the Express server also serves the built React app.
  const dist = path.resolve(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('/{*splat}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
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
  // make sure unique indexes (transaction_ref, phone, student+batch) exist
  await mongoose.syncIndexes();
  const port = process.env.PORT || 5000;
  createApp().listen(port, () => console.log(`EMI Manager API on http://localhost:${port}`));
}

if (require.main === module) {
  start().catch((e) => {
    console.error('Failed to start:', e.message);
    process.exit(1);
  });
}

module.exports = { createApp };
