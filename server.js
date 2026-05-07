require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'zappie-secret',
  resave: false,
  saveUninitialized: false
}));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:3000/auth/callback'
  );
}

app.get('/auth/google', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email'
    ]
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(req.query.code);
  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  req.session.tokens = tokens;
  req.session.email = data.email;
  res.redirect('/dashboard');
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/api/me', (req, res) => {
  if (!req.session.tokens) return res.json({ connected: false });
  res.json({ connected: true, email: req.session.email });
});

async function getGmailClient(tokens) {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

async function ensureZappieLabel(gmail) {
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  let label = data.labels.find(l => l.name === 'Zappie');
  if (!label) {
    const res = await gmail.users.labels.create({
      userId: 'me',
      requestBody: {
        name: 'Zappie',
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
        color: { backgroundColor: '#b694e8', textColor: '#000000' }
      }
    });
    label = res.data;
  }
  return label.id;
}

async function analyzeEmailWithAI(subject, from, snippet) {
  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `Analyse cet email et réponds UNIQUEMENT par "IMPORTANT" ou "INUTILE".

De: ${from}
Sujet: ${subject}
Aperçu: ${snippet}

Règles STRICTES:
- IMPORTANT = emails personnels d'une vraie personne, emails professionnels urgents, factures à payer, rendez-vous, emails bancaires
- INUTILE = promotions magasins, notifications apps (Facebook, Instagram, TikTok), newsletters, publicités, emails de réseaux sociaux, fidélité. En cas de doute, classe INUTILE. Sois très strict.

Réponds uniquement: IMPORTANT ou INUTILE`
    }]
  });
  return message.content[0].text.trim().includes('IMPORTANT') ? 'IMPORTANT' : 'INUTILE';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

app.post('/api/analyze', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const labelId = await ensureZappieLabel(gmail);
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 500,
      q: 'is:unread -label:Zappie'
    });
    if (!data.messages || data.messages.length === 0) {
      return res.json({ processed: 0, moved: 0, results: [] });
    }
    const results = [];
    let moved = 0;
    for (const msg of data.messages) {
      const { data: full } = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From']
      });
      const headers = full.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '(sans sujet)';
      const from = headers.find(h => h.name === 'From')?.value || 'Inconnu';
      const snippet = full.snippet || '';
      const decision = await analyzeEmailWithAI(subject, from, snippet);
      if (decision === 'INUTILE') {
        await gmail.users.messages.modify({
          userId: 'me',
          id: msg.id,
          requestBody: { addLabelIds: [labelId], removeLabelIds: ['INBOX'] }
        });
        moved++;
      }
      results.push({ id: msg.id, subject, from, decision });
    }
    res.json({ processed: data.messages.length, moved, results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/zappie-emails', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data: labelsData } = await gmail.users.labels.list({ userId: 'me' });
    const label = labelsData.labels.find(l => l.name === 'Zappie');
    if (!label) return res.json({ emails: [], total: 0 });
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      labelIds: [label.id],
      maxResults: 50
    });
    if (!data.messages) return res.json({ emails: [], total: 0 });
    const emails = [];
    for (const msg of data.messages.slice(0, 10)) {
      const { data: full } = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date']
      });
      const headers = full.payload.headers;
      emails.push({
        id: msg.id,
        subject: headers.find(h => h.name === 'Subject')?.value || '(sans sujet)',
        from: headers.find(h => h.name === 'From')?.value || 'Inconnu',
        date: headers.find(h => h.name === 'Date')?.value || '',
        snippet: full.snippet
      });
    }
    res.json({ emails, total: data.messages.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/restore/:id', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data: labelsData } = await gmail.users.labels.list({ userId: 'me' });
    const label = labelsData.labels.find(l => l.name === 'Zappie');
    await gmail.users.messages.modify({
      userId: 'me',
      id: req.params.id,
      requestBody: { addLabelIds: ['INBOX'], removeLabelIds: label ? [label.id] : [] }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/storage', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 100,
      q: 'has:attachment larger:1M'
    });
    if (!data.messages) return res.json({ emails: [], totalSize: 0, totalSizeFormatted: '0 B' });
    const emails = [];
    let totalSize = 0;
    for (const msg of data.messages.slice(0, 20)) {
      const { data: full } = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date']
      });
      const headers = full.payload.headers;
      const size = full.sizeEstimate || 0;
      totalSize += size;
      emails.push({
        id: msg.id,
        subject: headers.find(h => h.name === 'Subject')?.value || '(sans sujet)',
        from: headers.find(h => h.name === 'From')?.value || 'Inconnu',
        date: headers.find(h => h.name === 'Date')?.value || '',
        size,
        sizeFormatted: formatSize(size)
      });
    }
    emails.sort((a, b) => b.size - a.size);
    res.json({ emails, totalSize, totalSizeFormatted: formatSize(totalSize) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/delete/:id', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    await gmail.users.messages.trash({ userId: 'me', id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/archive-old', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const dateStr = `${oneYearAgo.getFullYear()}/${String(oneYearAgo.getMonth() + 1).padStart(2, '0')}/${String(oneYearAgo.getDate()).padStart(2, '0')}`;
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 500,
      q: `in:inbox before:${dateStr}`
    });
    if (!data.messages) return res.json({ archived: 0 });
    let archived = 0;
    for (const msg of data.messages) {
      await gmail.users.messages.modify({
        userId: 'me',
        id: msg.id,
        requestBody: { removeLabelIds: ['INBOX'] }
      });
      archived++;
    }
    res.json({ archived });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/daily-summary', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const today = new Date();
    const dateStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 20,
      q: `in:inbox after:${dateStr} -label:Zappie`
    });
    if (!data.messages) return res.json({ summary: 'Aucun email important aujourd\'hui ! 🎉', emails: [], count: 0 });
    const emails = [];
    for (const msg of data.messages.slice(0, 10)) {
      const { data: full } = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From']
      });
      const headers = full.payload.headers;
      emails.push({
        subject: headers.find(h => h.name === 'Subject')?.value || '(sans sujet)',
        from: headers.find(h => h.name === 'From')?.value || 'Inconnu',
        snippet: full.snippet
      });
    }
    const summaryMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Voici les emails importants reçus aujourd'hui. Fais un résumé court en français (3-5 bullet points max) de ce qui nécessite une action :

