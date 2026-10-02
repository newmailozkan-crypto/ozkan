# Instagram Satış Botu (Claude + Render + Telegram)

Instagram hesabınıza gelen **DM** ve **yorumlara** cevap veren, ürün görsellerini katalogla eşleştiren, sipariş toplayıp **Telegram**'a ileten satış chatbot'u.

## Neler yapıyor?
- DM'lere doğal sohbetle cevap verir, ikna edici satış yapar.
- Müşterinin gönderdiği ürün fotoğrafını analiz edip XML kataloğundaki ürünle eşleştirir (fiyat + bilgi + fotoğraf gönderir).
- Beden/numara stokunu kontrol eder; sadece stokta olan ürünleri önerir.
- Sipariş bilgilerini toplar: isim soyisim, telefon, açık adres, il, ilçe, ürün/beden.
- Bilgiler tamamlanınca müşterinin numarasında olan 5-10 modelin fotoğrafını gönderip 2'li alım kampanyasıyla upsell yapar.
- Sipariş sonunda "24 saat içinde paketlenir, SMS ile bilgilendirilirsiniz" der.
- Siparişi `isim, telefon, adres, il/ilçe, ürünler, nihai fiyat` formatında Telegram'a yollar.
- Gönderi altı yorumlara herkese açık kısa yanıt verir + yorumcuya DM (özel yanıt) gönderir.
- Ürün XML'ini (`FEED_REFRESH_MIN`, varsayılan 15 dk) ve kampanya/kargo/ödeme sayfalarını (`SITE_REFRESH_MIN`, varsayılan 30 dk) otomatik yeniler; değişiklik olunca bot yeni bilgiyle konuşur.
- Şikayet/iade/bilemediği durumlarda Telegram'a "insan desteği gerekli" bildirimi atar.

## Mimari
```
Instagram ──webhook──▶ Render (server.js) ──▶ Claude (araçlarla)
                              │                 ├─ search_products / get_product (XML katalog)
                              │                 ├─ match_customer_image (görsel eşleştirme)
                              │                 ├─ send_product_photos / suggest_upsell
                              │                 ├─ submit_order ──▶ Telegram
                              └─ site sayfaları (kampanya/kargo/ödeme) periyodik taranır
```

## Kurulum

### 1) GitHub
Bu klasörü bir GitHub deposuna yükleyin (`.env` dosyasını **yüklemeyin**, `.gitignore` zaten engeller).

```bash
git init && git add . && git commit -m "ilk sürüm"
git branch -M main
git remote add origin https://github.com/KULLANICI/ig-satis-botu.git
git push -u origin main
```

