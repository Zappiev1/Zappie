require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const cors = require('cors');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // Required for Railway/Heroku proxy
app.use(express.json());
app.use(cors({
  origin: process.env.APP_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new MemoryStore({ checkPeriod: 86400000 }),
  secret: process.env.SESSION_SECRET || 'zappie-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── OAUTH ───────────────────────────────────────────────────────────────────
function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.CALLBACK_URL || 'http://localhost:3000/auth/callback'
  );
}

async function getGmailClient(tokens) {
  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

app.get('/auth/google', (req, res) => {
  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ]
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  if (req.query.error) return res.redirect('/?error=' + req.query.error);
  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    req.session.tokens = tokens;
    req.session.email = data.email;
    // Force session save before redirect
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.redirect('/?error=session_failed');
      }
      res.redirect('/dashboard');
    });
  } catch (err) {
    console.error('Auth callback error:', err);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// ─── STRIPE HELPERS ──────────────────────────────────────────────────────────
const PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1TVchf8UsIPkunXGdzoJWrOo';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

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

// ─── FREE PLAN USAGE ─────────────────────────────────────────────────────────
const weeklyUsage = {};

function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
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

// ─── GMAIL HELPERS ────────────────────────────────────────────────────────────
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

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ─── AI EMAIL CLASSIFIER ─────────────────────────────────────────────────────
async function analyzeEmailWithAI(subject, from, snippet) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let attempts = 0;
  while (attempts < 3) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 30,
        messages: [{
          role: 'user',
          content: `You are a VERY CONSERVATIVE email classifier. Your job is to ONLY move clearly useless emails. When in doubt, always reply IMPORTANT.

Reply with ONLY one word: IMPORTANT, PROMOTION, NEWSLETTER, NOTIFICATION, or SPAM.

From: ${from}
Subject: ${subject}
Preview: ${snippet}

STRICT RULES — mark as IMPORTANT if ANY of these apply:
- Sender is a real person (not a noreply/marketing address)
- Contains: invoice, facture, commande, order, payment, paiement, bank, banque, compte, contrat, contract, devis, quote
- Contains: réunion, meeting, rendez-vous, appointment, deadline, urgent, action required
- Contains: livraison, delivery, tracking, suivi, colis
- Contains: job, emploi, candidature, application, recrutement
- From a company you might do business with
- Any legal or administrative content
- Anything that could require a response or action

ONLY mark as PROMOTION if it's 100% clearly a marketing/sales email with discounts or offers.
ONLY mark as NEWSLETTER if it's clearly a blog/digest/weekly update with no personal relevance.
ONLY mark as SPAM if it's obviously unsolicited junk.
ONLY mark as NOTIFICATION if it's a minor automated alert (social media like, follow, etc).

When in doubt: reply IMPORTANT.

Reply with ONE WORD only.`
        }]
      });
      const result = message.content[0].text.trim().toUpperCase();
      const validCategories = ['IMPORTANT', 'PROMOTION', 'NEWSLETTER', 'NOTIFICATION', 'SPAM'];
      const category = validCategories.find(c => result.includes(c)) || 'IMPORTANT';
      const isUseless = category !== 'IMPORTANT';
      return { category, isUseless };
    } catch (e) {
      if (e.status === 429) {
        await sleep(2000 * (attempts + 1));
        attempts++;
      } else {
        return { category: 'IMPORTANT', isUseless: false };
      }
    }
  }
  return { category: 'IMPORTANT', isUseless: false };
}

// ─── /api/me ─────────────────────────────────────────────────────────────────
app.get('/api/me', async (req, res) => {
  if (!req.session.tokens) return res.json({ connected: false });
  try {
    const isPro = await checkIsPro(req.session.email);
    // Get real inbox count from Gmail
    const gmail = await getGmailClient(req.session.tokens);
    const profile = await gmail.users.getProfile({ userId: 'me' });
    res.json({
      connected: true,
      email: req.session.email,
      isPro,
      messagesTotal: profile.data.messagesTotal || 0,
      threadsTotal: profile.data.threadsTotal || 0
    });
  } catch (err) {
    res.json({ connected: true, email: req.session.email, isPro: false });
  }
});

