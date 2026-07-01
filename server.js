// server.js — Proxy IA pour PÉNIEL — Étude biblique
// Rôle : recevoir les requêtes du navigateur (index.html) au format Anthropic,
// les router vers des modèles 100 % gratuits (Groq en primaire, OpenRouter en
// secours automatique), et retourner la réponse au même format Anthropic —
// sans modifier index.html.
//
// Variables d'environnement Render à configurer :
//   GITHUB_TOKEN        (recommandé)   jeton GitHub (permission « Models: read ») → GitHub Models, gratuit
//   OPENROUTER_API_KEY  (optionnel)    clé gratuite https://openrouter.ai → fallback
//   GROQ_API_KEY        (optionnel)    clé gratuite https://console.groq.com → fallback
//   GITHUB_MODELS       (optionnel)    défaut : openai/gpt-4o-mini,openai/gpt-4o
//   OPENROUTER_MODELS / GROQ_MODELS    (optionnel)  listes de slugs séparées par des virgules
// Il suffit d'UNE seule clé pour que l'app fonctionne. On essaie GitHub Models,
// puis OpenRouter, puis Groq, en basculant au suivant à chaque échec.

const express = require('express');
const cors = require('cors');

const app = express();

// Autorise les requêtes cross-origin (GitHub Pages -> Render).
app.use(cors());

app.use(express.json({ limit: '2mb' }));

// ── Fournisseurs IA gratuits (compatibles OpenAI Chat Completions) ──
// On essaie chaque fournisseur dans l'ordre ; si l'un échoue (erreur réseau,
// quota atteint, réponse vide), on bascule automatiquement sur le suivant.
// Les quotas étant indépendants, l'app reste opérationnelle quasi en permanence.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_MODELS_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Listes de modèles essayés DANS L'ORDRE (séparés par des virgules). On essaie
// chaque modèle jusqu'à ce que l'un réponde ; un modèle inexistant, saturé ou
// en échec est simplement ignoré, on passe au suivant.
const GITHUB_MODELS = (process.env.GITHUB_MODELS || 'openai/gpt-4o,openai/gpt-4o-mini')
  .split(',').map(s => s.trim()).filter(Boolean);
const OPENROUTER_MODELS = (process.env.OPENROUTER_MODELS || process.env.OPENROUTER_MODEL ||
  'meta-llama/llama-3.3-70b-instruct:free,nvidia/nemotron-3-ultra-550b-a55b:free'
).split(',').map(s => s.trim()).filter(Boolean);
const GROQ_MODELS = (process.env.GROQ_MODELS || process.env.GROQ_MODEL ||
  'llama-3.3-70b-versatile,llama-3.1-8b-instant'
).split(',').map(s => s.trim()).filter(Boolean);

const PROVIDERS = [
  {
    // GitHub Models — gratuit via un jeton GitHub. Plafond de sortie ~4000 tokens
    // par requête sur le palier gratuit, d'où maxOut.
    name: 'github',
    enabled: () => !!GITHUB_TOKEN,
    url: process.env.GITHUB_MODELS_URL || 'https://models.github.ai/inference/chat/completions',
    models: GITHUB_MODELS,
    maxOut: Number(process.env.GITHUB_MAXOUT || 8000),
    headers: () => ({ 'Authorization': 'Bearer ' + GITHUB_TOKEN })
  },
  {
    name: 'openrouter',
    enabled: () => !!OPENROUTER_API_KEY,
    url: 'https://openrouter.ai/api/v1/chat/completions',
    models: OPENROUTER_MODELS,
    maxOut: 8192,
    headers: () => ({
      'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
      'HTTP-Referer': 'https://kraidy-armel.github.io/arkad-bible/',
      'X-Title': 'PENIEL Etude biblique'
    })
  },
  {
    name: 'groq',
    enabled: () => !!GROQ_API_KEY,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    models: GROQ_MODELS,
    maxOut: 8192,
    headers: () => ({ 'Authorization': 'Bearer ' + GROQ_API_KEY })
  }
];

// Aplatis la liste des tentatives : pour chaque fournisseur activé, un essai
// par modèle, dans l'ordre.
function buildAttempts() {
  const out = [];
  for (const p of PROVIDERS) {
    if (!p.enabled()) continue;
    for (const model of p.models) out.push({ name: p.name, url: p.url, model, maxOut: p.maxOut || 8192, headers: p.headers });
  }
  return out;
}

// Construit le tableau de messages OpenAI à partir du format Anthropic envoyé
// par index.html ({ system, messages:[{role, content}] }).
function toOpenAiMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of (messages || [])) {
    const content = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.map(c => c.text || '').join('') : '');
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return out;
}

// Tente UN modèle d'un fournisseur OpenAI-compatible et renvoie le texte généré.
async function callAttempt(att, oaMessages, maxTokens) {
  const resp = await fetch(att.url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, att.headers()),
    body: JSON.stringify({
      model: att.model,
      messages: oaMessages,
      // On plafonne la sortie à 8192 (le JSON d'étude tient dans cette taille,
      // comme c'était déjà le cas sous Gemini) pour rester sous les limites
      // tokens/minute des paliers gratuits.
      max_tokens: Math.min(maxTokens || 8192, att.maxOut || 8192),
      temperature: 0.3
    })
  });

  let data;
  try { data = await resp.json(); }
  catch (e) { throw new Error('réponse non-JSON (HTTP ' + resp.status + ')'); }

  if (!resp.ok) {
    let msg = 'HTTP ' + resp.status;
    if (data && data.error) {
      msg = data.error.message || msg;
      const meta = data.error.metadata;
      const raw = meta && (meta.raw || meta.reasons);
      if (raw) msg += ' — ' + (typeof raw === 'string' ? raw : JSON.stringify(raw));
    }
    throw new Error(msg);
  }

  const choice = data.choices && data.choices[0];
  const text = choice && choice.message ? (choice.message.content || '') : '';
  if (!text) {
    const fr = choice && choice.finish_reason ? ' (finish_reason=' + choice.finish_reason + ')' : '';
    throw new Error('réponse vide' + fr);
  }
  return text;
}

// Route de vérification
app.get('/', (req, res) => {
  const atts = buildAttempts();
  const txt = atts.length
    ? "Modèles essayés dans l'ordre : " + atts.map(a => a.name + '/' + a.model).join(' → ')
    : 'Aucune clé configurée — ajoutez OPENROUTER_API_KEY (ou GROQ_API_KEY) dans Render.';
  res.send('✅ PÉNIEL — proxy IA en ligne. ' + txt);
});

