/* =============================================================================
   ADMIN PAGE logic (admin.html)
   Sections in this file:
     1. Setup & tabs (Items / Orders)
     2. Add / edit item form (incl. picture upload)
     3. Items table (inline price change, edit, delete, compare)
     4. Bulk price change
     5. Compare prices with other stores (pop-up)
     6. CSV import & JSON backup
     7. Orders
   ============================================================================= */
document.addEventListener('DOMContentLoaded', () => LF.adminLogin(start));

async function start() {
  const { api, config, esc, money } = LF;
  const $ = (id) => document.getElementById(id);
  const cfg = await config();
  let products = [];

  // ---------------------------------------------------------------------------
  // 1. SETUP & TABS — "#orders" in the address shows the Orders tab.
  // ---------------------------------------------------------------------------
  const options = (list) => list.map((v) => `<option>${esc(v)}</option>`).join('');
  $('f-category').innerHTML = options(cfg.categories);
  $('f-season').innerHTML = options(cfg.seasons);
  $('b-category').innerHTML += options(cfg.categories);
  $('b-season').innerHTML += options(cfg.seasons);
  $('f-price').max = cfg.maxPrice;

  function showTab() {
    const orders = location.hash === '#orders';
    $('tab-items').classList.toggle('hidden', orders);
    $('tab-orders').classList.toggle('hidden', !orders);
    if (orders) loadOrders();
  }
  window.addEventListener('hashchange', showTab);

  async function loadProducts() {
    products = await api('/api/products');
    renderTable();
  }

  // ---------------------------------------------------------------------------
  // 2. ADD / EDIT ITEM FORM
  // ---------------------------------------------------------------------------
  let imageData = null; // the chosen picture, ready to upload

  // Season box only shows for Clothes.
  const toggleSeason = () => $('season-field').classList.toggle('hidden', $('f-category').value !== 'Clothes');
  $('f-category').addEventListener('change', toggleSeason);

  // When a picture is chosen: shrink it (max 1200px wide/tall) so pages load
  // fast, and show a preview. GIFs are kept as-is so animations still work.
  $('f-image').addEventListener('change', async () => {
    const file = $('f-image').files[0];
    imageData = null;
    if (!file) return;
    if (file.size > cfg.maxImageMb * 1024 * 1024 * 3) { formMsg(`Picture is too large (max ${cfg.maxImageMb} MB).`, false); return; }
    imageData = file.type === 'image/gif' ? await readAsDataUrl(file) : await shrinkImage(file, 1200);
    $('f-preview').src = imageData;
    $('f-preview').classList.remove('hidden');
  });

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function shrinkImage(file, maxSide) {
    const img = new Image();
    img.src = await readAsDataUrl(file);
    await img.decode();
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    // PNGs stay PNG (keeps transparency); everything else becomes JPEG.
    return file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.85);
  }

  function formMsg(text, ok = true) {
    $('form-msg').innerHTML = text ? `<div class="notice ${ok ? 'ok' : 'err'}">${esc(text)}</div>` : '';
  }

  function resetForm() {
    $('item-form').reset();
    $('f-id').value = '';
    imageData = null;
    $('f-preview').classList.add('hidden');
    $('remove-image-wrap').classList.add('hidden');
    $('form-title').textContent = 'Add an item';
    $('save-btn').textContent = 'Add item';
    $('cancel-edit').classList.add('hidden');
    toggleSeason();
  }

  // Fill the form with an existing item so it can be edited.
  function editItem(item) {
    resetForm();
    $('f-id').value = item.id;
    $('f-name').value = item.name;
    $('f-price').value = item.price;
    $('f-qty').value = item.quantity;
    $('f-category').value = item.category;
    $('f-season').value = item.season || 'All Season';
    $('f-condition').value = item.condition || 'Good';
    $('f-desc').value = item.description || '';
    $('f-featured').checked = Boolean(item.featured);
    if (item.image) {
      $('f-preview').src = item.image;
      $('f-preview').classList.remove('hidden');
      $('remove-image-wrap').classList.remove('hidden');
    }
    $('form-title').textContent = 'Edit item';
    $('save-btn').textContent = 'Save changes';
    $('cancel-edit').classList.remove('hidden');
    toggleSeason();
    $('item-form').scrollIntoView({ behavior: 'smooth' });
  }
  $('cancel-edit').addEventListener('click', () => { resetForm(); formMsg(''); });

  $('item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('f-id').value;
    const body = {
      name: $('f-name').value,
      price: Number($('f-price').value),
      quantity: Number($('f-qty').value),
      category: $('f-category').value,
      season: $('f-season').value,
      condition: $('f-condition').value,
      description: $('f-desc').value,
      featured: $('f-featured').checked,
    };
    if (imageData) body.imageData = imageData;
    else if (id && $('f-remove-image').checked) body.removeImage = true;

    $('save-btn').disabled = true;
    try {
      await api(id ? `/api/products/${id}` : '/api/products', { method: id ? 'PUT' : 'POST', body, admin: true });
      formMsg(id ? 'Item updated.' : `"${body.name}" added to the shop.`);
      resetForm();
      await loadProducts();
    } catch (err) {
      formMsg(err.message, false);
    } finally {
      $('save-btn').disabled = false;
    }
  });

  // ---------------------------------------------------------------------------
  // 3. ITEMS TABLE
  // ---------------------------------------------------------------------------
  function renderTable() {
    const q = $('table-search').value.trim().toLowerCase();
    const list = products.filter((p) => !q || `${p.name} ${p.category} ${p.season}`.toLowerCase().includes(q));
    $('item-count').textContent = `(${products.length})`;
    $('item-rows').innerHTML = list.map((p) => `
      <tr>
        <td><img src="${esc(p.image || 'images/placeholder.svg')}" alt=""></td>
        <td><a href="item.html?id=${encodeURIComponent(p.id)}" target="_blank">${esc(p.name)}</a>${p.featured ? ' ⭐' : ''}</td>
        <td>${esc(p.category)}${p.season ? `<br><span class="muted">${esc(p.season)}</span>` : ''}</td>
        <td>
          <input class="price-input" type="number" step="0.01" min="0.01" max="${cfg.maxPrice}" value="${p.price}" data-price="${esc(p.id)}" aria-label="Price">
          ${p.wasPrice ? `<br><span class="was">${money(p.wasPrice)}</span>` : ''}
        </td>
        <td>${p.quantity > 0 ? p.quantity : '<span class="sold-out">0</span>'}</td>
        <td class="muted">${p.createdAt ? new Date(p.createdAt).toLocaleDateString() : ''}</td>
        <td><div class="actions">
          <button class="btn btn-small btn-outline" data-compare="${esc(p.id)}">Compare</button>
          <button class="btn btn-small btn-outline" data-edit="${esc(p.id)}">Edit</button>
          <button class="btn btn-small btn-danger" data-delete="${esc(p.id)}">Delete</button>
        </div></td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">No items yet. Add one with the form.</td></tr>';
  }
  $('table-search').addEventListener('input', renderTable);

  // Inline price change: edit the number, then press Enter or click away.
  $('item-rows').addEventListener('change', async (e) => {
    const id = e.target.dataset.price;
    if (!id) return;
    await setPrice(id, Number(e.target.value));
  });

  async function setPrice(id, price) {
    try {
      await api(`/api/products/${id}`, { method: 'PUT', body: { price }, admin: true });
    } catch (err) {
      alert(err.message);
    }
    await loadProducts();
  }

  $('item-rows').addEventListener('click', async (e) => {
    const { edit, delete: del, compare } = e.target.dataset;
    const item = products.find((p) => p.id === (edit || del || compare));
    if (!item) return;
    if (edit) editItem(item);
    if (compare) openCompare(item);
    if (del && confirm(`Delete "${item.name}"? This also deletes its picture.`)) {
      await api(`/api/products/${del}`, { method: 'DELETE', admin: true }).catch((err) => alert(err.message));
      await loadProducts();
    }
  });

  // ---------------------------------------------------------------------------
  // 4. BULK PRICE CHANGE
  // ---------------------------------------------------------------------------
  $('bulk-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const percent = Number($('b-percent').value);
    const body = { percent, category: $('b-category').value, season: $('b-season').value };
    const what = `${body.season ? `${body.season} ` : ''}${body.category === 'all' ? 'all items' : body.category}`;
    if (!confirm(`Change prices by ${percent > 0 ? '+' : ''}${percent}% on ${what}?`)) return;
    try {
      const { changed } = await api('/api/prices/bulk', { method: 'POST', body, admin: true });
      $('bulk-msg').innerHTML = `<div class="notice ok">${changed} price${changed === 1 ? '' : 's'} changed.</div>`;
      await loadProducts();
    } catch (err) {
      $('bulk-msg').innerHTML = `<div class="notice err">${esc(err.message)}</div>`;
    }
  });

  // ---------------------------------------------------------------------------
  // 5. COMPARE PRICES WITH OTHER STORES (pop-up)
  //    Asks the server (GET /api/compare) which uses the price API. Shows the
  //    lowest and middle price elsewhere, plus one-click "Use this price"
  //    suggestions so Lost & Found stays the better deal.
  // ---------------------------------------------------------------------------
  const dialog = $('compare-dialog');
  $('compare-close').addEventListener('click', () => dialog.close());

  async function openCompare(item) {
    $('compare-title').textContent = `Compare: ${item.name}`;
    $('compare-body').innerHTML = '<p class="muted">Checking other stores…</p>';
    dialog.showModal();
    let data;
    try {
      data = await api(`/api/compare?q=${encodeURIComponent(item.name)}`, { admin: true });
    } catch (err) {
      $('compare-body').innerHTML = `<div class="notice err">${esc(err.message)}</div>`;
      return;
    }

    const links = `<div class="store-links">${data.links.map((l) =>
      `<a class="btn btn-small btn-outline" target="_blank" rel="noopener" href="${esc(l.url)}">${esc(l.store)}</a>`).join('')}</div>`;

    if (!data.apiEnabled) {
      $('compare-body').innerHTML = `
        <div class="notice err">Automatic price lookup is off. Add a SERPAPI_KEY when starting the server (see README.md).</div>
        <p>Your price: <strong class="price">${money(item.price)}</strong>. Check other stores by hand:</p>${links}`;
      return;
    }
    if (!data.results.length) {
      $('compare-body').innerHTML = `<p>No prices found for this name. Try a shorter item name, or search by hand:</p>${links}`;
      return;
    }

    const prices = data.results.map((r) => r.price);
    const lowest = prices[0];
    const median = prices[Math.floor(prices.length / 2)];
    // Suggested prices: a bit under the lowest and under the typical price,
    // never above the shop's $20 cap.
    const cap = (n) => Math.min(cfg.maxPrice, Math.max(0.25, Math.round(n * 4) / 4));
    const suggestions = [...new Set([cap(lowest * 0.9), cap(median * 0.7), cap(median * 0.5)])];

    $('compare-body').innerHTML = `
      <p>Your price: <strong class="price">${money(item.price)}</strong> ·
         Lowest elsewhere: <strong>${money(lowest)}</strong> ·
         Typical: <strong>${money(median)}</strong></p>
      <p>${item.price <= lowest ? '<span class="deal">✓ You are the cheapest.</span>' : `You're ${money(item.price - lowest)} above the lowest price found.`}</p>
      <div class="store-links">${suggestions.map((s) =>
        `<button class="btn btn-small" data-use="${s}">Use ${money(s)}</button>`).join('')}</div>
      <div>${data.results.slice(0, 15).map((r) => `
        <div class="compare-row">
          <img src="${esc(r.thumbnail || 'images/placeholder.svg')}" alt="">
          <div><a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a><div class="muted">${esc(r.store || '')}</div></div>
          <div><strong>${money(r.price)}</strong>${r.oldPrice ? `<br><span class="was">${money(r.oldPrice)}</span>` : ''}</div>
        </div>`).join('')}</div>
      <p class="muted" style="font-size:.85rem">Search other stores yourself:</p>${links}`;

    $('compare-body').querySelectorAll('[data-use]').forEach((btn) => btn.addEventListener('click', async () => {
      await setPrice(item.id, Number(btn.dataset.use));
      dialog.close();
    }));
  }

  // ---------------------------------------------------------------------------
  // 6. CSV IMPORT & JSON BACKUP
  // ---------------------------------------------------------------------------
  // Reads a CSV file (handles "quoted, text" with commas inside).
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const [header, ...data] = rows.filter((r) => r.some((v) => v.trim()));
    const keys = (header || []).map((h) => h.trim().toLowerCase());
    return data.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()])));
  }

  $('csv-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('csv-file').files[0];
    if (!file) return;
    const rows = parseCsv(await file.text());
    let added = 0;
    const errors = [];
    for (const [i, r] of rows.entries()) {
      try {
        await api('/api/products', {
          method: 'POST',
          admin: true,
          body: { ...r, price: Number(r.price), quantity: Number(r.quantity || 1), featured: /^(yes|true|1|y)$/i.test(r.featured || '') },
        });
        added++;
      } catch (err) {
        errors.push(`Row ${i + 2} (${r.name || 'no name'}): ${err.message}`);
      }
    }
    $('csv-msg').innerHTML = `<div class="notice ${errors.length ? 'err' : 'ok'}">${added} item${added === 1 ? '' : 's'} added.
      ${errors.map((m) => `<br>${esc(m)}`).join('')}</div>`;
    $('csv-form').reset();
    await loadProducts();
  });

  // Saves a copy of every item (same format as data/products.json).
  $('export-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(products, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `lost-and-found-products-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---------------------------------------------------------------------------
  // 7. ORDERS
  // ---------------------------------------------------------------------------
  async function loadOrders() {
    const orders = await api('/api/orders', { admin: true });
    const statuses = ['new', 'paid', 'completed', 'cancelled'];
    $('order-rows').innerHTML = orders.map((o) => `
      <tr>
        <td>${new Date(o.createdAt).toLocaleString()}<br><span class="muted">${esc(o.id)}</span></td>
        <td>${esc(o.customer.name)}<br><a href="mailto:${esc(o.customer.email)}">${esc(o.customer.email)}</a>
            ${o.customer.phone ? `<br>${esc(o.customer.phone)}` : ''}
            ${o.customer.notes ? `<br><span class="muted">${esc(o.customer.notes)}</span>` : ''}</td>
        <td>${o.items.map((l) => `${l.qty} × ${esc(l.name)} (${money(l.price)})`).join('<br>')}</td>
        <td><strong>${money(o.total)}</strong></td>
        <td><select data-order="${esc(o.id)}">${statuses.map((s) => `<option${s === o.status ? ' selected' : ''}>${s}</option>`).join('')}</select></td>
      </tr>`).join('') || '<tr><td colspan="5" class="empty">No orders yet.</td></tr>';
  }

  $('order-rows').addEventListener('change', async (e) => {
    const id = e.target.dataset.order;
    if (id) await api(`/api/orders/${id}`, { method: 'PUT', body: { status: e.target.value }, admin: true }).catch((err) => alert(err.message));
  });

  // Go!
  toggleSeason();
  await loadProducts();
  showTab();
}
