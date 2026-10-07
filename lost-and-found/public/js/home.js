/* =============================================================================
   HOME PAGE logic (index.html)
   Fills in: product-type tiles, "Featured finds" and "Just added".
   ============================================================================= */
document.addEventListener('DOMContentLoaded', async () => {
  const { api, config, cardHtml, esc, TYPE_ICONS } = LF;

  // 1) Product-type tiles. "Clothes" also gets one tile per season.
  const cfg = await config();
  const tiles = cfg.categories.filter((c) => c !== 'Other').map((c) => (
    `<a class="type-tile" href="shop.html?category=${encodeURIComponent(c)}">
       <span class="emoji">${TYPE_ICONS[c] || '📦'}</span>${esc(c)}</a>`
  ));
  const seasonTiles = cfg.seasons.filter((s) => s !== 'All Season').map((s) => (
    `<a class="type-tile" href="shop.html?category=Clothes&season=${encodeURIComponent(s)}">
       <span class="emoji">🧥</span>${esc(s)} clothes</a>`
  ));
  document.getElementById('type-tiles').innerHTML = tiles.concat(seasonTiles).join('');

  // 2) Items: only show ones still in stock on the home page.
  const items = (await api('/api/products')).filter((p) => p.quantity > 0);

  // Featured = items the admin ticked "Featured" (up to 8).
  const featured = items.filter((p) => p.featured).slice(0, 8);
  document.getElementById('featured').innerHTML = featured.map(cardHtml).join('');
  if (!featured.length) document.getElementById('featured-section').classList.add('hidden');

  // Just added = 8 most recent by date added.
  const newest = [...items].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 8);
  document.getElementById('newest').innerHTML = newest.map(cardHtml).join('') ||
    '<p class="empty">New items coming soon!</p>';
});
