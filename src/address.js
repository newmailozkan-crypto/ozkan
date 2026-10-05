// Sipariş adresi: mahalle + cadde/sokak + kapı no (+ daire no) zorunlu. Doğrulama ve tek satırlık adres üretimi.
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function buildAddress(a) {
  const mahalle = clean(a.mahalle).replace(/\s*(mah\.?|mahallesi)$/i, '');
  const cadde = clean(a.cadde_sokak);
  const kapi = clean(a.kapi_no).replace(/^(no|kapı no|numara)[:.\s]*/i, '');
  const daire = clean(a.daire_no).replace(/^(daire|d)[:.\s]*/i, '');
  const note = clean(a.adres_notu).replace(/^\(|\)$/g, '');
  const noDaire = a.daire_yok === true || /^(yok|-|—|müstakil|iş ?yeri)$/i.test(daire);

  const errors = [];
  if (mahalle.length < 3) errors.push('MAHALLE eksik: müşteriden mahalle adını iste.');
  if (cadde.length < 2) errors.push('CADDE/SOKAK eksik: müşteriden cadde veya sokak adını iste.');
  if (!/\d/.test(kapi)) errors.push('KAPI NO eksik: müşteriden bina/kapı numarasını iste.');
  if (!daire && !noDaire) errors.push('DAİRE NO eksik: müşteriden daire numarasını sor. (Müşteri müstakil ev/iş yeri/dükkan olduğunu veya daire olmadığını söylerse daire_yok=true ile devam et, ısrar etme.)');
  if (errors.length) return { ok: false, errors };

  const parts = [`${mahalle} Mah.`, cadde, `No:${kapi}`];
  if (daire && !noDaire) parts.push(`Daire:${daire}`);
  let address = parts.join(' ');
  if (note) address += ` (${note})`;
  return { ok: true, address };
}
