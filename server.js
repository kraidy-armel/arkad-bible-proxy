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
  res.send('✅ EFBC Mission God proxy en ligne.');
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

    // Priorité 1 : annotations Segond 1910 elles-mêmes
    let top = [];
    let source = 'lsg';
    try {
      await loadLsgIndex();
      const usfm3 = OSIS_TO_USFM3[parsed.osis];
      if (usfm3 && lsgXrefIndex) {
        const seen = new Set();
        const ordered = [];
        for (let v = vStart; v <= vEnd; v++) {
          const list = lsgXrefIndex.get(usfm3 + '.' + parsed.chapter + '.' + v) || [];
          for (const r of list) {
            const k = `${r.osis}.${r.chapter}.${r.verse}`;
            if (seen.has(k)) continue;
            seen.add(k);
            ordered.push(formatFrRef(r.osis, r.chapter, r.verse, r.chapter, r.verse));
          }
        }
        top = ordered.slice(0, 12);
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

// Découpe le contenu brut d'une note \xt (ex. "Ge 3:15; 22:18. Mt 1:1. ")
// en une liste de références {osis, chapter, verse}.
function parseXtRefs(raw) {
  const refs = [];
  const segments = raw.split('.').map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const parts = seg.split(';').map(s => s.trim()).filter(Boolean);
    let currentOsis = null;
    for (const part of parts) {
      const m = part.match(/^(\d\s?[A-Za-zÀ-ÿ]+|[A-Za-zÀ-ÿ]+)\s+(\d+):\s*(\d+(?:[\s,]+\d+)*)/);
      let osis, chapter, versesStr;
      if (m) {
        const abbrevKey = stripAccents(m[1]).replace(/\s+/g, '');
        osis = ABBREV_TO_OSIS[abbrevKey];
        if (osis) currentOsis = osis;
        chapter = parseInt(m[2], 10);
        versesStr = m[3];
      } else if (currentOsis) {
        const m2 = part.match(/^(\d+):\s*(\d+(?:[\s,]+\d+)*)/);
        if (!m2) continue;
        osis = currentOsis;
        chapter = parseInt(m2[1], 10);
        versesStr = m2[2];
      } else {
        continue;
      }
      if (!osis) continue;
      const verseNums = versesStr.split(',').map(v => parseInt(v.trim(), 10)).filter(n => !isNaN(n));
      for (const v of verseNums) refs.push({ osis, chapter, verse: v });
    }
  }
  return refs;
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
  let chapter = null;
  let currentKey = null;
  let noteDepth = 0; // >0 = à l'intérieur d'une note \x...\x* ou \f...\f* (à ignorer)
  let xtCapturing = false; // true = on est juste après \xt, le texte qui suit est la référence
  let pendingExpect = null; // 'chapterNum' | 'verseNum' | null

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
        currentKey = chapter + '.' + parseInt(m[1], 10);
        str = m[2];
      }
      pendingExpect = null;
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
  return { texts, xrefs };
}

let lsgIndex = null;
let lsgXrefIndex = null;
let lsgLoading = null;

async function loadLsgIndex() {
  if (lsgIndex) return lsgIndex;
  if (lsgLoading) return lsgLoading;
  lsgLoading = (async () => {
    const idx = new Map();
    const xrefIdx = new Map();
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
    }
    lsgIndex = idx;
    lsgXrefIndex = xrefIdx;
    console.log(`LSG1910 chargé : ${idx.size} versets indexés, ${xrefIdx.size} versets avec références croisées.`);
    return idx;
  })().catch(err => {
    lsgLoading = null;
    throw err;
  });
  return lsgLoading;
}

// Retourne { verses: [{n, texte}], text } pour une référence française (verset ou plage).
async function getVerbatimText(ref) {
  const parsed = parseFrenchRef(ref);
  if (!parsed) return null;
  const usfm3 = OSIS_TO_USFM3[parsed.osis];
  if (!usfm3) return null;
  const idx = await loadLsgIndex();
  const vStart = parsed.verseStart || 1;
  const vEnd = parsed.verseEnd || vStart;
  const verses = [];
  for (let v = vStart; v <= vEnd; v++) {
    const texte = idx.get(usfm3 + '.' + parsed.chapter + '.' + v);
    if (texte) verses.push({ n: v, texte });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy EFBC Mission God en écoute sur le port ${PORT}`);
});