### 2) Telegram botu
1. Telegram'da `@BotFather` → `/newbot` → token'ı alın (`TELEGRAM_BOT_TOKEN`).
2. Botu siparişlerin gideceği gruba/sohbete ekleyin ve bir mesaj yazın.
3. Chat ID için: `https://api.telegram.org/bot<TOKEN>/getUpdates` adresinde `chat.id` değerine bakın (`TELEGRAM_CHAT_ID`; grup ID'leri `-100...` ile başlar).

### 3) Meta / Instagram
1. Instagram hesabınız **Profesyonel (Business/Creator)** olmalı.
2. [developers.facebook.com](https://developers.facebook.com) → Uygulama oluştur → **Instagram** ürününü ekleyin (Instagram API with Instagram Login).
3. İzinler: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`.
4. Hesabınızı bağlayıp **access token** üretin (uzun ömürlü token'a çevirin) → `IG_ACCESS_TOKEN`. Instagram hesap ID'niz → `IG_ACCOUNT_ID`. Uygulama gizli anahtarı → `IG_APP_SECRET`.
5. Webhook (Render'a deploy ettikten sonra):
   - Callback URL: `https://SERVIS-ADINIZ.onrender.com/webhook`
   - Verify token: `IG_VERIFY_TOKEN` ile aynı metin
   - Abone olunacak alanlar: **messages** ve **comments**
6. Canlıda herkese hizmet vermesi için Meta **App Review** (gelişmiş erişim) onayı gerekir. Onaydan önce sadece uygulamaya eklediğiniz test hesaplarıyla çalışır.

### 4) Render
1. Render → **New → Web Service** → GitHub deponuzu seçin (`render.yaml` otomatik okunur).
2. `Environment` bölümüne `.env.example`'daki değişkenleri girin.
3. Deploy sonrası `https://SERVIS.onrender.com/health` adresinde katalog ve site bilgisinin yüklendiğini görün (`catalog.count > 0`).

> **Önemli:** Render'ın ücretsiz planı boşta uyur; Meta webhook'ları ve müşteri mesajları kaçabilir. Canlı kullanım için **Starter** plan önerilir.

## Ortam değişkenleri
| Değişken | Açıklama |
|---|---|
| `IG_VERIFY_TOKEN` | Webhook doğrulama metni (kendiniz belirleyin) |
| `IG_APP_SECRET` | Meta uygulama gizli anahtarı (imza doğrulaması) |
| `IG_ACCESS_TOKEN` | Instagram erişim token'ı |
| `IG_ACCOUNT_ID` | Instagram profesyonel hesap ID |
| `ANTHROPIC_API_KEY` | Claude API anahtarı |
| `CLAUDE_MODEL` | Varsayılan `claude-sonnet-5-5` |
| `STORE_NAME` | Mağaza adı (bot kendini böyle tanıtır) |
| `PRODUCT_FEED_URL` | Ürün XML linkiniz |
| `SITE_INFO_URLS` | Kampanya/kargo/ödeme/iade sayfa linkleri (virgülle) |
| `FEED_REFRESH_MIN` / `SITE_REFRESH_MIN` | Yenileme sıklığı (dakika) |
| `CAMPAIGN_RULES` | (Opsiyonel) Örn. `2:300,3:600` → 2+ üründe 300 TL, 3+ üründe 600 TL. Verilirse indirimi sunucu hesaplar, bot değiştiremez. Verilmezse bot indirimi site bilgisinden okur (en fazla %40 ile sınırlı). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Sipariş bildirimi |

## XML formatı hakkında
Kod Google Merchant / Facebook feed'i, ve `<Product>…<Variants><Variant><Size>/<Stock>` tarzı yaygın e-ticaret XML'lerini tanımaya çalışır (farklı alan adlarını dener, aynı `item_group_id`'li satırları tek ürün + bedenler olarak birleştirir). Kendi XML'inizde alan adları farklıysa `src/catalog.js` içindeki `normalize()` ve `extractSizes()` fonksiyonlarındaki isim listelerine ekleme yapmanız yeterli. Test için: `npm run test:feed`. Sağlık adresinde `catalog.count` 0 çıkarsa XML'den bir örnek ürün kopyalayıp bana gönderin, alan eşlemesini birlikte düzeltelim.

## Bilmeniz gerekenler
- **24 saat kuralı:** Instagram, müşterinin son mesajından sonra 24 saat içinde cevap vermenize izin verir. Yorum "özel yanıtı" (private reply) yorum başına 1 kez ve 7 gün içinde kullanılabilir ve sadece metin gönderir; fotoğraflar müşteri DM'den yazınca gönderilir.
- **Bellek:** Konuşma geçmişi bellekte tutulur; sunucu yeniden başlarsa sipariş toplama yarım kalan müşteriler baştan başlar. Kalıcılık istenirse Redis/Postgres eklenebilir.
- **Ürün görselleri** herkese açık `https://` adres olmalı (Instagram bunları indirir).
- **Sipariş kaydı:** Siparişler Telegram'a gider ve Render loglarına `[ORDER]` olarak yazılır. Telegram'a ulaşılamazsa bot müşteriye siparişi aldığını söylemez.
- **Maliyet:** Her mesaj Claude API kullanır; görsel eşleştirme ek 2 çağrı yapar. Sistem istemi önbelleğe alınır.
- Bot, kampanya/kargo/ödeme için yalnızca site sayfalarındaki bilgiyi kullanır; sayfa yapısı değişirse `SITE_INFO_URLS` içindeki linkleri güncelleyin.
