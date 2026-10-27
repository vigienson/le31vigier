/* LE 31 — appli téléphone — V1.0
   Données : Google Sheet via Google Apps Script. Lien d'accès à usage unique (#inv=CODE&api=URL /exec) échangé contre
   un jeton propre à l'appareil. Chacun voit le compte commun et son compte perso. config.js (apiUrl) facultatif. */
'use strict';
const APP_VERSION = '1.3';

/* ================= Barème impôt (à mettre à jour chaque année) =================
   Barème 2026 sur les revenus 2025, par part. Plafond quotient familial : 1 807 € par demi-part.
   Décote : seuils 1 982 € (seul) / 3 277 € (couple), formules 897 € / 1 483 € − 45,25 % de l'impôt. */
const IMPOT = {
  annee: 'Barème 2026 (revenus 2025)',
  tranches: [[11600, 0], [29579, .11], [84577, .30], [181917, .41], [Infinity, .45]],
  plafondDemiPart: 1807,
  decote: { seul: [1982, 897], couple: [3277, 1483], taux: .4525 }
};

/* ================= Outils ================= */
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const MONTHS_L = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const FREQ = { M: 'Mensuel', T: 'Trimestriel', A: 'Annuel' };
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.')); return isNaN(n) ? null : n; };
const bool = v => v === true || /^(oui|true|vrai|1)$/i.test(String(v || '').trim());
const r2 = v => Math.round(v * 100) / 100;
const eur = v => (v || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: Math.abs((v || 0) % 1) > 0.004 ? 2 : 0, maximumFractionDigits: 2 });
const eur0 = v => Math.round(v || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const sgn = v => (v > 0.004 ? '+' : v < -0.004 ? '−' : '') + eur(Math.abs(v));
const fr = v => String(v == null ? '' : v).replace('.', ',');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
// Mois au format AAAA-MM
const mk = (y, m) => y + '-' + pad(m + 1);
const pm = k => ({ y: +k.slice(0, 4), m: +k.slice(5, 7) - 1 });
const addM = (k, n) => { const { y, m } = pm(k); const t = y * 12 + m + n; return mk(Math.floor(t / 12), t % 12); };
const diffM = (a, b) => { const A = pm(a), B = pm(b); return (B.y * 12 + B.m) - (A.y * 12 + A.m); };
const dim = k => { const { y, m } = pm(k); return new Date(y, m + 1, 0).getDate(); };
const mLabel = k => { const { y, m } = pm(k); return MONTHS_L[m] + ' ' + y; };
const mShort = k => { const { y, m } = pm(k); return MONTHS[m]; };
let CUR, TODAY, TODAY_ISO;
function refreshNow() {
  const n = new Date();
  CUR = mk(n.getFullYear(), n.getMonth()); TODAY = n.getDate(); TODAY_ISO = CUR + '-' + pad(TODAY);
}
refreshNow();

/* ================= Connexion (lien d'accès à usage unique) ================= */
const CFG = window.LE31_CONFIG || {};
const API_RE = /^https:\/\/script\.google(usercontent)?\.com\/[^\s#]+$/;
const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = () => !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
// Lit un lien d'accès (…#inv=CODE&api=https%3A…) : l'invitation sera échangée contre un jeton propre à cet appareil
function readLink(txt) {
  const i = /[#&?]inv=([A-Za-z0-9_-]+)/.exec(txt || ''), a = /[#&?]api=([^&#\s]+)/.exec(txt || '');
  let api = ''; try { api = a ? decodeURIComponent(a[1]) : ''; } catch (e) {}
  if (API_RE.test(api)) store.set('le31-api', api);
  if (i && i[1] !== store.get('le31-inv-faite', '')) store.set('le31-inv', i[1]);
  return !!i;
}
readLink(location.hash);
const API = () => API_RE.test(CFG.apiUrl || '') ? CFG.apiUrl : store.get('le31-api', '');
const apiOk = () => API_RE.test(API() || '');
const JETON = () => store.get('le31-jeton', '');
const INV = () => store.get('le31-inv', '');
let ME = store.get('le31-me', null);   // profil de cet appareil ('' = premier lancement pas terminé)
let JOIN = { busy: false, err: '', detail: '', iosOk: false };
function deviceName() {
  const u = navigator.userAgent;
  return /iPad/.test(u) || (IOS && !/iPhone/.test(u)) ? 'iPad' : /iPhone/.test(u) ? 'iPhone' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'PC Windows' : /Mac/.test(u) ? 'Mac' : 'Appareil';
}
// fetch avec délai maximum : l'appli ne reste jamais bloquée en attente
async function fetchT(url, opts, ms) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const tm = setTimeout(() => ctl && ctl.abort(), ms || 25000);
  try { return await fetch(url, Object.assign({}, opts, ctl ? { signal: ctl.signal } : {})); }
  catch (e) { const x = new Error(e && e.name === 'AbortError' ? 'delai' : 'reseau'); x.net = true; throw x; }
  finally { clearTimeout(tm); }
}
async function readJson(r) {
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (e) { const x = new Error('html'); x.detail = txt.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160); throw x; }
}
async function api(body) {
  const r = await fetchT(API(), { method: 'POST', body: JSON.stringify(Object.assign({ jeton: JETON() }, body)) });
  const j = await readJson(r);
  if (!j.ok) { const x = new Error(j.erreur || 'erreur'); x.detail = j.detail; throw x; }
  return j;
}
async function join() {
  if (JOIN.busy || !INV() || !apiOk()) return;
  // Sur iPhone/iPad, l'appli installée ne voit pas ce que Safari a mémorisé : on attend qu'elle soit installée
  if (IOS && !STANDALONE() && !JOIN.iosOk) { render(); return; }
  JOIN.busy = true; JOIN.err = ''; JOIN.detail = ''; render();
  try {
    // connexion par GET (le chemin le plus simple et le plus fiable), POST pour un serveur plus ancien
    let j = await readJson(await fetchT(API() + '?action=rejoindre&inv=' + encodeURIComponent(INV()) + '&appareil=' + encodeURIComponent(deviceName()) + '&t=' + Date.now()));
    if (!j.ok && j.erreur === 'acces') j = await readJson(await fetchT(API(), { method: 'POST', body: JSON.stringify({ action: 'rejoindre', inv: INV(), appareil: deviceName() }) }));
    if (!j.ok) { const x = new Error(j.erreur || 'erreur'); x.detail = j.detail; throw x; }
    store.set('le31-inv-faite', INV()); store.set('le31-inv', '');
    store.set('le31-jeton', j.jeton); store.set('le31-acces', j.acces); QUEUE = []; store.set('le31-file', []);
    RAW = null; LOADED = false; SYNC.error = '';
    received(j.data, j.moi);
  } catch (e) {
    const m = String(e.message || e), keep = e.net || m === 'html' || m === 'serveur' || m === 'reseau';
    JOIN.err = m; JOIN.detail = e.detail || '';
    if (!keep) store.set('le31-inv', ''); // lien refusé pour de bon (déjà utilisé, expiré…)
  }
  JOIN.busy = false; render();
}

/* ================= Données ================= */
const TABS = { comptes: 'Comptes', profils: 'Profils', categories: 'Categories', fixes: 'Fixes', virements: 'Virements', operations: 'Operations', pointages: 'Pointages', clotures: 'Clotures', simulations: 'Simulations', regles: 'Regles', parametres: 'Parametres', appareils: 'Appareils', attente: 'Attente' };
const EMPTY = () => { const o = {}; for (const k in TABS) o[k] = []; return o; };
let RAW = store.get('le31-data', null);          // dernière copie reçue du serveur
let QUEUE = store.get('le31-file', []);          // modifications pas encore envoyées
let DB = EMPTY();
let LOADED = !!RAW;
let SYNC = { state: 'off', last: store.get('le31-last', 0), error: '' };

function rebuild() {
  DB = EMPTY();
  const src = RAW || {};
  for (const k in TABS) DB[k] = (src[TABS[k]] || []).map(r => Object.assign({}, r));
  QUEUE.forEach(applyLocal);
  CACHE = {};
}
function applyLocal(op) {
  const key = Object.keys(TABS).find(k => TABS[k] === op.onglet); if (!key) return;
  const idCol = key === 'parametres' ? 'cle' : 'id', arr = DB[key];
  if (op.op === 'maj') {
    const i = arr.findIndex(r => r[idCol] === op.ligne[idCol]);
    if (i >= 0) arr[i] = Object.assign({}, arr[i], op.ligne); else arr.push(Object.assign({}, op.ligne));
  } else if (op.op === 'suppr') {
    const i = arr.findIndex(r => r[idCol] === op.id); if (i >= 0) arr.splice(i, 1);
  }
}
function clean(ops) { ops.forEach(o => { if (o.ligne) for (const c in o.ligne) if (o.ligne[c] == null) o.ligne[c] = ''; else if (typeof o.ligne[c] !== 'string') o.ligne[c] = String(o.ligne[c]); }); return ops; }
// Enregistrer des modifications : appliquées tout de suite, envoyées au Sheet aussitôt
function commit(ops) {
  clean(ops);
  QUEUE.push(...ops); store.set('le31-file', QUEUE);
  ops.forEach(applyLocal); CACHE = {};
  render(); flush();
}
const upd = (onglet, ligne) => ({ op: 'maj', onglet, ligne });
const del = (onglet, id) => ({ op: 'suppr', onglet, id });
const isAccessErr = e => e === 'acces';

let flushing = false, flushTimer = null;
async function flush() {
  if (flushing || !QUEUE.length || !apiOk() || !JETON()) { setSync(); return; }
  flushing = true; setSync('wait');
  const batch = QUEUE.slice();
  try {
    const j = await api({ action: 'ops', ops: batch }); if (j.acces) store.set('le31-acces', j.acces);
    QUEUE = QUEUE.slice(batch.length); store.set('le31-file', QUEUE);
    received(j.data, j.moi);
  } catch (e) {
    SYNC.error = String(e.message || e);
    if (isAccessErr(SYNC.error)) { flushing = false; setSync('err'); render(); return; }
    clearTimeout(flushTimer); flushTimer = setTimeout(flush, 8000); // nouvel essai dans 8 s
    setSync('off');
    flushing = false;
    return;
  }
  flushing = false;
  if (QUEUE.length) flush();
}
let pulling = false;
async function pull() {
  if (pulling || !apiOk() || !JETON()) return;
  if (QUEUE.length) return flush();
  pulling = true;
  try {
    const r = await fetchT(API() + '?action=tout&jeton=' + encodeURIComponent(JETON()) + '&t=' + Date.now());
    const j = await readJson(r);
    if (!j.ok) throw new Error(j.erreur || 'erreur');
    if (j.acces) store.set('le31-acces', j.acces);
    if (!QUEUE.length) received(j.data, j.moi);
  } catch (e) {
    SYNC.error = String(e.message || e);
    setSync(isAccessErr(SYNC.error) ? 'err' : 'off');
    if (isAccessErr(SYNC.error) || !LOADED) render();
  }
  pulling = false;
}
function received(data, moi) {
  const before = JSON.stringify(RAW) + ME;
  RAW = data; store.set('le31-data', RAW);
  if (moi != null) { ME = moi; store.set('le31-me', ME); }
  SYNC.last = Date.now(); store.set('le31-last', SYNC.last); SYNC.error = '';
  const first = !LOADED; LOADED = true;
  rebuild(); setSync();
  ensurePerso();
  if (first || before !== JSON.stringify(RAW) + ME) {
    // ne pas re-dessiner pendant qu'on tape dans un champ
    const a = document.activeElement;
    if (!a || !/INPUT|SELECT|TEXTAREA/.test(a.tagName) || first) render();
  }
}
function setSync(s) {
  if (s) SYNC.state = s; else SYNC.state = QUEUE.length ? (navigator.onLine === false ? 'off' : 'wait') : (SYNC.error ? (isAccessErr(SYNC.error) ? 'err' : 'off') : 'ok');
  const d = $('syncDot'); if (!d) return;
  d.className = 'sync' + (SYNC.state === 'ok' ? '' : ' ' + SYNC.state);
  d.title = { ok: 'Synchronisé', wait: 'Envoi en cours…', off: 'Hors ligne : les saisies seront envoyées au retour du réseau', err: 'Accès coupé' }[SYNC.state];
}

/* ================= Accès aux données ================= */
let CACHE = {};
const accRank = a => a.proprietaire === ME ? 0 : !a.proprietaire ? 1 : 2;
const accs = () => DB.comptes.slice().sort((a, b) => accRank(a) - accRank(b) || (num(a.ordre) || 0) - (num(b.ordre) || 0));
const accOf = id => DB.comptes.find(a => a.id === id) || { id, nom: id };
const accName = id => { const a = DB.comptes.find(x => x.id === id); if (a) return a.nom || id; const m = /^perso-(.+)$/.exec(id || ''); return m ? 'Perso ' + (pname(m[1]) || '') : id; };
const isShared = acc => !accOf(acc).proprietaire && DB.profils.length > 1;
const otherNames = () => DB.profils.filter(p => p.id !== ME).map(p => p.nom).join(', ');
const otherAcc = id => (accs().find(a => a.id !== id) || {}).id;
const profiles = () => DB.profils.slice().sort((a, b) => (num(a.ordre) || 0) - (num(b.ordre) || 0));
const pname = id => (DB.profils.find(p => p.id === id) || {}).nom || '';
const catsOf = acc => DB.categories.filter(c => c.compte === acc).sort((a, b) => (num(a.ordre) || 0) - (num(b.ordre) || 0));
const param = (k, d) => { const p = DB.parametres.find(x => x.cle === k); return p ? p.valeur : d; };
const started = acc => num(accOf(acc).soldeDepart) !== null;
const startMonth = acc => accOf(acc).moisDepart || CUR;
const clot = (acc, k) => DB.clotures.find(c => c.id === acc + '|' + k);
const point = (k, cle) => DB.pointages.find(p => p.id === k + '|' + cle);

function occursF(f, k) {
  if (!bool(f.actif)) return false;
  if (f.debut && k < f.debut) return false;
  if (f.fin && k > f.fin) return false;
  const m = pm(k).m + 1, ref = num(f.moisRef) || (f.debut ? pm(f.debut).m + 1 : 1);
  if (f.frequence === 'T') return ((m - ref) % 3 + 3) % 3 === 0;
  if (f.frequence === 'A') return m === ref;
  return true;
}
function occursV(v, k) {
  if (!bool(v.actif)) return false;
  if (v.debut && k < v.debut) return false;
  if (v.fin && k > v.fin) return false;
  return true;
}
const opsOf = (acc, k) => DB.operations.filter(o => o.compte === acc && String(o.date).slice(0, 7) === k);

/* ================= Calculs ================= */
function events(acc, k, o) {
  const D = dim(k), ev = [];
  DB.fixes.filter(f => f.compte === acc && occursF(f, k)).forEach(f => {
    const p = point(k, 'f' + f.id), a = p ? num(p.montantReel) : num(f.montant) || 0;
    ev.push({ d: Math.min(num(f.jour) || 1, D), v: f.sens === '+' ? a : -a, kind: 'fixe', key: 'f' + f.id, id: f.id, label: f.libelle, cat: f.categorie || 'Autre', ok: !!p });
  });
  DB.virements.filter(v => (v.de === acc || v.vers === acc) && occursV(v, k)).forEach(v => {
    const p = point(k, 'v' + v.id), a = p ? num(p.montantReel) : num(v.montant) || 0, out = v.de === acc;
    ev.push({ d: Math.min(num(v.jour) || 1, D), v: out ? -a : a, kind: 'vir', key: 'v' + v.id, id: v.id, label: v.libelle || (out ? 'Virement vers ' + accName(v.vers) : 'Virement depuis ' + accName(v.de)), cat: out ? '→ ' + accName(v.vers) : '← ' + accName(v.de), ok: !!p, who: v.profil });
  });
  opsOf(acc, k).forEach(op => {
    const d = Math.min(+String(op.date).slice(8, 10) || 1, D);
    ev.push({ d, v: num(op.montant) || 0, kind: op.type === 'ajust' ? 'ajust' : op.type === 'vir' ? 'virop' : 'ponct', id: op.id, label: op.libelle || op.categorie || (op.type === 'ajust' ? 'Correction de solde' : ''), cat: op.type === 'ajust' ? 'Correction de solde' : op.categorie, who: op.profil, op });
  });
  if (o && o.sim) DB.simulations.filter(s => s.compte === acc && s.mois === k && bool(s.actif)).forEach(s => {
    ev.push({ d: Math.min(15, D), v: -(num(s.montant) || 0), kind: 'sim', label: s.libelle, cat: 'Simulation' });
  });
  return ev;
}
function spentCat(acc, k, cat, upTo) {
  return -opsOf(acc, k).filter(o => o.categorie === cat && o.type !== 'ajust' && o.type !== 'vir' && (num(o.montant) || 0) < 0 && (upTo == null || +String(o.date).slice(8, 10) <= upTo))
    .reduce((a, o) => a + num(o.montant), 0);
}
// Dépense habituelle d'une catégorie : moyenne des 3 derniers mois + mois en cours extrapolé (dès le 10)
function habit(acc, cat) {
  const ck = 'h|' + acc + '|' + cat; if (ck in CACHE) return CACHE[ck];
  const k0 = startMonth(acc), vals = [];
  for (let j = 1; j <= 3; j++) { const k = addM(CUR, -j); if (k >= k0) vals.push(spentCat(acc, k, cat)); }
  if (TODAY >= 10) vals.push(spentCat(acc, CUR, cat, TODAY) * dim(CUR) / TODAY);
  const c = catsOf(acc).find(x => x.nom === cat);
  const res = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : (num(c && c.budget) || 0);
  return (CACHE[ck] = res);
}
const hasHistory = acc => addM(CUR, -1) >= startMonth(acc);

function calc(acc, k, start, o) {
  o = o || {};
  const mode = o.mode || 'budget', D = dim(k), T = k < CUR ? D : k === CUR ? TODAY : 0;
  const ev = events(acc, k, o);
  const realized = ev.filter(e => e.d <= T).reduce((a, e) => a + e.v, 0), bal = start + realized;
  const fut = ev.filter(e => e.d > T).reduce((a, e) => a + e.v, 0);
  const cats = catsOf(acc).map(c => {
    const spent = -ev.filter(e => e.kind === 'ponct' && e.cat === c.nom && e.d <= T && e.v < 0).reduce((a, e) => a + e.v, 0);
    const planned = -ev.filter(e => e.kind === 'ponct' && e.cat === c.nom && e.d > T && e.v < 0).reduce((a, e) => a + e.v, 0);
    const budget = num(c.budget);
    const target = k < CUR ? 0 : mode === 'habits' ? habit(acc, c.nom) : (budget || 0);
    return { nom: c.nom, budget, spent, target, remaining: k < CUR ? 0 : Math.max(0, target - spent - planned) };
  });
  const varRem = cats.reduce((a, c) => a + c.remaining, 0), end = bal + fut - varRem;
  const curve = []; let low = { d: D, v: Infinity };
  for (let d = 1; d <= D; d++) {
    let v = start + ev.filter(e => e.d <= d).reduce((a, e) => a + e.v, 0);
    if (d > T && D > T) v -= varRem * (d - T) / (D - T);
    curve.push(v); if (d > T && v < low.v) low = { d, v };
  }
  const rev = ev.filter(e => e.v > 0 && e.kind !== 'ajust').reduce((a, e) => a + e.v, 0);
  const chg = -ev.filter(e => (e.kind === 'fixe' || e.kind === 'vir') && e.v < 0).reduce((a, e) => a + e.v, 0);
  const vari = -ev.filter(e => (e.kind === 'ponct' || e.kind === 'sim' || e.kind === 'virop') && e.v < 0).reduce((a, e) => a + e.v, 0) + varRem;
  return { k, D, T, ev, start, bal, end, cats, varRem, curve, low, rev, chg, vari, net: end - start };
}
// Solde au 1er du mois k (enchaîne les mois depuis le mois de départ, en repartant des clôtures)
function startOf(acc, k) {
  const ck = 's|' + acc + '|' + k; if (ck in CACHE) return CACHE[ck];
  const A = accOf(acc), k0 = startMonth(acc);
  let s = num(A.soldeDepart) || 0;
  for (let m = k0; m < k; m = addM(m, 1)) { const c = clot(acc, m); s = c ? num(c.soldeFin) : calc(acc, m, s).end; }
  return (CACHE[ck] = s);
}
function forecast(acc, n, o) {
  const ck = 'f|' + acc + '|' + n + '|' + JSON.stringify(o || {}); if (ck in CACHE) return CACHE[ck];
  const out = []; let s = startOf(acc, CUR);
  for (let i = 0; i < n; i++) { const r = calc(acc, addM(CUR, i), s, o); out.push(r); s = r.end; }
  return (CACHE[ck] = out);
}
const curMonth = acc => calc(acc, CUR, startOf(acc, CUR), { mode: 'budget' });
function status(end, seuil) {
  if (end < 0) return { c: 'bad', t: 'Dépassement prévu', msg: `Il manque ${eur0(-end)} pour finir le mois` };
  if (end < seuil) return { c: 'warn', t: 'Budget serré', msg: `Marge de ${eur0(end)}, sous le seuil de ${eur0(seuil)}` };
  return { c: 'good', t: 'Budget tenu', msg: `Épargne possible : ${eur0(end - seuil)}` };
}
const seuilOf = acc => num(accOf(acc).seuil) || 0;
function margeHab(acc) {
  const ck = 'mh|' + acc; if (ck in CACHE) return CACHE[ck];
  const r = forecast(acc, 7, { mode: 'habits' }).slice(1);
  return (CACHE[ck] = r.reduce((a, x) => a + x.net, 0) / r.length);
}
function firstUnclosed(acc) {
  if (!started(acc)) return null;
  for (let k = startMonth(acc); k < CUR; k = addM(k, 1)) if (!clot(acc, k)) return k;
  return null;
}

/* ================= Simulations ================= */
const simI = s => diffM(CUR, s.mois);
const activeSims = acc => DB.simulations.filter(s => s.compte === acc && bool(s.actif) && simI(s) >= 0).sort((a, b) => simI(a) - simI(b) || String(a.id).localeCompare(String(b.id)));
function reservedBefore(s, list) {
  const idx = list.findIndex(x => x.id === s.id), prev = idx < 0 ? list : list.slice(0, idx), k = simI(s);
  if (k <= 0) return { avg: 0, names: [] };
  let tot = 0; const names = new Set();
  for (let mo = 1; mo <= k; mo++) prev.forEach(p => { const pk = simI(p); if (pk > 0 && mo <= pk) { tot += num(p.montant) / pk; names.add(p.libelle); } });
  return { avg: tot / k, names: [...names] };
}
function simsSummary(acc) {
  const all = activeSims(acc), list = all.filter(x => simI(x) > 0), marge = margeHab(acc);
  if (all.length < 2) return null;
  let peak = 0; const maxK = list.length ? Math.max(...list.map(simI)) : 0;
  for (let mo = 1; mo <= maxK; mo++) peak = Math.max(peak, list.filter(x => mo <= simI(x)).reduce((a, x) => a + num(x.montant) / simI(x), 0));
  return { n: all.length, total: all.reduce((a, x) => a + num(x.montant), 0), peak, marge, ratio: marge > 0 ? peak / marge : Infinity };
}
function simPlan(s) {
  const acc = s.compte, margeTot = margeHab(acc), k = simI(s), amt = num(s.montant) || 0;
  const need = k > 0 ? amt / k : amt;
  const res = reservedBefore(s, bool(s.actif) ? activeSims(acc) : activeSims(acc).concat([s]));
  const marge = margeTot - res.avg, ratio = marge > 0 ? need / marge : Infinity;
  const c = ratio <= 0.5 ? 'good' : ratio <= 0.9 ? 'warn' : 'bad';
  const label = c === 'good' ? 'Faisable' : c === 'warn' ? 'Tendu' : 'Difficile';
  let over = null;
  catsOf(acc).filter(x => num(x.budget)).forEach(x => { const h = habit(acc, x.nom) - num(x.budget); if (h > 15 && (!over || h > over.d)) over = { n: x.nom, d: h }; });
  const kmin = marge > 0 ? Math.ceil(amt / (marge * 0.5)) : null;
  const end = forecast(acc, Math.max(6, k + 2), { sim: true, mode: 'habits' });
  const neg = end.find(r => r.low.v < 0);
  let txt;
  if (k === 0) txt = `L'achat tombe ce mois-ci : il est pris directement sur la fin de mois.`;
  else if (res.avg > 0) txt = `Il reste habituellement ${eur0(margeTot)} en fin de mois, dont <b>${eur0(res.avg)}</b> déjà réservés pour ${res.names.map(esc).join(', ')}. Mettre <b>${eur0(need)}</b> de côté représente <b>${marge > 0 ? Math.round(ratio * 100) + ' %' : 'plus que tout'}</b> de ce qui reste disponible (${eur0(marge)}).`;
  else txt = `Mettre <b>${eur0(need)}</b> de côté chaque mois représente <b>${marge > 0 ? Math.round(ratio * 100) + ' %' : 'plus que tout'}</b> de ce qu'il reste habituellement en fin de mois (${eur0(margeTot)}).`;
  if (!hasHistory(acc)) txt += ` <i>Peu d'historique pour l'instant : les budgets servent d'estimation.</i>`;
  if (over) txt += ` D'après les saisies, l'enveloppe <b>${esc(over.n)}</b> est dépassée de ${eur0(over.d)} par mois en moyenne : c'est pris en compte.`;
  if (c !== 'good' && kmin && kmin > k) txt += ` Plus confortable en visant <b>${mLabel(addM(CUR, kmin))}</b> (${eur0(amt / kmin)}/mois).`;
  if (neg && bool(s.actif)) txt += ` Attention, découvert possible en ${mLabel(neg.k)}.`;
  if (!bool(s.actif)) txt = `<i>Simulation désactivée, évaluée comme si on l'ajoutait aux autres.</i> ` + txt;
  return { k, need, c: neg && bool(s.actif) ? 'bad' : c, label: neg && bool(s.actif) ? 'Risqué' : label, txt };
}

/* ================= Impôts ================= */
function bareme(q) { let t = 0, p = 0; for (const [l, r] of IMPOT.tranches) { if (q > p) t += (Math.min(q, l) - p) * r; p = l; } return t; }
function taxParams() {
  return { mode: param('impMode', 'commune'), kids: num(param('impEnfants')) || 0, sal1: num(param('impSal1')) || 0, sal2: num(param('impSal2')) || 0, autres: num(param('impAutres')) || 0, autresAb: num(param('impAutresAb')) || 50, taux: num(param('impTaux')) || 0 };
}
function calcTax(X, extra) {
  const couple = X.mode === 'commune', sal = (X.sal1 + extra) + (couple ? X.sal2 : 0);
  const Rsal = Math.max(0, sal * 0.9), Raut = X.autres * (1 - X.autresAb / 100), R = Rsal + Raut;
  const base = couple ? 2 : 1, parts = base + (X.kids <= 2 ? X.kids * 0.5 : 1 + (X.kids - 2));
  const Ifull = bareme(R / parts) * parts, Ibase = bareme(R / base) * base, cap = (parts - base) * 2 * IMPOT.plafondDemiPart;
  let I = Math.max(Ifull, Ibase - cap); const plaf = Ibase - cap > Ifull;
  const [sd, dx] = couple ? IMPOT.decote.couple : IMPOT.decote.seul; let dec = 0;
  if (I < sd) { dec = Math.min(I, Math.max(0, dx - IMPOT.decote.taux * I)); I -= dec; }
  const q = R / parts, TR = IMPOT.tranches; let k = 0; while (q > TR[k][0]) k++;
  const share = R > 0 ? Rsal / R : 0;
  return { R, parts, I, dec, plaf, q, tmi: TR[k][1], toNext: (TR[k][0] - q) * parts / 0.9, nextRate: TR[Math.min(k + 1, TR.length - 1)][1], tauxEst: sal > 0 ? I * share / sal * 100 : 0, prelev: sal * X.taux / 100, duSal: I * share, sal };
}

/* ================= Graphiques ================= */
function niceStep(s) { if (!(s > 0)) return 100; const p = Math.pow(10, Math.floor(Math.log10(s))), n = s / p; return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p; }
function curveSVG(r, seuil) {
  const W = 340, H = 150, L = 44, R = 8, Tp = 10, B = 22, vals = r.curve.concat([0, seuil]);
  let mn = Math.min(...vals), mx = Math.max(...vals); const padv = (mx - mn) * .08 || 50; mn -= padv; mx += padv;
  const x = d => L + (d - 1) * (W - L - R) / (r.D - 1), yv = v => Tp + (mx - v) * (H - Tp - B) / (mx - mn);
  const step = niceStep((mx - mn) / 4), ticks = []; for (let t = Math.ceil(mn / step) * step; t <= mx; t += step) ticks.push(t);
  const pts = r.curve.map((v, i) => [x(i + 1), yv(v)]), T = Math.max(1, r.T);
  let g = ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${yv(t)}" y2="${yv(t)}" stroke="var(--line)"/><text x="${L - 6}" y="${yv(t) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${Math.round(t)}</text>`).join('');
  g += `<line x1="${L}" x2="${W - R}" y1="${yv(seuil)}" y2="${yv(seuil)}" stroke="var(--warn)" stroke-dasharray="3 3" stroke-width="1.2"/><text x="${W - R}" y="${yv(seuil) - 4}" text-anchor="end" font-size="10" fill="var(--warn)">seuil ${Math.round(seuil)} €</text>`;
  if (mn < 0) g += `<line x1="${L}" x2="${W - R}" y1="${yv(0)}" y2="${yv(0)}" stroke="var(--bad)" stroke-width="1.2"/>`;
  [1, 10, 20, r.D].forEach(d => g += `<text x="${x(d)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${d}</text>`);
  const past = pts.slice(0, T).map(p => p.join(',')).join(' ');
  g += `<polygon points="${x(1)},${yv(mn)} ${past} ${x(T)},${yv(mn)}" fill="var(--accent)" opacity=".10"/>`;
  g += `<polyline points="${past}" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linejoin="round"/>`;
  g += `<polyline points="${pts.slice(T - 1).map(p => p.join(',')).join(' ')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4"/>`;
  if (r.T) g += `<circle cx="${x(T)}" cy="${yv(r.curve[T - 1])}" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>`;
  g += `<circle cx="${x(r.D)}" cy="${yv(r.end)}" r="4" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>`;
  return `<svg class="curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du solde sur le mois">${g}</svg>`;
}

/* ================= Interface ================= */
const UI = { acc: store.get('le31-compte', 'perso'), tab: 'home', foreTab: 'budget', horizon: 6, mode: 'habits', theme: store.get('le31-theme', 'auto') };
const draft = { sens: '-', cat: null, to: null };
const main = $('main');

function render() {
  refreshNow();
  if (!DB.comptes.find(a => a.id === UI.acc) && DB.comptes.length) UI.acc = accs()[0].id;
  const L = $('monthLbl'); if (L) L.textContent = mLabel(CUR);
  $('foot').textContent = 'Le 31 · V' + APP_VERSION;
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === UI.tab));
  const blocked = gate(), imp = !blocked && UI.imp && IMP;
  $('tabs').hidden = !!blocked || !!imp;
  $('top').querySelector('.seg').hidden = !!blocked || !!imp || accs().length < 2 || (UI.tab === 'fore' && UI.foreTab === 'tax') || UI.tab === 'set';
  $('accSeg').innerHTML = accs().map(a => `<button data-acc="${esc(a.id)}" aria-pressed="${a.id === UI.acc}">${esc(a.nom)}</button>`).join('');
  try {
    main.innerHTML = blocked || (imp ? vImport() : ({ home: vHome, fixed: vFixed, add: vAdd, fore: vFore, set: vSet })[UI.tab]());
  } catch (e) {
    console.error(e);
    main.innerHTML = `<section class="view"><div class="note bad">Un problème d'affichage est survenu : ${esc(e.message)}. Va dans Réglages ou recharge l'appli.</div></section>`;
  }
  setSync();
}
// Écrans bloquants : appli pas encore reliée, lien refusé, accès coupé, premier chargement, premier lancement
function gate() {
  const logo = `<div class="logo31">Le 31<span>.</span></div>`;
  const paste = `<form class="form" id="keyForm" novalidate style="text-align:left"><div class="field"><label for="keyIn">Colle ici le lien reçu</label><input id="keyIn" placeholder="https://…#inv=…" autocomplete="off"></div><button class="btn" type="submit">Relier l'appli</button></form>`;
  if (INV() && apiOk()) {
    if (IOS && !STANDALONE() && !JOIN.iosOk) return `<section class="view center">${logo}<h2>Installe d'abord Le 31</h2>
      <p class="hint" style="font-size:14px">Sur iPhone et iPad : bouton <b>Partager</b> puis <b>Sur l'écran d'accueil</b>. Ouvre ensuite Le 31 depuis l'écran d'accueil : si l'appli te le demande, colle le lien reçu.</p>
      <p class="hint">Ce lien ne marche qu'une fois, sur un seul appareil.</p><button class="btn ghost" data-iosok="1">Utiliser Le 31 dans Safari plutôt</button></section>`;
    const E = JOIN.err;
    if (!JOIN.busy && E) {
      const api = API(), short = api.replace(/^https:\/\/script\.google\.com\/macros\/s\/(.{6}).*(.{6})\/exec$/, '…/s/$1…$2/exec');
      const why = E === 'delai' ? "Le serveur n'a pas répondu à temps."
        : E === 'reseau' ? "Impossible de joindre le serveur (réseau, ou adresse du serveur incorrecte dans le lien)."
        : E === 'html' ? "L'adresse du serveur contenue dans le lien ne répond pas comme prévu : ce n'est sans doute pas la bonne (ou le déploiement n'est pas en « Tout le monde »)."
        : E === 'serveur' ? 'Le serveur a rencontré une erreur.' : 'Erreur : ' + esc(E);
      return `<section class="view center">${logo}<h2>Connexion impossible</h2>
        <p class="hint" style="font-size:14px">${why}</p>
        ${JOIN.detail ? `<div class="note" style="text-align:left;font-size:12px;word-break:break-word">Détail : ${esc(JOIN.detail)}</div>` : ''}
        <div class="note" style="text-align:left;font-size:13px">Adresse du serveur dans ton lien :<br><b style="word-break:break-all">${esc(short)}</b><br>Elle doit être identique à l'<b>URL de l'application Web</b> du déploiement. Ouverte dans Safari, elle doit afficher « Le 31 : serveur actif ». Sinon, recrée le lien depuis le menu « Le 31 » du Google Sheet en collant la bonne adresse.</div>
        <button class="btn" data-joinretry="1">Réessayer</button>
        ${paste}</section>`;
    }
    return `<section class="view center">${logo}<p class="hint">Connexion de cet appareil…</p></section>`;
  }
  if (!JETON() || !apiOk() || isAccessErr(SYNC.error)) {
    const E = JOIN.err, cut = isAccessErr(SYNC.error) && JETON();
    const msg = E === 'utilisee' ? "Ce lien a déjà servi : chaque lien ne marche qu'une fois. Demande un nouveau lien (Réglages > Profils sur le téléphone de l'autre personne, ou menu « Le 31 » du Google Sheet)."
      : E === 'expiree' ? 'Ce lien a expiré (14 jours). Demande-en un nouveau.'
      : E === 'annulee' ? 'Ce lien a été remplacé par un plus récent : utilise le dernier lien reçu.'
      : E === 'reseau' ? 'Pas de réseau : réessaie dès que possible.'
      : E ? 'Lien non reconnu.'
      : cut ? "L'accès de cet appareil a été coupé. Demande un nouveau lien pour le reconnecter."
      : "Ouvre le lien d'accès reçu par message pour relier l'appli à vos comptes.";
    return `<section class="view center">${logo}<h2>${cut ? 'Accès coupé' : E ? 'Lien refusé' : 'Bienvenue'}</h2><p class="hint" style="font-size:14px">${msg}</p>${paste}</section>`;
  }
  if (!LOADED) return `<section class="view center">${logo}<p class="hint">${SYNC.state === 'off' ? 'Pas de réseau pour le premier chargement. Réessaie dès que possible.' : 'Chargement des comptes…'}</p>${SYNC.state === 'off' ? '<button class="btn ghost" data-retry="1">Réessayer</button>' : ''}</section>`;
  if (ME === '') return vOnboard();
  if (!DB.comptes.length) return `<section class="view center">${logo}<p class="hint">Aucun compte visible pour ce profil. Ajoute un compte perso dans Réglages ou demande à être relié au compte commun.</p></section>`;
  return null;
}

