import express from 'express';
import { cfg, checkConfig } from './src/config.js';
import * as ig from './src/instagram.js';
import { startCatalogRefresh, catalogStatus } from './src/catalog.js';
import { startSiteRefresh, siteStatus } from './src/siteInfo.js';
import { handleDirectMessage, handleComment, setUsername } from './src/ai.js';

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
app.get('/health', (_req, res) => res.json({ ok: true, catalog: catalogStatus(), site: siteStatus() }));

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
  const msg = event.message;
  if (!senderId || !msg || msg.is_echo) return;
  if (String(senderId) === String(cfg.igAccountId)) return;
  if (msg.mid && isDuplicate('m:' + msg.mid)) return;

  const attachments = msg.attachments || [];
  const image = attachments.find((a) => a.type === 'image');
  const unsupported = !msg.text && !image;

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
          text: (t) => ig.sendText(senderId, t),
          image: (u) => ig.sendImage(senderId, u),
        },
      });
      if (reply) await ig.sendText(senderId, reply);
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

startCatalogRefresh();
startSiteRefresh();

app.listen(cfg.port, () => console.log(`[server] ${cfg.port} portunda dinleniyor`));
