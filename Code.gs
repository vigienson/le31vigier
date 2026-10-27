/**
 * LE 31 — serveur (Google Apps Script lié au Google Sheet « Le 31 »)
 * Version 1.3 : connexion d'un appareil par GET (plus robuste), erreurs toujours renvoyées en JSON.
 *
 * À coller dans : Google Sheet > Extensions > Apps Script (remplacer tout le contenu).
 * Ensuite : exécuter une fois la fonction « installer », puis Déployer > Nouveau déploiement > Application Web.
 * Voir le tuto d'installation (iPad ou PC).
 */

const VERSION_SERVEUR = '1.3';
const VALIDITE_LIEN_JOURS = 14;

// Onglets du Google Sheet et leurs colonnes (créés automatiquement)
const ONGLETS = {
  Comptes:     ['id', 'nom', 'proprietaire', 'soldeDepart', 'moisDepart', 'seuil', 'ordre'],
  Profils:     ['id', 'nom', 'perso', 'ordre'],
  Categories:  ['id', 'compte', 'nom', 'budget', 'ordre'],
  Fixes:       ['id', 'compte', 'libelle', 'montant', 'sens', 'jour', 'frequence', 'moisRef', 'categorie', 'debut', 'fin', 'actif', 'motif'],
  Virements:   ['id', 'de', 'vers', 'libelle', 'montant', 'jour', 'profil', 'debut', 'fin', 'actif', 'motif'],
  Operations:  ['id', 'compte', 'date', 'montant', 'categorie', 'libelle', 'profil', 'type', 'lien', 'ref'],
  Pointages:   ['id', 'compte', 'mois', 'cle', 'montantReel'],
  Clotures:    ['id', 'compte', 'mois', 'soldeFin', 'dateCloture'],
  Simulations: ['id', 'compte', 'libelle', 'montant', 'mois', 'actif'],
  Regles:      ['id', 'motif', 'categorie'],
  Parametres:  ['cle', 'valeur'],
  Acces:       ['id', 'jeton', 'profil', 'appareil', 'cree', 'vu', 'actif'],
  Invitations: ['code', 'profil', 'cree', 'utilise', 'par']
};
const PRIVES = ['Acces', 'Invitations'];          // jamais modifiables par l'appli directement
const PAR_COMPTE = ['Categories', 'Fixes', 'Operations', 'Pointages', 'Clotures', 'Simulations'];

const DEPART = {
  Parametres: [
    { cle: 'impMode', valeur: 'commune' }, { cle: 'impEnfants', valeur: '0' },
    { cle: 'impSal1', valeur: '0' }, { cle: 'impSal2', valeur: '0' },
    { cle: 'impAutres', valeur: '0' }, { cle: 'impAutresAb', valeur: '50' },
    { cle: 'impTaux', valeur: '0' }
  ]
};

/* =================== Installation et menu =================== */

/** À exécuter une fois depuis l'éditeur (bouton ▶ Exécuter) : crée les onglets. */
function installer() {
  preparer_(true);
  SpreadsheetApp.getActive().toast('Le 31 est prêt. Étape suivante : Déployer > Nouveau déploiement.', 'Le 31', 8);
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Le 31')
    .addItem("Lien d'accès (installation, nouveau téléphone)", 'montrerLien')
    .addSeparator()
    .addItem('Couper tous les accès (urgence)', 'couperTout')
    .addToUi();
}

function montrerLien() {
  preparer_(false);
  const p = PropertiesService.getScriptProperties();
  const t = HtmlService.createTemplate(HTML_LIEN_);
  t.adresse = p.getProperty('ADRESSE_APPLI') || '';
  t.exec = p.getProperty('ADRESSE_EXEC') || ''; // pas de pré-remplissage automatique : il pouvait proposer une mauvaise adresse
  t.profils = JSON.stringify(lire_('Profils').map(r => ({ id: r.id, nom: r.nom })));
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(520).setHeight(560), "Lien d'accès");
}

/** Appelé par la fenêtre du menu : crée une invitation et renvoie le lien. */
function creerLienMenu(profil, appli, exec) {
  const p = PropertiesService.getScriptProperties();
  p.setProperty('ADRESSE_APPLI', String(appli || '').trim());
  p.setProperty('ADRESSE_EXEC', String(exec || '').trim());
  const code = inviter_(profil || '', 'menu');
  return lien_(appli, exec, code);
}

