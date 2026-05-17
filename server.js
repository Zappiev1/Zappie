require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'zappie-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1TVchf8UsIPkunXGdzoJWrOo';
const APP_URL = process.env.APP_URL || 'https://zappie.app';
const FREE_LIMIT = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── WEEKLY USAGE TRACKER ────────────────────────────────────────────────────
const weeklyUsage = {};
function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday.getTime();
}
function checkWeeklyLimit(email, feature) {
  const key = email + ':' + feature;
  const weekStart = getWeekStart();
  if (!weeklyUsage[key] || weeklyUsage[key].weekStart !== weekStart) weeklyUsage[key] = { count: 0, weekStart };
  return weeklyUsage[key].count;
}
function incrementWeeklyUsage(email, feature) {
  const key = email + ':' + feature;
  const weekStart = getWeekStart();
  if (!weeklyUsage[key] || weeklyUsage[key].weekStart !== weekStart) weeklyUsage[key] = { count: 0, weekStart };
  weeklyUsage[key].count++;
  return weeklyUsage[key].count;
}

// ─── HELPERS ────────────────────────────────────────────────────────────────
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.CALLBACK_URL || 'http://localhost:8080/auth/callback'
  );
}
async function getGmailClient(tokens) {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: oauth2Client });
}
async function checkIsPro(email) {
  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return false;
    const subs = await stripe.subscriptions.list({ customer: customers.data[0].id, status: 'active', limit: 1 });
    return subs.data.length > 0;
  } catch { return false; }
}
async function ensureZappieLabel(gmail) {
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const existing = data.labels.find(l => l.name === 'Zappie');
  if (existing) return existing.id;
  const { data: newLabel } = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name: 'Zappie', labelListVisibility: 'labelShow', messageListVisibility: 'show' }
  });
  return newLabel.id;
}
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
function getCategoryFromDomain(domain) {
  const d = domain.toLowerCase();
  if (d.includes('amazon') || d.includes('aliexpress') || d.includes('shop') || d.includes('store') || d.includes('ebay')) return '🛒 Shopping';
  if (d.includes('facebook') || d.includes('twitter') || d.includes('instagram') || d.includes('tiktok') || d.includes('linkedin')) return '📱 Réseaux sociaux';
  if (d.includes('netflix') || d.includes('spotify') || d.includes('youtube') || d.includes('twitch')) return '🎮 Divertissement';
  if (d.includes('bank') || d.includes('paypal') || d.includes('stripe') || d.includes('ing') || d.includes('bnp')) return '💳 Finance';
  return '🌐 Autre';
}

// ─── AI ANALYSIS ─────────────────────────────────────────────────────────────
async function analyzeEmailWithAI(subject, from, snippet, hasAttachment = false) {
  if (hasAttachment) return 'IMPORTANT';
  const fromLower = from.toLowerCase();
  const isAutoSender = fromLower.includes('noreply') || fromLower.includes('no-reply') ||
    fromLower.includes('newsletter') || fromLower.includes('marketing') ||
    fromLower.includes('notification') || fromLower.includes('donotreply') ||
    fromLower.includes('promotions') || fromLower.includes('offers');
  if (!isAutoSender) return 'IMPORTANT';
  let attempts = 0;
  while (attempts < 3) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: `Email: De: ${from} | Sujet: ${subject} | Aperçu: ${snippet}\nRéponds UNIQUEMENT "IMPORTANT" ou "INUTILE".\nINUTILE = promotions, newsletters, notifications automatiques, marketing, pub, spam.\nIMPORTANT = factures, rendez-vous, banque, livraisons, urgences.\nEn cas de doute: INUTILE.` }]
      });
      return message.content[0].text.trim().includes('IMPORTANT') ? 'IMPORTANT' : 'INUTILE';
    } catch (e) {
      if (e.status === 429) { await sleep(2000 * (attempts + 1)); attempts++; }
      else return 'IMPORTANT';
    }
  }
  return 'IMPORTANT';
}