function rowEv(e) {
  const attr = e.kind === 'ponct' || e.kind === 'ajust' || e.kind === 'virop' ? `data-oid="${esc(e.id)}"` : e.kind === 'fixe' ? `data-fid="${esc(e.id)}"` : e.kind === 'vir' ? `data-vid="${esc(e.id)}"` : 'disabled';
  const who = e.who && DB.profils.length > 1 ? ' · ' + esc(pname(e.who)) : '';
  const tag = e.kind === 'vir' || e.kind === 'virop' ? '<span class="tag">lié</span>' : '';
  return `<button class="item" ${attr}><span class="day">${e.d}</span><span class="lbl"><b>${esc(e.label)}${tag}</b><small>${esc(e.cat || '')}${e.kind === 'fixe' ? ' · fixe' : ''}${who}</small></span><span class="amt ${e.v > 0 ? 'pos' : 'neg'}">${sgn(e.v)}</span></button>`;
}

/* ----- Onglet Mois ----- */
function vHome() {
  const acc = UI.acc, A = accOf(acc);
  if (!started(acc)) return `<section class="view"><div class="hero">
      <div class="rowhead"><span class="sub">Pour commencer</span></div>
      <h2>Démarrer : ${esc(A.nom)}</h2>
      <h3 style="margin:4px 0 0">Importer un relevé <span class="tag">recommandé</span></h3>
      <p class="hint" style="font-size:14px">Télécharge l'historique du compte sur le site de ta banque (format <b>CSV</b> ou <b>OFX</b>, idéalement 3 mois). Le 31 repère les prélèvements, classe les dépenses et calcule vos habitudes tout de suite.</p>
      <label class="btn" style="text-align:center">Choisir le fichier<input type="file" id="impFile" accept=".csv,.ofx,.qfx,.txt,text/csv" hidden></label>
      <div id="impErr"></div>
    </div>
    <div class="hero"><h3 style="margin:0">Ou saisir le solde à la main</h3>
      <p class="hint">Le solde affiché par la banque aujourd'hui. Tu ajouteras ensuite les charges fixes dans l'onglet Charges.</p>
      <form class="form" id="startForm" novalidate><div class="amountbox"><input id="startBal" inputmode="decimal" placeholder="0,00" aria-label="Solde actuel" autocomplete="off"><span>€</span></div>
      <button class="btn ghost" type="submit">Démarrer avec ce solde</button></form></div>
    ${isShared(acc) ? `<div class="note">Compte partagé : une seule personne le démarre, l'autre le retrouvera déjà prêt.</div>` : ''}</section>`;
  const r = curMonth(acc), seuil = seuilOf(acc), st = status(r.end, seuil);
  const upcoming = r.ev.filter(e => e.d > r.T).sort((a, b) => a.d - b.d);
  const ops = r.ev.filter(e => e.kind === 'ponct' || e.kind === 'ajust' || e.kind === 'virop').sort((a, b) => b.d - a.d || String(b.id).localeCompare(String(a.id)));
  const toRecon = r.ev.filter(e => (e.kind === 'fixe' || e.kind === 'vir') && e.d <= r.T && !e.ok).sort((a, b) => a.d - b.d);
  const envs = r.cats.filter(c => c.budget);
  const unc = firstUnclosed(acc);
  return `<section class="view">
  ${unc ? `<div class="banner warn"><span><b>${mLabel(unc)}</b> n'est pas clôturé.</span><button class="btn small" data-close-month="${unc}">Clôturer</button></div>` : ''}
  <div class="hero">
    <div class="rowhead"><span class="sub">Fin ${MONTHS_L[pm(CUR).m]} prévue</span><span class="pill ${st.c}">${st.t}</span></div>
    <div class="big num">${eur0(r.end)}</div>
    <div style="font-weight:600;color:var(--${st.c})">${st.msg}</div>
    <div class="kv">
      <div><small>Solde estimé au ${TODAY} ${MONTHS[pm(CUR).m]}</small><b>${eur(r.bal)}</b></div>
      <div><small>Reste à sortir</small><b>${eur(-(r.end - r.bal))}</b></div>
    </div>
    ${curveSVG(r, seuil)}
    ${r.low.v < 0 ? `<div class="alert bad">Découvert prévu le ${r.low.d} ${MONTHS[pm(CUR).m]} : ${eur0(r.low.v)}</div>` : ''}
    <div class="actions"><button class="btn ghost small" data-fixbal="1">Corriger le solde</button><label class="btn ghost small" style="text-align:center;flex:1">Importer un relevé<input type="file" id="impFile" accept=".csv,.ofx,.qfx,.txt,text/csv" hidden></label></div>
    <div id="impErr"></div>
  </div>
  <div class="block"><div class="rowhead"><h2>À pointer sur le relevé</h2><span class="sub">${toRecon.length ? toRecon.length + ' en attente' : 'à jour'}</span></div>
    <div class="list">${toRecon.length ? toRecon.map(e => `<div class="recon"><span class="day" style="font-family:var(--f-mono);font-size:12px;text-align:center;background:var(--sunk);border-radius:8px;padding:5px 0;color:var(--muted)">${e.d}</span><span class="lbl"><b>${esc(e.label)}</b><small>prévu ${eur(Math.abs(e.v))}</small></span><input id="rc-${esc(e.key)}" inputmode="decimal" value="${fr(r2(Math.abs(e.v)))}" aria-label="Montant réel"><button class="chk" data-recon="${esc(e.key)}" aria-label="Pointer">✓</button></div>`).join('') : `<div class="empty">Tous les prélèvements passés sont pointés.</div>`}</div>
    <div class="hint">Corrige le montant si le prélèvement réel est différent, puis valide : la prévision bascule en réel.</div>
  </div>
  ${envs.length ? `<div class="block"><div class="rowhead"><h2>Enveloppes du mois</h2><span class="sub">dépensé / budget</span></div>
    <div class="list">${envs.map(e => { const p = e.spent / e.budget, c = p > 1 ? 'over' : p > r.T / r.D + .15 ? 'near' : '';
      return `<div class="env"><div class="t"><b>${esc(e.nom)}</b><span>${eur(e.spent)} / ${eur0(e.budget)}</span></div><div class="bar"><i class="${c}" style="width:${Math.min(100, p * 100)}%"></i><em style="left:${r.T / r.D * 100}%"></em></div>${p > 1 ? `<small style="color:var(--bad);font-size:12px;font-weight:600">Dépassé de ${eur(e.spent - e.budget)}</small>` : ''}</div>`; }).join('')}</div></div>` : ''}
  <div class="block"><div class="rowhead"><h2>À venir d'ici le ${r.D}</h2><span class="sub">${upcoming.length} opération${upcoming.length > 1 ? 's' : ''}</span></div>
    <div class="list">${upcoming.length ? upcoming.map(rowEv).join('') : `<div class="empty">Plus rien de prévu ce mois-ci.</div>`}
    ${r.varRem > 0.5 ? `<div class="item" disabled><span class="day">~</span><span class="lbl"><b>Reste des enveloppes</b><small>estimé, réparti sur les jours restants</small></span><span class="amt neg">${sgn(-r.varRem)}</span></div>` : ''}</div>
  </div>
  <div class="block"><div class="rowhead"><h2>Saisies du mois</h2><button class="btn ghost small" data-go="add">Ajouter</button></div>
    <div class="list">${ops.length ? ops.map(rowEv).join('') : `<div class="empty">Aucune saisie ce mois-ci.</div>`}</div>
  </div></section>`;
}

/* ----- Onglet Charges ----- */
function vFixed() {
  const acc = UI.acc, A = accOf(acc), sortd = a => a.slice().sort((x, y) => (num(x.jour) || 0) - (num(y.jour) || 0));
  const per = f => { const a = num(f.montant) || 0; return f.frequence === 'T' ? a / 3 : f.frequence === 'A' ? a / 12 : a; };
  const fx = DB.fixes.filter(f => f.compte === acc);
  const live = f => bool(f.actif) && (!f.fin || f.fin >= CUR);
  const vr = DB.virements.filter(v => v.de === acc || v.vers === acc);
  const vrIn = v => v.vers === acc;
  const tot = fx.filter(f => live(f) && f.sens !== '+').reduce((a, f) => a + per(f), 0) + vr.filter(v => bool(v.actif) && !vrIn(v)).reduce((a, v) => a + (num(v.montant) || 0), 0);
  const totR = fx.filter(f => live(f) && f.sens === '+').reduce((a, f) => a + per(f), 0) + vr.filter(v => bool(v.actif) && vrIn(v)).reduce((a, v) => a + (num(v.montant) || 0), 0);
  const stateTxt = (cle, day, occ, active) => !active ? ' · en pause' : point(CUR, cle) ? ' · pointé ✓' : occ && day <= TODAY ? ' · à pointer' : occ ? ' · à venir' : '';
  const row = f => {
    const occ = occursF(f, CUR), fin = f.fin ? ` · jusqu'à ${mShort(f.fin)} ${pm(f.fin).y}` : '';
    return `<button class="item ${bool(f.actif) && (!f.fin || f.fin >= CUR) ? '' : 'off'}" data-fid="${esc(f.id)}"><span class="day">le ${esc(f.jour)}</span><span class="lbl"><b>${esc(f.libelle)}</b><small>${esc(f.categorie || 'Autre')} · ${FREQ[f.frequence] || 'Mensuel'}${f.frequence === 'T' || f.frequence === 'A' ? ' (' + MONTHS[(num(f.moisRef) || 1) - 1] + ')' : ''}${fin}${stateTxt('f' + f.id, num(f.jour), occ, bool(f.actif))}</small></span><span class="amt ${f.sens === '+' ? 'pos' : 'neg'}">${f.sens === '+' ? '+' : '−'}${eur(num(f.montant) || 0)}${f.frequence === 'T' || f.frequence === 'A' ? `<small>≈ ${eur(per(f))}/mois</small>` : ''}</span></button>`;
  };
  const rowV = v => `<button class="item ${bool(v.actif) ? '' : 'off'}" data-vid="${esc(v.id)}"><span class="day">le ${esc(v.jour)}</span><span class="lbl"><b>${esc(v.libelle || 'Virement')}<span class="tag">lié</span></b><small>${esc(accName(v.de))} → ${esc(accName(v.vers))}${v.profil ? ' · ' + esc(pname(v.profil)) : ''}${stateTxt('v' + v.id, num(v.jour), occursV(v, CUR), bool(v.actif))}</small></span><span class="amt ${vrIn(v) ? 'pos' : 'neg'}">${vrIn(v) ? '+' : '−'}${eur(num(v.montant) || 0)}</span></button>`;
  const rev = sortd(fx.filter(f => f.sens === '+')), men = sortd(fx.filter(f => f.sens !== '+' && (f.frequence || 'M') === 'M')), oth = sortd(fx.filter(f => f.sens !== '+' && f.frequence && f.frequence !== 'M'));
  const env = catsOf(acc).reduce((a, c) => a + (num(c.budget) || 0), 0);
  return `<section class="view">
    <div class="hero" style="gap:10px">
      <div class="kv"><div><small>Rentrées fixes / mois</small><b class="pos">${eur(totR)}</b></div><div><small>Sorties fixes / mois</small><b>${eur(tot)}</b></div></div>
      <div class="hint" style="font-size:13px">Reste pour vivre après les fixes : <b style="color:var(--ink)">${eur(totR - tot)}</b>${env ? `, dont ${eur0(env)} en enveloppes` : ''}.</div>
    </div>
    <div class="block"><div class="rowhead"><h2>Virements liés</h2><span class="sub">entre les comptes</span></div>
      <div class="list">${vr.length ? sortd(vr).map(rowV).join('') : `<div class="empty">Aucun virement lié.</div>`}</div>
      <div class="hint">Une seule ligne : elle débite un compte et crédite l'autre automatiquement.</div></div>
    <div class="block"><div class="rowhead"><h2>Rentrées</h2></div><div class="list">${rev.length ? rev.map(row).join('') : `<div class="empty">Aucune rentrée fixe (salaire…).</div>`}</div></div>
    <div class="block"><div class="rowhead"><h2>Charges mensuelles</h2><span class="sub">${men.length}</span></div><div class="list">${men.length ? men.map(row).join('') : `<div class="empty">Aucune charge mensuelle.</div>`}</div></div>
    <div class="block"><div class="rowhead"><h2>Trimestrielles et annuelles</h2></div><div class="list">${oth.length ? oth.map(row).join('') : `<div class="empty">Aucune.</div>`}</div></div>
    <div class="actions"><button class="btn" data-newfixed="1">Ajouter une charge, rentrée ou virement</button></div>
  </section>`;
}