// Route appelée par index.html — accepte le format Anthropic, répond en format
// Anthropic. En interne, essaie chaque modèle gratuit jusqu'à obtenir une réponse.
app.post('/api/messages', async (req, res) => {
  const attempts = buildAttempts();
  if (!attempts.length) {
    return res.status(500).json({
      error: { message: "Aucune clé IA configurée. Ajoutez OPENROUTER_API_KEY (ou GROQ_API_KEY) dans les variables d'environnement Render." }
    });
  }

  const { system, messages = [], max_tokens } = req.body;
  const oaMessages = toOpenAiMessages(system, messages);

  const errors = [];
  for (const att of attempts) {
    try {
      const text = await callAttempt(att, oaMessages, max_tokens);
      return res.json({
        content: [{ type: 'text', text }],
        model: att.name + ':' + att.model,
        stop_reason: 'end_turn'
      });
    } catch (err) {
      console.error('Échec ' + att.name + '/' + att.model + ' : ' + err.message);
      errors.push(att.name + '/' + att.model + ': ' + err.message);
      // on passe au modèle suivant (fallback)
    }
  }

  res.status(502).json({
    error: { message: 'Tous les modèles IA ont échoué. ' + errors.join(' | ') }
  });
});

// ── RÉFÉRENCES CROISÉES (cross-references) ──
// Source : OpenBible.info (CC-BY), via le miroir scrollmapper/bible_databases.
// On télécharge le fichier une seule fois (mis en cache en mémoire), puis on
// répond aux requêtes /api/cross-refs en cherchant les vraies références
// croisées classiques pour une péricope donnée, plutôt que de laisser l'IA
// en inventer.
const CROSSREF_URL = 'https://raw.githubusercontent.com/scrollmapper/bible_databases/master/sources/extras/cross_references.txt';
let crossRefIndex = null;
let crossRefLoading = null;

const OSIS_TO_FR = {
  Gen:'Genèse',Exod:'Exode',Lev:'Lévitique',Num:'Nombres',Deut:'Deutéronome',
  Josh:'Josué',Judg:'Juges',Ruth:'Ruth','1Sam':'1 Samuel','2Sam':'2 Samuel',
  '1Kgs':'1 Rois','2Kgs':'2 Rois','1Chr':'1 Chroniques','2Chr':'2 Chroniques',
  Ezra:'Esdras',Neh:'Néhémie',Esth:'Esther',Job:'Job',Ps:'Psaumes',Prov:'Proverbes',
  Eccl:'Ecclésiaste',Song:'Cantique des Cantiques',Isa:'Ésaïe',Jer:'Jérémie',
  Lam:'Lamentations',Ezek:'Ézéchiel',Dan:'Daniel',Hos:'Osée',Joel:'Joël',
  Amos:'Amos',Obad:'Abdias',Jonah:'Jonas',Mic:'Michée',Nah:'Nahum',Hab:'Habacuc',
  Zeph:'Sophonie',Hag:'Aggée',Zech:'Zacharie',Mal:'Malachie',
  Matt:'Matthieu',Mark:'Marc',Luke:'Luc',John:'Jean',Acts:'Actes',Rom:'Romains',
  '1Cor':'1 Corinthiens','2Cor':'2 Corinthiens',Gal:'Galates',Eph:'Éphésiens',
  Phil:'Philippiens',Col:'Colossiens','1Thess':'1 Thessaloniciens','2Thess':'2 Thessaloniciens',
  '1Tim':'1 Timothée','2Tim':'2 Timothée',Titus:'Tite',Phlm:'Philémon',Heb:'Hébreux',
  Jas:'Jacques','1Pet':'1 Pierre','2Pet':'2 Pierre','1John':'1 Jean','2John':'2 Jean',
  '3John':'3 Jean',Jude:'Jude',Rev:'Apocalypse'
};

