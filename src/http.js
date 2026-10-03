// Mağaza sitesinden XML/HTML/JSON indirmek için ortak yardımcı.
// - Tarayıcı benzeri başlıklar gönderir (bazı hosting/güvenlik duvarları bilinmeyen istemcileri 403 ile reddeder)
// - Geçici hatalarda (bağlantı, 429, 5xx) kısa beklemeyle yeniden dener
// - Engellenirse hatayı AÇIKÇA yazar (durum kodu, güvenlik duvarı ipucu, sayfanın ilk satırı), böylece neden anlaşılır

import { redact } from './util.js';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wafHint(res, body) {
  const hay = `${res.headers?.get?.('server') || ''} ${res.headers?.get?.('cf-ray') ? 'cloudflare' : ''} ${String(body).slice(0, 4000)}`;
  const m = hay.match(/cloudflare|just a moment|attention required|sucuri|wordfence|mod_security|modsecurity|incapsula|imperva|akamai|captcha/i);
  return m ? ` [güvenlik duvarı/bot koruması olabilir: ${m[0]}]` : '';
}

function snippet(body) {
  return String(body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function validUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function httpGet(url, { accept = '*/*', timeoutMs = 30000, retries = 2 } = {}) {
  if (!validUrl(url)) throw new Error('Geçersiz adres: PRODUCT_FEED_URL / SITE_CATALOG_URL değeri https:// ile başlayan bir bağlantı olmalı (Render ortam değişkenlerini kontrol edin; yanlışlıkla başka bir değer yapıştırılmış olabilir)');
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    let body;
    try {
      res = await fetch(url, {
        headers: { 'User-Agent': BROWSER_UA, Accept: accept, 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await res.text();
    } catch (e) {
      lastErr = new Error(`Bağlantı hatası (${url}): ${e.cause?.code || e.name || ''} ${e.message}`.trim());
      if (attempt < retries) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new Error(redact(lastErr.message));
    }
    if (res.ok) return { text: body, headers: res.headers, status: res.status };

    const err = new Error(`HTTP ${res.status} (${url})${wafHint(res, body)} ${snippet(body)}`.trim());
    err.status = res.status;
    if (RETRY_STATUS.has(res.status) && attempt < retries) {
      lastErr = err;
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw err;
  }
  throw lastErr;
}
