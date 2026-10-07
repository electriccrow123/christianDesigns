/* =============================================================================
   LOST AND FOUND — shared code used by EVERY page
   -----------------------------------------------------------------------------
   What lives here (all inside one object called LF):
     • LF.renderHeader / LF.renderFooter -> the menu at the top and footer at the
       bottom of every page. EDIT THE MENU OR FOOTER TEXT HERE ONCE and every page
       updates.
     • LF.api(...)        -> talks to the server (server.js) to load/save data.
     • LF.cart            -> the shopping cart, saved in the visitor's browser.
     • LF.money / LF.esc  -> small helpers for showing prices and safe text.
     • LF.cardHtml(item)  -> the HTML for one item "card" in a grid.
   ============================================================================= */
(function () {
  'use strict';

  // ---------- Site-wide text (change the shop details here) ----------
  const SITE = {
    name: 'Lost & Found',
    tagline: 'Everything $20 or less',
    contactEmail: 'hello@lostandfound.example', // TODO: replace with the client's real email
    ownerName: 'Lost & Found',                  // shown in the copyright line
  };

  // ---------- Main menu (label + page). Add/remove links here. ----------
  // "Clothes by season" links go straight to the shop with filters applied.
  const MENU = [
    { label: 'Home', href: 'index.html' },
    { label: 'Shop All', href: 'shop.html' },
    { label: 'Decor', href: 'shop.html?category=Decor' },
    { label: 'Tech', href: 'shop.html?category=Tech' },
    { label: 'Clothes', href: 'shop.html?category=Clothes' },
    { label: 'Toys', href: 'shop.html?category=Toys' },
    { label: 'Legal', href: 'legal.html' },
  ];

  // Emoji shown for each product type on the home page tiles.
  const TYPE_ICONS = { Decor: '🕯️', Tech: '🎧', Clothes: '🧥', Toys: '🧸', Other: '📦' };

  // ---------- Safe text: stops item names from breaking the page ----------
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ---------- Price formatting: 12 -> "$12.00" ----------
  const money = (n) => `$${Number(n || 0).toFixed(2)}`;

  // ---------- Server calls ----------
  // LF.api('/api/products')                       -> GET
  // LF.api('/api/products', { method: 'POST', body: {...}, admin: true })
  // admin: true sends the saved admin password with the request.
  async function api(path, { method = 'GET', body, admin = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (admin) headers['X-Admin-Password'] = adminPassword.get();
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    return data;
  }

  // Store settings from server.js (price cap, categories, seasons). Loaded once.
  let configPromise;
  const config = () => (configPromise ||= api('/api/config'));

  // ---------- Browser storage (wrapped so private windows don't crash) ----------
  function store(key, storage = localStorage) {
    return {
      get() { try { return JSON.parse(storage.getItem(key)); } catch { return null; } },
      set(v) { try { storage.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ } },
      clear() { try { storage.removeItem(key); } catch { /* storage blocked */ } },
    };
  }
  // Admin password is kept only for this browser tab (sessionStorage).
  const pw = store('lf_admin_pw', sessionStorage);
  const adminPassword = { get: () => pw.get() || '', set: (v) => pw.set(v), clear: () => pw.clear() };

  // ---------- Shopping cart ----------
  // Saved as a list like [{ id: "itm_123", qty: 2 }] in the visitor's browser.
  const cartStore = store('lf_cart');
  const cart = {
    items: () => cartStore.get() || [],
    count: () => cart.items().reduce((n, l) => n + l.qty, 0),
    add(id, qty = 1) {
      const items = cart.items();
      const line = items.find((l) => l.id === id);
      if (line) line.qty += qty; else items.push({ id, qty });
      cartStore.set(items);
      updateCartCount();
    },
    setQty(id, qty) {
      const items = cart.items().map((l) => (l.id === id ? { ...l, qty } : l)).filter((l) => l.qty > 0);
      cartStore.set(items);
      updateCartCount();
    },
    remove: (id) => cart.setQty(id, 0),
    clear() { cartStore.clear(); updateCartCount(); },
  };

  function updateCartCount() {
    const el = document.querySelector('.cart-count');
    if (el) el.textContent = cart.count();
  }

  // ---------- Header (logo + menu + cart) ----------
  function renderHeader() {
    const el = document.getElementById('site-header');
    if (!el) return;
    const here = location.pathname.split('/').pop() + location.search;
    const links = MENU.map((m) => {
      const active = here === m.href || (m.href === 'index.html' && (here === '' || here === 'index.html'));
      return `<a href="${m.href}"${active ? ' class="active" aria-current="page"' : ''}>${esc(m.label)}</a>`;
    }).join('');
    el.className = 'site-header';
    el.innerHTML = `
      <div class="price-banner">${esc(SITE.tagline)} — new finds added all the time</div>
      <div class="header-inner">
        <a class="logo" href="index.html">Lost <span>&amp;</span> Found</a>
        <nav class="main-nav" aria-label="Main menu">${links}</nav>
        <a class="cart-link" href="cart.html">Cart<span class="cart-count">0</span></a>
      </div>`;
    updateCartCount();
  }

  // ---------- Footer (copyright + links) ----------
  function renderFooter() {
    const el = document.getElementById('site-footer');
    if (!el) return;
    el.className = 'site-footer';
    el.innerHTML = `
      <div class="footer-inner">
        <div>© ${new Date().getFullYear()} ${esc(SITE.ownerName)}. All rights reserved.</div>
        <div>
          <a href="legal.html">Terms, Privacy &amp; Copyright</a> ·
          <a href="mailto:${esc(SITE.contactEmail)}">Contact</a> ·
          <a href="admin.html">Admin</a>
        </div>
      </div>`;
  }

  // ---------- One item card (used by the home & shop grids) ----------
  function cardHtml(item) {
    const img = item.image || 'images/placeholder.svg';
    const was = item.wasPrice > item.price ? `<span class="was">${money(item.wasPrice)}</span>` : '';
    const tags = [item.category, item.season, item.condition].filter(Boolean).map((t) => `<span class="tag">${esc(t)}</span>`).join('');
    return `
      <a class="card" href="item.html?id=${encodeURIComponent(item.id)}">
        <img src="${esc(img)}" alt="${esc(item.name)}" loading="lazy">
        <div class="card-body">
          <div class="card-title">${esc(item.name)}</div>
          <div><span class="price">${money(item.price)}</span>${was}</div>
          ${item.quantity > 0 ? '' : '<div class="sold-out">Sold out</div>'}
          <div class="tags">${tags}</div>
        </div>
      </a>`;
  }

  // Shortcut for reading ?name=value from the address bar.
  const param = (name) => new URLSearchParams(location.search).get(name) || '';

  // Make everything available to the page scripts as LF.something
  window.LF = { SITE, TYPE_ICONS, esc, money, api, config, cart, adminPassword, cardHtml, param, renderHeader, renderFooter };

  // Draw header & footer as soon as the page loads.
  document.addEventListener('DOMContentLoaded', () => { renderHeader(); renderFooter(); });
})();
