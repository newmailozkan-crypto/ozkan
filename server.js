import express from 'express';
import crypto from 'node:crypto';
import { cfg, checkConfig } from './src/config.js';
import * as ig from './src/instagram.js';
import { usageReport } from './src/claude.js';
import { startCatalogRefresh, catalogStatus, debugFeed, debugSearch, debugFamilies, debugStatus, BOT_VERSION, pushFeed, pushJson, pushState } from './src/catalog.js';
import { startSiteRefresh, siteStatus } from './src/siteInfo.js';
import { handleDirectMessage, handleComment, warmProductHashes, setUsername, noteUserMessage, noteBotMessage, noteSeen, dueFollowups, buildFollowup, humanMessage, observeCustomer, humanActive, hasSession, identifyLog } from './src/ai.js';
import { sendTelegram } from './src/telegram.js';
import { resolveShared, isMediaAttachment } from './src/media.js';
import { createBatcher } from './src/batch.js';
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
app.get('/debug/usage', (req, res) => debugAuth(req, res) && res.json(usageReport()));
const events = [];
function recordEvent(kind, info) {
  events.push({ at: new Date().toISOString(), kind, ...info });
  if (events.length > 40) events.shift();
}
app.get('/debug/events', (req, res) => debugAuth(req, res) && res.json({ son_olaylar: [...events].reverse() }));
app.get('/debug/identify', (req, res) => debugAuth(req, res) && res.json({ kayitlar: [...identifyLog].reverse() }));
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

let lastBotErrorAlert = 0;
const FALLBACK = `Şu an yoğunluk yaşıyoruz 🙏 Canlı müşteri temsilcimiz size hemen yardımcı olacaktır: ${cfg.whatsappUrl}`;

// Gönderdiğimiz mesajlar (kimlik -> içerik/ürün): müşteri bir mesajımıza "yanıtla" yapınca hangi ürün olduğunu bilmek için
const sentMap = new Map();
function rememberSent(ids, info) {
  for (const id of [].concat(ids || [])) {
    if (!id) continue;
    sentMap.set(id, info);
    if (sentMap.size > 4000) sentMap.delete(sentMap.keys().next().value);
  }
}

// Hesabımızdan giden mesajın yankısı: botun kendisi değilse bir insan yazmıştır -> bot susar, izler, öğrenir
function handleEcho(event) {
  const msg = event.message;
  const customerId = event.recipient?.id;
  if (!customerId || String(customerId) === String(cfg.igAccountId)) return;
  if (msg.mid && isDuplicate('e:' + msg.mid)) return;
  const t = setTimeout(() => {
    const hasAtt = (msg.attachments || []).length > 0;
    if (ig.isOurMessage(customerId, msg.mid, msg.text, hasAtt)) return; // botun kendi mesajı
    const text = msg.text || (hasAtt ? '[görsel/ek gönderdi]' : '');
    humanMessage(String(customerId), text);
    recordEvent('insan_mesaji', { musteri: customerId, metin: String(text).slice(0, 80), bot_sessiz_saat: cfg.handoffHours });
    console.log('[devir] insan yazdı, bot sessiz ve izlemede:', customerId);
  }, 4000);
  t.unref?.();
}