// ─── AUTH ────────────────────────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/userinfo.email']
  });
  res.redirect(url);
});
app.get('/auth/callback', async (req, res) => {
  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    req.session.tokens = tokens;
    req.session.email = data.email;
    res.redirect('/scan');
  } catch (e) { res.redirect('/?error=auth'); }
});
app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ─── PAGES ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/scan', (req, res) => { if (!req.session.tokens) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'scan.html')); });
app.get('/dashboard', (req, res) => { if (!req.session.tokens) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));

// ─── API: ME ─────────────────────────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  if (!req.session.tokens) return res.json({ connected: false });
  const isPro = await checkIsPro(req.session.email);
  res.json({ connected: true, email: req.session.email, isPro });
});

// ─── API: STATS ──────────────────────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);

    // Get real counts using label info (accurate)
    const { data: labelsData } = await gmail.users.labels.list({ userId: 'me' });
    const inboxLabel = labelsData.labels.find(l => l.id === 'INBOX');
    const zappieLabel = labelsData.labels.find(l => l.name === 'Zappie');

    // Get real inbox count from label details
    let inboxCount = 0;
    let zappieCount = 0;

    if (inboxLabel) {
      const { data: inboxDetail } = await gmail.users.labels.get({ userId: 'me', id: 'INBOX' });
      inboxCount = inboxDetail.messagesTotal || 0;
    }

    if (zappieLabel) {
      const { data: zappieDetail } = await gmail.users.labels.get({ userId: 'me', id: zappieLabel.id });
      zappieCount = zappieDetail.messagesTotal || 0;
    }

    const timeSaved = Math.round(zappieCount * 0.5);
    const stressScore = Math.max(5, Math.min(99, Math.round((inboxCount / Math.max(inboxCount + zappieCount, 1)) * 100)));
    res.json({ inboxCount, zappieCount, timeSaved, stressScore });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: SCAN ───────────────────────────────────────────────────────────────
app.get('/api/scan', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const [inboxData, storageData, subsData, zappieData] = await Promise.all([
      gmail.users.messages.list({ userId: 'me', maxResults: 1, q: 'in:inbox' }),
      gmail.users.messages.list({ userId: 'me', maxResults: 1, q: 'has:attachment larger:1M' }),
      gmail.users.messages.list({ userId: 'me', maxResults: 1, q: 'unsubscribe' }),
      gmail.users.messages.list({ userId: 'me', maxResults: 1, q: 'label:Zappie' })
    ]);
    const inboxCount = inboxData.data.resultSizeEstimate || 0;
    const storageEmails = storageData.data.resultSizeEstimate || 0;
    const subsCount = subsData.data.resultSizeEstimate || 0;
    const zappieCount = zappieData.data.resultSizeEstimate || 0;
    const stressScore = Math.min(99, Math.round(
      Math.min(inboxCount / 500, 1) * 40 +
      Math.min(storageEmails / 100, 1) * 30 +
      Math.min(subsCount / 200, 1) * 30
    ));
    res.json({ inboxCount, storageEmails, subsCount, zappieCount, stressScore, storageMB: storageEmails * 4 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: ANALYZE ─────────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const labelId = await ensureZappieLabel(gmail);
    const isPro = await checkIsPro(req.session.email);
    if (!isPro) {
      const used = checkWeeklyLimit(req.session.email, 'analyze');
      if (used >= FREE_LIMIT) return res.status(429).json({ error: 'FREE_LIMIT', message: 'Limite hebdomadaire atteinte (3/semaine). Passe à Pro 🚀', used, limit: FREE_LIMIT });
    }
    const maxEmails = isPro ? 500 : 50;
    const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: maxEmails, q: 'in:inbox -label:Zappie' });
    if (!data.messages || data.messages.length === 0) return res.json({ processed: 0, moved: 0, results: [] });
    if (!isPro) incrementWeeklyUsage(req.session.email, 'analyze');
    const BATCH = 5;
    let moved = 0;
    const results = [];
    for (let i = 0; i < data.messages.length; i += BATCH) {
      const batch = data.messages.slice(i, i + BATCH);
      const fetched = await Promise.all(batch.map(msg =>
        gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full', metadataHeaders: ['Subject', 'From'] })
          .then(r => ({ id: msg.id, data: r.data })).catch(() => null)
      ));
      for (const item of fetched.filter(Boolean)) {
        const { id, data: full } = item;
        const headers = full.payload.headers || [];
        const subject = headers.find(h => h.name === 'Subject')?.value || '(sans sujet)';
        const from = headers.find(h => h.name === 'From')?.value || 'Inconnu';
        const snippet = full.snippet || '';
        const hasAttachment = !!(full.payload.parts && full.payload.parts.some(p => p.filename && p.filename.length > 0));
        const decision = await analyzeEmailWithAI(subject, from, snippet, hasAttachment);
        if (decision === 'INUTILE') {
          try {
            await gmail.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds: [labelId], removeLabelIds: ['INBOX'] } });
            moved++;
          } catch {}
        }
        results.push({ id, subject, from, decision, hasAttachment });
        await sleep(150);
      }
      if (i + BATCH < data.messages.length) await sleep(500);
    }
    res.json({ processed: data.messages.length, moved, results });
  } catch (e) { console.error('Analyze error:', e.message); res.status(500).json({ error: e.message }); }
});

