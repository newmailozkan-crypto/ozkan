import express from 'express';
import crypto from 'node:crypto';
import { cfg, checkConfig } from './src/config.js';
import * as ig from './src/instagram.js';
import { startCatalogRefresh, catalogStatus, debugFeed, debugSearch, debugFamilies, debugStatus, BOT_VERSION, pushFeed, pushJson, pushState } from './src/catalog.js';
import { startSiteRefresh, siteStatus } from './src/siteInfo.js';
import { handleDirectMessage, handleComment, setUsername, noteUserMessage, noteBotMessage, noteSeen, dueFollowups, buildFollowup } from './src/ai.js';
import { initImages, instagramImageUrl, serveImage } from './src/images.js';

checkConfig();

const app = express();

// Meta imza doğrulaması için ham gövdeyi sakla
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.get('/', (_req, res) => res.send('Instagram satış botu çalışıyor ✅'));
app.get('/health', (_req, res) => res.json({ ok: true, version: BOT_VERSION, catalog: catalogStatus(), site: siteStatus() }));

// WordPress -> bot ürün aktarımı (Cloudflare bot korumasını kapatmadan çalışır). Anahtar: CATALOG_PUSH_KEY
const pushAuth = (req, res) => {
  const key = req.get('x-push-key') || '';
  if (!cfg.pushKey) return res.status(404).send('push kapalı (CATALOG_PUSH_KEY tanımlı değil)') && false;
  if (key.length !== cfg.pushKey.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(cfg.pushKey))) return res.sendStatus(403) && false;
  return true;
};
app.get('/catalog/state', (req, res) => pushAuth(req, res) && res.json(pushState()));
app.post('/catalog/push', express.text({ type: '*/*', limit: '80mb' }), (req, res) => {
  if (!pushAuth(req, res)) return;
  try {
    res.json({ ok: true, ...pushFeed(String(req.body || ''), req.get('x-feed-hash') || '') });
  } catch (e) {
    console.error('[push]', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/catalog/push-json', express.text({ type: '*/*', limit: '40mb' }), (req, res) => {
  if (!pushAuth(req, res)) return;
  try {
    res.json({ ok: true, ...pushJson(String(req.body || ''), req.get('x-feed-hash') || '') });
  } catch (e) {
    console.error('[push-json]', e.message);
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Teşhis: botun XML'den ne okuduğunu gösterir. Erişim için ?key=IG_VERIFY_TOKEN gerekir.
const debugAuth = (req, res) => {
  if (!cfg.verifyToken || req.query.key !== cfg.verifyToken) {
    res.sendStatus(403);
    return false;
  }
  return true;
};
app.get('/debug/status', (req, res) => debugAuth(req, res) && res.json({ ...debugStatus(), env: Object.fromEntries(['IG_VERIFY_TOKEN','IG_ACCESS_TOKEN','IG_ACCOUNT_ID','ANTHROPIC_API_KEY','PRODUCT_FEED_URL','SITE_CATALOG_URL','TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'].map((k) => [k, Boolean(process.env[k])])), models: { chat: cfg.model, vision: cfg.visionModel, index: cfg.indexModel } }));
app.get('/debug/feed', (req, res) => debugAuth(req, res) && res.json(debugFeed()));
app.get('/debug/catalog', (req, res) => debugAuth(req, res) && res.json(debugSearch(String(req.query.q || ''), Math.min(Number(req.query.limit) || 10, 30))));
app.get('/debug/families', (req, res) => debugAuth(req, res) && res.json(debugFamilies()));

// Instagram'ın alabilmesi için katalogdaki webp görselleri JPEG olarak sunar (yalnızca katalogda kayıtlı görseller)
app.get('/img/:file', async (req, res) => {
  try {
    const img = await serveImage(req.params.file.replace(/\.jpg$/i, ''));
    if (!img) return res.sendStatus(404);
    res.set('Content-Type', img.mediaType).set('Cache-Control', 'public, max-age=86400').send(img.buf);
  } catch (e) {
    console.error('[img]', e.message);
    res.sendStatus(502);
  }
});

// Webhook doğrulama (Meta panelinde "Doğrula ve Kaydet")
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === cfg.verifyToken) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ---- tekrar eden olayları ele (Meta aynı olayı tekrar gönderebilir) ----
const seen = new Map();
function isDuplicate(key) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 60 * 60 * 1000) seen.delete(k);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

// ---- kullanıcı başına sıralı işlem kuyruğu ----
const queues = new Map();
function enqueue(userId, task) {
  const prev = queues.get(userId) || Promise.resolve();
  const next = prev.then(task).catch((e) => console.error('[queue]', e)).finally(() => {
    if (queues.get(userId) === next) queues.delete(userId);
  });
  queues.set(userId, next);
}

const FALLBACK = 'Şu an yoğunluk yaşıyoruz, mesajınızı aldık. Birazdan size tekrar dönüş yapacağız 🙏';

async function processMessage(event) {
  const senderId = event.sender?.id;
  if (event.read && senderId) {
    noteSeen(String(senderId)); // müşteri son mesajımızı gördü
    return;
  }
  const msg = event.message;
  if (!senderId || !msg || msg.is_echo) return;
  if (String(senderId) === String(cfg.igAccountId)) return;
  if (msg.mid && isDuplicate('m:' + msg.mid)) return;

  const attachments = msg.attachments || [];
  const image = attachments.find((a) => a.type === 'image');
  const unsupported = !msg.text && !image;

  noteUserMessage(senderId);
  enqueue(senderId, async () => {
    try {
      if (unsupported) {
        await ig.sendText(senderId, 'Mesajınızı aldım 😊 Yazı veya ürün görseli olarak iletirseniz hemen yardımcı olabilirim.');
        return;
      }
      ig.typingOn(senderId);
      const prof = await ig.getProfile(senderId);
      setUsername(senderId, prof.username);

      const reply = await handleDirectMessage({
        userId: senderId,
        text: msg.text || '',
        imageUrl: image?.payload?.url,
        send: {
          text: async (t) => { await ig.sendText(senderId, t); noteBotMessage(senderId); },
          image: async (u) => { await ig.sendImage(senderId, instagramImageUrl(u)); noteBotMessage(senderId); },
        },
      });
      if (reply) {
        await ig.sendText(senderId, reply);
        noteBotMessage(senderId);
      }
    } catch (e) {
      console.error('[dm] hata:', e);
      try {
        await ig.sendText(senderId, FALLBACK);
      } catch {
        /* gönderilemedi */
      }
    }
  });
}

