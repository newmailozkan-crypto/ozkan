import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { sendTelegram } from './telegram.js';

// Tüm Claude çağrıları buradan geçer: kullanım/harcama sayılır, günlük uyarı/limit uygulanır, bakiye bitince haber verilir.
export const client = new Anthropic({ apiKey: cfg.anthropicKey, timeout: 60000, maxRetries: 2 }); // en çok ~3 dk; sonsuza dek takılmasın

// 1 milyon token başına TAHMİNİ fiyat (USD): [girdi, çıktı, önbellek yazma, önbellek okuma]. Gerçek fiyat için Anthropic Console'a bakın.
const PRICES = [
  [/haiku/i, [1, 5, 1.25, 0.1]],
  [/opus/i, [5, 25, 6.25, 0.5]],
  [/sonnet|fable|mythos/i, [3, 15, 3.75, 0.3]],
];
const priceOf = (model) => (PRICES.find(([re]) => re.test(model || '')) || [null, [3, 15, 3.75, 0.3]])[1];

export class BudgetError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BudgetError';
  }
}

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' }); // YYYY-MM-DD
let days = {}; // gün -> {cost, calls, byTag:{tag:{cost,calls,in,out}}}
try {
  days = JSON.parse(fs.readFileSync(cfg.usageFile, 'utf8'));
} catch {
  /* dosya yok */
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(cfg.usageFile), { recursive: true });
      const keys = Object.keys(days).sort().slice(-14);
      fs.writeFileSync(cfg.usageFile, JSON.stringify(Object.fromEntries(keys.map((k) => [k, days[k]]))));
    } catch {
      /* önemsiz */
    }
  }, 1000);
  saveTimer.unref?.();
}

const alerted = {};
async function alertOnce(key, text, everyMs = 24 * 3600 * 1000) {
  if (alerted[key] && Date.now() - alerted[key] < everyMs) return;
  alerted[key] = Date.now();
  try {
    await sendTelegram(text);
  } catch {
    /* yoksay */
  }
}

export function record(model, usage, tag) {
  if (!usage) return 0;
  const [pin, pout, pw, pr] = priceOf(model);
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cw = usage.cache_creation_input_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  const cost = (input * pin + output * pout + cw * pw + cr * pr) / 1e6;
  const d = (days[today()] ||= { cost: 0, calls: 0, byTag: {} });
  d.cost += cost;
  d.calls += 1;
  const t = (d.byTag[tag] ||= { cost: 0, calls: 0, input: 0, output: 0, cacheRead: 0 });
  t.cost += cost;
  t.calls += 1;
  t.input += input + cw;
  t.output += output;
  t.cacheRead += cr;
  save();
  if (cfg.dailyAlertUsd && d.cost >= cfg.dailyAlertUsd) {
    alertOnce('alert' + today(), `💸 Claude harcaması bugün tahmini $${d.cost.toFixed(2)} oldu (uyarı eşiği $${cfg.dailyAlertUsd}). Ayrıntı: /debug/usage`);
  }
  return cost;
}

export const spentToday = () => days[today()]?.cost || 0;
export const usageReport = () => ({
  not: 'Tutarlar tahminidir (token sayısı x liste fiyatı). Gerçek bakiye için Anthropic Console > Usage/Billing sayfasına bakın.',
  modeller: { sohbet: cfg.model, gorsel: cfg.visionModel, gorsel_hafiza: cfg.indexModel },
  limitler: { gunluk_uyari_usd: cfg.dailyAlertUsd, gunluk_limit_usd: cfg.dailyCapUsd || 'kapalı' },
  bugun_usd: Number(spentToday().toFixed(4)),
  gunler: Object.fromEntries(
    Object.entries(days)
      .sort()
      .slice(-7)
      .map(([k, v]) => [k, { usd: Number(v.cost.toFixed(4)), cagri: v.calls, nerede: Object.fromEntries(Object.entries(v.byTag).map(([t, x]) => [t, { usd: Number(x.cost.toFixed(4)), cagri: x.calls, girdi_token: x.input, cikti_token: x.output, onbellekten_okunan: x.cacheRead }])) }])
  ),
});

let billingBlockedAt = 0;
export const billingBlocked = () => Date.now() - billingBlockedAt < 10 * 60 * 1000;

export async function create(params, tag = 'sohbet') {
  if (cfg.dailyCapUsd && spentToday() >= cfg.dailyCapUsd) {
    alertOnce('cap' + today(), `⛔ Günlük Claude limiti ($${cfg.dailyCapUsd}) doldu; bot müşterileri bugün WhatsApp hattına yönlendiriyor. Limit: DAILY_CAP_USD`);
    throw new BudgetError('günlük limit doldu');
  }
  try {
    const resp = await client.messages.create(params);
    record(params.model, resp.usage, tag);
    return resp;
  } catch (e) {
    if (/credit balance|billing|insufficient/i.test(String(e?.message))) {
      billingBlockedAt = Date.now();
      alertOnce('billing', '🚨 Anthropic (Claude) bakiyesi bitmiş görünüyor: bot cevap veremiyor, müşteriler WhatsApp hattına yönlendiriliyor. console.anthropic.com > Billing üzerinden bakiye yükleyin.', 3600 * 1000);
    }
    throw e;
  }
}
