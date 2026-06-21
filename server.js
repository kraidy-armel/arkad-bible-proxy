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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy Arkad Bible en écoute sur le port ${PORT}`);
});