function stripAccents(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

const FR_TO_OSIS = {};
for (const [osis, fr] of Object.entries(OSIS_TO_FR)) {
  FR_TO_OSIS[stripAccents(fr)] = osis;
}
const EXTRA_ALIASES = {
  gn:'Gen', ge:'Gen', genese:'Gen',
  ex:'Exod', exo:'Exod',
  lv:'Lev', levi:'Lev', levitique:'Lev',
  nb:'Num', no:'Num', nombres:'Num',
  dt:'Deut', deut:'Deut', deuteronome:'Deut',
  jos:'Josh', josue:'Josh',
  jg:'Judg', juges:'Judg',
  rt:'Ruth',
  '1s':'1Sam','1sam':'1Sam','1samuel':'1Sam','i samuel':'1Sam',
  '2s':'2Sam','2sam':'2Sam','2samuel':'2Sam','ii samuel':'2Sam',
  '1r':'1Kgs','1rois':'1Kgs','1roi':'1Kgs',
  '2r':'2Kgs','2rois':'2Kgs','2roi':'2Kgs',
  '1ch':'1Chr','1chr':'1Chr','1chroniques':'1Chr',
  '2ch':'2Chr','2chr':'2Chr','2chroniques':'2Chr',
  esd:'Ezra', esdras:'Ezra',
  ne:'Neh', neh:'Neh', nehemie:'Neh',
  est:'Esth', esther:'Esth',
  jb:'Job', job:'Job',
  ps:'Ps', psaume:'Ps', psaumes:'Ps',
  pr:'Prov', prov:'Prov', proverbe:'Prov', proverbes:'Prov',
  ec:'Eccl', eccl:'Eccl', ecclesiaste:'Eccl',
  ct:'Song', cantique:'Song', cantiques:'Song', 'cantique des cantiques':'Song',
  es:'Isa', esaie:'Isa', isaie:'Isa',
  jr:'Jer', jer:'Jer', jeremie:'Jer',
  lm:'Lam', lam:'Lam', lamentations:'Lam',
  ez:'Ezek', eze:'Ezek', ezechiel:'Ezek', ezekiel:'Ezek', ezeckiel:'Ezek', ezechie:'Ezek',
  da:'Dan', dan:'Dan', daniel:'Dan',
  os:'Hos', osee:'Hos',
  jl:'Joel', joel:'Joel',
  am:'Amos', amos:'Amos',
  ab:'Obad', abdias:'Obad',
  jon:'Jonah', jonas:'Jonah',
  mi:'Mic', michee:'Mic',
  na:'Nah', nahum:'Nah',
  ha:'Hab', habacuc:'Hab',
  so:'Zeph', sophonie:'Zeph',
  ag:'Hag', aggee:'Hag',
  za:'Zech', zacharie:'Zech',
  ml:'Mal', malachie:'Mal',
  mt:'Matt', matthieu:'Matt',
  mc:'Mark', marc:'Mark',
  lc:'Luke', luc:'Luke',
  jn:'John', jean:'John',
  ac:'Acts', actes:'Acts',
  rm:'Rom', rom:'Rom', romains:'Rom',
  '1co':'1Cor','1cor':'1Cor','1corinthiens':'1Cor',
  '2co':'2Cor','2cor':'2Cor','2corinthiens':'2Cor',
  ga:'Gal', galates:'Gal',
  ep:'Eph', eph:'Eph', ephesiens:'Eph',
  ph:'Phil', phil:'Phil', philippiens:'Phil',
  col:'Col', colossiens:'Col',
  '1th':'1Thess','1thess':'1Thess','1thessaloniciens':'1Thess',
  '2th':'2Thess','2thess':'2Thess','2thessaloniciens':'2Thess',
  '1tm':'1Tim','1tim':'1Tim','1timothee':'1Tim',
  '2tm':'2Tim','2tim':'2Tim','2timothee':'2Tim',
  tt:'Titus', tite:'Titus',
  phm:'Phlm', philemon:'Phlm',
  he:'Heb', heb:'Heb', hebreux:'Heb',
  jc:'Jas', jas:'Jas', jacques:'Jas',
  '1p':'1Pet','1pi':'1Pet','1pierre':'1Pet',
  '2p':'2Pet','2pi':'2Pet','2pierre':'2Pet',
  '1jn':'1John','1jean':'1John',
  '2jn':'2John','2jean':'2John',
  '3jn':'3John','3jean':'3John',
  jude:'Jude',
  ap:'Rev', apoc:'Rev', apocalypse:'Rev'
};
for (const [k, v] of Object.entries(EXTRA_ALIASES)) {
  FR_TO_OSIS[stripAccents(k)] = v;
}

// Résout un nom de livre en code OSIS de façon TOLÉRANTE : accents, espaces,
// abréviations, et fautes de frappe par lettre(s) manquante(s) — ex. "1 timothé"
// -> "1 Timothée", "matthie" -> "Matthieu", "philipp" -> "Philippiens".
function resolveBook(bookRaw) {
  const key = stripAccents(bookRaw).replace(/\s+/g, ' ').trim();
  if (!key) return undefined;
  if (FR_TO_OSIS[key]) return FR_TO_OSIS[key];
  const nospace = key.replace(/\s+/g, '');
  if (FR_TO_OSIS[nospace]) return FR_TO_OSIS[nospace];
  // Repli par préfixe : une clé connue commence par la saisie, ou l'inverse.
  // On exige au moins 4 caractères de part et d'autre, et on garde la clé la
  // plus proche en longueur pour limiter les ambiguïtés.
  if (key.length >= 4) {
    let best = null;
    for (const k of Object.keys(FR_TO_OSIS)) {
      if (k.length < 4) continue;
      if (k.startsWith(key) || key.startsWith(k)) {
        if (!best || Math.abs(k.length - key.length) < Math.abs(best.length - key.length)) best = k;
      }
    }
    if (best) return FR_TO_OSIS[best];
  }
  return undefined;
}

// Accepte aussi bien "Livre ch:v", "Livre ch:v1-v2" que les références
// groupées non-contiguës "Livre ch:v1, v2" / "Livre ch:v1-v3, v8" (telles que
// produites par mergeAndFormatRefs pour les "preuves"). `ranges` contient
// toutes les sous-plages ; verseStart/verseEnd restent la plage globale
// (min/max) pour la compatibilité avec le code existant (ex. /api/cross-refs).
function parseFrenchRef(ref) {
  const s = (ref || '').trim();
  // On essaie d'abord la forme "Livre chapitre:versets" (le ":"/"." est alors
  // OBLIGATOIRE dans cette branche, pour éviter qu'un nombre de fin de liste
  // de versets — ex. le "16" de "19:1, 16" — soit avalé à tort comme chapitre
  // par un groupe nom-de-livre trop gourmand).
  let m = s.match(/^(.*\S)\s+(\d+)[:.]\s*([\d,\s–-]+)$/);
  let book, chapter, versesStr = null;
  if (m) {
    book = m[1]; chapter = parseInt(m[2], 10); versesStr = m[3];
  } else {
    m = s.match(/^(.*\S)\s+(\d+)$/);
    if (!m) return null;
    book = m[1]; chapter = parseInt(m[2], 10);
  }
  const osis = resolveBook(book);
  if (!osis) return null;
  const ranges = versesStr ? mergeRanges(parseVerseList(versesStr)) : [];
  const verseStart = ranges.length ? ranges[0].verseStart : null;
  const verseEnd = ranges.length ? ranges[ranges.length - 1].verseEnd : verseStart;
  return { osis, chapter, verseStart, verseEnd, ranges };
}

async function loadCrossRefIndex() {
  if (crossRefIndex) return crossRefIndex;
  if (crossRefLoading) return crossRefLoading;
  crossRefLoading = (async () => {
    const resp = await fetch(CROSSREF_URL);
    const text = await resp.text();
    const idx = new Map();
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line || line.startsWith('From') || line.startsWith('#')) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const fromRef = parts[0], toRef = parts[1], votesStr = parts[2];
      const fm = fromRef.match(/^(\d?[A-Za-z]+)\.(\d+)\.(\d+)$/);
      if (!fm) continue;
      const fromKey = fm[1] + '.' + fm[2] + '.' + fm[3];
      const tm = toRef.match(/^(\d?[A-Za-z]+)\.(\d+)\.(\d+)(?:-(\d?[A-Za-z]+)\.(\d+)\.(\d+))?$/);
      if (!tm) continue;
      const votes = parseInt(votesStr, 10) || 0;
      const entry = {
        toBook: tm[1],
        toChap1: parseInt(tm[2], 10), toV1: parseInt(tm[3], 10),
        toChap2: tm[5] ? parseInt(tm[5], 10) : parseInt(tm[2], 10),
        toV2: tm[6] ? parseInt(tm[6], 10) : parseInt(tm[3], 10),
        votes
      };
      if (!idx.has(fromKey)) idx.set(fromKey, []);
      idx.get(fromKey).push(entry);
    }
    crossRefIndex = idx;
    console.log(`Cross-references chargées : ${idx.size} versets sources.`);
    return idx;
  })().catch(err => {
    crossRefLoading = null; // permet de réessayer au prochain appel
    throw err;
  });
  return crossRefLoading;
}

