const env = process.env;

function parseRules(str) {
  // "2:300,3:600" -> [{min:2, discount:300}, {min:3, discount:600}] (büyükten küçüğe)
  if (!str) return [];
  return str
    .split(',')
    .map((p) => p.trim().split(':'))
    .filter((p) => p.length === 2 && Number(p[0]) > 0 && Number(p[1]) >= 0)
    .map(([m, d]) => ({ min: Number(m), discount: Number(d) }))
    .sort((a, b) => b.min - a.min);
}

export const cfg = {
  port: Number(env.PORT || 3000),
  storeName: env.STORE_NAME || 'Mağazamız',

  verifyToken: env.IG_VERIFY_TOKEN,
  appSecret: env.IG_APP_SECRET,
  igToken: env.IG_ACCESS_TOKEN,
  igAccountId: env.IG_ACCOUNT_ID,
  graphVersion: env.GRAPH_VERSION || 'v21.0',

  anthropicKey: env.ANTHROPIC_API_KEY,
  model: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  // Görsel eşleştirme için ayrı model istenirse (örn. sohbet Haiku, görsel Sonnet). Boşsa CLAUDE_MODEL kullanılır.
  visionModel: env.VISION_MODEL || env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  // Ürün görsellerini tek seferlik tanımlayan model (ucuz olanı yeterli)
  indexModel: env.INDEX_MODEL || 'claude-haiku-4-5-20251001',
  // Instagram'ın görsellere ulaşacağı herkese açık adres (Render bunu RENDER_EXTERNAL_URL olarak kendisi verir)
  publicUrl: (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),

  feedUrl: env.PRODUCT_FEED_URL,
  siteUrls: (env.SITE_INFO_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Stoklar sık değişmediği için ürünler ve site bilgisi varsayılan olarak 4,5 saatte bir (270 dk) yenilenir
  feedRefreshMin: Number(env.FEED_REFRESH_MIN || 270),
  siteRefreshMin: Number(env.SITE_REFRESH_MIN || 270),
  // Ürün kaynağı: auto = önce XML, okunamazsa siteden; xml = sadece XML; site = sadece siteden
  catalogSource: (env.CATALOG_SOURCE || 'auto').toLowerCase(),
  // Siteden ürün çekme için kategori sayfası (WooCommerce). Sayfalama /page/2/ biçiminde izlenir.
  siteCatalogUrl: env.SITE_CATALOG_URL || '',
  // WordPress'ten ürün XML'ini sunucuya iten uç nokta için gizli anahtar (boşsa uç nokta kapalı)
  pushKey: env.CATALOG_PUSH_KEY || '',
  // WordPress'ten gelen son veri buraya yazılır; bot yeniden başlarsa buradan okur. Kalıcı disk bağlıysa yolu oraya verin (örn. /var/data/last-push.xml)
  storeFile: env.CATALOG_STORE_FILE || 'data/last-push.dat',
  // Katalog boşken (ör. uyku sonrası) mesajlar bu kadar dakika boyunca WordPress'ten veri beklenir; gelmezse ekibe yönlendirilir
  catalogWaitMin: Number(env.CATALOG_WAIT_MIN || 12),
  fallbackFile: env.CATALOG_FALLBACK_FILE || 'data/feed.xml',
  siteProductPath: env.SITE_PRODUCT_PATH || '/product/',
  // Instagram DM'de webp destekleniyor; yine de gerekirse JPEG'e çevirmek için true yapılabilir
  convertWebp: String(env.CONVERT_WEBP || '').toLowerCase() === 'true',
  // Varsayılan kampanya: 2-3 üründe 300 TL, 4+ üründe 600 TL indirim (toplam). CAMPAIGN_RULES ile değiştirilebilir.
  campaignRules: parseRules(env.CAMPAIGN_RULES || '4:600,2:300'),
  // Sepet (indirim sonrası) bu tutarın altındaysa sabit kargo ücreti eklenir
  freeShippingMin: Number(env.FREE_SHIPPING_MIN || 2500),
  shippingFee: Number(env.SHIPPING_FEE || 100),
  whatsappUrl: env.WHATSAPP_URL || 'https://wa.me/905451348934',
  // Müşteri son mesajımızı gördüyse ve bu kadar saat cevap yazmadıysa tek seferlik hatırlatma gönderilir (0 = kapalı)
  // Sipariş sonrası bu süre içinde müşteri iptal isterse bot doğrudan iptal eder (saat)
  cancelWindowHours: Number(env.CANCEL_WINDOW_HOURS || 3),
  customersFile: env.CUSTOMERS_FILE || 'data/customers.json',
  followupHours: Number(env.FOLLOWUP_HOURS ?? 6),
  // Mağaza yetkilisi (insan) müşteriye yazdıktan sonra bot bu kadar saat sessiz kalıp sadece izler
  handoffHours: Number(env.HANDOFF_HOURS ?? 3),
  learnedFile: env.LEARNED_FILE || 'data/learned.json',

  tgToken: env.TELEGRAM_BOT_TOKEN,
  tgChatId: env.TELEGRAM_CHAT_ID,
};

export function checkConfig() {
  const required = {
    IG_VERIFY_TOKEN: cfg.verifyToken,
    IG_ACCESS_TOKEN: cfg.igToken,
    IG_ACCOUNT_ID: cfg.igAccountId,
    ANTHROPIC_API_KEY: cfg.anthropicKey,
    PRODUCT_FEED_URL: cfg.feedUrl,
    TELEGRAM_BOT_TOKEN: cfg.tgToken,
    TELEGRAM_CHAT_ID: cfg.tgChatId,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) console.warn('[config] Eksik ortam değişkenleri:', missing.join(', '));
  if (cfg.feedUrl && !/^https?:\/\//i.test(cfg.feedUrl)) console.error('[config] PRODUCT_FEED_URL geçerli bir bağlantı değil (https:// ile başlamalı). Yanlış değer yapıştırılmış olabilir!');
  if (cfg.feedUrl && /^sk-ant-/i.test(cfg.feedUrl.trim())) console.error('[config] UYARI: PRODUCT_FEED_URL içine bir API anahtarı yapıştırılmış. Anahtarı iptal edip yenisini oluşturun.');
  if (!cfg.appSecret) console.warn('[config] IG_APP_SECRET yok: webhook imza doğrulaması KAPALI.');
  return missing;
}
