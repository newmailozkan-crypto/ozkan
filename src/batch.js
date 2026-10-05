// Aynı müşterinin art arda gönderdiği mesajları (ör. video + yazı) kısa bir süre bekleyip TEK seferde işler:
// hem tek cevap verilir hem de gereksiz Claude çağrıları azalır.
export function createBatcher(delayMs, maxWaitMs, onFlush) {
  const pending = new Map();
  return {
    add(key, item) {
      let e = pending.get(key);
      const now = Date.now();
      if (!e) {
        e = { items: [], timer: null, first: now };
        pending.set(key, e);
      }
      e.items.push(item);
      clearTimeout(e.timer);
      const wait = Math.max(0, Math.min(delayMs, maxWaitMs - (now - e.first)));
      e.timer = setTimeout(() => {
        pending.delete(key);
        onFlush(key, e.items);
      }, wait);
      e.timer.unref?.();
    },
    size: () => pending.size,
  };
}