function formatFrRef(osisBook, chap1, v1, chap2, v2) {
  const fr = OSIS_TO_FR[osisBook] || osisBook;
  if (chap1 === chap2) {
    return v1 === v2 ? `${fr} ${chap1}:${v1}` : `${fr} ${chap1}:${v1}-${v2}`;
  }
  return `${fr} ${chap1}:${v1}-${chap2}:${v2}`;
}

// Route appelée par index.html avant de construire le prompt :
// GET /api/cross-refs?ref=Jean 3:16-17
// Priorité 1 : les références imprimées dans la Bible Segond 1910 elle-même
// (notes \xt du fichier LSG). Si aucune trouvée, on retombe sur la base
// OpenBible.info (vote-based) à titre de filet de sécurité.
app.get('/api/cross-refs', async (req, res) => {
  try {
    const ref = (req.query.ref || '').toString();
    const parsed = parseFrenchRef(ref);
    if (!parsed) {
      return res.status(400).json({ error: { message: 'Référence non reconnue : ' + ref } });
    }
    const vStart = parsed.verseStart || 1;
    const vEnd = parsed.verseEnd || vStart;

    let top = [];
    let source = 'lsg-section';
    try {
      await loadLsgIndex();
      const usfm3 = OSIS_TO_USFM3[parsed.osis];

      // PRIORITÉ : les références croisées IMPRIMÉES EN TÊTE DE PÉRICOPE (note
      // \r de section). C'est la liste exacte et concise voulue (ex. Psaume 23 :
      // És 40:11, Éz 34:11-31, Jn 10:10-30, Ap 7:16-17). On NE fusionne PAS les
      // notes par verset (qui gonfleraient artificiellement la liste).
      if (usfm3 && lsgSectionXrefIndex) {
        const items = [];
        for (let v = vStart; v <= vEnd; v++) {
          items.push(...(lsgSectionXrefIndex.get(usfm3 + '.' + parsed.chapter + '.' + v) || []));
        }
        if (items.length) top = mergeAndFormatRefs(items, 15);
      }

      // SECOURS 1 : si la péricope n'a pas de note de section, on prend les
      // notes \xt par verset (agrégées et dédupliquées).
      if (!top.length && usfm3 && lsgXrefIndex) {
        source = 'lsg-verse';
        const items = [];
        for (let v = vStart; v <= vEnd; v++) {
          items.push(...(lsgXrefIndex.get(usfm3 + '.' + parsed.chapter + '.' + v) || []));
        }
        if (items.length) top = mergeAndFormatRefs(items, 12);
      }
    } catch (e) {
      console.error('Erreur lecture xrefs LSG:', e);
    }

    // Filet de sécurité : OpenBible.info, si la Bible Segond n'a aucune note pour ce passage
    if (!top.length) {
      source = 'openbible';
      const idx = await loadCrossRefIndex();
      const combined = new Map();
      for (let v = vStart; v <= vEnd; v++) {
        const key = parsed.osis + '.' + parsed.chapter + '.' + v;
        const entries = idx.get(key) || [];
        for (const e of entries) {
          const k = `${e.toBook}.${e.toChap1}.${e.toV1}-${e.toChap2}.${e.toV2}`;
          if (combined.has(k)) combined.get(k).votes += e.votes;
          else combined.set(k, { ...e });
        }
      }
      const sorted = Array.from(combined.values()).sort((a, b) => b.votes - a.votes);
      top = sorted.slice(0, 10).map(e => formatFrRef(e.toBook, e.toChap1, e.toV1, e.toChap2, e.toV2));
    }

    res.json({ ref, references: top, source });
  } catch (err) {
    console.error('Erreur cross-refs:', err);
    res.status(500).json({ error: { message: 'Erreur cross-refs : ' + err.message } });
  }
});

// ── TEXTE BIBLIQUE LSG1910 VERBATIM ──
// Source : BibleCorps/FRA-B-LSG1910-PD-UBS (Louis Segond 1910, domaine public),
// au format USFM (.sfm). On télécharge les 66 livres une seule fois (mis en
// cache en mémoire), on les nettoie du balisage USFM, et on répond aux
// requêtes /api/verse-text avec le texte EXACT de n'importe quelle référence
// (verset unique ou plage), plutôt que de laisser l'IA reformuler le texte.
const LSG_BASE_URL = 'https://raw.githubusercontent.com/BibleCorps/FRA-B-LSG1910-PD-UBS/main/p.sfm/FRA%5BB%5DLSG1910%5BPD%5DUBS-';

// [numéro de fichier, code OSIS (réutilisé depuis le module cross-refs), code USFM 3 lettres]
const LSG_BOOKS = [
  ['01','Gen','GEN'],['02','Exod','EXO'],['03','Lev','LEV'],['04','Num','NUM'],['05','Deut','DEU'],
  ['06','Josh','JOS'],['07','Judg','JDG'],['08','Ruth','RUT'],['09','1Sam','1SA'],['10','2Sam','2SA'],
  ['11','1Kgs','1KI'],['12','2Kgs','2KI'],['13','1Chr','1CH'],['14','2Chr','2CH'],['15','Ezra','EZR'],
  ['16','Neh','NEH'],['17','Esth','EST'],['18','Job','JOB'],['19','Ps','PSA'],['20','Prov','PRO'],
  ['21','Eccl','ECC'],['22','Song','SNG'],['23','Isa','ISA'],['24','Jer','JER'],['25','Lam','LAM'],
  ['26','Ezek','EZK'],['27','Dan','DAN'],['28','Hos','HOS'],['29','Joel','JOL'],['30','Amos','AMO'],
  ['31','Obad','OBA'],['32','Jonah','JON'],['33','Mic','MIC'],['34','Nah','NAM'],['35','Hab','HAB'],
  ['36','Zeph','ZEP'],['37','Hag','HAG'],['38','Zech','ZEC'],['39','Mal','MAL'],
  ['41','Matt','MAT'],['42','Mark','MRK'],['43','Luke','LUK'],['44','John','JHN'],['45','Acts','ACT'],
  ['46','Rom','ROM'],['47','1Cor','1CO'],['48','2Cor','2CO'],['49','Gal','GAL'],['50','Eph','EPH'],
  ['51','Phil','PHP'],['52','Col','COL'],['53','1Thess','1TH'],['54','2Thess','2TH'],['55','1Tim','1TI'],
  ['56','2Tim','2TI'],['57','Titus','TIT'],['58','Phlm','PHM'],['59','Heb','HEB'],['60','Jas','JAS'],
  ['61','1Pet','1PE'],['62','2Pet','2PE'],['63','1John','1JN'],['64','2John','2JN'],['65','3John','3JN'],
  ['66','Jude','JUD'],['67','Rev','REV']
];
const OSIS_TO_USFM3 = {};
for (const [, osis, usfm3] of LSG_BOOKS) OSIS_TO_USFM3[osis] = usfm3;