async function processComment(change) {
  const v = change.value || {};
  const commentId = v.id;
  const from = v.from || {};
  if (!commentId || !v.text) return;
  if (String(from.id) === String(cfg.igAccountId)) return; // kendi yorumumuz
  if (v.parent_id) return; // yanıtlara yanıt verme (döngü önlemi)
  if (isDuplicate('c:' + commentId)) return;

  enqueue(from.id || commentId, async () => {
    try {
      const { publicReply, dm } = await handleComment({ userId: from.id, username: from.username, commentText: v.text });
      if (publicReply) await ig.replyToComment(commentId, publicReply);
      if (dm) await ig.privateReply(commentId, dm);
    } catch (e) {
      console.error('[comment] hata:', e);
    }
  });
}

app.post('/webhook', (req, res) => {
  if (!ig.verifySignature(req.rawBody, req.get('x-hub-signature-256'))) {
    console.warn('[webhook] imza doğrulanamadı');
    return res.sendStatus(401);
  }
  res.sendStatus(200); // Meta'ya hemen yanıt ver, işi arka planda yap

  const body = req.body;
  if (body?.object !== 'instagram') return;
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) processMessage(ev);
    for (const ch of entry.changes || []) {
      if (ch.field === 'comments' || ch.field === 'live_comments') processComment(ch);
    }
  }
});

// ---- 6 saat sessiz kalan (mesajımızı görmüş) müşterilere tek seferlik hatırlatma ----
setInterval(() => {
  for (const userId of dueFollowups()) {
    enqueue(userId, async () => {
      try {
        const text = await buildFollowup(userId);
        if (!text) return;
        await ig.sendText(userId, text);
        noteBotMessage(userId);
        console.log('[followup] hatırlatma gönderildi:', userId);
      } catch (e) {
        console.error('[followup] gönderilemedi:', e.message);
      }
    });
  }
}, 5 * 60 * 1000).unref?.();

await initImages(); // sharp (webp -> jpeg) hazır olsun, sonra katalog ve görsel hafıza yüklensin
startCatalogRefresh();
startSiteRefresh();

app.listen(cfg.port, () => console.log(`[server] ${cfg.port} portunda dinleniyor`));