// ─── API: ZAPPIE EMAILS ───────────────────────────────────────────────────────
app.get('/api/zappie-emails', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: 50, q: 'label:Zappie' });
    if (!data.messages) return res.json({ emails: [], total: 0 });
    const emails = await Promise.all(data.messages.slice(0, 20).map(async msg => {
      try {
        const { data: full } = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
        const headers = full.payload.headers || [];
        return { id: msg.id, subject: headers.find(h => h.name === 'Subject')?.value || '(sans sujet)', from: headers.find(h => h.name === 'From')?.value || 'Inconnu', date: headers.find(h => h.name === 'Date')?.value || '' };
      } catch { return null; }
    }));
    res.json({ emails: emails.filter(Boolean), total: data.resultSizeEstimate || data.messages.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: RESTORE ─────────────────────────────────────────────────────────────
app.post('/api/restore/:id', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data: labels } = await gmail.users.labels.list({ userId: 'me' });
    const zappieLabel = labels.labels.find(l => l.name === 'Zappie');
    await gmail.users.messages.modify({ userId: 'me', id: req.params.id, requestBody: { addLabelIds: ['INBOX'], removeLabelIds: zappieLabel ? [zappieLabel.id] : [] } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: DELETE ──────────────────────────────────────────────────────────────
app.delete('/api/delete/:id', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    await gmail.users.messages.trash({ userId: 'me', id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: STORAGE ─────────────────────────────────────────────────────────────
app.get('/api/storage', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) {
    const used = checkWeeklyLimit(req.session.email, 'storage');
    if (used >= FREE_LIMIT) return res.status(429).json({ error: 'FREE_LIMIT', message: 'Limite hebdomadaire atteinte. Passe à Pro 🚀' });
    incrementWeeklyUsage(req.session.email, 'storage');
  }
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: 25, q: 'has:attachment larger:1M' });
    if (!data.messages) return res.json({ emails: [], totalSize: 0, totalSizeFormatted: '0 MB', count: 0 });
    let totalSize = 0;
    const emails = (await Promise.all(data.messages.map(async msg => {
      try {
        const { data: full } = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From'] });
        const headers = full.payload.headers || [];
        const size = full.sizeEstimate || 0;
        totalSize += size;
        return { id: msg.id, subject: headers.find(h => h.name === 'Subject')?.value || '(sans sujet)', from: headers.find(h => h.name === 'From')?.value || 'Inconnu', size, sizeFormatted: formatSize(size) };
      } catch { return null; }
    }))).filter(Boolean).sort((a, b) => b.size - a.size);
    res.json({ emails, totalSize, totalSizeFormatted: formatSize(totalSize), count: emails.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: ARCHIVE COUNT ───────────────────────────────────────────────────────
app.get('/api/archive-count', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const months = parseInt(req.query.months) || 6;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const dateStr = `${cutoff.getFullYear()}/${String(cutoff.getMonth() + 1).padStart(2, '0')}/${String(cutoff.getDate()).padStart(2, '0')}`;
    const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: 1, q: `in:inbox before:${dateStr}` });
    res.json({ count: data.resultSizeEstimate || 0, months });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: ARCHIVE OLD ─────────────────────────────────────────────────────────
app.post('/api/archive-old', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) {
    const used = checkWeeklyLimit(req.session.email, 'archive');
    if (used >= FREE_LIMIT) return res.status(429).json({ error: 'FREE_LIMIT', message: 'Limite hebdomadaire atteinte. Passe à Pro 🚀' });
    incrementWeeklyUsage(req.session.email, 'archive');
  }
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const months = parseInt(req.query.months) || 6;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const dateStr = `${cutoff.getFullYear()}/${String(cutoff.getMonth() + 1).padStart(2, '0')}/${String(cutoff.getDate()).padStart(2, '0')}`;
    const { data: beforeData } = await gmail.users.messages.list({ userId: 'me', maxResults: 1, q: 'in:inbox' });
    const inboxBefore = beforeData.resultSizeEstimate || 0;
    let allMessages = [];
    let pageToken = undefined;
    do {
      const { data: pageData } = await gmail.users.messages.list({ userId: 'me', maxResults: 500, q: `in:inbox before:${dateStr}`, ...(pageToken ? { pageToken } : {}) });
      if (pageData.messages) allMessages.push(...pageData.messages);
      pageToken = pageData.nextPageToken;
    } while (pageToken);
    if (!allMessages.length) return res.json({ archived: 0, inboxBefore, inboxAfter: inboxBefore, reduction: 0 });
    const BATCH = 50;
    for (let i = 0; i < allMessages.length; i += BATCH) {
      await Promise.all(allMessages.slice(i, i + BATCH).map(msg =>
        gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['INBOX'] } }).catch(() => {})
      ));
    }
    const { data: afterData } = await gmail.users.messages.list({ userId: 'me', maxResults: 1, q: 'in:inbox' });
    const inboxAfter = afterData.resultSizeEstimate || 0;
    const reduction = inboxBefore > 0 ? Math.round((allMessages.length / inboxBefore) * 100) : 0;
    res.json({ archived: allMessages.length, inboxBefore, inboxAfter, reduction });
  } catch (e) { console.error('Archive error:', e.message); res.status(500).json({ error: e.message }); }
});