// Marqueurs USFM qui ne contiennent jamais de texte de verset (titres, intro, tables, etc.)
const SFM_SKIP_MARKERS = new Set([
  'id','ide','ie','h','toc1','toc2','toc3','mt','mt1','mt2','mt3','imt','imt1','imt2','imt3',
  'ip','io1','io2','io3','ior','rem','tr','tc1','tc2','tc3','ib','b','s','s1','s2','s3','r',
  'd','sp','periph','is','iot','cl','cp','restore'
]);

function cleanSfmText(raw) {
  return raw
    .replace(/\s+/g, ' ')
    .trim();
}

// Abréviations françaises "Segond" utilisées dans les notes \xt du fichier
// USFM lui-même (ex. "Ro 5:8", "1 Jn 4:9", "Ge 3:15; 22:18") — c'est la
// référence croisée IMPRIMÉE dans la Bible Segond 1910, donc la source la
// plus fidèle possible pour la section "preuves".
const ABBREV_TO_OSIS = {
  ge:'Gen', ex:'Exod', le:'Lev', no:'Num', de:'Deut', jos:'Josh', jg:'Judg', ru:'Ruth',
  '1s':'1Sam', '2s':'2Sam', '1r':'1Kgs', '2r':'2Kgs', '1ch':'1Chr', '2ch':'2Chr',
  esd:'Ezra', ne:'Neh', est:'Esth', job:'Job', ps:'Ps', pr:'Prov', ec:'Eccl', ca:'Song',
  es:'Isa', je:'Jer', la:'Lam', ez:'Ezek', da:'Dan', os:'Hos', joe:'Joel', am:'Amos',
  ab:'Obad', jon:'Jonah', mi:'Mic', na:'Nah', ha:'Hab', so:'Zeph', ag:'Hag', za:'Zech', mal:'Mal',
  mt:'Matt', mc:'Mark', lu:'Luke', jn:'John', ac:'Acts', ro:'Rom', '1co':'1Cor', '2co':'2Cor',
  ga:'Gal', ep:'Eph', ph:'Phil', col:'Col', '1th':'1Thess', '2th':'2Thess', '1ti':'1Tim', '2ti':'2Tim',
  tit:'Titus', phm:'Phlm', he:'Heb', ja:'Jas', '1pi':'1Pet', '2pi':'2Pet',
  '1jn':'1John', '2jn':'2John', '3jn':'3John', jude:'Jude', ap:'Rev'
};

// Découpe une liste de versets façon "9-20" ou "9, 10" ou "9-11, 15" en
// plages {verseStart, verseEnd}.
function parseVerseList(versesStr) {
  return versesStr.split(',').map(tok => tok.trim()).filter(Boolean).map(tok => {
    const r = tok.match(/^(\d+)(?:[-–](\d+))?$/);
    if (!r) return null;
    const vs = parseInt(r[1], 10);
    const ve = r[2] ? parseInt(r[2], 10) : vs;
    return { verseStart: vs, verseEnd: ve };
  }).filter(Boolean);
}

// Fusionne uniquement les plages VRAIMENT adjacentes/qui se recouvrent
// (ex. [1,1] et [2,5] -> [1,5]) ; deux versets éloignés (ex. 1 et 16)
// restent deux plages distinctes au sein de la même référence groupée.
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.verseStart - b.verseStart);
  const merged = [];
  for (const r of sorted) {
    const last = merged.length ? merged[merged.length - 1] : null;
    if (last && r.verseStart <= last.verseEnd + 1) {
      last.verseEnd = Math.max(last.verseEnd, r.verseEnd);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

// Découpe le contenu brut d'une note \xt (ex. "Ge 3:15; 22:18. Es 19:1, 16. ")
// en une liste de références groupées {osis, chapter, ranges:[{verseStart,verseEnd}]}.
// Chaque "clause" du texte source (ex. "19:1, 16") devient UNE seule référence
// groupée — exactement comme elle est imprimée dans la Bible Segond — plutôt
// que d'être éclatée en plusieurs cartes "preuves" séparées.
function parseXtRefs(raw) {
  const refs = [];
  const segments = raw.split('.').map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const parts = seg.split(';').map(s => s.trim()).filter(Boolean);
    let currentOsis = null;
    for (const part of parts) {
      let osis, chapter, versesStr = null, wholeChapter = false;
      let m = part.match(/^(\d\s?[A-Za-zÀ-ÿ]+|[A-Za-zÀ-ÿ]+)\s+(\d+):\s*([\d,\s–-]+)/);
      if (m) {
        // a) "Livre ch:versets" (ex. "De 32:1-29")
        const abbrevKey = stripAccents(m[1]).replace(/\s+/g, '');
        osis = ABBREV_TO_OSIS[abbrevKey];
        if (osis) currentOsis = osis;
        chapter = parseInt(m[2], 10);
        versesStr = m[3];
      } else if ((m = part.match(/^(\d\s?[A-Za-zÀ-ÿ]+|[A-Za-zÀ-ÿ]+)\s+(\d+)\s*$/))) {
        // b) "Livre ch" — CHAPITRE ENTIER sans verset (ex. "2 Ch 28", "Ps 15")
        const abbrevKey = stripAccents(m[1]).replace(/\s+/g, '');
        osis = ABBREV_TO_OSIS[abbrevKey];
        if (osis) currentOsis = osis;
        chapter = parseInt(m[2], 10);
        wholeChapter = true;
      } else if (currentOsis && (m = part.match(/^(\d+):\s*([\d,\s–-]+)/))) {
        // c) "ch:versets" (même livre que la référence précédente)
        osis = currentOsis;
        chapter = parseInt(m[1], 10);
        versesStr = m[2];
      } else if (currentOsis && (m = part.match(/^(\d+)\s*$/))) {
        // d) "ch" seul — chapitre entier, même livre
        osis = currentOsis;
        chapter = parseInt(m[1], 10);
        wholeChapter = true;
      } else {
        continue;
      }
      if (!osis) continue;
      if (wholeChapter) {
        refs.push({ osis, chapter, ranges: [] }); // ranges vide = chapitre entier
      } else {
        const ranges = mergeRanges(parseVerseList(versesStr));
        if (ranges.length) refs.push({ osis, chapter, ranges });
      }
    }
  }
  return refs;
}

// Formate une référence groupée, ex. {osis:'Isa',chapter:19,ranges:[{1,1},{16,16}]}
// -> "Ésaïe 19:1, 16" ; {osis:'1Cor',chapter:15,ranges:[{9,10}]} -> "1 Corinthiens 15:9-10".
function formatFrRefRanges(osisBook, chapter, ranges) {
  const fr = OSIS_TO_FR[osisBook] || osisBook;
  if (!ranges || !ranges.length) return `${fr} ${chapter}`; // chapitre entier (ex. "2 Chroniques 28")
  const parts = ranges.map(r => r.verseStart === r.verseEnd ? `${r.verseStart}` : `${r.verseStart}-${r.verseEnd}`);
  return `${fr} ${chapter}:${parts.join(', ')}`;
}

// Déduplique les références groupées identiques (la même note de section est
// répétée pour chaque verset de la péricope demandée) et les formate.
function mergeAndFormatRefs(items, limit) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const formatted = formatFrRefRanges(it.osis, it.chapter, it.ranges);
    // Déduplication sur le TEXTE FINAL affiché (évite tout doublon visible,
    // ex. "Deutéronome 32:1" provenant à la fois de la note de section et d'une note \xt).
    const key = formatted.replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(formatted);
    if (out.length >= limit) break;
  }
  return out;
}

