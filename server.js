// server.js — Proxy Anthropic pour Arkad Bible
// Rôle : recevoir les requêtes du navigateur (index.html), y ajouter la clé API
// Anthropic côté serveur (jamais exposée au client), et renvoyer la réponse.
// Cela élimine l'erreur CORS car l'appel à api.anthropic.com se fait
// maintenant serveur-à-serveur, plus depuis le navigateur.

const express = require('express');
const cors = require('cors');

const app = express();

// Autorise les requêtes cross-origin (GitHub Pages -> Render).
// Vous pouvez restreindre à votre domaine GitHub Pages une fois que tout fonctionne :
// app.use(cors({ origin: 'https://VOTRE-COMPTE.github.io' }));
app.use(cors());

app.use(express.json({ limit: '2mb' }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Route de vérification (pratique pour tester que le serveur est en ligne)
app.get('/', (req, res) => {
  res.send('✅ Arkad Bible proxy en ligne.');
});

// Route appelée par index.html
app.post('/api/messages', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: { message: 'ANTHROPIC_API_KEY manquante. Configurez-la dans les variables d’environnement Render.' }
    });
  }

  try {
    const anthropicResponse = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify(req.body)
    });

    const data = await anthropicResponse.json();
    res.status(anthropicResponse.status).json(data);
  } catch (err) {
    console.error('Erreur proxy:', err);
    res.status(500).json({ error: { message: 'Erreur du proxy : ' + err.message } });
  }
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
  ez:'Ezek', eze:'Ezek', ezechiel:'Ezek',
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

function parseFrenchRef(ref) {
  const m = (ref || '').trim().match(/^(.*\S)\s+(\d+)(?:[:.](\d+)(?:[-–](\d+))?)?$/);
  if (!m) return null;
  const osis = FR_TO_OSIS[stripAccents(m[1])];
  if (!osis) return null;
  const chapter = parseInt(m[2], 10);
  const verseStart = m[3] ? parseInt(m[3], 10) : null;
  const verseEnd = m[4] ? parseInt(m[4], 10) : verseStart;
  return { osis, chapter, verseStart, verseEnd };
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
app.get('/api/cross-refs', async (req, res) => {
  try {
    const ref = (req.query.ref || '').toString();
    const parsed = parseFrenchRef(ref);
    if (!parsed) {
      return res.status(400).json({ error: { message: 'Référence non reconnue : ' + ref } });
    }
    const idx = await loadCrossRefIndex();
    const vStart = parsed.verseStart || 1;
    const vEnd = parsed.verseEnd || vStart;
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
    const top = sorted.slice(0, 10).map(e => formatFrRef(e.toBook, e.toChap1, e.toV1, e.toChap2, e.toV2));
    res.json({ ref, references: top });
  } catch (err) {
    console.error('Erreur cross-refs:', err);
    res.status(500).json({ error: { message: 'Erreur cross-refs : ' + err.message } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy Arkad Bible en écoute sur le port ${PORT}`);
});