// ─── API: DAILY SUMMARY ───────────────────────────────────────────────────────
app.get('/api/daily-summary', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) {
    const used = checkWeeklyLimit(req.session.email, 'summary');
    if (used >= FREE_LIMIT) return res.status(429).json({ error: 'FREE_LIMIT', message: 'Limite hebdomadaire atteinte. Passe à Pro 🚀' });
    incrementWeeklyUsage(req.session.email, 'summary');
  }
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const today = new Date();
    const dateStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
    const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: 20, q: `in:inbox after:${dateStr} -label:Zappie` });
    if (!data.messages) return res.json({ items: [], intro: 'Aucun email important aujourd\'hui ! 🎉', count: 0, score: 'Journée légère 🟢' });
    const emails = (await Promise.all(data.messages.slice(0, 10).map(async msg => {
      try {
        const { data: full } = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['Subject', 'From'] });
        const headers = full.payload.headers || [];
        return { subject: headers.find(h => h.name === 'Subject')?.value || '(sans sujet)', from: headers.find(h => h.name === 'From')?.value || 'Inconnu', snippet: full.snippet || '' };
      } catch { return null; }
    }))).filter(Boolean);
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 800,
      messages: [{ role: 'user', content: `Tu es un assistant email. Voici les emails du jour:\n${emails.map((e, i) => `${i + 1}. De: ${e.from} | Sujet: ${e.subject} | Aperçu: ${e.snippet}`).join('\n')}\n\nRéponds en JSON:\n{"intro":"phrase courte","score":"Journée légère 🟢 ou Journée chargée 🟠 ou Journée intense 🔴","items":[{"priority":"urgent|important|info","category":"emoji + catégorie","title":"titre court","from":"nom","action":"action courte"}]}` }]
    });
    let parsed;
    try { parsed = JSON.parse(message.content[0].text.replace(/```json|```/g, '').trim()); }
    catch { parsed = { intro: 'Voici tes emails du jour.', score: 'Journée 🟡', items: [] }; }
    res.json({ ...parsed, count: emails.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: SUBSCRIPTIONS ───────────────────────────────────────────────────────
app.get('/api/subscriptions', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) {
    const used = checkWeeklyLimit(req.session.email, 'subscriptions');
    if (used >= FREE_LIMIT) return res.status(429).json({ error: 'FREE_LIMIT', message: 'Limite hebdomadaire atteinte. Passe à Pro 🚀' });
    incrementWeeklyUsage(req.session.email, 'subscriptions');
  }
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: 50, q: 'unsubscribe' });
    if (!data.messages) return res.json({ subscriptions: [], total: 0 });
    const seen = new Set();
    const subscriptions = [];
    await Promise.all(data.messages.slice(0, 30).map(async msg => {
      try {
        const { data: full } = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From', 'Date'] });
        const headers = full.payload.headers || [];
        const from = headers.find(h => h.name === 'From')?.value || '';
        const date = headers.find(h => h.name === 'Date')?.value || '';
        const domainMatch = from.match(/@([^>]+)/);
        const domain = domainMatch ? domainMatch[1].replace('>', '').trim() : from;
        if (!seen.has(domain) && domain) {
          seen.add(domain);
          const year = new Date(date).getFullYear() || new Date().getFullYear();
          subscriptions.push({ id: msg.id, domain, from, date, year, isOld: year < new Date().getFullYear() - 2, category: getCategoryFromDomain(domain) });
        }
      } catch {}
    }));
    res.json({ subscriptions, total: subscriptions.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: UNSUBSCRIBE ─────────────────────────────────────────────────────────
app.post('/api/unsubscribe', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  res.json({ success: true });
});

// ─── API: STRIPE ──────────────────────────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: APP_URL + '/dashboard?success=true',
      cancel_url: APP_URL + '/dashboard?canceled=true',
      customer_email: req.session.email
    });
    res.json({ url: session.url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/subscription-status', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  res.json({ isPro });
});