// Tokenise tout le fichier en alternant segments de texte et balises USFM,
// puis reconstitue verset par verset. Plusieurs balises peuvent apparaître
// sur une même ligne (fréquent en poésie, ex. "\q1 \v 1 ..."), donc on ne
// peut pas traiter le fichier ligne par ligne.
// Retourne { texts: Map, xrefs: Map } — xrefs contient, pour chaque verset,
// les références croisées imprimées dans la Bible Segond elle-même.
function parseSfmFile(text, usfm3) {
  const verses = new Map(); // `${chapter}.${verse}` -> texte brut accumulé
  const xrefRaw = new Map(); // `${chapter}.${verse}` -> contenu brut des notes \xt
  const sectionMarkers = new Map(); // chapter -> [{startVerse, explicitEnd|null, refsText}]
  const maxVerseByChap = new Map(); // chapter -> dernier numéro de verset vu
  let pendingSectionText = null;    // note \r générique en attente de son verset de départ
  let chapter = null;
  let currentKey = null;
  let noteDepth = 0; // >0 = à l'intérieur d'une note \x...\x* ou \f...\f* (à ignorer)
  let xtCapturing = false; // true = on est juste après \xt, le texte qui suit est la référence
  let pendingExpect = null; // 'chapterNum' | 'verseNum' | 'sectionRef' | null

  function appendVerseText(str) {
    if (noteDepth > 0 || !currentKey || !str) return;
    verses.set(currentKey, (verses.get(currentKey) || '') + str);
  }

  const tokenRe = /\\([a-zA-Z][a-zA-Z0-9]*)(\*?)/g;
  let lastIndex = 0, match;
  const tokens = [];
  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) tokens.push({ t: 'text', v: text.slice(lastIndex, match.index) });
    tokens.push({ t: 'tag', name: match[1], star: !!match[2] });
    lastIndex = tokenRe.lastIndex;
  }
  if (lastIndex < text.length) tokens.push({ t: 'text', v: text.slice(lastIndex) });

  for (const tok of tokens) {
    if (tok.t === 'tag') {
      const name = tok.name;
      if (name === 'x' || name === 'f') {
        if (tok.star) { noteDepth = Math.max(0, noteDepth - 1); xtCapturing = false; }
        else { noteDepth += 1; }
        continue;
      }
      if (noteDepth > 0) {
        if (name === 'xt') { xtCapturing = true; continue; }
        xtCapturing = false; // \xo ou toute autre sous-balise : on arrête de capturer
        continue;
      }
      if (name === 'c') { pendingExpect = 'chapterNum'; currentKey = null; continue; }
      if (name === 'v') { pendingExpect = 'verseNum'; continue; }
      if (name === 'r') { pendingExpect = 'sectionRef'; currentKey = null; continue; }
      if (SFM_SKIP_MARKERS.has(name)) { currentKey = null; pendingExpect = null; continue; }
      // Autres balises (\p, \m, \q, \q1, \add, \nd, \wj, etc.) : pas de changement
      // d'état, le texte qui suit continue simplement le verset en cours.
      continue;
    }
    // Token de texte
    if (noteDepth > 0) {
      if (xtCapturing && currentKey) {
        xrefRaw.set(currentKey, (xrefRaw.get(currentKey) || '') + tok.v);
      }
      continue;
    }
    let str = tok.v;
    if (pendingExpect === 'chapterNum') {
      const m = str.match(/^\s*(\d+)/);
      if (m) chapter = parseInt(m[1], 10);
      pendingExpect = null;
      continue; // le reste de la ligne après le numéro de chapitre n'est pas du texte de verset
    }
    if (pendingExpect === 'verseNum') {
      const m = str.match(/^\s*(\d+)([\s\S]*)$/);
      if (m) {
        const vnum = parseInt(m[1], 10);
        currentKey = chapter + '.' + vnum;
        str = m[2];
        if (vnum > (maxVerseByChap.get(chapter) || 0)) maxVerseByChap.set(chapter, vnum);
        // Une note \r générique en attente démarre sa section à CE verset.
        if (pendingSectionText !== null) {
          if (!sectionMarkers.has(chapter)) sectionMarkers.set(chapter, []);
          sectionMarkers.get(chapter).push({ startVerse: vnum, explicitEnd: null, refsText: pendingSectionText });
          pendingSectionText = null;
        }
      }
      pendingExpect = null;
      appendVerseText(str);
      continue;
    }
    if (pendingExpect === 'sectionRef') {
      // Note de section éditoriale \r = références croisées IMPRIMÉES en tête de
      // péricope. Deux formats coexistent dans la Segond :
      //  - "V. 14-21: cf. (No 21:4-9. Jn 12:32, 33.)" → plage explicite
      //  - "És 40:11. Éz 34:11-31. Jn 10:10-30." (Psaumes…) → la section va du
      //    prochain verset jusqu'à la prochaine note \r (ou la fin du chapitre).
      pendingExpect = null;
      const raw = str.trim();
      const m = raw.match(/^V\.?\s*(\d+)(?:[-–](\d+))?\s*:\s*cf\.?\s*([\s\S]*)$/i);
      if (m) {
        const vStart = parseInt(m[1], 10);
        const vEnd = m[2] ? parseInt(m[2], 10) : vStart;
        if (!sectionMarkers.has(chapter)) sectionMarkers.set(chapter, []);
        sectionMarkers.get(chapter).push({ startVerse: vStart, explicitEnd: vEnd, refsText: m[3].replace(/[()]/g, '') });
      } else if (raw) {
        pendingSectionText = raw.replace(/[()]/g, '');
      }
      continue;
    }
    appendVerseText(str);
  }

  const texts = new Map();
  for (const [k, v] of verses.entries()) {
    const clean = cleanSfmText(v);
    if (clean) texts.set(usfm3 + '.' + k, clean);
  }
  const xrefs = new Map();
  for (const [k, raw] of xrefRaw.entries()) {
    const list = parseXtRefs(raw);
    if (list.length) xrefs.set(usfm3 + '.' + k, list);
  }
  const sectionXrefs = new Map();
  const sectionRanges = new Map(); // verset -> {vStart, vEnd} de SA section (péricope imprimée)
  for (const [chap, markers] of sectionMarkers.entries()) {
    const sorted = markers.slice().sort((a, b) => a.startVerse - b.startVerse);
    const maxV = maxVerseByChap.get(chap) || 0;
    for (let i = 0; i < sorted.length; i++) {
      const sec = sorted[i];
      const vStart = sec.startVerse;
      let vEnd;
      if (sec.explicitEnd != null) {
        vEnd = sec.explicitEnd;
      } else {
        const nextStart = (i + 1 < sorted.length) ? sorted[i + 1].startVerse : null;
        vEnd = nextStart ? (nextStart - 1) : (maxV || vStart);
      }
      if (vEnd < vStart) vEnd = vStart;
      for (let v = vStart; v <= vEnd; v++) {
        sectionRanges.set(usfm3 + '.' + chap + '.' + v, { vStart, vEnd });
      }
      const list = parseXtRefs(sec.refsText);
      if (!list.length) continue;
      for (let v = vStart; v <= vEnd; v++) {
        sectionXrefs.set(usfm3 + '.' + chap + '.' + v, list);
      }
    }
  }
  return { texts, xrefs, sectionXrefs, sectionRanges };
}