/* ----- Onglet Saisir ----- */
function vAdd() {
  const acc = UI.acc, cats = catsOf(acc).map(c => c.nom), oth = otherAcc(acc);
  if (!cats.includes(draft.cat)) draft.cat = cats[0] || null;
  const others = accs().filter(a => a.id !== acc);
  if (!others.find(a => a.id === draft.to)) draft.to = others[0] && others[0].id;
  const isVir = draft.sens === 'v' && others.length > 0;
  return `<section class="view"><form class="form" id="addForm" novalidate>
    <div class="seg" role="group" aria-label="Type" style="grid-template-columns:1fr 1fr 1fr"><button type="button" data-sens="-" aria-pressed="${draft.sens === '-'}">Dépense</button><button type="button" data-sens="+" aria-pressed="${draft.sens === '+'}">Rentrée</button>${others.length ? `<button type="button" data-sens="v" aria-pressed="${isVir}">Virement</button>` : ''}</div>
    <div class="amountbox"><input id="amt" inputmode="decimal" placeholder="0,00" aria-label="Montant" autocomplete="off"><span>€</span></div>
    ${isVir ? (others.length > 1 ? `<div class="field"><label for="vto">Vers</label><select id="vto" data-vto="1">${others.map(a => `<option value="${esc(a.id)}" ${a.id === draft.to ? 'selected' : ''}>${esc(a.nom)}</option>`).join('')}</select></div>` : '') + `<div class="note">De <b>${esc(accName(acc))}</b> vers <b>${esc(accName(draft.to))}</b> : l'opération apparaît sur les deux comptes.</div>` :
    `<div class="field"><label>Type de dépense</label><div class="chips">${cats.map(c => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${c === draft.cat}">${esc(c)}</button>`).join('')}<button type="button" class="chip" data-newcat="${esc(acc)}" style="border-style:dashed;color:var(--accent)">＋ Nouvelle</button></div></div>`}
    <div class="two"><div class="field"><label for="dt">Date</label><input id="dt" type="date" value="${TODAY_ISO}"></div>
    <div class="field"><label for="lb">Libellé</label><input id="lb" placeholder="${isVir ? 'Ex. Complément courses' : 'Ex. Drive'}" autocomplete="off"></div></div>
    <div class="hint" style="font-size:13px">Compte : <b style="color:var(--ink)">${esc(accName(acc))}</b>. Une date dans un mois futur crée une opération prévue, prise en compte dans les prévisions.</div>
    <button class="btn" type="submit">Enregistrer</button>
  </form></section>`;
}

