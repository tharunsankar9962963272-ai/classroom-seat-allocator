import { computeLayout } from './compute.js';

const LIMITS = {
  students: { min: 0, max: 100_000 },
  seatsPerRow: { min: 1, max: 1_000 },
};

const el = {
  form: document.getElementById('allocatorForm'),
  students: document.getElementById('students'),
  seatsPerRow: document.getElementById('seatsPerRow'),
  submit: document.getElementById('submitBtn'),
  formError: document.getElementById('formError'),
  previewRows: document.getElementById('previewRows'),
  previewEmpty: document.getElementById('previewEmpty'),
  previewTotal: document.getElementById('previewTotal'),
  tbody: document.getElementById('historyBody'),
  emptyState: document.getElementById('emptyState'),
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  refresh: document.getElementById('refreshBtn'),
};

const timeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const numFmt = new Intl.NumberFormat();

const store = new Map();
let highlightId = null;
let channel = null;

/* ---------------- Helpers ---------------- */

function setStatus(kind, text) {
  el.status.className = `status status--${kind}`;
  el.statusText.textContent = text;
}

function showError(msg) {
  el.formError.textContent = msg;
  el.formError.hidden = false;
}

function clearError() {
  el.formError.textContent = '';
  el.formError.hidden = true;
}

function makeCell(text, cls, title) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  if (title) td.title = title;
  return td;
}

function fromDbRow(r) {
  return {
    id: r.id,
    students: r.students,
    seatsPerRow: r.seats_per_row,
    rowsRequired: r.rows_required,
    emptySeatsLastRow: r.empty_seats_last_row,
    createdAt: r.created_at,
  };
}

/* ---------------- Render ---------------- */

function render() {
  const rows = [...store.values()]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 100);

  el.tbody.replaceChildren();
  el.emptyState.hidden = rows.length > 0;

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (r.id === highlightId) tr.classList.add('row--new');
    tr.append(
      makeCell(timeFmt.format(new Date(r.createdAt)), 'cell-time', r.createdAt),
      makeCell(numFmt.format(r.students), 'num'),
      makeCell(numFmt.format(r.seatsPerRow), 'num'),
      makeCell(numFmt.format(r.rowsRequired), 'num'),
      makeCell(numFmt.format(r.emptySeatsLastRow), 'num'),
    );
    frag.append(tr);
  }
  el.tbody.append(frag);
  highlightId = null;
}

/* ---------------- Preview ---------------- */

function readInt(input) {
  if (input.value.trim() === '') return null;
  const v = Number(input.value);
  return Number.isInteger(v) ? v : null;
}

function updatePreview() {
  const s = readInt(el.students);
  const sp = readInt(el.seatsPerRow);

  const valid =
    s !== null && sp !== null &&
    s >= LIMITS.students.min && s <= LIMITS.students.max &&
    sp >= LIMITS.seatsPerRow.min && sp <= LIMITS.seatsPerRow.max;

  if (!valid) {
    el.previewRows.textContent = '—';
    el.previewEmpty.textContent = '—';
    el.previewTotal.textContent = '—';
    return;
  }

  const { rowsRequired, emptySeatsInLastRow, totalSeats } = computeLayout(s, sp);
  el.previewRows.textContent = numFmt.format(rowsRequired);
  el.previewEmpty.textContent = numFmt.format(emptySeatsInLastRow);
  el.previewTotal.textContent = numFmt.format(totalSeats);
}

/* ---------------- API ---------------- */

async function loadAll() {
  try {
    const res = await fetch('/api/allocations?limit=100', {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { allocations } = await res.json();
    store.clear();
    for (const a of allocations) store.set(a.id, a);
    render();
  } catch (e) {
    showError(`Could not load history: ${e.message}`);
  }
}

async function create(students, seatsPerRow) {
  const res = await fetch('/api/allocations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ students, seatsPerRow }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.allocation;
}

/* ---------------- Supabase SDK ---------------- */

async function loadSdk() {
  if (globalThis.supabase?.createClient) return globalThis.supabase;
  const m = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  return m;
}

/* ---------------- Realtime ---------------- */

async function initRealtime() {
  setStatus('connecting', 'Connecting…');
  try {
    const cfg = await fetch('/api/config').then((r) => r.json());
    const sdk = await loadSdk();

    const client = sdk.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    channel = client.channel('public:allocations')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'allocations' }, (p) => {
        const item = fromDbRow(p.new);
        if (!item.id) return;
        store.set(item.id, item);
        highlightId = item.id;
        render();
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'allocations' }, (p) => {
        if (p.old?.id && store.delete(p.old.id)) render();
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setStatus('live', 'Live');
        else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) setStatus('error', 'Realtime error');
        else setStatus('connecting', 'Connecting…');
      });
  } catch (e) {
    console.error('[realtime]', e);
    setStatus('error', 'Realtime unavailable');
  }
}

/* ---------------- Events ---------------- */

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();

  const s = readInt(el.students);
  const sp = readInt(el.seatsPerRow);

  if (s === null || s < LIMITS.students.min || s > LIMITS.students.max) {
    return showError(`Students must be a whole number between ${LIMITS.students.min} and ${LIMITS.students.max}.`);
  }
  if (sp === null || sp < LIMITS.seatsPerRow.min || sp > LIMITS.seatsPerRow.max) {
    return showError(`Seats per row must be a whole number between ${LIMITS.seatsPerRow.min} and ${LIMITS.seatsPerRow.max}.`);
  }

  el.submit.disabled = true;
  try {
    const a = await create(s, sp);
    store.set(a.id, a);
    highlightId = a.id;
    render();
  } catch (err) {
    showError(err.message);
  } finally {
    el.submit.disabled = false;
  }
});

el.students.addEventListener('input', updatePreview);
el.seatsPerRow.addEventListener('input', updatePreview);

el.refresh.addEventListener('click', () => {
  clearError();
  loadAll();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadAll();
});

/* ---------------- Boot ---------------- */

(async function boot() {
  updatePreview();
  await loadAll();
  await initRealtime();
})();