// ─── /api/stats — REAL Gmail stats ───────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);

    // Use labels API for accurate counts
    const { data: labelsData } = await gmail.users.labels.list({ userId: 'me' });
    
    // Get real INBOX count from label info
    const inboxLabel = labelsData.labels.find(l => l.id === 'INBOX');
    let inboxCount = 0;
    if (inboxLabel) {
      const { data: inboxInfo } = await gmail.users.labels.get({ userId: 'me', id: 'INBOX' });
      inboxCount = inboxInfo.messagesUnread || inboxInfo.messagesTotal || 0;
    }

    // Real Zappie label count
    const zappieLabel = labelsData.labels.find(l => l.name === 'Zappie');
    let zappieCount = 0;
    if (zappieLabel) {
      const { data: zappieData } = await gmail.users.labels.get({ userId: 'me', id: zappieLabel.id });
      zappieCount = zappieData.messagesTotal || 0;
    }

    res.json({
      inboxCount,
      zappieCount,
      timeSaved: Math.round(zappieCount * 0.5)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/analyze — REAL AI classification ───────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const labelId = await ensureZappieLabel(gmail);
    const isPro = await checkIsPro(req.session.email);

    // Fetch real inbox emails (unread, not already in Zappie)
    let allMessages = [];
    if (isPro) {
      let pageToken;
      do {
        const { data } = await gmail.users.messages.list({
          userId: 'me', maxResults: 500,
          q: 'is:unread -label:Zappie',
          ...(pageToken ? { pageToken } : {})
        });
        if (data.messages) allMessages.push(...data.messages);
        pageToken = data.nextPageToken;
      } while (pageToken && allMessages.length < 2000);
    } else {
      const { data } = await gmail.users.messages.list({
        userId: 'me', maxResults: 35, q: 'is:unread -label:Zappie'
      });
      if (data.messages) allMessages = data.messages;
    }

    if (!allMessages.length) return res.json({ processed: 0, moved: 0, results: [], inboxCount: 0 });

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const BATCH = 5;
    let moved = 0;
    const results = [];

    for (let i = 0; i < allMessages.length; i += BATCH) {
      const batch = allMessages.slice(i, i + BATCH);

      // Fetch real metadata in parallel
      const fetched = await Promise.all(batch.map(msg =>
        gmail.users.messages.get({
          userId: 'me', id: msg.id, format: 'full',
          metadataHeaders: ['Subject', 'From']
        }).then(r => ({ id: msg.id, data: r.data })).catch(() => null)
      ));

      // Analyze each email with real AI
      for (const item of fetched.filter(Boolean)) {
        const { id, data: full } = item;
        const headers = full.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || '(sans sujet)';
        const from = headers.find(h => h.name === 'From')?.value || 'Inconnu';
        const snippet = full.snippet || '';

        // If email has attachments, always keep as IMPORTANT
        const hasParts = full.payload.parts && full.payload.parts.length > 0;
        const hasAttachment = hasParts && full.payload.parts.some(p => p.filename && p.filename.length > 0);

        let category, isUseless;
        if (hasAttachment) {
          category = 'IMPORTANT';
          isUseless = false;
        } else {
          ({ category, isUseless } = await analyzeEmailWithAI(subject, from, snippet));
        }

        if (isUseless) {
          try {
            await gmail.users.messages.modify({
              userId: 'me', id,
              requestBody: { addLabelIds: [labelId], removeLabelIds: ['INBOX'] }
            });
            moved++;
          } catch (e) { console.error('Move error:', e.message); }
        }

        results.push({ id, subject, from, snippet, category, isUseless });
        await sleep(150);
      }

      if (i + BATCH < allMessages.length) await sleep(800);
    }

    // Get real updated inbox count
    const { data: inboxData } = await gmail.users.messages.list({
      userId: 'me', maxResults: 1, labelIds: ['INBOX']
    });

    res.json({
      processed: allMessages.length,
      moved,
      results,
      isPro,
      inboxCount: inboxData.resultSizeEstimate || 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/zappie-emails — REAL emails from Zappie label ──────────────────────
app.get('/api/zappie-emails', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data: labelsData } = await gmail.users.labels.list({ userId: 'me' });
    const label = labelsData.labels.find(l => l.name === 'Zappie');
    if (!label) return res.json({ emails: [], total: 0 });

    const { data: labelInfo } = await gmail.users.labels.get({ userId: 'me', id: label.id });
    const total = labelInfo.messagesTotal || 0;

    const { data } = await gmail.users.messages.list({
      userId: 'me', labelIds: [label.id], maxResults: 50
    });
    if (!data.messages) return res.json({ emails: [], total });

    const emails = await Promise.all(data.messages.slice(0, 30).map(async msg => {
      try {
        const { data: full } = await gmail.users.messages.get({
          userId: 'me', id: msg.id, format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date']
        });
        const headers = full.payload.headers;
        return {
          id: msg.id,
          subject: headers.find(h => h.name === 'Subject')?.value || '(sans sujet)',
          from: headers.find(h => h.name === 'From')?.value || 'Inconnu',
          date: headers.find(h => h.name === 'Date')?.value || '',
          snippet: full.snippet || ''
        };
      } catch { return null; }
    }));

    res.json({ emails: emails.filter(Boolean), total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/restore/:id ────────────────────────────────────────────────────────
app.post('/api/restore/:id', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const { data: labelsData } = await gmail.users.labels.list({ userId: 'me' });
    const label = labelsData.labels.find(l => l.name === 'Zappie');
    await gmail.users.messages.modify({
      userId: 'me', id: req.params.id,
      requestBody: { addLabelIds: ['INBOX'], removeLabelIds: label ? [label.id] : [] }
    });
    // Return updated counts
    const { data: inboxData } = await gmail.users.messages.list({
      userId: 'me', maxResults: 1, labelIds: ['INBOX']
    });
    res.json({ success: true, inboxCount: inboxData.resultSizeEstimate || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/delete/:id ─────────────────────────────────────────────────────────
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

// ─── /api/storage-quota — REAL Google account storage ────────────────────────
app.get('/api/storage-quota', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(req.session.tokens);
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const { data } = await drive.about.get({ fields: 'storageQuota' });
    const quota = data.storageQuota;
    const used = parseInt(quota.usage || 0);
    const total = parseInt(quota.limit || 15 * 1024 * 1024 * 1024); // 15GB default
    const usedInGmail = parseInt(quota.usageInDriveTrash || 0);
    const pct = Math.round((used / total) * 100);
    res.json({
      used,
      total,
      usedFormatted: formatSize(used),
      totalFormatted: formatSize(total),
      freeFormatted: formatSize(total - used),
      pct,
      isAlmostFull: pct > 80
    });
  } catch (err) {
    console.error('Storage quota error:', err);
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/storage', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) {
    const used = checkWeeklyLimit(req.session.email, 'storage');
    if (used >= FREE_LIMIT) return res.status(429).json({
      error: 'FREE_LIMIT',
      message: 'Limite hebdomadaire atteinte. Passe à Pro pour un accès illimité.',
      used, limit: FREE_LIMIT
    });
    incrementWeeklyUsage(req.session.email, 'storage');
  }
  try {
    const gmail = await getGmailClient(req.session.tokens);

    // Fetch real large emails with attachments
    const { data } = await gmail.users.messages.list({
      userId: 'me', maxResults: 100, q: 'has:attachment larger:500K'
    });
    if (!data.messages) return res.json({ emails: [], totalSize: 0, totalSizeFormatted: '0 B', count: 0 });

    const emails = await Promise.all(data.messages.slice(0, 25).map(async msg => {
      try {
        const { data: full } = await gmail.users.messages.get({
          userId: 'me', id: msg.id, format: 'metadata',
          metadataHeaders: ['Subject', 'From', 'Date']
        });
        const headers = full.payload.headers;
        const size = full.sizeEstimate || 0;
        // Detect attachment type from subject/snippet
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const s = subject.toLowerCase();
        let attachType = '📦 Pièce jointe';
        if (s.includes('pdf') || s.includes('facture') || s.includes('invoice')) attachType = '📄 PDF';
        else if (s.includes('photo') || s.includes('image') || s.includes('jpg') || s.includes('png')) attachType = '🖼️ Photo';
        else if (s.includes('video') || s.includes('mp4') || s.includes('mov')) attachType = '🎥 Vidéo';

        return {
          id: msg.id,
          subject,
          from: headers.find(h => h.name === 'From')?.value || 'Inconnu',
          date: headers.find(h => h.name === 'Date')?.value || '',
          size,
          sizeFormatted: formatSize(size),
          attachType
        };
      } catch { return null; }
    }));

    const valid = emails.filter(Boolean).sort((a, b) => b.size - a.size);
    const totalSize = valid.reduce((s, e) => s + e.size, 0);

    res.json({
      emails: valid,
      totalSize,
      totalSizeFormatted: formatSize(totalSize),
      count: data.messages.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/archive-count — REAL count ─────────────────────────────────────────
app.get('/api/archive-count', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const months = parseInt(req.query.months) || 6;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const dateStr = `${cutoff.getFullYear()}/${String(cutoff.getMonth() + 1).padStart(2, '0')}/${String(cutoff.getDate()).padStart(2, '0')}`;
    const { data } = await gmail.users.messages.list({
      userId: 'me', maxResults: 1, q: `in:inbox before:${dateStr}`
    });
    res.json({ count: data.resultSizeEstimate || 0, months });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/archive-old — REAL archive action ──────────────────────────────────
app.post('/api/archive-old', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) {
    const used = checkWeeklyLimit(req.session.email, 'archive');
    if (used >= FREE_LIMIT) return res.status(429).json({
      error: 'FREE_LIMIT',
      message: 'Limite hebdomadaire atteinte. Passe à Pro pour un accès illimité.',
      used, limit: FREE_LIMIT
    });
    incrementWeeklyUsage(req.session.email, 'archive');
  }
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const months = parseInt(req.query.months) || 6;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const dateStr = `${cutoff.getFullYear()}/${String(cutoff.getMonth() + 1).padStart(2, '0')}/${String(cutoff.getDate()).padStart(2, '0')}`;

    // Get real inbox count BEFORE
    const { data: beforeData } = await gmail.users.messages.list({
      userId: 'me', maxResults: 1, labelIds: ['INBOX']
    });
    const inboxBefore = beforeData.resultSizeEstimate || 0;

    // Fetch all old emails
    let allMessages = [];
    let pageToken;
    do {
      const { data: pageData } = await gmail.users.messages.list({
        userId: 'me', maxResults: 500,
        q: `in:inbox before:${dateStr}`,
        ...(pageToken ? { pageToken } : {})
      });
      if (pageData.messages) allMessages.push(...pageData.messages);
      pageToken = pageData.nextPageToken;
    } while (pageToken);

    if (!allMessages.length) return res.json({ archived: 0, inboxBefore, inboxAfter: inboxBefore });

    // Archive in batches of 50 — real Gmail archive = remove INBOX label
    const BATCH = 50;
    for (let i = 0; i < allMessages.length; i += BATCH) {
      await Promise.all(allMessages.slice(i, i + BATCH).map(msg =>
        gmail.users.messages.modify({
          userId: 'me', id: msg.id,
          requestBody: { removeLabelIds: ['INBOX'] }
        }).catch(() => null)
      ));
    }

    // Get real inbox count AFTER
    const { data: afterData } = await gmail.users.messages.list({
      userId: 'me', maxResults: 1, labelIds: ['INBOX']
    });
    const inboxAfter = afterData.resultSizeEstimate || 0;

    res.json({
      archived: allMessages.length,
      inboxBefore,
      inboxAfter,
      reduction: inboxBefore > 0 ? Math.round((allMessages.length / inboxBefore) * 100) : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/daily-summary — REAL emails summarized by AI ───────────────────────
app.get('/api/daily-summary', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) {
    const used = checkWeeklyLimit(req.session.email, 'summary');
    if (used >= FREE_LIMIT) return res.status(429).json({
      error: 'FREE_LIMIT',
      message: 'Limite hebdomadaire atteinte. Passe à Pro pour un accès illimité.',
      used, limit: FREE_LIMIT
    });
    incrementWeeklyUsage(req.session.email, 'summary');
  }
  try {
    const gmail = await getGmailClient(req.session.tokens);
    const today = new Date();
    const dateStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;

    // Fetch today's real inbox emails
    const { data } = await gmail.users.messages.list({
      userId: 'me', maxResults: 20, q: `in:inbox after:${dateStr} -label:Zappie`
    });

    if (!data.messages) return res.json({
      items: [], intro: 'Aucun email important aujourd\'hui ! 🎉',
      score: 'Journée légère 🟢', count: 0
    });

    const emails = await Promise.all(data.messages.slice(0, 10).map(async msg => {
      try {
        const { data: full } = await gmail.users.messages.get({
          userId: 'me', id: msg.id, format: 'metadata',
          metadataHeaders: ['Subject', 'From']
        });
        const headers = full.payload.headers;
        return {
          subject: headers.find(h => h.name === 'Subject')?.value || '(sans sujet)',
          from: headers.find(h => h.name === 'From')?.value || 'Inconnu',
          snippet: full.snippet || ''
        };
      } catch { return null; }
    }));

    const validEmails = emails.filter(Boolean);

    // Real AI summary
    const summaryMsg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are an executive AI email assistant. Analyze these real emails and return ONLY a valid JSON object (no markdown, no explanation):
{
  "intro": "short human sentence about today's email load (max 15 words)",
  "score": "Journée légère 🟢 | Journée chargée 🟠 | Journée intense 🔴",
  "items": [
    {
      "priority": "urgent | important | info",
      "category": "💰 Finance | 📦 Commandes | 👤 Personnel | ⚠️ Action requise | 📅 Rendez-vous | 💼 Travail",
      "title": "ultra short title (max 5 words)",
      "action": "recommended action or 'Aucune action'",
      "from": "short sender name"
    }
  ]
}

Emails to analyze:
${validEmails.map(e => `From: ${e.from} | Subject: ${e.subject} | Preview: ${e.snippet}`).join('\n')}`
      }]
    });

    let parsed;
    try {
      const text = summaryMsg.content[0].text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = {
        intro: 'Voici tes emails importants du jour.',
        score: 'Journée 🟡',
        items: validEmails.map(e => ({
          priority: 'info',
          category: '📧 Email',
          title: e.subject.slice(0, 30),
          action: 'À vérifier',
          from: e.from.split('<')[0].trim()
        }))
      };
    }

    res.json({ ...parsed, count: validEmails.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/subscriptions — REAL account detection ─────────────────────────────
app.get('/api/subscriptions', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  const isPro = await checkIsPro(req.session.email);
  if (!isPro) {
    const used = checkWeeklyLimit(req.session.email, 'subscriptions');
    if (used >= FREE_LIMIT) return res.status(429).json({
      error: 'FREE_LIMIT',
      message: 'Limite hebdomadaire atteinte. Passe à Pro pour un accès illimité.',
      used, limit: FREE_LIMIT
    });
    incrementWeeklyUsage(req.session.email, 'subscriptions');
  }
  try {
    const gmail = await getGmailClient(req.session.tokens);

    // Search real registration/subscription emails
    const queries = [
      'subject:(bienvenue OR welcome OR "compte créé" OR "account created" OR "verify your email" OR "confirmez")',
      'subject:("thank you for registering" OR "merci de vous être inscrit" OR "activate your account" OR "activation")',
      'subject:(unsubscribe OR "se désinscrire" OR newsletter OR subscription)'
    ];

    const allMessages = [];
    for (const q of queries) {
      try {
        const { data } = await gmail.users.messages.list({ userId: 'me', maxResults: 100, q });
        if (data.messages) allMessages.push(...data.messages);
      } catch (e) { console.error('Query error:', e.message); }
    }

    const seen = new Set();
    const subscriptions = [];

    const fetched = await Promise.all(allMessages.slice(0, 60).map(msg =>
      gmail.users.messages.get({
        userId: 'me', id: msg.id, format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date']
      }).then(r => ({ id: msg.id, data: r.data })).catch(() => null)
    ));

    for (const item of fetched.filter(Boolean)) {
      const headers = item.data.payload.headers;
      const from = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';

      const domainMatch = from.match(/@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      const domain = domainMatch
        ? domainMatch[1].replace(/^mail\.|^email\.|^noreply\.|^no-reply\.|^info\.|^hello\.|^contact\./, '')
        : null;
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);

      const d = domain.toLowerCase();
      let category = '🌐 Autre';
      if (['facebook', 'instagram', 'twitter', 'tiktok', 'linkedin', 'snapchat', 'pinterest', 'x.com'].some(s => d.includes(s))) category = '📱 Réseaux sociaux';
      else if (['amazon', 'ebay', 'etsy', 'aliexpress', 'shein', 'zalando', 'cdiscount', 'fnac', 'leboncoin'].some(s => d.includes(s))) category = '🛒 Shopping';
      else if (['netflix', 'spotify', 'deezer', 'disney', 'youtube', 'twitch', 'steam', 'apple'].some(s => d.includes(s))) category = '🎬 Entertainment';
      else if (['google', 'microsoft', 'apple', 'dropbox', 'notion', 'slack', 'zoom', 'github', 'atlassian'].some(s => d.includes(s))) category = '💼 Productivité';
      else if (['paypal', 'stripe', 'revolut', 'boursorama', 'bnp', 'credit', 'banque', 'lydia', 'sumeria'].some(s => d.includes(s))) category = '💳 Finance';

      const year = date ? new Date(date).getFullYear() : null;
      const isOld = year && year < new Date().getFullYear() - 3;

      subscriptions.push({ id: item.id, from, subject, date, domain, category, isOld, year });
    }

    res.json({ subscriptions, total: subscriptions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/unsubscribe — Send RGPD deletion request ───────────────────────────
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
      messages: [{
        role: 'user',
        content: `Write a short professional email in French to request account deletion and data removal from ${domain} under GDPR. Return only the email body, no subject, no signature.`
      }]
    });

    const emailBody = aiMsg.content[0].text;
    const emailContent = [
      `To: privacy@${domain}`,
      `Subject: Demande de suppression de compte et données - RGPD`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      emailBody
    ].join('\n');

    const encoded = Buffer.from(emailContent).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/auto-filter — Live filter for Pro users ────────────────────────────
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

    if (!lastHistoryId[email]) {
      lastHistoryId[email] = currentHistoryId;
      return res.json({ filtered: 0, newMessages: 0, initialized: true });
    }

    if (currentHistoryId === lastHistoryId[email]) {
      return res.json({ filtered: 0, newMessages: 0 });
    }

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
      lastHistoryId[email] = currentHistoryId;
      return res.json({ filtered: 0, newMessages: 0, reset: true });
    }

    lastHistoryId[email] = currentHistoryId;
    if (!newMessages.length) return res.json({ filtered: 0, newMessages: 0 });

    const labelId = await ensureZappieLabel(gmail);
    let filtered = 0;
    const filteredEmails = [];

    await Promise.all(newMessages.map(async (msg) => {
      try {
        const full = await gmail.users.messages.get({
          userId: 'me', id: msg.id, format: 'metadata',
          metadataHeaders: ['Subject', 'From']
        });
        const headers = full.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const snippet = full.data.snippet || '';
        const { isUseless } = await analyzeEmailWithAI(subject, from, snippet);
        if (isUseless) {
          await gmail.users.messages.modify({
            userId: 'me', id: msg.id,
            requestBody: { addLabelIds: [labelId], removeLabelIds: ['INBOX'] }
          });
          filtered++;
          filteredEmails.push({ subject, from });
        }
      } catch (e) { console.error('Auto-filter item error:', e.message); }
    }));

    res.json({ filtered, newMessages: newMessages.length, emails: filteredEmails });
  } catch (e) {
    console.error('Auto-filter error:', e);
    res.status(500).json({ error: 'Erreur auto-filter' });
  }
});

// ─── STRIPE ───────────────────────────────────────────────────────────────────
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

app.get('/api/subscription-status', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Non connecté' });
  try {
    const customers = await stripe.customers.list({ email: req.session.email, limit: 1 });
    if (!customers.data.length) return res.json({ isPro: false });
    const subscriptions = await stripe.subscriptions.list({
      customer: customers.data[0].id, status: 'active', limit: 1
    });
    res.json({ isPro: subscriptions.data.length > 0 });
  } catch (err) {
    res.json({ isPro: false });
  }
});

// ─── PAGES ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/pricing', (req, res) => {
  const pricingPath = path.join(__dirname, 'public', 'pricing.html');
  res.sendFile(pricingPath, (err) => { if (err) res.redirect('/'); });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Zappie tourne sur http://localhost:${PORT}`));
