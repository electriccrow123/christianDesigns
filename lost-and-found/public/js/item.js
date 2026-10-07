/* =============================================================================
   ITEM PAGE logic (item.html?id=...)
   Loads one item from the server and shows its details + "Add to cart".
   ============================================================================= */
document.addEventListener('DOMContentLoaded', async () => {
  const { api, esc, money, cart, param } = LF;
  const box = document.getElementById('item');

  let item;
  try {
    item = await api(`/api/products/${encodeURIComponent(param('id'))}`);
  } catch {
    box.innerHTML = '<p class="empty">Sorry, that item could not be found. It may have sold.</p>';
    return;
  }
  document.title = `${item.name} — Lost & Found`;

  const inCart = cart.items().find((l) => l.id === item.id)?.qty || 0;
  const left = item.quantity - inCart; // how many more this shopper can add
  const was = item.wasPrice > item.price ? `<span class="was">Was ${money(item.wasPrice)}</span>` : '';
  const tags = [item.category, item.season, item.condition].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('');

  box.innerHTML = `
    <div class="item-layout">
      <img src="${esc(item.image || 'images/placeholder.svg')}" alt="${esc(item.name)}">
      <div>
        <h1>${esc(item.name)}</h1>
        <p><span class="price">${money(item.price)}</span> ${was}</p>
        <div class="tags" style="margin-bottom:16px">${tags}</div>
        <p>${esc(item.description || '').replace(/\n/g, '<br>')}</p>
        <p class="muted">${item.quantity > 0 ? `${item.quantity} available` : 'Sold out'}</p>
        <div class="row" style="max-width:320px;align-items:end">
          <div><label for="qty">Quantity</label><input id="qty" type="number" min="1" max="${Math.max(1, left)}" value="1" ${left > 0 ? '' : 'disabled'}></div>
          <button class="btn" id="add" ${left > 0 ? '' : 'disabled'}>${item.quantity > 0 ? 'Add to cart' : 'Sold out'}</button>
        </div>
        <div id="msg"></div>
      </div>
    </div>`;

  document.getElementById('add')?.addEventListener('click', () => {
    const qty = Math.min(left, Math.max(1, Math.floor(Number(document.getElementById('qty').value)) || 1));
    cart.add(item.id, qty);
    document.getElementById('msg').innerHTML =
      `<div class="notice ok">Added to cart. <a href="cart.html">View cart →</a></div>`;
    document.getElementById('add').disabled = qty >= left;
  });
});