/** Secours (si le menu n'apparaît pas) : à exécuter depuis l'éditeur, les liens s'affichent dans le journal. */
function lienSecours() {
  preparer_(false);
  const p = PropertiesService.getScriptProperties();
  const appli = p.getProperty('ADRESSE_APPLI'), exec = p.getProperty('ADRESSE_EXEC') || urlExec_();
  if (!appli || !exec) { console.log("Adresses inconnues : utilise d'abord une fois le menu Le 31 > Lien d'accès."); return; }
  const profs = lire_('Profils');
  if (!profs.length) console.log('Premier lancement : ' + lien_(appli, exec, inviter_('', 'secours')));
  profs.forEach(r => console.log(r.nom + ' : ' + lien_(appli, exec, inviter_(r.id, 'secours'))));
}

function couperTout() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.alert('Couper tous les accès ?', "Tous les téléphones seront déconnectés. Il faudra renvoyer un lien à chacun (menu Le 31 > Lien d'accès).", ui.ButtonSet.OK_CANCEL);
  if (r !== ui.Button.OK) return;
  modifier_('Acces', rows => rows.forEach(a => { a.actif = 'non'; }));
  modifier_('Invitations', rows => rows.forEach(i => { if (!i.utilise) i.utilise = 'annulée'; }));
  ui.alert('Tous les accès sont coupés.');
}

function urlExec_() {
  try { const u = ScriptApp.getService().getUrl(); return /\/exec$/.test(u || '') ? u : ''; } catch (e) { return ''; }
}
function lien_(appli, exec, code) {
  appli = String(appli || '').trim(); if (appli.slice(-1) !== '/') appli += '/';
  return appli + '#inv=' + code + '&api=' + encodeURIComponent(String(exec || '').trim());
}

const HTML_LIEN_ = `
<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">
  <p><b>1.</b> Adresse de l'appli sur GitHub Pages (ex. https://monbudget.github.io/le31/) :</p>
  <input id="a" style="width:100%;padding:6px;font-size:14px" value="<?= adresse ?>" placeholder="https://....github.io/le31/">
  <p><b>2.</b> Adresse du script : l'<b>URL de l'application Web</b> copiée au déploiement (se termine par /exec) :</p>
  <input id="x" style="width:100%;padding:6px;font-size:14px" value="<?= exec ?>" placeholder="https://script.google.com/macros/s/.../exec">
  <p><b>3.</b> Pour qui ?</p>
  <select id="p" style="width:100%;padding:6px;font-size:14px"></select>
  <p><button onclick="gen()" style="font-size:15px;padding:6px 14px">Créer le lien</button></p>
  <div id="r" style="display:none">
    <p><b>4.</b> Lien à ouvrir sur le téléphone (envoie-le par SMS ou WhatsApp). Il ne marche <b>qu'une fois</b>, sur un seul appareil, pendant 14 jours :</p>
    <textarea id="l" style="width:100%;height:80px;font-size:13px" readonly></textarea>
    <p><button onclick="cp()">Copier le lien</button> <span id="ok" style="color:green"></span></p>
  </div>
</div>
<script>
  var PROFILS = <?!= profils ?>;
  var sel = document.getElementById('p');
  if (!PROFILS.length) sel.innerHTML = '<option value="">Premier lancement (configuration de l\\'appli)</option>';
  else sel.innerHTML = PROFILS.map(function(p){ return '<option value="'+p.id+'">'+p.nom.replace(/</g,'&lt;')+'</option>'; }).join('');
  function gen(){
    var a = document.getElementById('a').value.trim(), x = document.getElementById('x').value.trim();
    if(!/^https:\\/\\/.+github\\.io/.test(a)){ alert("L'adresse de l'appli doit ressembler à https://....github.io/le31/"); return; }
    if(!/^https:\\/\\/script\\.google\\.com\\/.+\\/exec$/.test(x)){ alert("L'adresse du script doit commencer par https://script.google.com/ et se terminer par /exec"); return; }
    google.script.run.withSuccessHandler(function(l){
      document.getElementById('l').value = l; document.getElementById('r').style.display = 'block'; document.getElementById('ok').textContent = '';
    }).creerLienMenu(sel.value, a, x);
  }
  function cp(){ var l=document.getElementById('l'); l.focus(); l.select(); l.setSelectionRange(0, 99999);
    var done=function(){ document.getElementById('ok').textContent='Copié !'; };
    if(navigator.clipboard){ navigator.clipboard.writeText(l.value).then(done, function(){ document.execCommand('copy'); done(); }); } else { document.execCommand('copy'); done(); } }
</script>`;

/* =================== Appli web (API) =================== */

