import * as cheerio from 'cheerio';
import crypto from 'node:crypto';
import { cfg } from './config.js';

let pages = []; // {url, text}
let lastUpdated = null;
let lastHash = '';

function extractText(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, header nav, footer, form[action*="search"]').remove();
  const root = $('main').length ? $('main') : $('body');
  const t = root
    .text()
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return t.slice(0, 5000);
}

export async function refreshSiteInfo() {
  if (!cfg.siteUrls.length) return;
  const results = [];
  for (const url of cfg.siteUrls) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'ig-satis-botu/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      results.push({ url, text: extractText(await res.text()) });
    } catch (e) {
      console.error(`[site] ${url} alınamadı:`, e.message);
      const old = pages.find((p) => p.url === url);
      if (old) results.push(old); // eski veriyi koru
    }
  }
  if (!results.length) return;
  const hash = crypto.createHash('sha1').update(JSON.stringify(results)).digest('hex');
  if (hash !== lastHash) console.log('[site] kampanya/kargo/ödeme bilgisi güncellendi');
  pages = results;
  lastHash = hash;
  lastUpdated = new Date();
}

export function startSiteRefresh() {
  refreshSiteInfo();
  setInterval(refreshSiteInfo, cfg.siteRefreshMin * 60 * 1000).unref?.();
}

// Sistem istemine eklenecek güncel site bilgisi
export function siteInfoText() {
  if (!pages.length) return '(Site bilgisi henüz alınamadı. Kampanya/kargo/ödeme konusunda emin değilsen müşteriye net bilgi uydurma; "kontrol edip dönüyorum" de ve ilgili konuyu atla.)';
  return pages.map((p) => `### ${p.url}\n${p.text}`).join('\n\n');
}

export function siteStatus() {
  return { pages: pages.length, lastUpdated };
}
