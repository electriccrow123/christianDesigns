/* =============================================================================
   CART & CHECKOUT logic (cart.html)
   Shows the items saved in LF.cart, lets the shopper change quantities, and
   sends the order to the server (POST /api/orders). The server re-checks the
   prices and stock itself, so prices can't be tampered with in the browser.
   ============================================================================= */
document.addEventListener('DOMContentLoaded', async () => {
  const { api, esc, money, cart } = LF;
  const $ = (id) => document.getElementById(id);
  const products = await api('/api/products');

  function render() {
    // Match cart lines to current item info; drop ones that no longer exist.
    const lines = cart.items()
      .map((l) => ({ ...l, item: products.find((p) => p.id === l.id) }))
      .filter((l) => l.item);
    const total = lines.reduce((sum, l) => sum + l.item.price * l.qty, 0);

    $('cart-total').textContent = money(total);
    $('checkout').classList.toggle('hidden', !lines.length);
    $('cart-lines').innerHTML = lines.length ? lines.map((l) => `
      <div class="cart-line">
        <img src="${esc(l.item.image || 'images/placeholder.svg')}" alt="">
        <div>
          <a href="item.html?id=${encodeURIComponent(l.id)}"><strong>${esc(l.item.name)}</strong></a>
          <div class="muted">${money(l.item.price)} each</div>
          ${l.qty > l.item.quantity ? `<div class="sold-out">Only ${l.item.quantity} left</div>` : ''}
        </div>
        <div class="actions">
          <input class="qty" type="number" min="0" max="${l.item.quantity}" value="${l.qty}" data-id="${esc(l.id)}" aria-label="Quantity">
          <button class="btn btn-small btn-outline" data-remove="${esc(l.id)}">Remove</button>
        </div>
      </div>`).join('') : '<p class="empty">Your cart is empty. <a href="shop.html">Go find something!</a></p>';
  }

  // Change quantity / remove buttons
  $('cart-lines').addEventListener('change', (e) => {
    if (e.target.dataset.id) { cart.setQty(e.target.dataset.id, Math.max(0, Math.floor(Number(e.target.value)) || 0)); render(); }
  });
  $('cart-lines').addEventListener('click', (e) => {
    if (e.target.dataset.remove) { cart.remove(e.target.dataset.remove); render(); }
  });

  // Place order
  $('checkout').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      const order = await api('/api/orders', {
        method: 'POST',
        body: {
          items: cart.items(),
          customer: { name: $('c-name').value, email: $('c-email').value, phone: $('c-phone').value, notes: $('c-notes').value },
        },
      });
      cart.clear();
      $('cart-lines').innerHTML = '';
      $('checkout').classList.add('hidden');
      $('checkout-msg').innerHTML = `<div class="notice ok"><strong>Thank you!</strong> Order ${esc(order.id)} for ${money(order.total)}
        was placed. We'll email you soon to arrange payment and pickup/shipping.</div>`;
    } catch (err) {
      $('checkout-msg').innerHTML = `<div class="notice err">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  });

  render();
});
