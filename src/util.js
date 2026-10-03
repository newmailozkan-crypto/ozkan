// Ortak yardımcılar (catalog.js ve siteCatalog.js kullanır)

export function decodeEntities(s) {
  // WooCommerce çıktılarında bazı alanlar çift kodlanmış gelir (&amp;gt; gibi): iki tur çöz
  let t = String(s ?? '');
  for (let i = 0; i < 2; i++) {
    t = t
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&amp;/g, '&');
  }
  return t;
}

export function stripTags(s) {
  return decodeEntities(String(s ?? ''))
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "2299.00 TRY", "1.299,90 TL", "1,299.90", "₺1.199" gibi yazımları sayıya çevirir
export function parsePrice(v) {
  if (v == null) return null;
  let s = String(typeof v === 'object' ? Object.values(v)[0] ?? '' : v).replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lc = s.lastIndexOf(',');
  const ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) {
    s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lc > -1) {
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (ld > -1 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}