// ─── API: AUTO-FILTER ─────────────────────────────────────────────────────────
const lastHistoryId = {};
app.post('/api/auto-filter', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) return res.status(403).json({ error: 'PRO_REQUIRED' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const email = req.session.email;
    const profile = await gmail.users.getProfile({ userId: 'me' });
    const currentHistoryId = profile.data.historyId;
    if (!lastHistoryId[email]) { lastHistoryId[email] = currentHistoryId; return res.json({ filtered: 0, initialized: true }); }
    if (currentHistoryId === lastHistoryId[email]) return res.json({ filtered: 0 });
    let newMessages = [];
    try {
      const history = await gmail.users.history.list({ userId: 'me', startHistoryId: lastHistoryId[email], historyTypes: ['messageAdded'], labelId: 'INBOX' });
      if (history.data.history) history.data.history.forEach(h => { if (h.messagesAdded) h.messagesAdded.forEach(m => { if (!newMessages.find(x => x.id === m.message.id)) newMessages.push(m.message); }); });
    } catch { lastHistoryId[email] = currentHistoryId; return res.json({ filtered: 0, reset: true }); }
    lastHistoryId[email] = currentHistoryId;
    if (!newMessages.length) return res.json({ filtered: 0 });
    const labelId = await ensureZappieLabel(gmail);
    let filtered = 0;
    for (const msg of newMessages) {
      try {
        const { data: full } = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full', metadataHeaders: ['Subject', 'From'] });
        const headers = full.payload.headers || [];
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const snippet = full.snippet || '';
        const hasAttachment = !!(full.payload.parts && full.payload.parts.some(p => p.filename && p.filename.length > 0));
        const decision = await analyzeEmailWithAI(subject, from, snippet, hasAttachment);
        if (decision === 'INUTILE') { await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { addLabelIds: [labelId], removeLabelIds: ['INBOX'] } }); filtered++; }
        await sleep(150);
      } catch {}
    }
    res.json({ filtered });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`✅ Zappie tourne sur http://localhost:${PORT}`));
