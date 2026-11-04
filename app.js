/* Customer Sales Dashboard
 * Data source:
 *  - If CONFIG.SHEET_ID is set, data is read LIVE from that Google Sheet
 *    (sheet shared as "Anyone with the link can view"). Sheet tabs needed:
 *      "2026 sale data", "2025 sale data"  -> Month = col H, Customer = col J, Taxable Amount = col AM
 *      "Target'26"                           -> month blocks: row 1 month name, row 2 Customer/Target, rows 3+ data
 *  - If CONFIG.SHEET_ID is empty, the snapshot in data.js is used.
 */
const CONFIG = {
  SHEET_ID: '',                       // e.g. '1AbC...xyz' from the Google Sheet URL
  CY_SHEET: '2026 sale data',
  LY_SHEET: '2025 sale data',
  TARGET_SHEET: "Target'26",
  DEFAULT_MONTH: ''                   // '' = latest month with sales
};

const MONTHS = ['Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar'];
const mkey = m => String(m || '').trim().slice(0, 3).toLowerCase();

/* ---------------- Data loading ---------------- */

function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const num = v => { const n = parseFloat(String(v ?? '').replace(/[,₹\s]/g, '')); return isNaN(n) ? 0 : n; };

function gvizUrl(sheet, query, headers) {
  let u = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet)}`;
  if (query) u += `&tq=${encodeURIComponent(query)}`;
  if (headers !== undefined) u += `&headers=${headers}`;
  return u + `&_=${Date.now()}`;
}
async function fetchCSV(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return parseCSV(await r.text());
}

async function loadLive() {
  const q = 'select H, J, sum(AM) where J is not null group by H, J';
  const [cy, ly, tg] = await Promise.all([
    fetchCSV(gvizUrl(CONFIG.CY_SHEET, q)),
    fetchCSV(gvizUrl(CONFIG.LY_SHEET, q)),
    fetchCSV(gvizUrl(CONFIG.TARGET_SHEET, '', 0))
  ]);
  const sales = rows => rows.slice(1).filter(r => r[1]).map(r => [r[0], r[1], num(r[2])]);
  const targets = {};
  const head = tg[0] || [];
  for (let c = 0; c < head.length; c++) {
    const k = mkey(head[c]);
    if (!head[c] || !MONTHS.some(m => mkey(m) === k)) continue;
    const list = [];
    for (let r = 2; r < tg.length; r++) {
      const name = String(tg[r][c] || '').trim();
      if (!name) continue;
      if (name.toLowerCase() === 'total') break;
      list.push([name, num(tg[r][c + 1])]);
    }
    targets[k] = list;
  }
  return { sales: { cy: sales(cy), ly: sales(ly) }, targets, source: 'Live from Google Sheet' };
}

function loadSnapshot() {
  const d = window.DASH_DATA;
  return { sales: { cy: d.sales['2026'], ly: d.sales['2025'] }, targets: d.targets, source: d.asOf };
}

/* ---------------- Model ---------------- */

let DB;
function buildDB(raw) {
  const idx = rows => {
    const m = {};
    rows.forEach(([mon, cust, amt]) => {
      const k = mkey(mon), c = String(cust).trim();
      (m[k] = m[k] || {})[c] = (m[k][c] || 0) + num(amt);
    });
    return m;
  };
  const cy = idx(raw.sales.cy), ly = idx(raw.sales.ly);
  // master customer order: targets (month order), then CY sales, then LY sales customers
  const master = [];
  const add = n => { if (n && !master.includes(n)) master.push(n); };
  MONTHS.forEach(m => (raw.targets[mkey(m)] || []).forEach(([n]) => add(n)));
  raw.sales.cy.forEach(r => add(String(r[1]).trim()));
  raw.sales.ly.forEach(r => add(String(r[1]).trim()));
  return { cy, ly, targets: raw.targets, master, source: raw.source };
}

const sale = (book, mon, cust) => (book[mkey(mon)] || {})[cust] || 0;
const target = (mon, cust) => (DB.targets[mkey(mon)] || []).filter(r => r[0] === cust).reduce((s, r) => s + num(r[1]), 0);
const ytdMonths = mon => MONTHS.slice(0, MONTHS.indexOf(mon) + 1);

/* ---------------- Formatting ---------------- */

const inr = v => Math.round(v).toLocaleString('en-IN');
const pct = v => (v === null || !isFinite(v)) ? '' : (v * 100).toFixed(1) + '%';
const ratio = (a, b) => b ? a / b : null;
const growth = (cy, ly) => ly ? cy / ly - 1 : null;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function cell(v, type) {
  if (type === 'name') return `<td>${esc(v)}</td>`;
  if (type === 'ach') return `<td class="${v === null ? '' : v >= 1 ? 'good' : 'bad'}">${pct(v)}</td>`;
  if (type === 'gr') return `<td class="${v === null ? '' : v >= 0 ? 'good' : 'bad'}">${pct(v)}</td>`;
  return `<td class="${v ? '' : 'zero'}">${inr(v)}</td>`;
}
function table(el, headers, types, rows, total) {
  const th = headers.map(h => `<th>${h}</th>`).join('');
  const tr = r => '<tr>' + r.map((v, i) => cell(v, types[i])).join('') + '</tr>';
  const tot = '<tr class="total">' + total.map((v, i) => cell(v, types[i])).join('') + '</tr>';
  document.getElementById(el).innerHTML = `<thead><tr>${th}</tr></thead><tbody>${tot}${rows.map(tr).join('')}</tbody>`;
}

/* ---------------- Render ---------------- */

function render(mon) {
  const next = MONTHS[(MONTHS.indexOf(mon) + 1) % 12];
  const tList = (DB.targets[mkey(mon)] || []).map(r => r[0]);
  const tNames = [...new Set(tList)];

  // Month list = target customers + customers with CY/LY sales this month but no target line
  const monthCust = [...tNames];
  DB.master.forEach(c => {
    if (!monthCust.includes(c) && (sale(DB.cy, mon, c) || sale(DB.ly, mon, c))) monthCust.push(c);
  });

  // 1. Month-wise
  const r1 = monthCust.map(c => { const t = target(mon, c), s = sale(DB.cy, mon, c); return [c, t, s, ratio(s, t)]; });
  const T1 = r1.reduce((a, r) => [a[0] + r[1], a[1] + r[2]], [0, 0]);
  table('tbl1', ['Customer', 'Target', 'Sales', 'Ach%'], ['name', 'n', 'n', 'ach'], r1, ['TOTAL', T1[0], T1[1], ratio(T1[1], T1[0])]);

  // 2. CY VS LY SALE
  const r2 = monthCust.map(c => { const l = sale(DB.ly, mon, c), s = sale(DB.cy, mon, c); return [c, l, s, growth(s, l)]; });
  const T2 = r2.reduce((a, r) => [a[0] + r[1], a[1] + r[2]], [0, 0]);
  table('tbl2', ['Customer', 'LY', 'CY', 'GROWTH%'], ['name', 'n', 'n', 'gr'], r2, ['TOTAL', T2[0], T2[1], growth(T2[1], T2[0])]);

  // 3. YTD MONTH  &  4. YTD year
  const yms = ytdMonths(mon);
  const ytd = DB.master.map(c => ({
    c,
    t: yms.reduce((s, m) => s + target(m, c), 0),
    s: yms.reduce((s, m) => s + sale(DB.cy, m, c), 0),
    l: yms.reduce((s, m) => s + sale(DB.ly, m, c), 0)
  })).filter(x => x.t || x.s || x.l);
  const r3 = ytd.map(x => [x.c, x.t, x.s, ratio(x.s, x.t)]);
  const T3 = ytd.reduce((a, x) => [a[0] + x.t, a[1] + x.s, a[2] + x.l], [0, 0, 0]);
  table('tbl3', ['Store', 'Target', 'Sale', 'Ach %'], ['name', 'n', 'n', 'ach'], r3, ['TOTAL', T3[0], T3[1], ratio(T3[1], T3[0])]);
  const r4 = ytd.map(x => [x.c, x.l, x.s, growth(x.s, x.l)]);
  table('tbl4', ['Store', 'LY', 'CY', 'GROWTH%'], ['name', 'n', 'n', 'gr'], r4, ['TOTAL', T3[2], T3[1], growth(T3[1], T3[2])]);

  // 5. current month target (month after the selected month)
  const r5 = [...new Set((DB.targets[mkey(next)] || []).map(r => r[0]))].map(c => [c, target(next, c)]);
  const T5 = r5.reduce((s, r) => s + r[1], 0);
  table('tbl5', ['store name', 'target'], ['name', 'n'], r5, ['TOTAL', T5]);

  // Titles (template names + period)
  document.getElementById('t1').textContent = `Month-wise — ${mon}`;
  document.getElementById('t2').textContent = `CY VS LY SALE — ${mon}`;
  document.getElementById('t3').textContent = `YTD MONTH — Apr to ${mon}`;
  document.getElementById('t4').textContent = `YTD year — Apr to ${mon}`;
  document.getElementById('t5').textContent = `current month target — ${next}`;

  // KPI cards
  const k = [
    ['Month Target', inr(T1[0]), mon],
    ['Month Sales', inr(T1[1]), mon],
    ['Month Ach%', pct(ratio(T1[1], T1[0])), 'Sales ÷ Target', ratio(T1[1], T1[0]), 1],
    ['LY Month Sales', inr(T2[0]), mon + ' last year'],
    ['Month Growth%', pct(growth(T2[1], T2[0])), 'CY vs LY', growth(T2[1], T2[0]), 0],
    ['YTD Target', inr(T3[0]), 'Apr to ' + mon],
    ['YTD Sales', inr(T3[1]), 'Apr to ' + mon],
    ['YTD Ach%', pct(ratio(T3[1], T3[0])), 'Sales ÷ Target', ratio(T3[1], T3[0]), 1],
    ['YTD Growth%', pct(growth(T3[1], T3[2])), 'LY ' + inr(T3[2]), growth(T3[1], T3[2]), 0],
    ['Next Month Target', inr(T5), next]
  ];
  document.getElementById('kpis').innerHTML = k.map(([lab, val, sub, v, th]) => {
    const cls = v === undefined || v === null ? '' : (v >= th ? 'good' : 'bad');
    return `<div class="kpi ${cls}"><div class="lab">${lab}</div><div class="val">${val || '–'}</div><div class="sub">${sub}</div></div>`;
  }).join('');
}

/* ---------------- Init ---------------- */

async function init() {
  let raw;
  try {
    raw = CONFIG.SHEET_ID ? await loadLive() : loadSnapshot();
  } catch (e) {
    console.error(e);
    raw = loadSnapshot();
    raw.source = 'Could not read Google Sheet (' + e.message + '). Showing snapshot: ' + raw.source;
  }
  DB = buildDB(raw);
  document.getElementById('source').textContent = 'Data: ' + DB.source;

  const withSales = MONTHS.filter(m => DB.cy[mkey(m)]);
  const options = MONTHS.filter(m => DB.cy[mkey(m)] || DB.targets[mkey(m)]);
  const sel = document.getElementById('month');
  sel.innerHTML = options.map(m => `<option>${m}</option>`).join('');
  sel.value = CONFIG.DEFAULT_MONTH || withSales[withSales.length - 1] || options[0];
  sel.addEventListener('change', () => render(sel.value));
  render(sel.value);
  document.getElementById('loading').classList.add('hide');
}
init();
