/* =============================================================================
   SHOP PAGE logic (shop.html)
   Browse by PRODUCT (search, type, season), by COST (max price, sort by price)
   and by DATE ADDED (sort newest/oldest). Filters are kept in the address bar
   so a filtered view can be bookmarked or linked from the menu.
   ============================================================================= */
document.addEventListener('DOMContentLoaded', async () => {
  const { api, config, cardHtml, esc, param } = LF;
  const $ = (id) => document.getElementById(id);

  // ---- Fill the dropdowns from the store settings in server.js ----
  const cfg = await config();
  $('category').innerHTML += cfg.categories.map((c) => `<option>${esc(c)}</option>`).join('');
  $('season').innerHTML += cfg.seasons.map((s) => `<option>${esc(s)}</option>`).join('');

  // ---- Start with any filters given in the address bar ----
  $('q').value = param('q');
  $('category').value = param('category');
  $('season').value = param('season');
  $('max').value = param('max');
  $('sort').value = param('sort') || 'newest';

  const products = await api('/api/products');

  function render() {
    const q = $('q').value.trim().toLowerCase();
    const category = $('category').value;
    const season = $('season').value;
    const max = Number($('max').value) || Infinity;

    // The season dropdown only makes sense for Clothes.
    $('season').closest('div').classList.toggle('hidden', category !== 'Clothes');

    // ---- Filter ----
    let list = products.filter((p) =>
      (!q || `${p.name} ${p.description}`.toLowerCase().includes(q)) &&
      (!category || p.category === category) &&
      (category !== 'Clothes' || !season || p.season === season || p.season === 'All Season') &&
      p.price <= max);

    // ---- Sort ----
    const sorters = {
      newest: (a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''),
      oldest: (a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''),
      'price-asc': (a, b) => a.price - b.price,
      'price-desc': (a, b) => b.price - a.price,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    list.sort(sorters[$('sort').value] || sorters.newest);
    // Sold-out items always go to the end.
    list.sort((a, b) => (b.quantity > 0) - (a.quantity > 0));

    // ---- Show ----
    const title = category === 'Clothes' && season ? `${season} clothes` : category || 'Shop all';
    $('shop-title').textContent = title;
    document.title = `${title} — Lost & Found`;
    $('result-count').textContent = `${list.length} item${list.length === 1 ? '' : 's'}`;
    $('results').innerHTML = list.map(cardHtml).join('') || '<p class="empty">No items match. Try a different filter.</p>';

    // Keep the address bar in sync (so the view can be shared/bookmarked).
    const params = new URLSearchParams();
    for (const id of ['q', 'category', 'season', 'max', 'sort']) if ($(id).value) params.set(id, $(id).value);
    if (category !== 'Clothes') params.delete('season');
    history.replaceState(null, '', `shop.html${params.toString() ? `?${params}` : ''}`);
  }

  $('browse').addEventListener('input', render);
  render();
});
