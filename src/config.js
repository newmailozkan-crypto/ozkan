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

  feedUrl: env.PRODUCT_FEED_URL,
  siteUrls: (env.SITE_INFO_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  feedRefreshMin: Number(env.FEED_REFRESH_MIN || 15),
  siteRefreshMin: Number(env.SITE_REFRESH_MIN || 30),
  campaignRules: parseRules(env.CAMPAIGN_RULES),

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
  if (!cfg.appSecret) console.warn('[config] IG_APP_SECRET yok: webhook imza doğrulaması KAPALI.');
  return missing;
}