function doGet(e) {
  try { return doGet_(e); } catch (err) { return json_({ ok: false, erreur: 'serveur', detail: String(err && err.message || err) }); }
}
function doPost(e) {
  try { return doPost_(e); } catch (err) { return json_({ ok: false, erreur: 'serveur', detail: String(err && err.message || err) }); }
}

function doGet_(e) {
  const p = (e && e.parameter) || {};
  if (!p.action) return ContentService.createTextOutput('Le 31 : serveur actif (V' + VERSION_SERVEUR + ')');
  if (p.action === 'ping') return json_({ ok: true, v: VERSION_SERVEUR });
  preparer_(false);
  if (p.action === 'rejoindre') {
    const verrou = LockService.getScriptLock(); verrou.waitLock(25000);
    try { return json_(rejoindre_(p.inv, p.appareil)); } finally { verrou.releaseLock(); }
  }
  const a = acces_(p.jeton);
  if (!a) return json_({ ok: false, erreur: 'acces' });
  if (p.action === 'tout') return json_({ ok: true, v: VERSION_SERVEUR, moi: a.profil, acces: a.id, data: tout_(a.profil) });
  return json_({ ok: false, erreur: 'action inconnue' });
}

function doPost_(e) {
  let c;
  try { c = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, erreur: 'json' }); }
  preparer_(false);
  const verrou = LockService.getScriptLock();
  verrou.waitLock(25000);
  try {
    if (c.action === 'rejoindre') return json_(rejoindre_(c.inv, c.appareil));
    const a = acces_(c.jeton);
    if (!a) return json_({ ok: false, erreur: 'acces' });
    let moi = a.profil, extra = {};
    if (c.action === 'ops' || !c.action) {
      const refus = appliquer_(c.ops || [], moi);
      if (c.associer && moi === '' && lire_('Profils').some(r => r.id === c.associer)) {
        modifier_('Acces', rows => rows.forEach(r => { if (r.id === a.id) r.profil = c.associer; }));
        moi = c.associer;
      }
      if (refus) extra.refus = refus;
    } else if (c.action === 'inviter') {
      if (!lire_('Profils').some(r => r.id === c.profil)) return json_({ ok: false, erreur: 'profil inconnu' });
      extra.code = inviter_(c.profil, moi);
    } else if (c.action === 'couper') {
      modifier_('Acces', rows => rows.forEach(r => {
        if (r.id === a.id) return; // jamais son propre appareil en cours
        if ((c.acces && r.id === c.acces) || (!c.acces && c.profil && r.profil === c.profil)) r.actif = 'non';
      }));
      modifier_('Invitations', rows => rows.forEach(i => { if (!c.acces && i.profil === c.profil && !i.utilise) i.utilise = 'annulée'; }));
    } else return json_({ ok: false, erreur: 'action inconnue' });
    SpreadsheetApp.flush();
    return json_(Object.assign({ ok: true, v: VERSION_SERVEUR, moi: moi, acces: a.id, data: tout_(moi) }, extra));
  } finally {
    verrou.releaseLock();
  }
}

/* =================== Accès =================== */

function acces_(jeton) {
  if (!jeton) return null;
  const a = lire_('Acces').find(r => r.jeton === String(jeton) && r.actif === 'oui');
  if (!a) return null;
  const cache = CacheService.getScriptCache();
  if (!cache.get('vu_' + a.id)) { // « vu le » mis à jour au plus une fois par heure
    cache.put('vu_' + a.id, '1', 3600);
    // une seule cellule écrite : pas de risque d'écraser une écriture en cours
    const sh = SpreadsheetApp.getActive().getSheetByName('Acces'), v = sh.getDataRange().getDisplayValues();
    const ci = v[0].indexOf('vu'), ri = v.findIndex(r => r[0] === a.id);
    if (ci >= 0 && ri > 0) sh.getRange(ri + 1, ci + 1).setValue(maintenant_());
  }
  return a;
}

function rejoindre_(code, appareil) {
  const inv = lire_('Invitations').find(i => i.code === String(code || ''));
  if (!inv) return { ok: false, erreur: 'invitation' };
  if (inv.utilise) return { ok: false, erreur: inv.utilise === 'annulée' ? 'annulee' : 'utilisee' };
  if (Date.now() - new Date(inv.cree).getTime() > VALIDITE_LIEN_JOURS * 864e5) return { ok: false, erreur: 'expiree' };
  if (inv.profil && !lire_('Profils').some(r => r.id === inv.profil)) return { ok: false, erreur: 'invitation' };
  const jeton = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const id = 'a' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  modifier_('Acces', rows => rows.push({ id, jeton, profil: inv.profil, appareil: String(appareil || 'Appareil').slice(0, 60), cree: maintenant_(), vu: maintenant_(), actif: 'oui' }));
  modifier_('Invitations', rows => rows.forEach(i => { if (i.code === inv.code) i.utilise = maintenant_(); }));
  return { ok: true, jeton, acces: id, moi: inv.profil, data: tout_(inv.profil) };
}

