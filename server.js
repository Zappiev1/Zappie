require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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
    process.env.CALLBACK_URL || 'http://localhost:3000/auth/callback'
  );
}

app.get('/auth/google', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/userinfo.email']
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

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.get('/api/me', async (req, res) => {
  if (!req.session.tokens) return res.json({ connected: false });
  const isPro = await checkIsPro(req.session.email);
  res.json({ connected: true, email: req.session.email, isPro });
});

async function getGmailClient(tokens) {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ─── FREE / PRO HELPER ───────────────────────────────────────────────────────
async function checkIsPro(email) {
  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return false;
    const subscriptions = await stripe.subscriptions.list({
      customer: customers.data[0].id,
      status: 'active',
      limit: 1
    });
    return subscriptions.data.length > 0;
  } catch { return false; }
}


// ─── FREE PLAN: USAGE TRACKER (3x/semaine par feature) ───────────────────────
const weeklyUsage = {}; // { 'email:feature': { count, weekStart } }

function getWeekStart() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(now.setDate(diff));
  monday.setHours(0,0,0,0);
  return monday.getTime();
}

function checkWeeklyLimit(email, feature) {
  const key = email + ':' + feature;
  const weekStart = getWeekStart();
  if (!weeklyUsage[key] || weeklyUsage[key].weekStart !== weekStart) {
    weeklyUsage[key] = { count: 0, weekStart };
  }
  return weeklyUsage[key].count;
}

function incrementWeeklyUsage(email, feature) {
  const key = email + ':' + feature;
  const weekStart = getWeekStart();
  if (!weeklyUsage[key] || weeklyUsage[key].weekStart !== weekStart) {
    weeklyUsage[key] = { count: 0, weekStart };
  }
  weeklyUsage[key].count++;
  return weeklyUsage[key].count;
}

const FREE_LIMIT = 3;

async function ensureZappieLabel(gmail) {
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  let label = data.labels.find(l => l.name === 'Zappie');
  if (!label) {
    const res = await gmail.users.labels.create({
      userId: 'me',
      requestBody: { name: 'Zappie', labelListVisibility: 'labelShow', messageListVisibility: 'show', color: { backgroundColor: '#b694e8', textColor: '#000000' } }
    });
    label = res.data;
  }
  return label.id;
}

async function analyzeEmailWithAI(subject, from, snippet, hasAttachment = false) {
  // Protect emails with attachments always
  if (hasAttachment) return 'IMPORTANT';

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: `Email: De: ${from} | Sujet: ${subject} | Aperçu: ${snippet}
Réponds UNIQUEMENT "IMPORTANT" ou "INUTILE".
IMPORTANT = emails perso, famille, amis, collègues, factures, rendez-vous, banque, livraisons, documents, contrats, urgences, vraies personnes.
INUTILE = promotions, newsletters, notifications automatiques, réseaux sociaux, marketing, pub, spam, offres commerciales, noreply.
Si l'email vient d'une vraie personne: IMPORTANT. En cas de doute: IMPORTANT.`
    }]
  });
  return message.content[0].text.trim().includes('IMPORTANT') ? 'IMPORTANT' : 'INUTILE';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function bytesToEquivalent(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb > 1000) return `~${(mb/1024).toFixed(1)} GB — comme ${Math.round(mb/4)} photos 📸`;
  if (mb > 100) return `~${Math.round(mb/4)} photos 📸`;
  return `~${Math.round(mb/0.5)} emails standards`;
}

