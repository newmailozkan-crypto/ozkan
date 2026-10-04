import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as ig from './instagram.js';
import { fromBuffer } from './images.js';

// Müşteri DM'den bir gönderi/reels/hikaye ilettiğinde veya hikayemize yanıt verdiğinde görseli ve açıklamayı çözer.
// Sırayla: (1) kendi medya kimliğimiz/permalink'imiz -> Graph API'den görsel+açıklama, (2) ekin kendi adresi (görsel ise indir,
// video ise ffmpeg ile kare çıkar), (3) ekte gelen başlık. Hiçbiri olmazsa image=null döner.

const MEDIA_TYPES = new Set(['share', 'ig_post', 'ig_reel', 'reel', 'story_mention', 'story', 'ig_story', 'video', 'ig_video', 'post']);
export const isMediaAttachment = (a) => MEDIA_TYPES.has(String(a?.type || '').toLowerCase());

const shortcode = (u) => String(u || '').match(/instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/i)?.[1];

async function download(url, maxBytes = 30 * 1024 * 1024) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ig-satis-botu/1.0)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('dosya çok büyük');
  return { buf, type };
}

let ffPath = null;
async function ffmpegPath() {
  if (ffPath) return ffPath;
  if (process.env.FFMPEG_PATH) return (ffPath = process.env.FFMPEG_PATH);
  try {
    ffPath = (await import('ffmpeg-static')).default || 'ffmpeg'; // npm ile gelen ffmpeg (Render'da sistem ffmpeg'i yoktur)
  } catch {
    ffPath = 'ffmpeg';
  }
  return ffPath;
}

// Videodan bir kare (1. saniye; kısa videoda ilk kare) JPEG olarak çıkarır
export async function frameFromVideo(buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  const inp = path.join(dir, 'in.mp4');
  const out = path.join(dir, 'out.jpg');
  const bin = await ffmpegPath();
  try {
    fs.writeFileSync(inp, buf);
    const run = (args) =>
      new Promise((resolve, reject) => {
        const p = spawn(bin, args, { stdio: 'ignore' });
        const t = setTimeout(() => p.kill('SIGKILL'), 20000);
        p.on('error', reject);
        p.on('close', (code) => {
          clearTimeout(t);
          code === 0 && fs.existsSync(out) ? resolve() : reject(new Error('ffmpeg kare çıkaramadı'));
        });
      });
    try {
      await run(['-y', '-ss', '1', '-i', inp, '-frames:v', '1', '-q:v', '3', out]);
    } catch {
      await run(['-y', '-i', inp, '-frames:v', '1', '-q:v', '3', out]);
    }
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function imageFromUrl(url) {
  const { buf, type } = await download(url);
  if (type.startsWith('image/')) return buf;
  if (type.startsWith('video/') || /\.mp4(\?|$)/i.test(url)) return frameFromVideo(buf);
  throw new Error('görsel veya video değil: ' + (type || '?'));
}

async function fromOwnMedia(ids, links) {
  // 1) kimlikle doğrudan
  for (const id of ids.filter(Boolean)) {
    const m = await ig.getMedia(String(id));
    if (m && (m.media_url || m.thumbnail_url || m.caption)) return m;
  }
  // 2) permalink / kimlik ile kendi medya listemizde ara
  const codes = links.map(shortcode).filter(Boolean);
  if (!ids.filter(Boolean).length && !codes.length) return null;
  const list = await ig.listOwnMedia();
  return list.find((m) => ids.map(String).includes(String(m.id)) || codes.some((c) => String(m.permalink || '').includes(c))) || null;
}

/**
 * @param {Array} attachments webhook ekleri
 * @param {object|null} story  message.reply_to.story ({id,url})
 * @returns {{image:{b64,mediaType}|null, caption:string, kind:string, debug:object}|null}
 */
export async function resolveShared(attachments, story) {
  const items = [];
  for (const a of attachments || []) if (isMediaAttachment(a)) items.push({ kind: String(a.type), p: a.payload || {} });
  if (story) items.push({ kind: 'hikaye yanıtı', p: { url: story.url, id: story.id } });
  if (!items.length) return null;

  const debug = { turler: items.map((i) => i.kind), anahtarlar: items.map((i) => Object.keys(i.p)) };
  let caption = '';
  for (const it of items) {
    const p = it.p;
    caption = caption || String(p.title || p.caption || '').trim();
    let buf = null;
    // 1) bizim gönderimiz/hikayemiz mi?
    try {
      const m = await fromOwnMedia([p.ig_post_media_id, p.reel_video_id, p.reel_id, p.media_id, p.id, p.story_id], [p.url, p.permalink]);
      if (m) {
        caption = String(m.caption || '').trim() || caption;
        const src = m.thumbnail_url || m.media_url;
        if (src) buf = await imageFromUrl(src).catch(() => null);
        debug.kaynak = 'kendi_medyamiz';
      }
    } catch (e) {
      debug.kendi_medya_hata = e.message;
    }
    // 2) ekin kendi adresi
    if (!buf && p.url) {
      try {
        buf = await imageFromUrl(p.url);
        debug.kaynak = debug.kaynak || 'ek_adresi';
      } catch (e) {
        debug.ek_adresi_hata = e.message;
      }
    }
    if (buf) {
      try {
        const image = await fromBuffer(buf, { maxSide: 1024 });
        return { image, caption, kind: it.kind, debug };
      } catch (e) {
        debug.islenemedi = e.message;
      }
    }
  }
  return { image: null, caption, kind: items[0].kind, debug };
}