${emails.map(e => `- De: ${e.from}\n  Sujet: ${e.subject}\n  Aperçu: ${e.snippet}`).join('\n\n')}

Résume en bullet points courts et actionables.`
      }]
    });
    res.json({ summary: summaryMsg.content[0].text, emails, count: emails.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Zappie tourne sur http://localhost:${PORT}`));

// 🆕 Détecter les inscriptions
app.get('/api/subscriptions', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 200,
      q: 'subject:(bienvenue OR welcome OR "compte créé" OR "account created" OR "merci de vous être inscrit" OR "thank you for registering" OR "verify your email" OR "confirmez votre email" OR "activation de votre compte")'
    });
    if (!data.messages) return res.json({ subscriptions: [] });
    const subscriptions = [];
    const seen = new Set();
    for (const msg of data.messages.slice(0, 50)) {
      const { data: full } = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date']
      });
      const headers = full.payload.headers;
      const from = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      // Extraire le domaine
      const domainMatch = from.match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      const domain = domainMatch ? domainMatch[1].replace(/^mail\.|^email\.|^noreply\.|^no-reply\./, '') : null;
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      subscriptions.push({ id: msg.id, from, subject, date, domain });
    }
    res.json({ subscriptions, total: subscriptions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🆕 Envoyer email de suppression de compte
app.post('/api/unsubscribe', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const { domain, fromEmail } = req.body;
  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(req.session.tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Générer un email de demande de suppression avec l'IA
    const aiMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Rédige un email court et professionnel en français pour demander la suppression de mon compte sur le site ${domain}. 
L'email doit être adressé à leur support, demander clairement la suppression du compte et de toutes mes données personnelles (conformément au RGPD), et rester poli. 
Génère uniquement le corps de l'email, sans objet ni signature.`
      }]
    });

    const emailBody = aiMsg.content[0].text;
    const supportEmail = `support@${domain}`;
    const subject = `Demande de suppression de compte - ${domain}`;

    // Encoder l'email en base64
    const emailContent = [
      `To: ${supportEmail}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      emailBody
    ].join('\n');

    const encoded = Buffer.from(emailContent).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encoded }
    });

    res.json({ success: true, emailBody, supportEmail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