/* ----- Onglet Prévisions ----- */
function vFore() {
  const seg = `<div class="seg" role="group" aria-label="Vue"><button data-ftab="budget" aria-pressed="${UI.foreTab === 'budget'}">Budget</button><button data-ftab="tax" aria-pressed="${UI.foreTab === 'tax'}">Impôts</button></div>`;
  return seg + (UI.foreTab === 'tax' ? vTax() : vBudget());
}
function vBudget() {
  const acc = UI.acc;
  if (!started(acc)) return `<section class="view"><div class="note">Indique d'abord le solde actuel du compte dans l'onglet Mois.</div></section>`;
  const seuil = seuilOf(acc), rows = forecast(acc, UI.horizon, { sim: true, mode: UI.mode }), base = forecast(acc, UI.horizon, { mode: UI.mode });
  const last = rows[rows.length - 1], lastBase = base[base.length - 1];
  const avgNet = rows.slice(1).reduce((a, r) => a + r.net, 0) / Math.max(1, rows.length - 1), neg = rows.find(r => r.low.v < 0);
  const W = 340, H = 140, L = 8, B = 22, mxA = Math.max(...rows.map(r => Math.abs(r.net)), 1), bw = (W - L * 2) / rows.length, y0 = (H - B) / 2 + 4;
  const bars = rows.map((r, i) => { const h = Math.abs(r.net) / mxA * ((H - B) / 2 - 12), x = L + i * bw + bw * .18, w = bw * .64, y = r.net >= 0 ? y0 - h : y0;
    return `<rect x="${x}" y="${y}" width="${w}" height="${Math.max(1, h)}" rx="3" fill="var(--${r.net >= 0 ? 'good' : 'bad'})"/><text x="${x + w / 2}" y="${r.net >= 0 ? y - 4 : y + h + 11}" text-anchor="middle" font-size="9.5" fill="var(--muted)">${r.net >= 0 ? '+' : '−'}${Math.round(Math.abs(r.net))}</text><text x="${x + w / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="var(--muted)">${mShort(r.k)}</text>`; }).join('');
  const sims = DB.simulations.filter(s => s.compte === acc).sort((a, b) => simI(a) - simI(b) || String(a.id).localeCompare(String(b.id)));
  const habits = catsOf(acc).map(c => ({ n: c.nom, h: habit(acc, c.nom), b: num(c.budget) })).filter(x => x.h > 0.5 || x.b);
  const sum = simsSummary(acc), stL = status(last.end, seuil);
  return `<section class="view">
    <div class="chips" role="group" aria-label="Horizon">${[3, 6, 12].map(n => `<button class="chip" data-h="${n}" aria-pressed="${UI.horizon === n}">${n} mois</button>`).join('')}</div>
    <div class="seg" role="group" aria-label="Base de calcul"><button data-mode="habits" aria-pressed="${UI.mode === 'habits'}">Selon nos habitudes</button><button data-mode="budget" aria-pressed="${UI.mode === 'budget'}">Selon nos budgets</button></div>
    <div class="hero">
      <div class="rowhead"><span class="sub">Solde fin ${mLabel(last.k)}</span><span class="pill ${stL.c}">${stL.t}</span></div>
      <div class="big num">${eur0(last.end)}</div>
      <div class="kv"><div><small>Gagné en moyenne / mois</small><b style="color:var(--${avgNet >= 0 ? 'good' : 'bad'})">${sgn(Math.round(avgNet))}</b></div>
      <div><small>Épargnable sur la période</small><b>${eur0(Math.max(0, last.end - seuil))}</b></div></div>
      ${neg ? `<div class="alert bad">Risque de découvert en ${mLabel(neg.k)} (point bas ${eur0(neg.low.v)} le ${neg.low.d})</div>` : ''}
      ${DB.simulations.some(s => s.compte === acc && bool(s.actif) && simI(s) >= 0) ? `<div class="hint" style="font-size:13px">Sans les simulations : ${eur0(lastBase.end)}</div>` : ''}
      ${UI.mode === 'habits' && !hasHistory(acc) ? `<div class="hint">Peu d'historique pour l'instant : les budgets d'enveloppes servent d'estimation jusqu'à la fin du premier mois.</div>` : ''}
      <svg class="curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Solde gagné ou perdu par mois"><line x1="${L}" x2="${W - L}" y1="${y0}" y2="${y0}" stroke="var(--line)"/>${bars}</svg>
    </div>
    <div class="block"><div class="rowhead"><h2>Et si…</h2><span class="sub">simulations</span></div>
      ${sum ? (() => { const c = sum.ratio <= 0.5 ? 'good' : sum.ratio <= 0.9 ? 'warn' : 'bad';
        return `<div class="note ${c}"><b>Toutes les simulations ensemble :</b> ${sum.n} achats pour ${eur0(sum.total)}. Au plus fort, il faut mettre <b>${eur0(sum.peak)}/mois</b> de côté, soit <b>${sum.marge > 0 ? Math.round(sum.ratio * 100) + ' %' : 'plus que tout'}</b> de la marge habituelle (${eur0(sum.marge)}). Les achats sont financés par ordre de date.</div>`; })() : ''}
      ${sims.map(s => { const past = simI(s) < 0;
        if (past) return `<div class="simcard off"><div class="simhead"><div><b>${esc(s.libelle)}</b><div class="mini">${eur0(num(s.montant))} en ${mLabel(s.mois)} · date passée</div></div></div><div class="actions"><button class="btn ghost small" data-simdel="${esc(s.id)}">Retirer</button></div></div>`;
        const p = simPlan(s);
        return `<div class="simcard ${bool(s.actif) ? '' : 'off'}">
        <div class="simhead"><div><b>${esc(s.libelle)}</b><div class="mini" style="font-size:13px">${eur0(num(s.montant))} en ${mLabel(s.mois)}</div></div>
        <div style="display:flex;gap:8px;align-items:center"><span class="pill ${p.c}">${p.label}</span><input type="checkbox" aria-label="Activer la simulation" data-simtog="${esc(s.id)}" ${bool(s.actif) ? 'checked' : ''}></div></div>
        ${p.k > 0 ? `<div class="save"><strong class="num">${eur0(p.need)}</strong><span>à mettre de côté par mois, de ${MONTHS_L[pm(addM(CUR, 1)).m]} à ${MONTHS_L[pm(s.mois).m]} (${p.k} mois)</span></div>` : ''}
        <div class="note ${p.c}">${p.txt}</div>
        <div class="actions"><button class="btn ghost small" data-simdel="${esc(s.id)}">Retirer</button></div></div>`; }).join('') || `<div class="note">Teste un achat avant de le faire : il s'ajoute aux prévisions sans toucher au réel.</div>`}
      <form class="form" id="simForm" novalidate style="gap:10px">
        <div class="two"><div class="field"><label for="simL">Achat envisagé</label><input id="simL" placeholder="Ex. Week-end" autocomplete="off"></div>
        <div class="field"><label for="simA">Montant (€)</label><input id="simA" inputmode="decimal" placeholder="800" autocomplete="off"></div></div>
        <div class="two"><div class="field"><label for="simM">Mois de l'achat</label><select id="simM">${Array.from({ length: 24 }, (_, i) => { const k = addM(CUR, i); return `<option value="${k}" ${i === 3 ? 'selected' : ''}>${mLabel(k)}</option>`; }).join('')}</select></div>
        <div class="field" style="justify-content:flex-end"><button class="btn ghost" type="submit">Simuler</button></div></div>
      </form>
    </div>
    <div class="block"><div class="rowhead"><h2>Nos habitudes</h2><span class="sub">moyenne / mois</span></div>
      <div class="list">${habits.length ? habits.map(x => { const d = x.b ? x.h - x.b : null;
        return `<div class="habit"><b>${esc(x.n)}</b><span>${x.b ? 'budget ' + eur0(x.b) : 'sans enveloppe'}</span><span style="font-weight:700;color:var(--${d !== null && d > 15 ? 'bad' : d !== null && d < -15 ? 'good' : 'ink'})">${eur0(x.h)}</span></div>`; }).join('') : `<div class="empty">Les habitudes apparaîtront au fil des saisies.</div>`}</div>
      <div class="hint">Calculé sur les 3 derniers mois et le mois en cours (à partir du 10). Ça s'affine à chaque saisie.</div>
    </div>
    <div class="block"><h2>Mois par mois</h2>
      <div class="tablewrap"><table><thead><tr><th>Mois</th><th>Rentrées</th><th>Fixes</th><th>Variables</th><th>Fin</th></tr></thead><tbody>
      ${rows.map(r => { const st = status(r.end, seuil).c; return `<tr><td>${mShort(r.k)}${pm(r.k).m === 0 ? ' ' + String(pm(r.k).y).slice(2) : ''}${r.k === CUR ? ' · en cours' : ''}</td><td class="pos">${eur0(r.rev)}</td><td>${eur0(r.chg)}</td><td>${eur0(r.vari)}</td><td class="end" style="color:var(--${st === 'good' ? 'ink' : st})">${eur0(r.end)}</td></tr>`; }).join('')}
      </tbody></table></div>
    </div>
  </section>`;
}
let TAX_DELTA = 0;
function vTax() {
  const X = taxParams(), t = calcTax(X, TAX_DELTA), t0 = calcTax(X, 0), t1 = calcTax(X, TAX_DELTA + 1000);
  const p = profiles(), n1 = (p[0] || {}).nom || 'Personne 1', n2 = (p[1] || {}).nom || 'Personne 2';
  const ecart = t.prelev - t.duSal, pct = t.duSal > 0 ? Math.abs(ecart) / t.duSal : 0;
  const verdict = t.sal <= 0 ? { c: '', t: 'À compléter', m: 'Renseigne les salaires nets imposables plus bas pour lancer l\'estimation.' }
    : Math.abs(ecart) < 150 ? { c: 'good', t: 'Taux bien calé', m: `Écart d'environ ${eur0(Math.abs(ecart))} sur l'année : rien à changer.` }
    : ecart > 0 ? { c: 'warn', t: 'Prélèvement trop élevé', m: `Environ ${eur0(ecart)} de trop sur l'année, remboursés l'été suivant. ${pct > 0.10 && ecart > 200 ? 'L\'écart dépasse 10 % et 200 € : une baisse du taux est possible sur impots.gouv.fr, rubrique « Gérer mon prélèvement à la source ».' : 'L\'écart reste sous les seuils pour demander une baisse.'}` }
    : { c: 'bad', t: 'Prélèvement trop faible', m: `Il manquera environ ${eur0(-ecart)}, régularisés en fin d'année suivante. Le taux peut être augmenté librement sur impots.gouv.fr pour lisser.` };
  const maxQ = 90000, seg = IMPOT.tranches.slice(0, 4).map((tr, k) => { const lo = k ? IMPOT.tranches[k - 1][0] : 0, hi = Math.min(tr[0], maxQ); return `<i style="width:${(hi - lo) / maxQ * 100}%;background:var(--${['sunk', 'accent-soft', 'warn-soft', 'bad-soft'][k]})"></i>`; }).join('');
  const inp = (id, key, val, label, attrs) => `<div class="field"><label for="${id}">${label}</label><input id="${id}" data-tax="${key}" inputmode="decimal" value="${fr(val)}" ${attrs || ''}></div>`;
  return `<section class="view">
    <div class="hero">
      <div class="rowhead"><span class="sub">Impôt estimé du foyer</span><span class="pill ${t.tmi >= 0.30 ? 'warn' : 'good'}">Tranche ${Math.round(t.tmi * 100)} %</span></div>
      <div class="big num">${eur0(t.I)}</div>
      <div class="kv"><div><small>Revenu imposable</small><b>${eur0(t.R)}</b></div><div><small>Parts / taux moyen</small><b>${fr(t.parts)} · ${t.R > 0 ? fr((t.I / t.R * 100).toFixed(1)) : '0'} %</b></div></div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <div class="tranche">${seg}<span class="tranche-marker" style="left:calc(${Math.min(t.q, maxQ) / maxQ * 100}% - 1px)"></span></div>
        <div class="tlegend"><span>0 %</span><span>11 %</span><span>30 %</span><span>41 %</span></div>
      </div>
      <div class="note">${t.tmi < 0.45 ? `Encore <b>${eur0(t.toNext)}</b> de salaire net imposable avant la tranche à <b>${Math.round(t.nextRate * 100)} %</b>.` : 'Tranche la plus haute.'} ${t.dec > 0 ? `Décote appliquée : ${eur0(t.dec)}.` : ''} ${t.plaf ? 'Plafonnement du quotient familial appliqué.' : ''}</div>
    </div>
    <div class="block"><div class="rowhead"><h2>Prélèvement à la source</h2></div>
      <div class="hero" style="gap:12px">
        <div class="kv"><div><small>Taux actuel</small><b>${fr(X.taux)} %</b></div><div><small>Taux estimé juste</small><b>${fr(t.tauxEst.toFixed(1))} %</b></div></div>
        <div class="kv"><div><small>Prélevé sur l'année</small><b>${eur0(t.prelev)}</b></div><div><small>Impôt dû sur les salaires</small><b>${eur0(t.duSal)}</b></div></div>
        <div class="note ${verdict.c}"><b>${verdict.t}.</b> ${verdict.m}</div>
      </div></div>
    <div class="block"><div class="rowhead"><h2>Simuler un changement de revenu</h2></div>
      <div class="hero" style="gap:10px">
        <label class="daysim" for="taxdelta" style="color:var(--ink)">Prime / augmentation (${esc(n1)}) <input type="range" id="taxdelta" min="-10000" max="20000" step="500" value="${TAX_DELTA}"> <b class="num">${TAX_DELTA >= 0 ? '+' : ''}${eur0(TAX_DELTA)}</b></label>
        <div class="kv"><div><small>Impôt après changement</small><b>${eur0(t.I)}</b></div><div><small>Différence</small><b style="color:var(--${t.I > t0.I + 0.5 ? 'bad' : 'good'})">${sgn(Math.round(t.I - t0.I))}</b></div></div>
        <div class="note">Sur 1 000 € de salaire en plus, environ <b>${eur0(t1.I - t.I)}</b> partent en impôt.</div>
      </div></div>
    <div class="block"><div class="rowhead"><h2>Données du foyer</h2></div>
      <div class="form">
        <div class="seg"><button type="button" data-taxmode="commune" aria-pressed="${X.mode === 'commune'}">Déclaration commune</button><button type="button" data-taxmode="seule" aria-pressed="${X.mode === 'seule'}">Déclaration séparée</button></div>
        <div class="two">${inp('tx-s1', 'impSal1', X.sal1, 'Salaire net imposable ' + esc(n1) + ' / an')}${X.mode === 'commune' ? inp('tx-s2', 'impSal2', X.sal2, 'Salaire net imposable ' + esc(n2) + ' / an') : inp('tx-k', 'impEnfants', X.kids, 'Enfants rattachés')}</div>
        <div class="two">${X.mode === 'commune' ? inp('tx-k', 'impEnfants', X.kids, 'Enfants à charge') : ''}${inp('tx-t', 'impTaux', X.taux, 'Taux de prélèvement actuel (%)')}</div>
        <div class="two">${inp('tx-a', 'impAutres', X.autres, 'Autres revenus (micro-entreprise) / an')}
        <div class="field"><label for="tx-ab">Abattement</label><select id="tx-ab" data-tax="impAutresAb">${[71, 50, 34].map(a => `<option value="${a}" ${a === X.autresAb ? 'selected' : ''}>${a} %</option>`).join('')}</select></div></div>
      </div>
      <div class="hint">Estimation indicative : ${IMPOT.annee}, abattement de 10 % sur les salaires. Le simulateur officiel d'impots.gouv.fr fait foi. Le salaire net imposable figure sur la fiche de paie de décembre (cumul annuel).</div>
    </div>
  </section>`;
}

