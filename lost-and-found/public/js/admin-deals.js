/* =============================================================================
   DEALS PAGE logic (admin-deals.html)
   Searches other stores through the price API (GET /api/compare) and lists
   results cheapest first, so the admin can spot deals to restock with or
   compare against Lost & Found's own prices.
   ============================================================================= */

// Quick-search buttons: one row of ideas per product type. Edit freely.
const QUICK_SEARCHES = {
  Decor: ['candle holder', 'picture frame', 'throw pillow', 'vase'],
  Tech: ['phone charger', 'bluetooth speaker', 'earbuds', 'usb hub'],
  Clothes: ['winter beanie', 'summer t-shirt', 'rain jacket', 'hoodie'],
  Toys: ['building blocks', 'board game', 'plush toy', 'puzzle 500 pieces'],
};

document.addEventListener('DOMContentLoaded', () => LF.adminLogin(start));

async function start() {
  const { api, config, esc, money } = LF;
  const $ = (id) => document.getElementById(id);
  const cfg = await config();

  if (!cfg.priceApi) {
    $('api-status').innerHTML = `<div class="notice err">Automatic deal search is off: start the server with a
      SERPAPI_KEY (see README.md). Until then, searches give you one-click links to each store.</div>`;
  }

  // Quick-search buttons
  $('quick-searches').innerHTML = Object.entries(QUICK_SEARCHES).map(([type, terms]) =>
    `<strong style="align-self:center">${esc(type)}:</strong>` +
    terms.map((t) => `<button type="button" class="btn btn-small btn-outline" data-q="${esc(t)}">${esc(t)}</button>`).join('')
  ).join('<span style="flex-basis:100%"></span>');
  $('quick-searches').addEventListener('click', (e) => {
    if (!e.target.dataset.q) return;
    $('deal-q').value = e.target.dataset.q;
    search();
  });

  $('deal-form').addEventListener('submit', (e) => { e.preventDefault(); search(); });

  async function search() {
    const q = $('deal-q').value.trim();
    if (!q) return;
    const max = Number($('deal-max').value) || Infinity;
    $('deal-results').innerHTML = '<p class="muted">Searching…</p>';
    let data;
    try {
      data = await api(`/api/compare?q=${encodeURIComponent(q)}`, { admin: true });
    } catch (err) {
      $('deal-results').innerHTML = `<div class="notice err">${esc(err.message)}</div>`;
      return;
    }

    const links = `<div class="store-links">${data.links.map((l) =>
      `<a class="btn btn-small btn-outline" target="_blank" rel="noopener" href="${esc(l.url)}">Search ${esc(l.store)}</a>`).join('')}</div>`;
    const results = data.results.filter((r) => r.price <= max);

    // Is it a deal? On sale at that store (has an old price) or $20 and under.
    const rows = results.map((r) => {
      const sale = r.oldPrice && r.oldPrice > r.price;
      const pctOff = sale ? Math.round((1 - r.price / r.oldPrice) * 100) : 0;
      return `
        <div class="compare-row">
          <img src="${esc(r.thumbnail || 'images/placeholder.svg')}" alt="">
          <div>
            <a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a>
            <div class="muted">${esc(r.store || '')}${sale ? ` · <span class="deal">SALE ${pctOff}% off</span>` : ''}</div>
          </div>
          <div style="text-align:right">
            <strong class="${r.price <= cfg.maxPrice ? 'deal' : ''}">${money(r.price)}</strong>
            ${sale ? `<br><span class="was">${money(r.oldPrice)}</span>` : ''}
          </div>
        </div>`;
    }).join('');

    $('deal-results').innerHTML = `
      <section class="box">
        <h2>Results for "${esc(data.query)}"</h2>
        ${data.apiEnabled ? `<p class="muted">${results.length} result${results.length === 1 ? '' : 's'}, cheapest first.</p>` : ''}
        ${rows || (data.apiEnabled ? '<p class="empty">No results at that price.</p>' : '')}
        <p class="muted" style="margin-top:14px">Open this search on each store:</p>${links}
      </section>`;
  }
}
