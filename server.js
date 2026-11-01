import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { createClient } from '@supabase/supabase-js';

import { computeLayout } from './public/compute.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ============================== Environment ============================= */

const PORT = Number(process.env.PORT ?? 3000);
const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').trim();
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY ?? '').trim();
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();

const missing = Object.entries({
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
}).filter(([, v]) => v === '').map(([k]) => k);

if (missing.length > 0) {
  console.error(`[fatal] Missing required environment variables: ${missing.join(', ')}`);
  console.error('        Copy .env.example to .env and fill in your Supabase credentials.');
  process.exit(1);
}

/* ============================== Supabase ================================ */

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

/* =============================== Helpers ================================ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const wrap = (h) => (req, res, next) =>
  Promise.resolve(h(req, res, next)).catch(next);

const LIMITS = {
  students: { min: 0, max: 100_000 },
  seatsPerRow: { min: 1, max: 1_000 },
  limit: { min: 1, max: 200 },
};

function parseInteger(raw, name, { min, max }) {
  const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new HttpError(400, `"${name}" must be a whole number.`);
  }
  if (v < min || v > max) {
    throw new HttpError(400, `"${name}" must be between ${min} and ${max}.`);
  }
  return v;
}

const toClientRow = (r) => ({
  id: r.id,
  students: r.students,
  seatsPerRow: r.seats_per_row,
  rowsRequired: r.rows_required,
  emptySeatsLastRow: r.empty_seats_last_row,
  createdAt: r.created_at,
});

/* ================================= App ================================== */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

/* ------------------------------- API ----------------------------------- */

app.get('/api/health', (req, res) =>
  res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) }),
);

app.get('/api/config', (req, res) =>
  res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY }),
);

app.get(
  '/api/allocations',
  wrap(async (req, res) => {
    const limit =
      req.query.limit === undefined
        ? 100
        : parseInteger(req.query.limit, 'limit', LIMITS.limit);

    const { data, error } = await supabase
      .from('allocations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

 if (error) {
  console.error('[DB Error Object]', error);
  throw new HttpError(502, `Database error: ${error.message} (Code: ${error.code})`);
}
    res.json({ allocations: (data ?? []).map(toClientRow) });
  }),
);

app.post(
  '/api/allocations',
  wrap(async (req, res) => {
    const body = req.body ?? {};
    const students = parseInteger(body.students, 'students', LIMITS.students);
    const seatsPerRow = parseInteger(body.seatsPerRow, 'seatsPerRow', LIMITS.seatsPerRow);

    const { rowsRequired, emptySeatsInLastRow } = computeLayout(students, seatsPerRow);

    const { data, error } = await supabase
      .from('allocations')
      .insert({
        students,
        seats_per_row: seatsPerRow,
        rows_required: rowsRequired,
        empty_seats_last_row: emptySeatsInLastRow,
      })
      .select('*')
      .single();

    if (error) throw new HttpError(502, `Database error: ${error.message}`);
    res.status(201).json({ allocation: toClientRow(data) });
  }),
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/* --------------------- Vendored Supabase UMD bundle -------------------- */

const umdPath = path.join(
  __dirname,
  'node_modules',
  '@supabase',
  'supabase-js',
  'dist',
  'umd',
  'supabase.js',
);

if (fs.existsSync(umdPath)) {
  app.get('/vendor/supabase.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(umdPath);
  });
}

/* ------------------------------ Static --------------------------------- */

app.use(
  express.static(PUBLIC_DIR, {
    index: 'index.html',
    setHeaders(res, f) {
      res.setHeader('Cache-Control', f.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
    },
  }),
);

/* --------------------------- Error handling ---------------------------- */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error('[error]', err);
  const msg =
    status >= 500 && !(err instanceof HttpError) && err.type !== 'entity.parse.failed'
      ? 'Internal Server Error'
      : err.message;
  res.status(status).json({ error: msg });
});

/* ================================ Boot ================================= */

app.listen(PORT, () => {
  console.log(`▶ Classroom Seat Allocator running at http://localhost:${PORT}`);

  supabase
    .from('allocations')
    .select('id', { head: true, count: 'exact' })
    .limit(1)
    .then(({ error }) => {
      if (error) {
        console.warn(`[warn] Supabase probe: ${error.message}`);
        console.warn('       Did you run supabase/schema.sql in your project?');
      } else {
        console.log('[ok] Supabase connection verified.');
      }
    });
});

const shutdown = (sig) => {
  console.log(`\n[${sig}] shutting down…`);
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));