let lsgIndex = null;
let lsgXrefIndex = null;
let lsgSectionXrefIndex = null;
let lsgSectionRangeIndex = null;
let lsgLoading = null;

async function loadLsgIndex() {
  if (lsgIndex) return lsgIndex;
  if (lsgLoading) return lsgLoading;
  lsgLoading = (async () => {
    const idx = new Map();
    const xrefIdx = new Map();
    const sectionIdx = new Map();
    const sectionRangeIdx = new Map();
    const results = await Promise.all(LSG_BOOKS.map(async ([num, , usfm3]) => {
      const url = `${LSG_BASE_URL}${num}-${usfm3}.p.sfm`;
      try {
        const resp = await fetch(url);
        if (!resp.ok) { console.error(`LSG: échec ${usfm3} (${resp.status})`); return null; }
        const text = await resp.text();
        return parseSfmFile(text, usfm3);
      } catch (e) {
        console.error(`LSG: erreur ${usfm3}: ${e.message}`);
        return null;
      }
    }));
    for (const book of results) {
      if (!book) continue;
      for (const [k, v] of book.texts.entries()) idx.set(k, v);
      for (const [k, v] of book.xrefs.entries()) xrefIdx.set(k, v);
      for (const [k, v] of book.sectionXrefs.entries()) sectionIdx.set(k, v);
      for (const [k, v] of book.sectionRanges.entries()) sectionRangeIdx.set(k, v);
    }
    lsgIndex = idx;
    lsgXrefIndex = xrefIdx;
    lsgSectionXrefIndex = sectionIdx;
    lsgSectionRangeIndex = sectionRangeIdx;
    console.log(`LSG1910 chargé : ${idx.size} versets indexés, ${xrefIdx.size} versets avec xrefs, ${sectionIdx.size} versets avec note de section.`);
    return idx;
  })().catch(err => {
    lsgLoading = null;
    throw err;
  });
  return lsgLoading;
}

// Retourne { verses: [{n, texte}], text } pour une référence française (verset,
// plage, ou référence groupée non-contiguë "ch:v1, v2-v3" — toutes les sous-
// plages sont parcourues, dans l'ordre).
async function getVerbatimText(ref) {
  const parsed = parseFrenchRef(ref);
  if (!parsed) return null;
  const usfm3 = OSIS_TO_USFM3[parsed.osis];
  if (!usfm3) return null;
  const idx = await loadLsgIndex();
  const ranges = (parsed.ranges && parsed.ranges.length)
    ? parsed.ranges
    : [{ verseStart: parsed.verseStart || 1, verseEnd: parsed.verseEnd || parsed.verseStart || 1 }];
  const verses = [];
  for (const r of ranges) {
    for (let v = r.verseStart; v <= r.verseEnd; v++) {
      const texte = idx.get(usfm3 + '.' + parsed.chapter + '.' + v);
      if (texte) verses.push({ n: v, texte });
    }
  }
  if (!verses.length) return null;
  const text = verses.length > 1
    ? verses.map(v => `(${v.n}) ${v.texte}`).join(' ')
    : verses[0].texte;
  return { verses, text };
}