/* ----- Onglet Réglages ----- */
function vSet() {
  const sysDark = matchMedia('(prefers-color-scheme: dark)').matches, dark = UI.theme === 'dark' || (UI.theme === 'auto' && sysDark);
  const accBlock = A => { const k = A.id, cats = catsOf(k);
    return `<div class="hero" style="gap:12px"><div class="rowhead"><h2>${esc(A.nom)}</h2><span class="sub">${A.proprietaire ? 'privé' : DB.profils.length > 1 ? 'partagé' : ''}</span></div>
    ${isShared(k) ? `<div class="hint">Compte partagé : les changements ici s'appliquent aussi pour ${esc(otherNames())}.</div>` : ''}
    <div class="field"><label for="an-${esc(k)}">Nom du compte</label><input id="an-${esc(k)}" data-accname="${esc(k)}" value="${esc(A.nom)}"></div>
    <div class="two"><div class="field"><label for="op-${esc(k)}">Solde au 1er ${started(k) ? MONTHS_L[pm(startMonth(k)).m] : 'du mois de départ'}</label><input id="op-${esc(k)}" data-open="${esc(k)}" inputmode="decimal" value="${fr(A.soldeDepart)}" placeholder="non renseigné"></div>
    <div class="field"><label for="se-${esc(k)}">Seuil de sécurité (€)</label><input id="se-${esc(k)}" data-seuil="${esc(k)}" inputmode="decimal" value="${fr(A.seuil)}"></div></div>
    <div class="field"><label for="md-${esc(k)}">Mois de départ</label><input id="md-${esc(k)}" type="month" data-mdep="${esc(k)}" value="${esc(startMonth(k))}" max="${CUR}"></div>
    <div class="hint">Le solde de départ est le solde au 1er du mois de départ. Pour recaler en cours de mois, utilise plutôt « Corriger le solde » dans l'onglet Mois.</div>
    <div class="field"><label>Catégories de dépenses</label><div class="list">${cats.length ? cats.map(c => `<button class="item" data-editcat="${esc(c.id)}"><span class="day">${num(c.budget) ? '◔' : '·'}</span><span class="lbl"><b>${esc(c.nom)}</b><small>${num(c.budget) ? 'enveloppe mensuelle' : 'sans enveloppe'}</small></span><span class="amt">${num(c.budget) ? eur0(num(c.budget)) : ''}</span></button>`).join('') : '<div class="empty">Aucune catégorie.</div>'}</div></div>
    <button class="btn ghost small" data-newcat="${esc(k)}">＋ Ajouter une catégorie</button></div>`; };
  const syncTxt = { ok: 'Synchronisé', wait: 'Envoi en cours…', off: 'Hors ligne', err: 'Accès coupé' }[SYNC.state] || '';
  return `<section class="view">
    <div class="hero" style="gap:6px"><div class="rowhead"><h2>Apparence</h2></div>
      <label class="switch" for="th-auto"><span>Suivre le réglage du téléphone</span><input type="checkbox" id="th-auto" data-theme-auto="1" ${UI.theme === 'auto' ? 'checked' : ''}></label>
      <label class="switch" for="th-dark" style="${UI.theme === 'auto' ? 'opacity:.45' : ''}"><span>Mode sombre</span><input type="checkbox" id="th-dark" data-theme-dark="1" ${dark ? 'checked' : ''} ${UI.theme === 'auto' ? 'disabled' : ''}></label>
      <div class="hint">${UI.theme === 'auto' ? "L'appli passe en sombre quand le téléphone l'est." : 'Choix forcé, quel que soit le réglage du téléphone.'} Réglage propre à ce téléphone.</div>
    </div>
    ${accs().map(accBlock).join('')}
    ${vProfiles()}
    <div class="hero" style="gap:8px"><div class="rowhead"><h2>Synchronisation</h2><span class="pill ${SYNC.state === 'ok' ? 'good' : SYNC.state === 'err' ? 'bad' : 'warn'}">${syncTxt}</span></div>
      <div class="hint">Les saisies partent tout de suite vers le Google Sheet et l'appli se met à jour seule toutes les 30 secondes. Sans réseau, elles sont gardées et envoyées au retour de la connexion.${QUEUE.length ? ` <b>${QUEUE.length} modification(s) en attente d'envoi.</b>` : ''}</div>
      <div class="hint">Dernière synchro : ${SYNC.last ? new Date(SYNC.last).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : 'jamais'}</div>
      <button class="btn ghost small" data-syncnow="1">Synchroniser maintenant</button>
    </div>
  </section>`;
}

/* ================= Premier lancement ================= */
const CATS_PERSO = ['Courses', 'Carburant', 'Restaurants', 'Loisirs', 'Shopping', 'Santé', 'Cadeaux', 'Divers'];
const CATS_COMMUN = ['Courses', 'Maison', 'Enfants', 'Santé', 'Sorties', 'Restaurants', 'Divers'];
const catOps = (acc, list) => list.map((n, i) => upd('Categories', { id: uid(), compte: acc, nom: n, budget: '', ordre: i + 1 }));
const ONB = { step: 0, name: '', mode: '', partner: '', commun: true, busy: false };
function vOnboard() {
  const O = ONB, head = n => `<div class="steps" style="display:flex;gap:6px">${[0, 1, 2].map(i => `<i style="flex:1;height:4px;border-radius:9px;background:var(--${i <= n ? 'accent' : 'line'})"></i>`).join('')}</div>`;
  if (O.step === 0) return `<section class="view">${head(0)}<h2 style="font-size:24px">Bienvenue sur Le 31</h2><p class="hint" style="font-size:14px">L'appli qui vous dit si vous tenez jusqu'au 31. Deux questions pour commencer.</p>
    <form class="form" id="onbName" novalidate><div class="field"><label for="onbN">Ton prénom</label><input id="onbN" value="${esc(O.name)}" placeholder="Ex. Alex" autocomplete="given-name"></div><button class="btn" type="submit">Continuer</button></form></section>`;
  if (O.step === 1) return `<section class="view">${head(1)}<h2 style="font-size:24px">Tu utilises Le 31…</h2>
    <div class="two"><button class="chip" style="border-radius:16px;padding:14px;text-align:left" data-onbmode="solo" aria-pressed="${O.mode === 'solo'}"><b style="font-size:16px;display:block">Seul</b><span style="font-weight:500">Mon compte, et un compte commun si j'en ai un</span></button>
    <button class="chip" style="border-radius:16px;padding:14px;text-align:left" data-onbmode="duo" aria-pressed="${O.mode === 'duo'}"><b style="font-size:16px;display:block">À deux</b><span style="font-weight:500">Un perso chacun et un compte commun</span></button></div>
    ${O.mode === 'duo' ? `<div class="field"><label for="onbP">Prénom de ton/ta partenaire</label><input id="onbP" value="${esc(O.partner)}" placeholder="Ex. Camille" autocomplete="off"></div>
      <div class="note">Chacun aura son propre lien d'accès. ${esc(O.partner || 'Ton/ta partenaire')} verra le <b>compte commun</b> et <b>son</b> compte perso, jamais le tien.</div>` : ''}
    ${O.mode === 'solo' ? `<label class="switch" for="onbC"><span>J'ai aussi un compte commun à suivre</span><input type="checkbox" id="onbC" ${O.commun ? 'checked' : ''}></label>` : ''}
    <div class="actions"><button class="btn ghost" data-onbstep="0">Retour</button><button class="btn" data-onbstep="2">Continuer</button></div></section>`;
  const accsL = [`<b>Compte perso de ${esc(O.name)}</b> · visible seulement par toi`];
  if (O.mode === 'duo') accsL.push(`<b>Compte perso de ${esc(O.partner)}</b> · visible seulement par ${esc(O.partner)}, démarré sur son téléphone`);
  if (O.mode === 'duo' || O.commun) accsL.push(`<b>Compte commun</b> · visible par ${O.mode === 'duo' ? 'vous deux' : 'toi'}`);
  return `<section class="view">${head(2)}<h2 style="font-size:24px">Vos comptes</h2>
    <div class="list">${accsL.map(l => `<div class="item" disabled style="grid-template-columns:1fr"><span class="lbl" style="white-space:normal">${l}</span></div>`).join('')}</div>
    <div class="hint">Les noms se changent ensuite dans Réglages.${O.mode === 'duo' ? ` Tu enverras son lien à ${esc(O.partner)} depuis Réglages > Profils.` : ''}</div>
    <div class="actions"><button class="btn ghost" data-onbstep="1">Retour</button><button class="btn" data-onbdone="1" ${O.busy ? 'disabled' : ''}>${O.busy ? 'Création…' : 'Créer mes comptes'}</button></div></section>`;
}
async function finishOnboard() {
  const O = ONB; if (O.busy) return;
  const p1 = 'p' + uid(), ops = [upd('Profils', { id: p1, nom: O.name, perso: 'oui', ordre: 1 })];
  ops.push(upd('Comptes', { id: 'perso-' + p1, nom: 'Perso ' + O.name, proprietaire: p1, soldeDepart: '', moisDepart: '', seuil: 200, ordre: 1 }), ...catOps('perso-' + p1, CATS_PERSO));
  if (O.mode === 'duo') ops.push(upd('Profils', { id: 'p' + uid(), nom: O.partner, perso: 'oui', ordre: 2 }));
  if (O.mode === 'duo' || O.commun) ops.push(upd('Comptes', { id: 'commun', nom: 'Compte commun', proprietaire: '', soldeDepart: '', moisDepart: '', seuil: 150, ordre: 2 }), ...catOps('commun', CATS_COMMUN));
  if (O.mode === 'solo') ops.push(upd('Parametres', { cle: 'impMode', valeur: 'seule' }));
  O.busy = true; render();
  try { const j = await api({ action: 'ops', ops: clean(ops), associer: p1 }); UI.acc = 'perso-' + p1; received(j.data, j.moi); toast('Comptes créés'); }
  catch (e) { toast(e instanceof TypeError ? 'Connexion nécessaire pour créer les comptes' : 'Erreur : ' + e.message); }
  O.busy = false; render();
}
// La personne invitée crée son compte perso à sa première ouverture
function ensurePerso() {
  if (!ME) return;
  const p = DB.profils.find(x => x.id === ME);
  if (!p || p.perso !== 'oui' || DB.comptes.some(c => c.proprietaire === ME)) return;
  const id = 'perso-' + ME;
  UI.acc = id;
  commit([upd('Comptes', { id, nom: 'Perso ' + p.nom, proprietaire: ME, soldeDepart: '', moisDepart: '', seuil: 200, ordre: 1 }), ...catOps(id, CATS_PERSO)]);
}

/* ================= Import de relevé (CSV / OFX) ================= */
const NORM = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const STOP = new Set('PRLV PRELEVEMENT PRELEV SEPA CB CARTE PAIEMENT PAIE VIR VIREMENT VIRT INST INSTANTANE RECU RECUE EMIS EMISE DE DU DES LA LE LES ET FACT FACTURE ECH REF MANDAT ICS RUM NUM NO PAR POUR SUR AVEC EN AU AUX FR EUR WWW COM SA SAS SARL MOTIF VERS BENEF BENEFICIAIRE ORDRE EMETTEUR'.split(' '));
function motifOf(lib) {
  const w = NORM(lib).replace(/\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?/g, ' ').replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(x => x.length > 1 && !STOP.has(x));
  return w.slice(0, 3).join(' ') || NORM(lib).replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 24);
}
const pretty = m => m.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
const AUTO = [
  [/SALAIRE|REMUNERATION|POLE EMPLOI|FRANCE TRAVAIL|\bCAF\b|ALLOCATION|PENSION|RETRAITE/, 'Revenus'],
  [/DGFIP|IMPOT|TRESOR PUBLIC|FINANCES PUBLIQUES/, 'Impôts'],
  [/\bPRET\b|CREDIT|COFIDIS|CETELEM|SOFINCO|FRANFINANCE|ONEY/, 'Crédits'],
  [/MUTUELLE|ASSUR|MAAF|MACIF|MATMUT|\bAXA\b|ALLIANZ|\bGMF\b|\bMAIF\b|GROUPAMA|HARMONIE|MGEN|GENERALI/, 'Assurances'],
  [/\bEDF\b|ENGIE|TOTALENERGIES ELEC|VEOLIA|\bSAUR\b|SUEZ|\bEAU\b|GRDF|ENERCOOP|EKWATEUR/, 'Énergie'],
  [/FREE MOBILE|FREE TELECOM|\bFREE\b|ORANGE|\bSFR\b|BOUYGUES|\bSOSH\b|RED BY/, 'Abonnements'],
  [/NETFLIX|SPOTIFY|DEEZER|DISNEY|CANAL|AMAZON PRIME|APPLE\.COM|ITUNES|GOOGLE PLAY|YOUTUBE/, 'Loisirs'],
  [/CARREFOUR|LECLERC|AUCHAN|INTERMARCHE|\bLIDL\b|\bALDI\b|SUPER U|HYPER U|\bU EXPRESS|CASINO|FRANPRIX|MONOPRIX|NETTO|GRAND FRAIS|PICARD|\bSPAR\b|PROXI|\bCORA\b|BIOCOOP|MARCHE/, 'Courses'],
  [/TOTAL|ESSO|SHELL|\bBP\b|\bAVIA\b|STATION|CARBU|DYNEFF|\bAGIP\b|AS24/, 'Carburant'],
  [/RESTAU|MC ?DONALD|MCDO|BURGER|\bKFC\b|DELIVEROO|UBER ?EATS|PIZZ|BRASSERIE|\bCAFE\b|BOULANG|SUSHI|KEBAB|STARBUCKS|PAUL\b/, 'Restaurants'],
  [/PHARMA|DOCTEUR|\bDR\b|MEDEC|CPAM|AMELI|DENTIST|OPTIC|LABO|KINE|HOPITAL|CLINIQUE/, 'Santé'],
  [/AMAZON|FNAC|DARTY|ZALANDO|VINTED|DECATHLON|KIABI|ACTION|CDISCOUNT|SHEIN|LEBONCOIN|ZARA|H ?& ?M|PRIMARK/, 'Shopping'],
  [/LEROY|CASTORAMA|BRICO|WELDOM|JARDILAND|\bIKEA\b|BOULANGER|CONFORAMA|BUT\b/, 'Maison'],
  [/CINEMA|\bCINE\b|STEAM|PLAYSTATION|XBOX|NINTENDO|BOWLING|PARC|MUSEE|CONCERT|TICKETMASTER/, 'Loisirs'],
  [/RETRAIT|\bDAB\b|\bGAB\b/, 'Retraits']
];
function guessCat(lib) {
  const m = motifOf(lib), N = NORM(lib);
  const r = DB.regles.find(x => x.motif === m); if (r) return r.categorie;
  for (const [re, c] of AUTO) if (re.test(N)) return c;
  return '';
}
function parseAmount(v) {
  let s = String(v == null ? '' : v).replace(/[ \s€]|EUR/gi, '').replace(/^\+/, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s); return neg ? -Math.abs(n) : n;
}
function parseDate(v) {
  const s = String(v || '').trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/.exec(s);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; if (+m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return `${y}-${pad(+m[2])}-${pad(+m[1])}`; }
  return null;
}
function parseOFX(t) {
  const tx = [];
  t.split(/<STMTTRN>/i).slice(1).forEach(b => {
    const g = tag => { const m = new RegExp('<' + tag + '>([^<\\r\\n]*)', 'i').exec(b); return m ? m[1].trim() : ''; };
    const d = parseDate(g('DTPOSTED').slice(0, 8)), a = parseAmount(g('TRNAMT'));
    if (d && a !== null) tx.push({ date: d, montant: a, libelle: [g('NAME'), g('MEMO')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() });
  });
  const lb = /<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]+)[\s\S]*?<DTASOF>(\d{8})/i.exec(t);
  return { tx, solde: lb && parseAmount(lb[1]) !== null ? { montant: parseAmount(lb[1]), date: parseDate(lb[2]) } : null, format: 'OFX' };
}
function parseCSV(t) {
  const lines = t.split(/\r?\n/).filter(l => l.trim());
  const sep = [';', '\t', ',', '|'].map(c => [c, lines.slice(0, 40).reduce((a, l) => a + (l.split(c).length - 1), 0)]).sort((a, b) => b[1] - a[1])[0][0];
  const split = l => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; continue; } if (ch === sep && !q) { out.push(cur); cur = ''; continue; } cur += ch; } out.push(cur); return out.map(x => x.trim()); };
  const rows = lines.map(split);
  const find = (h, re, not) => h.findIndex(x => re.test(x) && !(not && not.test(x)));
  let hi = -1, c = {};
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const h = rows[i].map(NORM);
    const date = (() => { let k = find(h, /DATE.*(OPE|COMPTA)/); if (k < 0) k = find(h, /^DATE|DATE$|^JOUR/, /VALEUR/); return k; })();
    const montant = find(h, /^MONTANT|AMOUNT|^SOMME/), debit = find(h, /DEBIT/), credit = find(h, /CREDIT/);
    if (date >= 0 && (montant >= 0 || debit >= 0 || credit >= 0)) {
      c = { date, montant, debit, credit, solde: find(h, /SOLDE|BALANCE/), lib: find(h, /LIBELLE|DESCRIPTION|INTITULE|DETAIL|LABEL|NATURE|OPERATION|BENEFICIAIRE/, /DATE|MONTANT|TYPE/) };
      hi = i; break;
    }
  }
  if (hi < 0) { // sans en-tête : on devine
    const sample = rows.slice(0, 20);
    const nc = Math.max(...sample.map(r => r.length));
    const score = (k, f) => sample.filter(r => f(r[k])).length;
    const cols = Array.from({ length: nc }, (_, k) => k);
    c.date = cols.find(k => score(k, parseDate) > sample.length * 0.6);
    const numc = cols.filter(k => k !== c.date && score(k, v => parseAmount(v) !== null && /\d/.test(v || '')) > sample.length * 0.5);
    if (c.date === undefined || !numc.length) throw new Error('Colonnes non reconnues');
    c.montant = numc[0]; c.debit = -1; c.credit = -1; c.solde = numc.length > 1 ? numc[numc.length - 1] : -1;
    c.lib = cols.filter(k => k !== c.date && !numc.includes(k)).sort((a, b) => score(b, v => (v || '').length > 6) - score(a, v => (v || '').length > 6))[0];
  }
  const tx = []; let soldeRow = null;
  rows.slice(hi + 1).forEach(r => {
    const d = parseDate(r[c.date]); if (!d) return;
    let a = c.montant >= 0 ? parseAmount(r[c.montant]) : null;
    if (a === null) { const de = c.debit >= 0 ? parseAmount(r[c.debit]) : null, cr = c.credit >= 0 ? parseAmount(r[c.credit]) : null; if (de === null && cr === null) return; a = (cr ? Math.abs(cr) : 0) - (de ? Math.abs(de) : 0); }
    const t2 = { date: d, montant: a, libelle: (c.lib >= 0 ? r[c.lib] : '') || r.filter((x, k) => k !== c.date && parseAmount(x) === null).join(' ') };
    tx.push(t2);
    if (c.solde >= 0) { const sv = parseAmount(r[c.solde]); if (sv !== null && (!soldeRow || d >= soldeRow.date)) soldeRow = { montant: sv, date: d }; }
  });
  if (!soldeRow) { // « Solde au 25/10/2026 : 1 482,25 » dans l'en-tête
    for (const l of lines.slice(0, Math.max(hi, 0) + 1)) { const m = /SOLDE[^0-9-]*(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})?[^0-9-]*(-?[\d\s.,]+\d)/i.exec(NORM(l)); if (m && parseAmount(m[2]) !== null) { soldeRow = { montant: parseAmount(m[2]), date: parseDate(m[1]) }; break; } }
  }
  return { tx, solde: soldeRow, format: 'CSV' };
}
function readImportFile(file) {
  return file.arrayBuffer().then(buf => {
    let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { t = new TextDecoder('windows-1252').decode(buf); }
    t = t.replace(/^﻿/, '');
    const p = /<OFX>|OFXHEADER|<STMTTRN>/i.test(t) ? parseOFX(t) : parseCSV(t);
    if (!p.tx.length) throw new Error('Aucune opération trouvée dans ce fichier');
    return p;
  });
}
const refOf = t => t.date + '|' + r2(t.montant) + '|' + motifOf(t.libelle);
function matchFixed(t, acc, used) {
  const k = t.date.slice(0, 7), d = +t.date.slice(8, 10), a = Math.abs(t.montant), neg = t.montant < 0;
  const near = (m, j) => Math.abs((num(m) || 0) - a) <= Math.max(0.15 * (num(m) || 0), 5) && Math.abs((num(j) || 1) - d) <= 4;
  const free = key => !used.has(k + '|' + key);
  const f = DB.fixes.find(f => f.compte === acc && occursF(f, k) && (f.sens === '+') !== neg && free('f' + f.id) && (f.motif ? f.motif === t.motif : near(f.montant, f.jour)));
  if (f) return 'f' + f.id;
  const v = DB.virements.find(v => occursV(v, k) && ((v.de === acc && neg) || (v.vers === acc && !neg)) && free('v' + v.id) && (v.motif && v.de === acc ? v.motif === t.motif : near(v.montant, v.jour)));
  return v ? 'v' + v.id : null;
}
function detectRecurring(tx, acc) {
  const months = [...new Set(tx.map(t => t.date.slice(0, 7)))], span = months.length;
  if (span < 2) return [];
  const groups = {};
  tx.forEach(t => { const k = (t.montant < 0 ? '-' : '+') + t.motif; (groups[k] = groups[k] || []).push(t); });
  const commun = accOf(acc).proprietaire ? accs().find(a => !a.proprietaire) : null;
  const out = [];
  Object.values(groups).forEach(g => {
    const ms = new Set(g.map(t => t.date.slice(0, 7)));
    if (ms.size < 2 || ms.size < Math.ceil(span * 0.6) || g.length > ms.size * 1.5) return;
    const amts = g.map(t => Math.abs(t.montant)).sort((a, b) => a - b), med = amts[Math.floor(amts.length / 2)];
    if (amts[amts.length - 1] - amts[0] > Math.max(0.3 * med, 15)) return;
    // paiement par carte : seulement si le montant est identique chaque mois (abonnement), sinon ce sont des achats
    if (/^\s*(CB|CARTE|PAIEMENT CB|PAIEMENT PAR CARTE)\b/.test(NORM(g[0].libelle)) && amts[amts.length - 1] - amts[0] > 1) return;
    const days = g.map(t => +t.date.slice(8, 10)).sort((a, b) => a - b);
    if (days[days.length - 1] - days[0] > 8) return;
    const neg = g[0].montant < 0, last = g[g.length - 1];
    const N0 = NORM(g[0].libelle), nom = /SALAIRE|REMUNERATION/.test(N0) ? 'Salaire' : /\bLOYER\b/.test(N0) ? 'Loyer' : pretty(g[0].motif);
    out.push({ id: 'r' + out.length, motif: g[0].motif, nom, montant: r2(Math.abs(last.montant)), sens: neg ? '-' : '+', jour: days[Math.floor(days.length / 2)],
      cat: guessCat(g[0].libelle) || (neg ? 'Autre' : 'Revenus'), variable: amts[amts.length - 1] - amts[0] > 2 ? [amts[0], amts[amts.length - 1]] : null,
      txs: g, months: ms.size, span, lib: g[0].libelle, vir: neg && /\bVIR/.test(NORM(g[0].libelle)) && commun ? commun.id : null });
  });
  return out.sort((a, b) => a.jour - b.jour);
}
let IMP = null;
function startImport(parsed) {
  const acc = UI.acc, first = !started(acc), used = new Set();
  const tx = parsed.tx.slice().sort((a, b) => a.date.localeCompare(b.date));
  const seen = {};
  tx.forEach(t => { t.motif = motifOf(t.libelle); t.ref = refOf(t); seen[t.ref] = (seen[t.ref] || 0) + 1; if (seen[t.ref] > 1) t.ref += '#' + seen[t.ref]; });
  const I = { acc, first, parsed, tx, recur: [], keep: {}, virOn: {}, ucat: {}, solde: parsed.solde, recal: true };
  if (first) {
    const m0 = tx[0].date.slice(0, 7), mL = tx[tx.length - 1].date.slice(0, 7);
    I.mois = +tx[0].date.slice(8, 10) <= 3 || m0 === mL ? m0 : addM(m0, 1);
  } else I.mois = startMonth(acc);
  I.kept = tx.filter(t => t.date.slice(0, 7) >= I.mois && t.date <= TODAY_ISO.slice(0, 7) + '-31');
  // déjà connus : prélèvements fixes / virements liés, opérations déjà importées ou saisies à la main
  const refs = new Set(DB.operations.filter(o => o.compte === acc && o.ref).map(o => o.ref));
  const manual = DB.operations.filter(o => o.compte === acc && !o.ref && o.type !== 'ajust');
  I.kept.forEach(t => {
    if (refs.has(t.ref)) { t.dup = true; return; }
    const m = matchFixed(t, acc, used);
    if (m) { used.add(t.date.slice(0, 7) + '|' + m); if (point(t.date.slice(0, 7), m)) t.dup = true; else t.match = m; return; } // déjà pointé = déjà compté
    const mo = manual.find(o => Math.abs((num(o.montant) || 0) - t.montant) < 0.01 && Math.abs(new Date(o.date) - new Date(t.date)) <= 4 * 864e5);
    if (mo) { t.same = mo.id; manual.splice(manual.indexOf(mo), 1); }
  });
  if (first) { I.recur = detectRecurring(tx.filter(t => !t.match), acc); I.recur.forEach(r => { I.keep[r.id] = true; if (r.vir) I.virOn[r.id] = true; }); }
  I.step = first ? (I.recur.length ? 'recur' : 'classify') : 'classify';
  IMP = I; UI.imp = 'go'; render(); scrollTo(0, 0);
}
// opérations à créer (hors prélèvements reconnus) avec leur catégorie
function impRest(I) {
  const inRecur = new Set(); if (I.first) I.recur.filter(r => I.keep[r.id]).forEach(r => r.txs.forEach(t => inRecur.add(t)));
  return I.kept.filter(t => !t.dup && !t.match && !t.same && !inRecur.has(t)).map(t => { t.cat = I.ucat[t.motif] || guessCat(t.libelle) || (t.montant > 0 ? 'Revenus' : ''); return t; });
}
function vImport() {
  const I = IMP, A = accOf(I.acc), nRec = I.recur.filter(r => I.keep[r.id]).length;
  const close = `<button class="btn ghost small" data-impclose="1">Annuler</button>`;
  const top = (t, sub) => `<div class="rowhead"><h2 style="font-size:20px">${t}</h2>${close}</div>${sub ? `<p class="hint" style="font-size:14px;margin:0">${sub}</p>` : ''}`;
  const span = `${I.parsed.format} · ${I.tx.length} opérations · du ${I.tx[0].date.split('-').reverse().join('/')} au ${I.tx[I.tx.length - 1].date.split('-').reverse().join('/')}`;
  if (I.step === 'recur') return `<section class="view">${top(`${I.recur.length} prélèvement${I.recur.length > 1 ? 's' : ''} régulier${I.recur.length > 1 ? 's' : ''} trouvé${I.recur.length > 1 ? 's' : ''}`, `${span}. Coche ceux à ajouter en charges fixes, renomme-les si besoin.`)}
    <div class="list">${I.recur.map(r => `<div class="recon" style="grid-template-columns:24px 1fr auto;align-items:start;${I.keep[r.id] ? '' : 'opacity:.5'}">
      <input type="checkbox" data-rkeep="${r.id}" ${I.keep[r.id] ? 'checked' : ''} aria-label="Ajouter" style="margin-top:8px">
      <span class="lbl" style="display:flex;flex-direction:column;gap:3px"><input data-rname="${r.id}" value="${esc(r.nom)}" style="text-align:left;font-weight:600;padding:5px 8px" aria-label="Nom">
        <small>le ${r.jour} · ${esc(r.cat)} · ${r.months}/${r.span} mois${r.variable ? ` · <span style="color:var(--warn)">variable ${eur0(r.variable[0])} à ${eur0(r.variable[1])}</span>` : ''}</small>
        <small style="font-family:var(--f-mono);font-size:11px">${esc(r.lib.slice(0, 40))}</small>
        ${r.vir ? `<label class="mini" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-rvir="${r.id}" ${I.virOn[r.id] ? 'checked' : ''} style="width:18px;height:18px"> Virement lié vers ${esc(accName(r.vir))}</label>` : ''}</span>
      <span class="amt ${r.sens === '+' ? 'pos' : 'neg'}" style="padding-top:6px">${r.sens === '+' ? '+' : '−'}${eur(r.montant)}</span></div>`).join('')}</div>
    ${I.recur.some(r => r.vir) ? `<div class="note">Un <b>virement lié</b> apparaît aussi sur le compte commun : inutile de l'ajouter une deuxième fois en important le relevé du commun.</div>` : ''}
    <button class="btn" data-impstep="classify">Ajouter ${nRec} charge${nRec > 1 ? 's' : ''} et continuer</button></section>`;
  if (I.step === 'classify') {
    const rest = impRest(I), months = Math.max(1, new Set(rest.map(t => t.date.slice(0, 7))).size);
    const unk = {}; rest.filter(t => !t.cat).forEach(t => { (unk[t.motif] = unk[t.motif] || { n: 0, tot: 0, lib: t.libelle }); unk[t.motif].n++; unk[t.motif].tot += t.montant; });
    const unkL = Object.entries(unk).sort((a, b) => a[1].tot - b[1].tot).slice(0, 15);
    const byCat = {}; rest.filter(t => t.cat && t.montant < 0).forEach(t => { byCat[t.cat] = (byCat[t.cat] || 0) - t.montant; });
    const cats = catsOf(I.acc).map(c => c.nom), known = I.kept.filter(t => t.dup || t.same).length, pts = I.kept.filter(t => t.match).length;
    return `<section class="view">${top(I.first ? 'Dépenses du quotidien' : 'Nouveau relevé', I.first ? `${rest.length} opérations classées d'après leur libellé. Moyenne par mois :` : span)}
      ${!I.first ? `<div class="kv"><div><small>Nouvelles opérations</small><b>${rest.length}</b></div><div><small>Prélèvements pointés</small><b>${pts}</b></div></div>${known ? `<div class="hint">${known} opération(s) déjà présente(s) ignorée(s) : pas de doublon.</div>` : ''}` : ''}
      <div class="list">${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `<div class="habit"><b>${esc(c)}</b><span>${cats.includes(c) ? '' : 'nouvelle catégorie'}</span><span style="font-weight:700">${eur0(v / months)}${I.first ? '<small class="mini"> / mois</small>' : ''}</span></div>`).join('') || '<div class="empty">Rien à classer automatiquement.</div>'}</div>
      ${unkL.length ? `<h2>${unkL.length} libellé${unkL.length > 1 ? 's' : ''} à classer</h2>
      <div class="list">${unkL.map(([m, u]) => `<div class="env"><div class="t"><b style="font-size:13px">${esc(u.lib.slice(0, 34))}</b><span>${u.n} × · ${eur(u.tot)}</span></div><div class="chips">${cats.map(c => `<button type="button" class="chip" style="padding:4px 10px;font-size:12px" data-ucat="${esc(m)}" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div></div>`).join('')}</div>
      <div class="hint">Le 31 retient tes choix pour les prochains imports. Ce qui reste non classé va dans « Divers ».</div>` : ''}
      ${!I.first && I.solde ? (() => { const d = soldeDelta(I); return Math.abs(d.delta) >= 1 ? `<label class="switch" for="recal"><span>Recaler le solde sur le relevé (${eur(I.solde.montant)} au ${I.solde.date.split('-').reverse().join('/')}, écart ${sgn(r2(d.delta))})</span><input type="checkbox" id="recal" data-recal="1" ${I.recal ? 'checked' : ''}></label>` : ''; })() : ''}
      <button class="btn" data-impstep="${I.first ? 'solde' : 'go'}">${I.first ? 'Continuer' : 'Importer'}</button></section>`;
  }
  if (I.step === 'solde') return `<section class="view">${top('Solde du compte', '')}
    ${I.solde ? `<div class="hero"><span class="sub">Solde lu dans le relevé au ${I.solde.date.split('-').reverse().join('/')}</span><div class="big num">${eur(I.solde.montant)}</div>
      <div class="hint">Si ce n'est pas le bon, corrige-le :</div><div class="amountbox"><input id="impSolde" inputmode="decimal" value="${fr(I.solde.montant)}" aria-label="Solde"><span>€</span></div></div>`
    : `<div class="hero"><div class="hint" style="font-size:14px">Le fichier n'indique pas le solde. Indique le solde affiché par la banque à la date de la dernière opération du relevé (${I.tx[I.tx.length - 1].date.split('-').reverse().join('/')}).</div><div class="amountbox"><input id="impSolde" inputmode="decimal" placeholder="0,00" aria-label="Solde"><span>€</span></div></div>`}
    <div class="note">Le 31 démarre le compte au <b>1er ${mLabel(I.mois)}</b>, recalcule chaque mois passé et les clôture automatiquement.</div>
    <button class="btn" data-impstep="go">Créer le compte</button></section>`;
  const R = I.result || {};
  return `<section class="view"><h2 style="font-size:22px">${I.first ? 'Compte prêt' : 'Relevé importé'}</h2>
    <div class="hero"><div class="kv"><div><small>Opérations ajoutées</small><b>${R.ops || 0}</b></div><div><small>${I.first ? 'Charges fixes créées' : 'Prélèvements pointés'}</small><b>${I.first ? R.fixes || 0 : R.pts || 0}</b></div></div>
    ${I.first ? `<div class="note good">Les habitudes de dépenses sont calculées dès maintenant${R.clos ? ` et ${R.clos} mois passé${R.clos > 1 ? 's sont clôturés' : ' est clôturé'}` : ''}.</div>` : ''}
    ${R.recal ? `<div class="note">Solde recalé de ${sgn(R.recal)}.</div>` : ''}
    <div class="hint">Pour la suite : importe un nouveau relevé quand tu veux (bouton « Importer un relevé » dans l'onglet Mois). Les doublons sont ignorés et les prélèvements se pointent tout seuls.</div></div>
    <button class="btn" data-impclose="1">Voir le mois</button></section>`;
}
// écart entre le solde calculé par l'appli et le solde du relevé
function soldeDelta(I) {
  const d = I.solde.date, k = d.slice(0, 7);
  if (k < startMonth(I.acc) || k > CUR) return { delta: 0 };
  const r = calc(I.acc, k, startOf(I.acc, k)), day = Math.min(+d.slice(8, 10), r.D);
  // opérations de ce relevé pas encore présentes
  const rest = impRest(I).filter(t => t.date <= d).reduce((a, t) => a + t.montant, 0);
  const ptsDiff = I.kept.filter(t => t.match && t.date <= d).reduce((a, t) => { const ev = r.ev.find(e => e.key === t.match); return a + (ev && ev.d <= day ? t.montant - ev.v : 0); }, 0);
  return { delta: I.solde.montant - (r.curve[day - 1] + rest + ptsDiff) };
}
function commitImport() {
  const I = IMP, acc = I.acc, ops = [], pts = {}, res = { ops: 0, fixes: 0, pts: 0, clos: 0 };
  const addPt = (t, cle) => { const k = t.date.slice(0, 7), id = k + '|' + cle; if (!pts[id]) pts[id] = { id, compte: acc, mois: k, cle, montantReel: 0 }; pts[id].montantReel = r2(pts[id].montantReel + Math.abs(t.montant)); };
  I.kept.filter(t => t.match).forEach(t => addPt(t, t.match));
  I.kept.filter(t => t.same).forEach(t => ops.push(upd('Operations', { id: t.same, ref: t.ref })));
  if (I.first) I.recur.filter(r => I.keep[r.id]).forEach(r => {
    const id = uid(), inK = r.txs.filter(t => t.date.slice(0, 7) >= I.mois);
    if (r.vir && I.virOn[r.id]) { ops.push(upd('Virements', { id, de: acc, vers: r.vir, libelle: r.nom, montant: r.montant, jour: r.jour, profil: ME, debut: I.mois, fin: '', actif: 'oui', motif: r.motif })); inK.forEach(t => addPt(t, 'v' + id)); }
    else { ops.push(upd('Fixes', { id, compte: acc, libelle: r.nom, montant: r.montant, sens: r.sens, jour: r.jour, frequence: 'M', moisRef: '', categorie: r.cat, debut: I.mois, fin: '', actif: 'oui', motif: r.motif })); inK.forEach(t => addPt(t, 'f' + id)); }
    res.fixes++;
  });
  const rest = impRest(I), have = new Set(catsOf(acc).map(c => c.nom.toLowerCase()));
  let ordre = Math.max(0, ...DB.categories.map(c => num(c.ordre) || 0));
  rest.forEach(t => {
    const cat = t.cat || (t.montant < 0 ? 'Divers' : 'Revenus');
    if (!have.has(cat.toLowerCase())) { have.add(cat.toLowerCase()); ops.push(upd('Categories', { id: uid(), compte: acc, nom: cat, budget: '', ordre: ++ordre })); }
    ops.push(upd('Operations', { id: uid(), compte: acc, date: t.date, montant: r2(t.montant), categorie: cat, libelle: t.libelle.slice(0, 80), profil: ME, type: 'ponct', lien: '', ref: t.ref }));
    res.ops++;
  });
  Object.entries(I.ucat).forEach(([m, c]) => { const ex = DB.regles.find(x => x.motif === m); ops.push(upd('Regles', { id: ex ? ex.id : uid(), motif: m, categorie: c })); });
  Object.values(pts).forEach(p => ops.push(upd('Pointages', p)));
  res.pts = Object.keys(pts).length;
  if (I.first) {
    const sIn = num(($('impSolde') || {}).value);
    const S = sIn !== null ? sIn : I.solde ? I.solde.montant : 0, D = I.solde && sIn === I.solde.montant ? I.solde.date : I.tx[I.tx.length - 1].date;
    const M = I.kept.filter(t => t.date <= D).reduce((a, t) => a + t.montant, 0), s0 = r2(S - M);
    ops.push(upd('Comptes', { id: acc, soldeDepart: s0, moisDepart: I.mois }));
    const lastM = I.kept.length ? I.kept[I.kept.length - 1].date.slice(0, 7) : I.mois;
    for (let k = I.mois; k < lastM && k < CUR; k = addM(k, 1)) {
      const end = k + '-31', bal = s0 + I.kept.filter(t => t.date <= end).reduce((a, t) => a + t.montant, 0);
      ops.push(upd('Clotures', { id: acc + '|' + k, compte: acc, mois: k, soldeFin: r2(bal), dateCloture: TODAY_ISO })); res.clos++;
    }
  }
  const recal = !I.first && I.solde && I.recal ? r2(soldeDelta(I).delta) : 0;
  commit(ops);
  if (Math.abs(recal) >= 1) { commit([upd('Operations', { id: uid(), compte: acc, date: I.solde.date, montant: recal, categorie: 'Correction de solde', libelle: 'Correction (relevé importé)', profil: ME, type: 'ajust', lien: '', ref: '' })]); res.recal = recal; }
  I.result = res; I.step = 'done'; render(); scrollTo(0, 0);
}


/* ----- Profils et accès ----- */
const fmtD = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }); };
function vProfiles() {
  const myAcc = store.get('le31-acces', '');
  const rows = profiles().map(p => {
    const me = p.id === ME, devs = DB.appareils.filter(a => a.profil === p.id && a.actif === 'oui'), wait = DB.attente.some(a => a.profil === p.id);
    const sees = 'Voit : ' + [accs().some(a => !a.proprietaire) || DB.comptes.some(a => !a.proprietaire) ? 'le compte commun' : '', p.perso === 'oui' ? 'son compte perso' : ''].filter(Boolean).join(' + ');
    return `<div class="env" style="gap:8px">
      <div class="inline"><input id="pf-${esc(p.id)}" data-prof="${esc(p.id)}" value="${esc(p.nom)}" aria-label="Prénom" style="border:1px solid var(--line);background:var(--surface);border-radius:10px;padding:8px 10px;font-weight:600;min-width:0">${me ? '<span class="tag">toi</span>' : ''}</div>
      <div class="mini">${esc(sees)}</div>
      ${devs.map(d => `<div class="inline" style="justify-content:space-between;font-size:13px"><span>📱 ${esc(d.appareil)} · depuis le ${fmtD(d.cree)}${d.vu ? ' · vu le ' + fmtD(d.vu) : ''}${d.id === myAcc ? ' · <b>cet appareil</b>' : ''}</span>${d.id === myAcc ? '' : `<button class="btn danger small" data-cut="${esc(d.id)}" data-cutname="${esc(p.nom)}">Couper</button>`}</div>`).join('') || `<div class="mini">${wait ? 'Lien envoyé, pas encore utilisé.' : 'Aucun appareil connecté.'}</div>`}
      ${devs.length && wait ? '<div class="mini">Un nouveau lien est en attente d\'utilisation.</div>' : ''}
      <div class="actions"><button class="btn ghost small" data-invite="${esc(p.id)}">${me ? 'Lien pour un autre appareil' : 'Envoyer son lien'}</button>${!me && devs.length ? `<button class="btn danger small" data-cutall="${esc(p.id)}" data-cutname="${esc(p.nom)}">Couper tous ses accès</button>` : ''}</div>
    </div>`;
  }).join('');
  return `<div class="hero" style="gap:12px"><div class="rowhead"><h2>Profils et accès</h2></div>
    <div class="list">${rows}</div>
    <form class="form" id="profForm" novalidate style="gap:8px"><div class="field"><label for="pfnew">Ajouter une personne</label><input id="pfnew" placeholder="Prénom" autocomplete="off"></div>
      <label class="switch" for="pfperso"><span>Lui créer un compte perso</span><input type="checkbox" id="pfperso" checked></label>
      <button class="btn ghost small" type="submit">Ajouter et envoyer son lien</button></form>
    <div class="hint">Chacun a son propre lien, qui ne marche qu'une fois, sur un seul appareil. Chacun voit le compte commun et son compte perso, jamais celui de l'autre. Téléphone perdu : l'autre personne coupe son accès ici, puis lui renvoie un lien. En dernier recours : menu « Le 31 » du Google Sheet. Le propriétaire du Google Sheet peut techniquement tout voir dans le Sheet.</div>
  </div>`;
}
async function invite(pid) {
  const p = DB.profils.find(x => x.id === pid); if (!p) return;
  try {
    const j = await api({ action: 'inviter', profil: pid });
    const link = location.origin + location.pathname + '#inv=' + j.code + '&api=' + encodeURIComponent(API());
    received(j.data, j.moi);
    const me = pid === ME;
    const msg = me ? `Mon accès à *Le 31* pour un autre appareil :\n${link}` : `Salut ${p.nom} 👋\nVoici ton accès à *Le 31*, notre appli de budget.\nOuvre ce lien sur ton téléphone puis appuie sur _Installer_ (iPhone : Partager > Sur l'écran d'accueil) :\n${link}\n_Ce lien est personnel et ne marche qu'une fois._`;
    openSheet(`<div class="form"><h2>${me ? 'Lien pour un autre appareil' : 'Envoyer son lien à ' + esc(p.nom)}</h2>
      <textarea id="shareTxt" readonly style="width:100%;min-height:150px;border:1px solid var(--line);background:var(--surface);border-radius:12px;padding:10px;font:inherit;font-size:14px">${esc(msg)}</textarea>
      <div class="note warn">Ce lien ouvre le compte commun${p.perso === 'oui' ? ' et le compte perso de ' + esc(p.nom) : ''}. ${me ? 'Garde-le pour toi.' : 'Envoie-le seulement à ' + esc(p.nom) + '.'} Il ne marche qu'une fois, pendant 14 jours.</div>
      <div class="actions"><button class="btn ghost" data-copyshare="1">Copier</button><button class="btn" data-doshare="1">Partager…</button></div></div>`);
  } catch (e) { toast(e instanceof TypeError ? 'Connexion nécessaire pour créer un lien' : 'Erreur : ' + e.message); }
}
async function cutAccess(body, label) {
  try { const j = await api(Object.assign({ action: 'couper' }, body)); received(j.data, j.moi); closeSheet(); toast(label); render(); }
  catch (e) { toast(e instanceof TypeError ? 'Connexion nécessaire' : 'Erreur : ' + e.message); }
}