const handoffAlert = new Map();
async function processMessage(event) {
  const senderId = event.sender?.id;
  if (event.read && senderId) {
    noteSeen(String(senderId)); // müşteri son mesajımızı gördü
    return;
  }
  const msg = event.message;
  if (msg?.is_echo) return handleEcho(event);
  if (!senderId || !msg) return;
  if (String(senderId) === String(cfg.igAccountId)) return;
  if (msg.mid && isDuplicate('m:' + msg.mid)) return;

  const attachments = msg.attachments || [];
  const image = attachments.find((a) => a.type === 'image');
  const sharedAtts = attachments.filter((a) => a !== image && isMediaAttachment(a));
  const story = msg.reply_to?.story || null;
  const hasShared = sharedAtts.length > 0 || Boolean(story && !image);
  const unsupported = !msg.text && !image && !hasShared;
  if (attachments.length || story || msg.reply_to) {
    recordEvent('mesaj_eki', { kimden: senderId, ekler: attachments.map((a) => `${a.type}:${Object.keys(a.payload || {}).join('/')}`), hikaye_yaniti: Boolean(story), yanitlanan_mesaj: msg.reply_to?.mid ? true : false });
  }

  if (unsupported) {
    // Ses mesajı dışında (beğeni, çıkartma, konum vb.) hiçbir şey yazma: sipariş akışını bozmasın
    recordEvent('desteklenmeyen_mesaj', { kimden: senderId, ekler: attachments.map((a) => a.type) });
    if (attachments.some((a) => a.type === 'audio') && !humanActive(String(senderId), cfg.handoffHours)) {
      enqueue(senderId, () => ig.sendText(senderId, 'Sesli mesajınızı dinleyemiyorum 🙏 Yazarak iletebilir misiniz?'));
    }
    return;
  }

  noteUserMessage(senderId);
  // Mağaza yetkilisi müşteriyle yazışıyorsa bot cevap vermez, sadece izler
  if (humanActive(String(senderId), cfg.handoffHours)) {
    observeCustomer(String(senderId), msg.text || (image ? '[müşteri görsel gönderdi]' : '[müşteri bir paylaşım iletti]'));
    recordEvent('izleme', { kimden: senderId, metin: String(msg.text || '').slice(0, 80) });
    if (Date.now() - (handoffAlert.get(String(senderId)) || 0) > 30 * 60 * 1000) {
      handoffAlert.set(String(senderId), Date.now());
      sendTelegram(`👀 Müşteri yazdı ama bot sessiz (mağaza yetkilisi bu müşteriyle yazıştı sayılıyor, ${cfg.handoffHours} saat).\nMüşteri: ${senderId}\nMesaj: ${String(msg.text || '(görsel/paylaşım)').slice(0, 150)}\nBu müşteriye siz cevap vermediyseniz bot yanlışlıkla susmuş olabilir.`).catch(() => {});
    }
    return;
  }
  ig.typingOn(senderId);
  batcher.add(senderId, { msg, image, sharedAtts, story, hasShared });
}

const lastResolved = new Map(); // müşteri -> paylaşım görseli en son ne zaman çözüldü

async function processBatch(senderId, items) {
  const send = {
    text: async (t, productId) => {
      const ids = await ig.sendText(senderId, t);
      rememberSent(ids, { productId, text: t });
      noteBotMessage(senderId);
    },
    image: async (u, productId) => {
      const r = await ig.sendImage(senderId, instagramImageUrl(u));
      rememberSent(r?.message_id, { productId, text: '(ürün fotoğrafı)' });
      noteBotMessage(senderId);
    },
  };
  const watchdog = new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('işlem 150 sn içinde bitmedi (zaman aşımı)')), 150000); t.unref?.(); });
  try {
    await Promise.race([watchdog, processBatchInner(senderId, items, send)]);
  } catch (e) {
    return onBatchError(senderId, e);
  }
}

async function onBatchError(senderId, e) {
  {
    console.error('[dm] hata:', e);
    try {
      await ig.sendText(senderId, FALLBACK);
    } catch {
      /* gönderilemedi */
    }
    if (Date.now() - lastBotErrorAlert > 10 * 60 * 1000) {
      lastBotErrorAlert = Date.now();
      try {
        await sendTelegram(`⚠️ İNSAN DESTEĞİ GEREKİYOR: bot bir müşteriye cevap veremedi (@${senderId}).\nMüşteriye WhatsApp hattı gönderildi. Hata: ${String(e.message).slice(0, 200)}\nRender Logs'ta "[dm] hata" satırına bakın.`);
      } catch {
        /* yoksay */
      }
    }
  }
}