function inviter_(profil, par) {
  const code = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  modifier_('Invitations', rows => {
    rows.forEach(i => { if (i.profil === profil && !i.utilise) i.utilise = 'annulée'; }); // un seul lien valable à la fois
    rows.push({ code, profil, cree: maintenant_(), utilise: '', par: par || '' });
  });
  return code;
}

/* =================== Données visibles =================== */

function comptesVisibles_(moi) {
  return lire_('Comptes').filter(c => !c.proprietaire || (moi && c.proprietaire === moi)).map(c => c.id);
}

function tout_(moi) {
  const vis = comptesVisibles_(moi), out = {};
  // un virement lié est visible des deux côtés, son pointage aussi
  const virVis = lire_('Virements').filter(r => vis.indexOf(r.de) >= 0 || vis.indexOf(r.vers) >= 0).map(r => 'v' + r.id);
  Object.keys(ONGLETS).forEach(nom => {
    if (PRIVES.indexOf(nom) >= 0) return;
    let rows = lire_(nom);
    if (nom === 'Comptes') rows = rows.filter(r => vis.indexOf(r.id) >= 0);
    else if (nom === 'Virements') rows = rows.filter(r => vis.indexOf(r.de) >= 0 || vis.indexOf(r.vers) >= 0);
    else if (nom === 'Pointages') rows = rows.filter(r => vis.indexOf(r.compte) >= 0 || virVis.indexOf(String(r.cle)) >= 0);
    else if (PAR_COMPTE.indexOf(nom) >= 0) rows = rows.filter(r => vis.indexOf(r.compte) >= 0);
    out[nom] = rows;
  });
  // Appareils de chaque profil (sans les jetons) et liens en attente
  const now = Date.now();
  out.Appareils = lire_('Acces').filter(a => a.profil).map(a => ({ id: a.id, profil: a.profil, appareil: a.appareil, cree: a.cree, vu: a.vu, actif: a.actif }));
  out.Attente = lire_('Invitations').filter(i => !i.utilise && i.profil && now - new Date(i.cree).getTime() <= VALIDITE_LIEN_JOURS * 864e5).map(i => ({ profil: i.profil, cree: i.cree }));
  return out;
}

/** Applique les modifications de l'appli, en refusant ce qui touche un compte perso d'un autre. Renvoie le nombre de refus. */
function appliquer_(ops, moi) {
  const comptes = lire_('Comptes');
  const vis = comptes.filter(c => !c.proprietaire || (moi && c.proprietaire === moi)).map(c => c.id);
  const setup = moi === '';
  let refus = 0;
  const parOnglet = {};
  ops.forEach(op => {
    if (!ONGLETS[op.onglet] || PRIVES.indexOf(op.onglet) >= 0) { refus++; return; }
    (parOnglet[op.onglet] = parOnglet[op.onglet] || []).push(op);
  });
  // ordre : Profils et Comptes d'abord (un nouveau compte doit exister avant ses lignes)
  const ordre = ['Profils', 'Comptes'].concat(Object.keys(ONGLETS).filter(n => n !== 'Profils' && n !== 'Comptes'));
  ordre.forEach(nom => {
    const liste = parOnglet[nom]; if (!liste) return;
    modifier_(nom, rows => {
      const cleCol = nom === 'Parametres' ? 'cle' : 'id';
      liste.forEach(op => {
        const id = op.op === 'suppr' ? op.id : (op.ligne || {})[cleCol];
        if (id == null || id === '') { refus++; return; }
        const i = rows.findIndex(r => r[cleCol] === String(id));
        const ancien = i >= 0 ? rows[i] : null;
        const futur = op.op === 'suppr' ? ancien : Object.assign({}, ancien || {}, op.ligne);
        if (!setup && !autorise_(nom, ancien, futur, vis, moi)) { refus++; return; }
        if (nom === 'Comptes' && futur && i < 0 && !setup && futur.proprietaire && futur.proprietaire !== moi) { refus++; return; }
        if (op.op === 'suppr') { if (i >= 0) rows.splice(i, 1); }
        else if (i >= 0) { Object.keys(op.ligne).forEach(k => { rows[i][k] = op.ligne[k] == null ? '' : String(op.ligne[k]); }); }
        else { const n = {}; Object.keys(op.ligne).forEach(k => { n[k] = op.ligne[k] == null ? '' : String(op.ligne[k]); }); rows.push(n); }
        if (nom === 'Comptes' && futur && vis.indexOf(futur.id) < 0 && (!futur.proprietaire || futur.proprietaire === moi)) vis.push(futur.id);
      });
    });
  });
  return refus;
}
function autorise_(nom, ancien, futur, vis, moi) {
  const ok = c => vis.indexOf(c) >= 0;
  if (nom === 'Comptes') return ancien ? ok(ancien.id) : (!futur.proprietaire || futur.proprietaire === moi);
  if (nom === 'Virements') return [ancien, futur].every(r => !r || ok(r.de) || ok(r.vers));
  if (nom === 'Pointages') return [ancien, futur].every(r => !r || ok(r.compte) || virOk_(r.cle, vis));
  if (PAR_COMPTE.indexOf(nom) >= 0) return [ancien, futur].every(r => !r || ok(r.compte));
  return true; // Profils, Regles, Parametres : communs au foyer
}