// ─── ANALYSE PARALLELE x10 ───────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const labelId = await ensureZappieLabel(gmail);
    const isPro = await checkIsPro(req.session.email);

    // ── Récupère tous les messages (pagination pour Pro, 35 max pour Free) ──
    let allMessages = [];
    if (isPro) {
      let pageToken = undefined;
      do {
        const { data } = await gmail.users.messages.list({
          userId: 'me', maxResults: 500, q: 'is:unread -label:Zappie',
          ...(pageToken ? { pageToken } : {})
        });
        if (data.messages) allMessages.push(...data.messages);
        pageToken = data.nextPageToken;
      } while (pageToken);
    } else {
      const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: 35, q: 'is:unread -label:Zappie' });
      if (data.messages) allMessages = data.messages;
    }

    if (allMessages.length === 0) return res.json({ processed: 0, moved: 0, results: [] });

    // ── Analyse en batches parallèles de 10 (multi-agent IA) ──
    const BATCH = 10;
    let moved = 0;
    const results = [];

    for (let i = 0; i < allMessages.length; i += BATCH) {
      const batch = allMessages.slice(i, i + BATCH);

      // Fetch metadata en parallèle
      const fetched = await Promise.all(batch.map(msg =>
        gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Content-Type'] })
          .then(r => ({ id: msg.id, data: r.data }))
          .catch(() => null)
      ));

      // Analyse séquentielle avec protection PJ
      const analyzed = [];
      for (const item of fetched.filter(Boolean)) {
        const { id, data: full } = item;
        const headers = full.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || '(sans sujet)';
        const from = headers.find(h => h.name === 'From')?.value || 'Inconnu';
        const snippet = full.snippet || '';
        // Detect attachment from payload parts
        const hasAttachment = !!(full.payload.parts && full.payload.parts.some(p => p.filename && p.filename.length > 0)) || full.payload.mimeType === 'multipart/mixed';
        let decision = 'INUTILE';
        let attempts = 0;
        while (attempts < 3) {
          try {
            decision = await analyzeEmailWithAI(subject, from, snippet, hasAttachment);
            break;
          } catch (e) {
            if (e.status === 429) { await new Promise(r => setTimeout(r, 2000 * (attempts + 1))); attempts++; }
            else break;
          }
        }
        analyzed.push({ id, subject, from, snippet, decision, hasAttachment });
        await new Promise(r => setTimeout(r, 150));
      }

      // Move les INUTILE en parallèle
      await Promise.all(analyzed.map(async ({ id, decision }) => {
        if (decision === 'INUTILE') {
          await gmail.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds: [labelId], removeLabelIds: ['INBOX'] } });
          moved++;
        }
      }));

      results.push(...analyzed);
    }

    res.json({ processed: allMessages.length, moved, results, isPro });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get('/api/zappie-emails', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data: labelsData } = await gmail.users.labels.list({ userId: 'me' });
    const label = labelsData.labels.find(l => l.name === 'Zappie');
    if (!label) return res.json({ emails: [], total: 0 });
    const { data } = await gmail.users.messages.list({ userId: 'me', labelIds: [label.id], maxResults: 50 });
    if (!data.messages) return res.json({ emails: [], total: 0 });
    const emails = await Promise.all(data.messages.slice(0, 20).map(async msg => {
      const { data: full } = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
      const headers = full.payload.headers;
      return {
        id: msg.id,
        subject: headers.find(h => h.name === 'Subject')?.value || '(sans sujet)',
        from: headers.find(h => h.name === 'From')?.value || 'Inconnu',
        date: headers.find(h => h.name === 'Date')?.value || '',
        snippet: full.snippet
      };
    }));
    res.json({ emails, total: data.messages.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/restore/:id', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data: labelsData } = await gmail.users.labels.list({ userId: 'me' });
    const label = labelsData.labels.find(l => l.name === 'Zappie');
    await gmail.users.messages.modify({ userId: 'me', id: req.params.id, requestBody: { addLabelIds: ['INBOX'], removeLabelIds: label ? [label.id] : [] } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/delete/:id', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    await gmail.users.messages.trash({ userId: 'me', id: req.params.id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/unsubscribe-sender/:id', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data: labelsData } = await gmail.users.labels.list({ userId: 'me' });
    const label = labelsData.labels.find(l => l.name === 'Zappie');
    // Move to trash and keep in Zappie
    await gmail.users.messages.modify({ userId: 'me', id: req.params.id, requestBody: { addLabelIds: label ? [label.id] : [], removeLabelIds: ['INBOX'] } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/storage', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) {
    const usedStorage = checkWeeklyLimit(req.session.email, 'storage');
    if (usedStorage >= FREE_LIMIT) return res.status(429).json({ error: 'FREE_LIMIT', message: 'Limite hebdomadaire atteinte (3/semaine). Passe à Pro pour un accès illimité 🚀', used: usedStorage, limit: FREE_LIMIT });
    incrementWeeklyUsage(req.session.email, 'storage');
  }
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: 100, q: 'has:attachment larger:1M' });
    if (!data.messages) return res.json({ emails: [], totalSize: 0, totalSizeFormatted: '0 B', equivalent: '' });
    const emails = await Promise.all(data.messages.slice(0, 20).map(async msg => {
      const { data: full } = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
      const headers = full.payload.headers;
      const size = full.sizeEstimate || 0;
      return { id: msg.id, subject: headers.find(h => h.name === 'Subject')?.value || '(sans sujet)', from: headers.find(h => h.name === 'From')?.value || 'Inconnu', date: headers.find(h => h.name === 'Date')?.value || '', size, sizeFormatted: formatSize(size) };
    }));
    emails.sort((a, b) => b.size - a.size);
    const totalSize = emails.reduce((s, e) => s + e.size, 0);
    res.json({ emails, totalSize, totalSizeFormatted: formatSize(totalSize), equivalent: bytesToEquivalent(totalSize), count: data.messages.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/archive-count', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const months = parseInt(req.query.months) || 6;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const dateStr = `${cutoff.getFullYear()}/${String(cutoff.getMonth()+1).padStart(2,'0')}/${String(cutoff.getDate()).padStart(2,'0')}`;
    const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: 1, q: `in:inbox before:${dateStr}` });
    res.json({ count: data.resultSizeEstimate || 0, months });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/archive-old', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) {
    const usedArchive = checkWeeklyLimit(req.session.email, 'archive');
    if (usedArchive >= FREE_LIMIT) return res.status(429).json({ error: 'FREE_LIMIT', message: 'Limite hebdomadaire atteinte (3/semaine). Passe à Pro pour un accès illimité 🚀', used: usedArchive, limit: FREE_LIMIT });
    incrementWeeklyUsage(req.session.email, 'archive');
  }
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const months = parseInt(req.query.months) || 6;
    const oneYearAgo = new Date();
    oneYearAgo.setMonth(oneYearAgo.getMonth() - months);
    const dateStr = `${oneYearAgo.getFullYear()}/${String(oneYearAgo.getMonth()+1).padStart(2,'0')}/${String(oneYearAgo.getDate()).padStart(2,'0')}`;

    // Count inbox before
    const { data: beforeData } = await gmail.users.messages.list({ userId: 'me', maxResults: 1, q: 'in:inbox' });
    const inboxBefore = beforeData.resultSizeEstimate || 0;

    // Get all old emails with pagination
    let allMessages = [];
    let pageToken = undefined;
    do {
      const { data: pageData } = await gmail.users.messages.list({
        userId: 'me', maxResults: 500,
        q: `in:inbox before:${dateStr}`,
        ...(pageToken ? { pageToken } : {})
      });
      if (pageData.messages) allMessages.push(...pageData.messages);
      pageToken = pageData.nextPageToken;
    } while (pageToken);

    if (!allMessages.length) return res.json({ archived: 0, inboxBefore, inboxAfter: inboxBefore, reduction: 0 });

    // Archive in batches of 50
    const BATCH = 50;
    for (let i = 0; i < allMessages.length; i += BATCH) {
      await Promise.all(allMessages.slice(i, i + BATCH).map(msg =>
        gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['INBOX'] } })
      ));
    }

    // Count inbox after
    const { data: afterData } = await gmail.users.messages.list({ userId: 'me', maxResults: 1, q: 'in:inbox' });
    const inboxAfter = afterData.resultSizeEstimate || 0;
    const reduction = inboxBefore > 0 ? Math.round((allMessages.length / inboxBefore) * 100) : 0;

    res.json({ archived: allMessages.length, inboxBefore, inboxAfter, reduction });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/daily-summary', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) {
    const usedSummary = checkWeeklyLimit(req.session.email, 'summary');
    if (usedSummary >= FREE_LIMIT) return res.status(429).json({ error: 'FREE_LIMIT', message: 'Limite hebdomadaire atteinte (3/semaine). Passe à Pro pour un accès illimité 🚀', used: usedSummary, limit: FREE_LIMIT });
    incrementWeeklyUsage(req.session.email, 'summary');
  }
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const today = new Date();
    const dateStr = `${today.getFullYear()}/${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}`;
    const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: 20, q: `in:inbox after:${dateStr} -label:Zappie` });
    if (!data.messages) return res.json({ items: [], intro: 'Aucun email important aujourd\'hui ! 🎉 Profite de ta journée.', count: 0, score: 'Journée légère 🟢' });
    
    const emails = await Promise.all(data.messages.slice(0, 10).map(async msg => {
      const { data: full } = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From'] });
      const headers = full.payload.headers;
      return { subject: headers.find(h => h.name === 'Subject')?.value || '(sans sujet)', from: headers.find(h => h.name === 'From')?.value || 'Inconnu', snippet: full.snippet };
    }));

    const summaryMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Tu es un assistant IA premium. Analyse ces emails et retourne un JSON UNIQUEMENT (pas de markdown, pas de texte avant/après):
{
  "intro": "phrase courte et humaine décrivant la journée (max 15 mots)",
  "score": "Journée légère 🟢 | Journée chargée 🟠 | Journée intense 🔴",
  "items": [
    {
      "priority": "urgent | important | info",
      "category": "💰 Finance | 📦 Commandes | 👤 Personnel | ⚠️ Action requise | 📅 Rendez-vous | 💼 Travail",
      "title": "titre ultra court (max 5 mots)",
      "action": "action recommandée courte ou 'Aucune action'",
      "from": "nom expéditeur court"
    }
  ]
}