async function processBatchInner(senderId, items, send) {
  {
    const prof = await ig.getProfile(senderId);
    setUsername(senderId, prof.username);

    const text = items.map((i) => i.msg.text).filter(Boolean).join('\n');
    const lastImg = [...items].reverse().find((i) => i.image)?.image;
    const sharedAtts = items.flatMap((i) => i.sharedAtts);
    const story = items.find((i) => i.story && !i.image)?.story || null;
    const hasShared = sharedAtts.length > 0 || Boolean(story);

    // Paylaşılan gönderi / reels / hikaye: görseli ve açıklamayı çöz
    let imageData = null;
    let caption = '';
    const notes = [];
    if (hasShared) {
      const r = await resolveShared(sharedAtts, story);
      recordEvent('paylasim_cozuldu', { kimden: senderId, ...r?.debug, gorsel_alindi: Boolean(r?.image), aciklama: Boolean(r?.caption), mesaj_sayisi: items.length });
      if (r) {
        imageData = r.image;
        caption = r.caption;
        const kind = r.kind === 'hikaye yanıtı' ? 'bir hikayemize yanıt verdi' : `bir Instagram paylaşımını (${r.kind}) iletti`;
        if (r.image) {
          lastResolved.set(senderId, Date.now());
          notes.push(`Müşteri ${kind}; görseli ekledim. Paylaşım müşterinin sormak/sipariş vermek istediği üründür.${r.caption ? ` Paylaşım açıklaması: "${r.caption.slice(0, 400)}".` : ''}`);
        } else if (r.caption) {
          notes.push(`Müşteri ${kind} ama görseli okunamadı. Paylaşım açıklaması: "${r.caption.slice(0, 400)}". Açıklamadaki model/renk bilgisiyle search_products kullan.`);
        } else if (!text && Date.now() - (lastResolved.get(senderId) || 0) < 90 * 1000) {
          return; // aynı paylaşımın çift olayı: az önce zaten cevaplandı, "net gelmedi" gibi bir mesaj atma
        } else {
          notes.push(`Müşteri ${kind} ama içeriği okunamadı. Özür dileme, "net gelmedi" deme; kısaca ve kibarca "Hangi modeli kastettiğinizi yazar mısınız?" diye sor.`);
        }
      }
    }

    // "Yanıtla" ile bir mesajımıza cevap verdiyse
    const rmid = items.map((i) => i.msg.reply_to?.mid).find(Boolean);
    const replyTo = rmid ? sentMap.get(rmid) || { unknown: true } : null;

    // Yeni oturumsa (yeniden başlama / insan yazışması) önceki konuşmayı Instagram'dan oku
    let history = null;
    if (!hasSession(senderId)) {
      const mids = new Set(items.map((i) => i.msg.mid));
      history = (await ig.fetchHistory(senderId, 20)).filter((h) => !mids.has(h.mid));
    }

    const reply = await handleDirectMessage({
      userId: senderId,
      text,
      imageUrl: imageData ? undefined : lastImg?.payload?.url,
      imageData,
      notes,
      replyTo,
      caption,
      history,
      send,
    });
    if (reply) {
      const ids = await ig.sendText(senderId, reply);
      rememberSent(ids, { text: reply });
      noteBotMessage(senderId);
    }
  }
}

const batcher = createBatcher(cfg.batchMs, 6000, (senderId, items) => enqueue(senderId, () => processBatch(senderId, items)));