function virOk_(cle, vis) {
  const m = /^v(.+)$/.exec(String(cle || '')); if (!m) return false;
  return lire_('Virements').some(r => r.id === m[1] && (vis.indexOf(r.de) >= 0 || vis.indexOf(r.vers) >= 0));
}

/* =================== Lecture / écriture du Sheet =================== */

function preparer_(forcer) {
  const cache = CacheService.getScriptCache();
  if (!forcer && cache.get('pret_' + VERSION_SERVEUR)) return;
  const ss = SpreadsheetApp.getActive();
  Object.keys(ONGLETS).forEach(nom => {
    const cols = ONGLETS[nom];
    let sh = ss.getSheetByName(nom);
    if (!sh) {
      sh = ss.insertSheet(nom);
      sh.getRange('A:Z').setNumberFormat('@'); // tout en texte : Google Sheets ne transforme rien
      sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
      sh.setFrozenRows(1);
      const dep = DEPART[nom];
      if (dep && dep.length) sh.getRange(2, 1, dep.length, cols.length).setValues(dep.map(r => cols.map(c => r[c] == null ? '' : String(r[c]))));
    } else {
      const n = Math.max(sh.getLastColumn(), 1);
      const tete = sh.getRange(1, 1, 1, n).getDisplayValues()[0];
      cols.forEach(c => {
        if (tete.indexOf(c) < 0) {
          const col = tete.filter(String).length + 1;
          sh.getRange(1, col).setValue(c).setFontWeight('bold');
          sh.getRange(1, col, sh.getMaxRows(), 1).setNumberFormat('@');
          tete[col - 1] = c;
        }
      });
    }
  });
  const f1 = ss.getSheetByName('Feuille 1') || ss.getSheetByName('Sheet1');
  if (f1 && ss.getSheets().length > 1 && f1.getLastRow() === 0) ss.deleteSheet(f1);
  cache.put('pret_' + VERSION_SERVEUR, '1', 21600);
}

function lire_(nom) {
  const sh = SpreadsheetApp.getActive().getSheetByName(nom);
  const v = sh.getDataRange().getDisplayValues(), tete = v[0] || [];
  return v.slice(1).filter(r => String(r[0]).trim() !== '').map(r => {
    const o = {}; tete.forEach((c, i) => { if (c) o[c] = r[i]; }); return o;
  });
}

/** Lit un onglet, laisse la fonction modifier les lignes en mémoire, puis réécrit l'onglet d'un coup (rapide, même pour un gros import). */
function modifier_(nom, fn) {
  const sh = SpreadsheetApp.getActive().getSheetByName(nom);
  const v = sh.getDataRange().getDisplayValues(), tete = v[0];
  const avant = v.length - 1;
  const rows = v.slice(1).filter(r => String(r[0]).trim() !== '').map(r => { const o = {}; tete.forEach((c, i) => { if (c) o[c] = r[i]; }); return o; });
  fn(rows);
  const out = rows.map(o => tete.map(c => (c && o[c] != null) ? String(o[c]) : ''));
  if (avant > 0) sh.getRange(2, 1, avant, tete.length).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, tete.length).setValues(out);
}

function maintenant_() { return new Date().toISOString(); }
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