Emails:
${emails.map(e => `- De: ${e.from} | Sujet: ${e.subject} | Aperçu: ${e.snippet}`).join('\n')}`
      }]
    });

    let parsed;
    try {
      const text = summaryMsg.content[0].text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(text);
    } catch(e) {
      parsed = { intro: 'Voici tes emails importants du jour.', score: 'Journée 🟡', items: emails.map(e => ({ priority: 'info', category: '📧 Email', title: e.subject.slice(0, 30), action: 'À vérifier', from: e.from.split('<')[0].trim() })) };
    }

    res.json({ ...parsed, count: emails.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/subscriptions', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) {
    const usedSubs = checkWeeklyLimit(req.session.email, 'subscriptions');
    if (usedSubs >= FREE_LIMIT) return res.status(429).json({ error: 'FREE_LIMIT', message: 'Limite hebdomadaire atteinte (3/semaine). Passe à Pro pour un accès illimité 🚀', used: usedSubs, limit: FREE_LIMIT });
    incrementWeeklyUsage(req.session.email, 'subscriptions');
  }
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const queries = [
      'subject:(bienvenue OR welcome OR "compte créé" OR "account created" OR "verify your email" OR "confirmez votre email")',
      'subject:("thank you for registering" OR "merci de vous être inscrit" OR "activation" OR "activate your account")'
    ];
    
    const allMessages = [];
    for (const q of queries) {
      const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: 100, q });
      if (data.messages) allMessages.push(...data.messages);
    }

    const seen = new Set();
    const subscriptions = [];

    const fetched = await Promise.all(allMessages.slice(0, 50).map(msg =>
      gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] })
        .then(r => ({ id: msg.id, data: r.data }))
        .catch(() => null)
    ));

    for (const item of fetched) {
      if (!item) continue;
      const headers = item.data.payload.headers;
      const from = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      const domainMatch = from.match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      const domain = domainMatch ? domainMatch[1].replace(/^mail\.|^email\.|^noreply\.|^no-reply\.|^info\.|^hello\./, '') : null;
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);

      // Categorize
      const d = domain.toLowerCase();
      let category = '🌐 Autre';
      if (['facebook', 'instagram', 'twitter', 'tiktok', 'linkedin', 'snapchat', 'pinterest'].some(s => d.includes(s))) category = '📱 Réseaux sociaux';
      else if (['amazon', 'ebay', 'etsy', 'aliexpress', 'shein', 'zalando', 'cdiscount', 'fnac'].some(s => d.includes(s))) category = '🛒 Shopping';
      else if (['netflix', 'spotify', 'deezer', 'disney', 'youtube', 'twitch', 'steam'].some(s => d.includes(s))) category = '🎬 Entertainment';
      else if (['google', 'microsoft', 'apple', 'dropbox', 'notion', 'slack', 'zoom'].some(s => d.includes(s))) category = '💼 Productivité';
      else if (['paypal', 'stripe', 'revolut', 'boursorama', 'bnp', 'credit'].some(s => d.includes(s))) category = '💳 Finance';
      else if (['gmail', 'yahoo', 'outlook', 'hotmail', 'proton'].some(s => d.includes(s))) category = '📧 Email';

      const year = date ? new Date(date).getFullYear() : null;
      const isOld = year && year < 2020;

      subscriptions.push({ id: item.id, from, subject, date, domain, category, isOld, year });
    }

    res.json({ subscriptions, total: subscriptions.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/unsubscribe', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const { domain } = req.body;
  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(req.session.tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const aiMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: `Rédige un email court et professionnel en français pour demander la suppression de mon compte sur ${domain} et de toutes mes données (RGPD). Corps uniquement, sans objet ni signature.` }]
    });
    const emailBody = aiMsg.content[0].text;
    const emailContent = [`To: support@${domain}`, `Subject: Demande de suppression de compte - ${domain}`, `Content-Type: text/plain; charset=utf-8`, ``, emailBody].join('\n');
    const encoded = Buffer.from(emailContent).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

const PORT = process.env.PORT || 3000;
// ─── AUTO-FILTER LIVE (polling toutes les 30s) ────────────────────────────────
// Garde en mémoire le dernier historyId par user pour détecter uniquement les nouveaux emails
const lastHistoryId = {};

app.post('/api/auto-filter', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) return res.status(403).json({ error: 'PRO_REQUIRED' });

  try {
    const gmail = await getGmailClient(req.session.tokens);
    const email = req.session.email;

    // Récupère le historyId actuel
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const currentHistoryId = profile.data.historyId;

    // Premier appel — on initialise juste le curseur, rien à filtrer
    if (!lastHistoryId[email]) {
      lastHistoryId[email] = currentHistoryId;
      return res.json({ filtered: 0, newMessages: 0, initialized: true });
    }

    // Pas de changement depuis le dernier check
    if (currentHistoryId === lastHistoryId[email]) {
      return res.json({ filtered: 0, newMessages: 0 });
    }

    // Récupère l'historique depuis le dernier check
    let newMessages = [];
    try {
      const history = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: lastHistoryId[email],
        historyTypes: ['messageAdded'],
        labelId: 'INBOX'
      });
      if (history.data.history) {
        history.data.history.forEach(h => {
          if (h.messagesAdded) {
            h.messagesAdded.forEach(m => {
              if (!newMessages.find(x => x.id === m.message.id)) {
                newMessages.push(m.message);
              }
            });
          }
        });
      }
    } catch (e) {
      // historyId expiré — on remet à jour et on repart
      lastHistoryId[email] = currentHistoryId;
      return res.json({ filtered: 0, newMessages: 0, reset: true });
    }

    lastHistoryId[email] = currentHistoryId;

    if (!newMessages.length) return res.json({ filtered: 0, newMessages: 0 });

    // Récupère le label Zappie
    const labelId = await ensureZappieLabel(gmail);

    // Analyse les nouveaux emails en parallèle
    const analyzed = await Promise.all(newMessages.map(async (msg) => {
      try {
        const full = await gmail.users.messages.get({
          userId: 'me', id: msg.id, format: 'metadata',
          metadataHeaders: ['Subject', 'From']
        });
        const headers = full.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const snippet = full.data.snippet || '';
        const decision = await analyzeEmailWithAI(subject, from, snippet);
        return { id: msg.id, subject, from, decision };
      } catch (e) { return null; }
    }));

    // Filtre les inutiles
    let filtered = 0;
    const filteredEmails = [];
    await Promise.all(analyzed.filter(Boolean).map(async (email) => {
      if (email.decision === 'INUTILE') {
        await gmail.users.messages.modify({
          userId: 'me', id: email.id,
          requestBody: { addLabelIds: [labelId], removeLabelIds: ['INBOX'] }
        });
        filtered++;
        filteredEmails.push({ subject: email.subject, from: email.from });
      }
    }));

    res.json({ filtered, newMessages: newMessages.length, emails: filteredEmails });
  } catch (e) {
    console.error('Auto-filter error:', e);
    res.status(500).json({ error: 'Erreur auto-filter' });
  }
});


// ─── STATS DASHBOARD ─────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    // Get inbox count
    const { data: inboxData } = await gmail.users.messages.list({ userId: 'me', maxResults: 1, q: 'in:inbox' });
    const inboxCount = inboxData.resultSizeEstimate || 0;
    // Get Zappie label count
    const { data: zappieData } = await gmail.users.messages.list({ userId: 'me', maxResults: 1, q: 'label:Zappie' });
    const zappieCount = zappieData.resultSizeEstimate || 0;
    const timeSaved = Math.round(zappieCount * 0.5);
    res.json({ inboxCount, zappieCount, timeSaved });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`✅ Zappie tourne sur http://localhost:${PORT}`));

// ─── STRIPE PAIEMENT ──────────────────────────────────────────────────────────
const PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1TVchf8UsIPkunXGdzoJWrOo';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Créer une session de paiement Stripe
app.post('/api/create-checkout', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      success_url: APP_URL + '/dashboard?success=true',
      cancel_url: APP_URL + '/dashboard?canceled=true',
      customer_email: req.session.email,
      metadata: { email: req.session.email }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Vérifier si l'utilisateur est Pro
app.get('/api/subscription-status', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const customers = await stripe.customers.list({ email: req.session.email, limit: 1 });
    if (!customers.data.length) return res.json({ isPro: false });
    const subscriptions = await stripe.subscriptions.list({
      customer: customers.data[0].id,
      status: 'active',
      limit: 1
    });
    res.json({ isPro: subscriptions.data.length > 0 });
  } catch (err) {
    res.json({ isPro: false });
  }
});

// Page pricing
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));
 