// GET /api/verse-text?ref=Jean 3:16-17
app.get('/api/verse-text', async (req, res) => {
  try {
    const ref = (req.query.ref || '').toString();
    const result = await getVerbatimText(ref);
    if (!result) return res.status(404).json({ error: { message: 'Référence introuvable : ' + ref } });
    res.json({ ref, ...result });
  } catch (err) {
    console.error('Erreur verse-text:', err);
    res.status(500).json({ error: { message: 'Erreur verse-text : ' + err.message } });
  }
});

// POST /api/verse-text-batch  { refs: ["Jean 3:16-17", "Romains 5:8", ...] }
app.post('/api/verse-text-batch', async (req, res) => {
  try {
    const refs = Array.isArray(req.body.refs) ? req.body.refs : [];
    const results = {};
    for (const ref of refs) {
      if (results[ref]) continue; // évite de refaire le travail pour des doublons
      const r = await getVerbatimText(ref);
      if (r) results[ref] = r;
    }
    res.json({ results });
  } catch (err) {
    console.error('Erreur verse-text-batch:', err);
    res.status(500).json({ error: { message: 'Erreur verse-text-batch : ' + err.message } });
  }
});

// ── CLASSIFICATION D'UNE RÉFÉRENCE DANS LES 4 PÉRIODES ──
// Sert à placer automatiquement un texte d'explication choisi par
// l'utilisateur (et non par l'IA) dans la bonne période/zone, selon les
// mêmes règles de répartition des livres que celles imposées à l'IA.
const OSIS_TO_PERIODE = {
  Josh: 'histoire', Judg: 'histoire', Ruth: 'histoire', '1Sam': 'histoire', '2Sam': 'histoire',
  '1Kgs': 'histoire', '2Kgs': 'histoire', '1Chr': 'histoire', '2Chr': 'histoire', Ezra: 'histoire',
  Neh: 'histoire', Esth: 'histoire', Acts: 'histoire',
  Gen: 'loi', Exod: 'loi', Lev: 'loi', Num: 'loi', Deut: 'loi', Matt: 'loi', Mark: 'loi', Luke: 'loi', John: 'loi',
  Isa: 'prophetie', Jer: 'prophetie', Lam: 'prophetie', Ezek: 'prophetie', Dan: 'prophetie', Hos: 'prophetie',
  Joel: 'prophetie', Amos: 'prophetie', Obad: 'prophetie', Jonah: 'prophetie', Mic: 'prophetie', Nah: 'prophetie',
  Hab: 'prophetie', Zeph: 'prophetie', Hag: 'prophetie', Zech: 'prophetie', Mal: 'prophetie', Rev: 'prophetie',
  Job: 'poesie', Ps: 'poesie', Prov: 'poesie', Eccl: 'poesie', Song: 'poesie',
  Rom: 'poesie', '1Cor': 'poesie', '2Cor': 'poesie', Gal: 'poesie', Eph: 'poesie', Phil: 'poesie', Col: 'poesie',
  '1Thess': 'poesie', '2Thess': 'poesie', '1Tim': 'poesie', '2Tim': 'poesie', Titus: 'poesie', Phlm: 'poesie',
  Heb: 'poesie', Jas: 'poesie', '1Pet': 'poesie', '2Pet': 'poesie', '1John': 'poesie', '2John': 'poesie',
  '3John': 'poesie', Jude: 'poesie'
};
const OT_OSIS_SET = new Set(LSG_BOOKS.slice(0, 39).map(b => b[1]));
function zoneOfOsis(osis) { return OT_OSIS_SET.has(osis) ? 'at' : 'nt'; }

// GET /api/pericope?ref=Ésaïe 1:1
// Renvoie les bornes de la péricope (la section imprimée « V. x-y » de la
// Bible Segond) qui contient le verset demandé — pour ne pas laisser le modèle
// estimer la plage. { found:true, pericope:"Ésaïe 1:1-9", verseStart, verseEnd }
app.get('/api/pericope', async (req, res) => {
  try {
    const ref = (req.query.ref || '').toString();
    const parsed = parseFrenchRef(ref);
    if (!parsed) return res.status(400).json({ error: { message: 'Référence non reconnue : ' + ref } });
    await loadLsgIndex();
    const usfm3 = OSIS_TO_USFM3[parsed.osis];
    const v = parsed.verseStart || 1;
    const range = (usfm3 && lsgSectionRangeIndex)
      ? lsgSectionRangeIndex.get(usfm3 + '.' + parsed.chapter + '.' + v)
      : null;
    if (!range) return res.json({ ref, found: false });
    const fr = OSIS_TO_FR[parsed.osis] || parsed.osis;
    const pericope = range.vStart === range.vEnd
      ? `${fr} ${parsed.chapter}:${range.vStart}`
      : `${fr} ${parsed.chapter}:${range.vStart}-${range.vEnd}`;
    res.json({ ref, found: true, pericope, verseStart: range.vStart, verseEnd: range.vEnd });
  } catch (err) {
    console.error('Erreur pericope:', err);
    res.status(500).json({ error: { message: 'Erreur pericope : ' + err.message } });
  }
});

// GET /api/classify-ref?ref=Romains 8:28
app.get('/api/classify-ref', async (req, res) => {
  try {
    const ref = (req.query.ref || '').toString();
    const parsed = parseFrenchRef(ref);
    if (!parsed) return res.status(400).json({ error: { message: 'Référence non reconnue : ' + ref } });
    const periode = OSIS_TO_PERIODE[parsed.osis];
    if (!periode) return res.status(400).json({ error: { message: 'Ce livre ne correspond à aucune des 4 périodes de la méthode Dr. Arkad.' } });
    const zone = zoneOfOsis(parsed.osis);
    const vt = await getVerbatimText(ref);
    if (!vt) return res.status(404).json({ error: { message: 'Verset introuvable : ' + ref } });
    const ranges = (parsed.ranges && parsed.ranges.length) ? parsed.ranges : [{ verseStart: parsed.verseStart, verseEnd: parsed.verseEnd }];
    const frRef = formatFrRefRanges(parsed.osis, parsed.chapter, ranges);
    res.json({ ref: frRef, periode, zone, texte: vt.text });
  } catch (err) {
    console.error('Erreur classify-ref:', err);
    res.status(500).json({ error: { message: 'Erreur classify-ref : ' + err.message } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy PÉNIEL — Étude biblique en écoute sur le port ${PORT}`);
});