/* ================= Feuilles (fenêtres) ================= */
const sheetRoot = $('sheetRoot');
function openSheet(html) { sheetRoot.innerHTML = `<div class="sheet-bg" data-closebg="1"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`; const f = sheetRoot.querySelector('input:not([type=checkbox]),select'); if (f && !f.value && f.id !== 'fF') setTimeout(() => f.focus(), 50); }
function closeSheet() { sheetRoot.innerHTML = ''; }
function monthOpts(sel, from, n) { return Array.from({ length: n }, (_, i) => { const k = addM(from, i); return `<option value="${k}" ${k === sel ? 'selected' : ''}>${mLabel(k)}</option>`; }).join(''); }
function fixedSheet(f, kind) {
  const isNew = !f, acc = UI.acc, oth = otherAcc(acc);
  kind = kind || 'fix';
  if (kind === 'vir') f = f || { id: '', libelle: 'Apport au ' + accName(oth), montant: '', jour: '1', de: acc, vers: oth, profil: (profiles()[0] || {}).id, debut: CUR, fin: '', actif: 'oui' };
  else f = f || { id: '', libelle: '', montant: '', sens: sheetRoot.dataset.sens || '-', jour: '1', frequence: 'M', moisRef: String(pm(CUR).m + 1), categorie: '', debut: CUR, fin: '', actif: 'oui' };
  const p = !isNew && point(CUR, (kind === 'vir' ? 'v' : 'f') + f.id);
  const catList = [...new Set(DB.fixes.map(x => x.categorie).filter(Boolean).concat(['Logement', 'Crédits', 'Énergie', 'Assurances', 'Abonnements', 'Impôts', 'Enfants', 'Épargne', 'Revenus']))];
  openSheet(`<form class="form" id="fixForm" data-id="${esc(f.id)}" data-kind="${kind}" novalidate>
    <h2>${isNew ? 'Nouvelle opération fixe' : 'Modifier'}</h2>
    ${isNew ? `<div class="seg" style="grid-template-columns:1fr 1fr 1fr"><button type="button" data-fkind="-" aria-pressed="${kind === 'fix' && f.sens === '-'}">Charge</button><button type="button" data-fkind="+" aria-pressed="${kind === 'fix' && f.sens === '+'}">Rentrée</button><button type="button" data-fkind="vir" aria-pressed="${kind === 'vir'}">Virement</button></div>` : ''}
    ${kind === 'vir' ? `<div class="field"><label for="fDir">Sens</label><select id="fDir">${accs().map(a => accs().filter(b => b.id !== a.id).map(b => `<option value="${esc(a.id)}>${esc(b.id)}" ${f.de === a.id && f.vers === b.id ? 'selected' : ''}>${esc(a.nom)} → ${esc(b.nom)}</option>`).join('')).join('')}</select></div>` : ''}
    <div class="field"><label for="fL">Libellé</label><input id="fL" value="${esc(f.libelle)}" placeholder="${kind === 'vir' ? 'Ex. Apport mensuel' : 'Ex. Électricité'}" autocomplete="off"></div>
    <div class="two"><div class="field"><label for="fA">Montant (€)</label><input id="fA" inputmode="decimal" value="${fr(f.montant)}"></div>
    <div class="field"><label for="fD">Jour du prélèvement</label><input id="fD" type="number" inputmode="numeric" min="1" max="31" value="${esc(f.jour)}"></div></div>
    ${kind === 'vir' ? (profiles().length > 1 ? `<div class="field"><label for="fW">Versé par</label><select id="fW"><option value="">—</option>${profiles().map(x => `<option value="${esc(x.id)}" ${x.id === f.profil ? 'selected' : ''}>${esc(x.nom)}</option>`).join('')}</select></div>` : '') :
    `<div class="two"><div class="field"><label for="fF">Fréquence</label><select id="fF">${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${k === (f.frequence || 'M') ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="field"><label for="fS">Mois du prélèvement</label><select id="fS">${MONTHS_L.map((n, i) => `<option value="${i + 1}" ${i + 1 === (num(f.moisRef) || 1) ? 'selected' : ''}>${n}</option>`).join('')}</select></div></div>
    <div class="hint" style="margin-top:-6px">Le mois du prélèvement ne sert que pour le trimestriel et l'annuel.</div>
    <div class="field"><label for="fC">Catégorie</label><input id="fC" list="fCl" value="${esc(f.categorie)}" placeholder="Ex. Énergie" autocomplete="off"><datalist id="fCl">${catList.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>`}
    <div class="two"><div class="field"><label for="fB">À partir de</label><select id="fB">${monthOpts(f.debut || CUR, addM(f.debut && f.debut < CUR ? f.debut : CUR, -12), 36)}</select></div>
    <div class="field"><label for="fE">Dernière échéance</label><select id="fE"><option value="">Sans fin</option>${monthOpts(f.fin, f.fin && f.fin < addM(CUR, -1) ? f.fin : addM(CUR, -1), 120)}</select></div></div>
    <label class="switch" for="fOn"><span>Active (décomptée automatiquement)</span><input type="checkbox" id="fOn" ${bool(f.actif) ? 'checked' : ''}></label>
    ${p ? `<div class="note good" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span>Pointé ce mois : <b>${eur(num(p.montantReel))}</b></span><button type="button" class="btn ghost small" data-unpoint="${esc(p.id)}">Annuler</button></div>` : ''}
    ${(kind === 'vir' ? (isShared(f.de) || isShared(f.vers)) : isShared(f.compte || acc)) ? `<div class="note">Compte partagé : ${isNew ? 'cette opération sera visible' : 'cette modification s\'applique'} aussi pour ${esc(otherNames())}.</div>` : ''}
    <div class="actions">${isNew ? '' : `<button type="button" class="btn danger" data-del="${kind}:${esc(f.id)}">Supprimer</button>`}<button class="btn" type="submit">Enregistrer</button></div>
    <div class="hint">Pour une charge qui s'arrête (fin de crédit…), indique la dernière échéance plutôt que de la supprimer : l'historique reste juste.</div>
    <div id="confirmBox"></div>
  </form>`);
}
function catSheet(acc, c) {
  openSheet(`<form class="form" id="catForm" data-acc="${esc(acc)}" data-id="${c ? esc(c.id) : ''}" novalidate>
    <h2>${c ? 'Modifier la catégorie' : 'Nouvelle catégorie'}</h2>
    <div class="mini" style="font-size:13px">${esc(accName(acc))}</div>
    <div class="field"><label for="cN">Nom</label><input id="cN" value="${c ? esc(c.nom) : ''}" placeholder="Ex. Animaux" autocomplete="off"></div>
    <div class="field"><label for="cB">Enveloppe mensuelle (€, optionnel)</label><input id="cB" inputmode="decimal" value="${c ? fr(c.budget) : ''}" placeholder="Vide = pas d'enveloppe"></div>
    ${isShared(acc) ? `<div class="note">Compte partagé : la catégorie est la même pour ${esc(otherNames())}.</div>` : ''}
    <div class="actions">${c ? `<button type="button" class="btn danger" data-catdel="${esc(c.id)}">Supprimer</button>` : ''}<button class="btn" type="submit">Enregistrer</button></div>
    <div id="confirmBox"></div></form>`);
}
function opSheet(o) {
  const acc = o.compte, isVir = o.type === 'vir', isAdj = o.type === 'ajust', amt = num(o.montant) || 0;
  const cats = catsOf(acc).map(c => c.nom); if (o.categorie && !cats.includes(o.categorie) && !isVir && !isAdj) cats.push(o.categorie);
  openSheet(`<form class="form" id="opForm" data-id="${esc(o.id)}" novalidate>
    <h2>${isAdj ? 'Correction de solde' : isVir ? 'Virement entre comptes' : amt < 0 ? 'Dépense' : 'Rentrée'}</h2>
    <div class="mini" style="font-size:13px">${esc(accName(acc))}${o.profil ? ' · saisi par ' + esc(pname(o.profil)) : ''}</div>
    <div class="amountbox"><input id="oA" inputmode="decimal" value="${fr(r2(Math.abs(amt)))}" aria-label="Montant"><span>€</span></div>
    ${isAdj ? `<div class="note">${amt >= 0 ? 'Ajout' : 'Retrait'} de ${eur(Math.abs(amt))} pour recaler le solde sur la banque.</div>` : ''}
    ${!isVir && !isAdj ? `<div class="field"><label for="oC">Catégorie</label><select id="oC">${cats.map(c => `<option ${c === o.categorie ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>` : ''}
    <div class="two"><div class="field"><label for="oD">Date</label><input id="oD" type="date" value="${esc(o.date)}"></div>
    <div class="field"><label for="oL">Libellé</label><input id="oL" value="${esc(o.libelle)}" autocomplete="off"></div></div>
    <div class="actions"><button type="button" class="btn danger" data-odel="${esc(o.id)}">Supprimer</button><button class="btn" type="submit">Enregistrer</button></div>
    <div id="confirmBox"></div></form>`);
}
function balSheet() {
  const r = curMonth(UI.acc);
  openSheet(`<form class="form" id="balForm" novalidate><h2>Corriger le solde</h2>
    <div class="note">Le 31 calcule <b>${eur(r.bal)}</b> aujourd'hui. Indique le solde affiché par la banque : l'écart est enregistré comme correction et toutes les prévisions repartent de là.</div>
    <div class="amountbox"><input id="realBal" inputmode="decimal" placeholder="${fr(r2(r.bal))}" aria-label="Solde réel" autocomplete="off"><span>€</span></div>
    <div class="hint">Avant de corriger, pointe les prélèvements passés : un écart vient souvent d'une dépense oubliée.</div>
    <button class="btn" type="submit">Recaler</button></form>`);
}
function closeMonthSheet(k) {
  const acc = UI.acc, r = calc(acc, k, startOf(acc, k));
  const rows = r.cats.filter(c => c.budget || c.spent).map(c => { const d = c.budget ? c.spent - c.budget : null; return `<div class="habit"><b>${esc(c.nom)}</b><span>${c.budget ? 'budget ' + eur0(c.budget) : '—'}</span><span style="font-weight:700;color:var(--${d > 0 ? 'bad' : 'ink'})">${eur0(c.spent)}</span></div>`; }).join('');
  openSheet(`<form class="form" id="closeForm" data-k="${k}" novalidate><h2>Clôturer ${mLabel(k)}</h2>
    ${rows ? `<div class="list">${rows}</div>` : ''}
    <div class="kv"><div><small>Solde calculé au ${r.D} ${MONTHS[pm(k).m]}</small><b>${eur(r.end)}</b></div><div><small>Rentrées / sorties</small><b>${eur0(r.rev)} / ${eur0(r.chg + r.vari)}</b></div></div>
    <div class="field"><label for="clReal">Solde réel du relevé au ${r.D} (si différent)</label><input id="clReal" inputmode="decimal" placeholder="Laisser vide si juste" autocomplete="off"></div>
    <div class="note">Le mois est archivé : son solde de fin sert de départ au mois suivant et ses dépenses alimentent les habitudes.</div>
    <button class="btn" type="submit">Clôturer et reporter</button></form>`);
}
function copyText(txt, el) {
  const done = () => toast('Copié');
  const fallback = () => { if (el) { el.focus(); el.select(); el.setSelectionRange && el.setSelectionRange(0, 99999); } try { document.execCommand('copy'); done(); } catch (e) { toast('Sélectionne le texte et copie-le'); } };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, fallback); else fallback();
}
let toastT;
function toast(t) { document.querySelectorAll('.toast').forEach(x => x.remove()); const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; document.body.appendChild(d); clearTimeout(toastT); toastT = setTimeout(() => d.remove(), 2600); }

/* ================= Thème ================= */
function applyTheme() {
  const r = document.documentElement;
  if (UI.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', UI.theme);
  store.set('le31-theme', UI.theme);
  const dark = UI.theme === 'dark' || (UI.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const m = $('themeColor'); if (m) m.setAttribute('content', dark ? '#0D1120' : '#EDF0F6');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { applyTheme(); if (UI.tab === 'set') render(); });

/* ================= Événements ================= */
document.addEventListener('click', ev => {
  const t = ev.target.closest('button,.sheet-bg,input[type=checkbox]'); if (!t) return;
  if (t.classList.contains('sheet-bg')) { if (ev.target === t) closeSheet(); return; }
  const ds = t.dataset;
  if (ds.retry) { pull(); return; }
  if (ds.acc) { UI.acc = ds.acc; store.set('le31-compte', UI.acc); render(); return; }
  if (ds.tab) { UI.tab = ds.tab; render(); scrollTo(0, 0); return; }
  if (ds.go) { UI.tab = ds.go; render(); scrollTo(0, 0); return; }
  if (ds.ftab) { UI.foreTab = ds.ftab; render(); return; }
  if (ds.mode) { UI.mode = ds.mode; render(); return; }
  if (ds.h) { UI.horizon = +ds.h; render(); return; }
  if (ds.fid) { const f = DB.fixes.find(x => x.id === ds.fid); if (f) fixedSheet(f, 'fix'); return; }
  if (ds.vid) { const v = DB.virements.find(x => x.id === ds.vid); if (v) fixedSheet(v, 'vir'); return; }
  if (ds.oid) { const o = DB.operations.find(x => x.id === ds.oid); if (o) opSheet(o); return; }
  if (ds.newfixed) { sheetRoot.dataset.sens = '-'; fixedSheet(null, 'fix'); return; }
  if (ds.fkind) { if (ds.fkind === 'vir') fixedSheet(null, 'vir'); else { sheetRoot.dataset.sens = ds.fkind; fixedSheet(null, 'fix'); } return; }
  if (ds.sens) { draft.sens = ds.sens; const a = $('amt') && $('amt').value, l = $('lb') && $('lb').value, d = $('dt') && $('dt').value; render(); if (a) $('amt').value = a; if (l) $('lb').value = l; if (d) $('dt').value = d; return; }
  if (ds.cat) { draft.cat = ds.cat; t.parentNode.querySelectorAll('[data-cat]').forEach(b => b.setAttribute('aria-pressed', b === t)); return; }
  if (ds.newcat) { catSheet(ds.newcat, null); return; }
  if (ds.editcat) { const c = DB.categories.find(x => x.id === ds.editcat); if (c) catSheet(c.compte, c); return; }
  if (ds.simtog) { const s = DB.simulations.find(x => x.id === ds.simtog); if (s) commit([upd('Simulations', { id: s.id, actif: t.checked ? 'oui' : 'non' })]); return; }
  if (ds.simdel) { commit([del('Simulations', ds.simdel)]); toast('Simulation retirée'); return; }
  if (ds.recon) {
    const v = num($('rc-' + ds.recon).value); if (v === null || v < 0) { toast('Montant invalide'); return; }
    const id = CUR + '|' + ds.recon;
    commit([upd('Pointages', { id, compte: UI.acc, mois: CUR, cle: ds.recon, montantReel: r2(v) })]); toast('Pointé : la prévision passe en réel'); return;
  }
  if (ds.unpoint) { commit([del('Pointages', ds.unpoint)]); closeSheet(); toast('Pointage annulé'); return; }
  if (ds.fixbal) { balSheet(); return; }
  if (ds.closeMonth) { closeMonthSheet(ds.closeMonth); return; }
  if (ds.taxmode) { commit([upd('Parametres', { cle: 'impMode', valeur: ds.taxmode })]); return; }
  if (ds.syncnow) { QUEUE.length ? flush() : pull(); toast('Synchronisation lancée'); return; }
  if (ds.iosok) { JOIN.iosOk = true; join(); return; }
  if (ds.joinretry) { JOIN.err = ''; join(); return; }
  if (ds.onbmode) { ONB.mode = ds.onbmode; render(); return; }
  if (ds.onbstep) {
    const P = $('onbP'); if (P) ONB.partner = P.value.trim();
    if (ds.onbstep === '2' && (!ONB.mode || (ONB.mode === 'duo' && !ONB.partner))) { toast(ONB.mode ? 'Indique le prénom de ton/ta partenaire' : 'Choisis seul ou à deux'); return; }
    ONB.step = +ds.onbstep; render(); return;
  }
  if (ds.onbdone) { finishOnboard(); return; }
  if (ds.impstep) {
    if (ds.impstep === 'go') { commitImport(); return; }
    IMP.step = ds.impstep; render(); scrollTo(0, 0); return;
  }
  if (ds.impclose) { UI.imp = null; IMP = null; UI.tab = 'home'; render(); scrollTo(0, 0); return; }
  if (ds.rkeep) { IMP.keep[ds.rkeep] = t.checked; render(); return; }
  if (ds.rvir) { IMP.virOn[ds.rvir] = t.checked; return; }
  if (ds.recal) { IMP.recal = t.checked; return; }
  if (ds.ucat) { IMP.ucat[ds.ucat] = ds.c; render(); return; }
  if (ds.invite) { invite(ds.invite); return; }
  if (ds.cut || ds.cutall) {
    openSheet(`<div class="form"><h2>Couper ${ds.cut ? 'cet appareil' : 'tous les accès'} de ${esc(ds.cutname)} ?</h2>
      <div class="note warn">${ds.cut ? "Cet appareil ne pourra plus rien voir ni saisir, tout de suite." : 'Tous ses appareils seront déconnectés et ses liens en attente annulés.'} Les données restent intactes. Envoie ensuite un nouveau lien à ${esc(ds.cutname)} pour son nouvel appareil.</div>
      <div class="actions"><button class="btn ghost" data-closebtn="1">Annuler</button><button class="btn danger" data-cutok="${esc(ds.cut || '')}" data-cutprof="${esc(ds.cutall || '')}">Couper l'accès</button></div></div>`);
    return;
  }
  if ('cutok' in ds) { cutAccess(ds.cutok ? { acces: ds.cutok } : { profil: ds.cutprof }, 'Accès coupé'); return; }
  if (ds.closebtn) { closeSheet(); return; }
  if (ds.copyshare) { const tx = $('shareTxt'); copyText(tx.value, tx); return; }
  if (ds.doshare) {
    const tx = $('shareTxt').value;
    if (navigator.share) navigator.share({ text: tx }).then(() => { closeSheet(); toast('Lien partagé'); }).catch(() => {});
    else copyText(tx, $('shareTxt'));
    return;
  }
  if (ds.del) { $('confirmBox').innerHTML = `<div class="alert bad" style="display:flex;justify-content:space-between;align-items:center;gap:8px">Supprimer définitivement ? L'historique des mois passés sera recalculé sans elle${DB.profils.length > 1 ? ', pour tout le monde' : ''}.<button type="button" class="btn danger small" data-delok="${esc(ds.del)}">Supprimer</button></div>`; return; }
  if (ds.delok) {
    const [k, id] = ds.delok.split(':'), cle = (k === 'vir' ? 'v' : 'f') + id;
    const ops = [del(k === 'vir' ? 'Virements' : 'Fixes', id)].concat(DB.pointages.filter(p => p.cle === cle).map(p => del('Pointages', p.id)));
    commit(ops); closeSheet(); toast('Opération supprimée'); return;
  }
  if (ds.odel) { $('confirmBox').innerHTML = `<div class="alert bad" style="display:flex;justify-content:space-between;align-items:center;gap:8px">Supprimer cette saisie ?<button type="button" class="btn danger small" data-odelok="${esc(ds.odel)}">Supprimer</button></div>`; return; }
  if (ds.odelok) {
    const o = DB.operations.find(x => x.id === ds.odelok); if (!o) { closeSheet(); return; }
    const ops = [del('Operations', o.id)]; if (o.type === 'vir' && o.lien) DB.operations.filter(x => x.lien === o.lien && x.id !== o.id).forEach(x => ops.push(del('Operations', x.id)));
    commit(ops); closeSheet(); toast(o.type === 'vir' ? 'Virement supprimé des deux comptes' : 'Saisie supprimée'); return;
  }
  if (ds.catdel) { $('confirmBox').innerHTML = `<div class="alert bad" style="display:flex;justify-content:space-between;align-items:center;gap:8px">Les saisies existantes gardent leur catégorie.<button type="button" class="btn danger small" data-catdelok="${esc(ds.catdel)}">Supprimer</button></div>`; return; }
  if (ds.catdelok) { commit([del('Categories', ds.catdelok)]); closeSheet(); toast('Catégorie supprimée'); return; }
});
document.addEventListener('input', ev => {
  if (ev.target.id === 'taxdelta') { TAX_DELTA = +ev.target.value; render(); const e = $('taxdelta'); if (e) e.focus(); }
});
document.addEventListener('change', ev => {
  const el = ev.target, ds = el.dataset;
  if (ds.themeAuto) { UI.theme = el.checked ? 'auto' : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); applyTheme(); render(); return; }
  if (ds.themeDark) { UI.theme = el.checked ? 'dark' : 'light'; applyTheme(); render(); return; }
  if (ds.accname) { const v = el.value.trim(); if (v) { commit([upd('Comptes', { id: ds.accname, nom: v })]); toast(isShared(ds.accname) ? 'Compte renommé pour tout le monde' : 'Compte renommé'); } return; }
  if (el.id === 'impFile' && el.files && el.files[0]) {
    const box = $('impErr'); if (box) box.innerHTML = '<div class="hint">Lecture du fichier…</div>';
    readImportFile(el.files[0]).then(startImport).catch(e => { const b = $('impErr'); if (b) b.innerHTML = `<div class="note bad">Fichier non reconnu : ${esc(e.message)}. Choisis un export CSV ou OFX de ta banque (pas un PDF).</div>`; });
    return;
  }
  if (ds.rname) { const r = IMP && IMP.recur.find(x => x.id === ds.rname); if (r && el.value.trim()) r.nom = el.value.trim(); return; }
  if (ds.vto) { draft.to = el.value; render(); return; }
  if (el.id === 'onbC') { ONB.commun = el.checked; return; }
  if (ds.open) { const v = num(el.value); if (el.value.trim() === '' || v !== null) { commit([upd('Comptes', { id: ds.open, soldeDepart: v === null ? '' : r2(v), moisDepart: startMonth(ds.open) })]); toast('Solde de départ mis à jour'); } else toast('Montant invalide'); return; }
  if (ds.seuil) { const v = num(el.value); if (v !== null) { commit([upd('Comptes', { id: ds.seuil, seuil: r2(v) })]); toast('Seuil mis à jour'); } return; }
  if (ds.mdep) { const v = el.value; if (/^\d{4}-\d{2}$/.test(v) && v <= CUR) { commit([upd('Comptes', { id: ds.mdep, moisDepart: v })]); toast('Mois de départ mis à jour'); } else toast('Choisis un mois passé ou le mois en cours'); return; }
  if (ds.prof) { const v = el.value.trim(); if (v) { commit([upd('Profils', { id: ds.prof, nom: v })]); toast(DB.profils.length > 1 ? 'Prénom changé pour tout le monde' : 'Prénom changé'); } return; }
  if (ds.tax) { const v = ds.tax === 'impAutresAb' ? el.value : num(el.value); if (v !== null && v !== '') commit([upd('Parametres', { cle: ds.tax, valeur: v })]); return; }
});
document.addEventListener('submit', ev => {
  ev.preventDefault(); const f = ev.target;
  if (f.id === 'keyForm') {
    if (!readLink($('keyIn').value.trim())) { toast("Lien non reconnu : il doit contenir #inv="); return; }
    if (!apiOk()) { toast("Le lien ne contient pas l'adresse du serveur : refais-le"); return; }
    JOIN.iosOk = true; JOIN.err = ''; SYNC.error = ''; join(); return;
  }
  if (f.id === 'onbName') {
    const n = $('onbN').value.trim(); if (!n) { toast('Indique ton prénom'); return; }
    ONB.name = n; ONB.step = 1; render(); return;
  }
  if (f.id === 'startForm') {
    const v = num($('startBal').value); if (v === null) { toast('Indique le solde'); return; }
    const sofar = calc(UI.acc, CUR, 0).bal; // opérations déjà passées ce mois-ci
    commit([upd('Comptes', { id: UI.acc, soldeDepart: r2(v - sofar), moisDepart: CUR })]); toast('C\'est parti !'); return;
  }
  if (f.id === 'addForm') {
    const a = num($('amt').value), dt = $('dt').value;
    if (!a || a <= 0) { toast('Indique un montant'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) { toast('Indique une date'); return; }
    const who = ME || '', acc = UI.acc;
    if (draft.sens === 'v') {
      const oth = draft.to || otherAcc(acc), lien = uid(), lb = $('lb').value.trim() || 'Virement';
      commit([upd('Operations', { id: uid(), compte: acc, date: dt, montant: r2(-a), categorie: 'Virement', libelle: lb, profil: who, type: 'vir', lien }),
              upd('Operations', { id: uid(), compte: oth, date: dt, montant: r2(a), categorie: 'Virement', libelle: lb, profil: who, type: 'vir', lien })]);
      toast(`Virement de ${eur(a)} vers ${accName(oth)} enregistré`);
      draft.sens = '-';
    } else {
      if (!draft.cat) { toast('Crée d\'abord une catégorie'); return; }
      const lb = $('lb').value.trim() || draft.cat;
      commit([upd('Operations', { id: uid(), compte: acc, date: dt, montant: r2(draft.sens === '-' ? -a : a), categorie: draft.cat, libelle: lb, profil: who, type: 'ponct', lien: '' })]);
      toast(`${draft.sens === '-' ? 'Dépense' : 'Rentrée'} ${dt.slice(0, 7) > CUR ? 'prévue' : 'ajoutée'} : ${lb} ${eur(a)}`);
    }
    UI.tab = dt.slice(0, 7) > CUR ? 'fore' : 'home'; UI.foreTab = 'budget'; render(); scrollTo(0, 0); return;
  }
  if (f.id === 'fixForm') {
    const id = f.dataset.id || uid(), kind = f.dataset.kind, isNew = !f.dataset.id;
    const libelle = $('fL').value.trim(), montant = num($('fA').value);
    const jour = Math.min(31, Math.max(1, parseInt($('fD').value, 10) || 1)), actif = $('fOn').checked ? 'oui' : 'non';
    const debut = $('fB').value, fin = $('fE').value;
    if (!libelle || !montant || montant <= 0) { toast('Libellé et montant requis'); return; }
    if (fin && fin < debut) { toast('La dernière échéance est avant le début'); return; }
    if (kind === 'vir') {
      const [de, vers] = $('fDir').value.split('>');
      commit([upd('Virements', { id, de, vers, libelle, montant: r2(montant), jour, profil: $('fW') ? $('fW').value : '', debut, fin, actif })]);
      toast(isNew ? 'Virement lié créé sur les deux comptes' : 'Virement mis à jour');
    } else {
      const sb = f.querySelector('[data-fkind][aria-pressed=true]');
      const row = { id, compte: isNew ? UI.acc : (DB.fixes.find(x => x.id === id) || {}).compte || UI.acc, libelle, montant: r2(montant), jour, frequence: $('fF').value, moisRef: $('fS').value, categorie: $('fC').value.trim() || 'Autre', debut, fin, actif };
      if (isNew) row.sens = sb ? sb.dataset.fkind : '-';
      commit([upd('Fixes', row)]); toast('Charges recalculées');
    }
    closeSheet(); return;
  }
  if (f.id === 'catForm') {
    const acc = f.dataset.acc, id = f.dataset.id, nom = $('cN').value.trim(), b = num($('cB').value);
    if (!nom) { toast('Donne un nom'); return; }
    if (catsOf(acc).some(c => c.nom.toLowerCase() === nom.toLowerCase() && c.id !== id)) { toast('Cette catégorie existe déjà'); return; }
    if (!id) {
      const ordre = Math.max(0, ...DB.categories.map(c => num(c.ordre) || 0)) + 1;
      commit([upd('Categories', { id: uid(), compte: acc, nom, budget: b > 0 ? r2(b) : '', ordre })]);
      if (UI.tab === 'add') draft.cat = nom;
    } else {
      const old = DB.categories.find(c => c.id === id), ops = [upd('Categories', { id, nom, budget: b > 0 ? r2(b) : '' })];
      if (old && old.nom !== nom) DB.operations.filter(o => o.compte === acc && o.categorie === old.nom).forEach(o => ops.push(upd('Operations', { id: o.id, categorie: nom })));
      commit(ops);
    }
    closeSheet(); toast('Catégorie enregistrée'); return;
  }
  if (f.id === 'opForm') {
    const o = DB.operations.find(x => x.id === f.dataset.id); if (!o) { closeSheet(); return; }
    const a = num($('oA').value), dt = $('oD').value; if (!a || a <= 0) { toast('Indique un montant'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) { toast('Indique une date'); return; }
    const neg = (num(o.montant) || 0) < 0, lb = $('oL').value.trim();
    const ops = [upd('Operations', { id: o.id, montant: r2(neg ? -a : a), date: dt, libelle: lb, categorie: $('oC') ? $('oC').value : o.categorie })];
    if (o.type === 'vir' && o.lien) DB.operations.filter(x => x.lien === o.lien && x.id !== o.id).forEach(x => ops.push(upd('Operations', { id: x.id, montant: r2(neg ? a : -a), date: dt, libelle: lb })));
    commit(ops); closeSheet(); toast('Saisie mise à jour'); return;
  }
  if (f.id === 'balForm') {
    const v = num($('realBal').value); if (v === null) { toast('Indique le solde de la banque'); return; }
    const delta = r2(v - curMonth(UI.acc).bal);
    if (Math.abs(delta) >= 0.01) commit([upd('Operations', { id: uid(), compte: UI.acc, date: TODAY_ISO, montant: delta, categorie: 'Correction de solde', libelle: 'Correction de solde', profil: '', type: 'ajust', lien: '' })]);
    closeSheet(); toast(Math.abs(delta) >= 0.01 ? `Solde recalé (${sgn(delta)})` : 'Le solde était déjà juste'); render(); return;
  }
  if (f.id === 'closeForm') {
    const k = f.dataset.k, acc = UI.acc, comp = calc(acc, k, startOf(acc, k)).end, v = num($('clReal').value);
    commit([upd('Clotures', { id: acc + '|' + k, compte: acc, mois: k, soldeFin: r2(v === null ? comp : v), dateCloture: TODAY_ISO })]);
    closeSheet(); toast(`${mLabel(k)} clôturé : solde reporté`); return;
  }
  if (f.id === 'simForm') {
    const a = num($('simA').value); if (!a || a <= 0) { toast('Indique un montant'); return; }
    commit([upd('Simulations', { id: uid(), compte: UI.acc, libelle: $('simL').value.trim() || 'Achat', montant: r2(a), mois: $('simM').value, actif: 'oui' })]);
    toast('Simulation ajoutée'); return;
  }
  if (f.id === 'profForm') {
    const n = $('pfnew').value.trim(); if (!n) { toast('Indique un prénom'); return; }
    const id = 'p' + uid();
    commit([upd('Profils', { id, nom: n, perso: $('pfperso').checked ? 'oui' : 'non', ordre: Math.max(0, ...DB.profils.map(p => num(p.ordre) || 0)) + 1 })]);
    setTimeout(() => invite(id), 400); return;
  }
});

/* ================= Installation sur l'écran d'accueil ================= */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; showInstall(); });
function showInstall() {
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone || store.get('le31-noinstall', false)) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!installEvt && !ios) return;
  if (document.querySelector('.install')) return;
  const b = document.createElement('div');
  b.className = 'banner install';
  b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:15;max-width:440px;margin:0 auto;box-shadow:0 6px 20px rgba(0,0,0,.18)';
  b.innerHTML = ios ? `<span>Pour installer : bouton <b>Partager</b> puis <b>Sur l'écran d'accueil</b>.</span><button class="btn ghost small" data-noinst="1">OK</button>`
    : `<span><b>Installer Le 31</b> sur ce téléphone</span><span style="display:flex;gap:6px"><button class="btn small" data-inst="1">Installer</button><button class="btn ghost small" data-noinst="1">Plus tard</button></span>`;
  document.body.appendChild(b);
  b.addEventListener('click', async e => {
    if (e.target.dataset.inst && installEvt) { installEvt.prompt(); await installEvt.userChoice; installEvt = null; b.remove(); }
    if (e.target.dataset.noinst) { store.set('le31-noinstall', true); b.remove(); }
  });
}
window.addEventListener('appinstalled', () => { const b = document.querySelector('.install'); if (b) b.remove(); });

/* ================= Démarrage ================= */
applyTheme();
rebuild();
render();
if (INV() && apiOk()) join(); else { pull(); flush(); }
setTimeout(showInstall, 1500);
setInterval(() => { if (document.visibilityState === 'visible') { pull(); } }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshNow(); pull(); flush(); } });
window.addEventListener('online', () => { flush(); pull(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then(reg => { setInterval(() => reg.update(), 60 * 60 * 1000); }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !reloaded) { reloaded = true; location.reload(); } });
}