async function processComment(change) {
  const v = change.value || {};
  const commentId = v.id;
  const from = v.from || {};
  recordEvent('yorum_geldi', { id: commentId, kimden: from.username || from.id, metin: String(v.text || '').slice(0, 80) });
  if (!commentId || !v.text) return recordEvent('yorum_atlandi', { neden: 'id veya metin yok' });
  if (String(from.id) === String(cfg.igAccountId)) return recordEvent('yorum_atlandi', { id: commentId, neden: 'kendi hesabımızın yorumu (test için başka hesaptan yorum yazın)' });
  if (v.parent_id) return recordEvent('yorum_atlandi', { id: commentId, neden: 'yanıta yanıt (döngü önlemi)' });
  if (isDuplicate('c:' + commentId)) return;

  enqueue(from.id || commentId, async () => {
    try {
      const media = v.media?.id ? await ig.getMedia(v.media.id) : {};
      const mediaImageUrl = media.thumbnail_url || (media.media_type && media.media_type !== 'VIDEO' ? media.media_url : null);
      const { publicReply, dm } = await handleComment({ userId: from.id, username: from.username, commentText: v.text, mediaCaption: media.caption, mediaId: v.media?.id, mediaImageUrl });
      const result = { id: commentId, kimden: from.username || from.id };
      if (publicReply) {
        await ig.replyToComment(commentId, publicReply);
        result.herkese_acik_cevap = 'gönderildi';
      }
      if (dm) {
        try {
          await ig.privateReply(commentId, dm);
          result.dm = 'gönderildi';
        } catch (e) {
          result.dm = 'gönderilemedi: ' + e.message;
          console.error('[comment] DM gönderilemedi:', e.message);
        }
      }
      recordEvent('yorum_cevaplandi', result);
    } catch (e) {
      console.error('[comment] hata:', e);
      recordEvent('yorum_hata', { id: commentId, hata: String(e.message).slice(0, 200) });
      try {
        await sendTelegram(`⚠️ Bir yoruma cevap verilemedi (@${from.username || from.id}): ${String(e.message).slice(0, 200)}\nYorum: ${String(v.text).slice(0, 150)}`);
      } catch {
        /* yoksay */
      }
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
    for (const ch of entry.changes || []) console.log('[webhook] değişiklik alanı:', ch.field);
    if ((entry.messaging || []).length) console.log('[webhook] mesaj olayı:', entry.messaging.map((m) => (m.read ? 'read' : m.message ? 'message' : Object.keys(m).join('/'))).join(','));
  }
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) processMessage(ev);
    for (const ch of entry.changes || []) {
      if (ch.field === 'comments' || ch.field === 'live_comments') processComment(ch);
    }
  }
});

// ---- FOLLOWUP_HOURS (varsayılan 6) saat sessiz kalan müşterilere tek seferlik hatırlatma (gece dahil, 24 saatlik pencere içinde) ----
function runFollowups() {
  for (const { userId, stage } of dueFollowups()) {
    enqueue(userId, async () => {
      try {
        const { text, imageUrl } = buildFollowup(userId, stage);
        if (imageUrl) {
          try {
            await ig.sendImage(userId, instagramImageUrl(imageUrl));
          } catch (e) {
            console.error('[followup] çorap görseli gönderilemedi:', e.message);
          }
        }
        await ig.sendText(userId, text);
        noteBotMessage(userId);
        recordEvent('hatirlatma_gonderildi', { musteri: userId, asama: stage, gorsel: Boolean(imageUrl) });
        console.log(`[followup] ${stage}. aşama hatırlatma gönderildi:`, userId);
      } catch (e) {
        console.error('[followup] gönderilemedi:', e.message);
        recordEvent('hatirlatma_hata', { musteri: userId, hata: String(e.message).slice(0, 150) });
      }
    });
  }
}
setInterval(runFollowups, 5 * 60 * 1000).unref?.();
setTimeout(runFollowups, 60 * 1000).unref?.(); // uyku/yeniden başlatma sonrası kaçan hatırlatmaları yakala

await initImages(); // sharp (webp -> jpeg) hazır olsun, sonra katalog ve görsel hafıza yüklensin
startCatalogRefresh();
setInterval(() => warmProductHashes().catch(() => {}), 15 * 60 * 1000).unref?.();
setTimeout(() => warmProductHashes().catch(() => {}), 45 * 1000).unref?.();
startSiteRefresh();

app.listen(cfg.port, () => console.log(`[server] ${cfg.port} portunda dinleniyor`));
