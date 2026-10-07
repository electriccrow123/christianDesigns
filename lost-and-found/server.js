// =============================================================================
//  LOST AND FOUND — web server
// -----------------------------------------------------------------------------
//  What this file does:
//    1. Serves every page/picture/style in the /public folder to visitors.
//    2. Provides a small "API" the pages talk to:
//         GET    /api/products          -> list of items for sale (public)
//         GET    /api/products/:id      -> one item (public)
//         POST   /api/orders            -> a shopper places an order (public)
//         POST   /api/login             -> check the admin password
//         POST   /api/products          -> add an item          (admin only)
//         PUT    /api/products/:id      -> edit an item         (admin only)
//         DELETE /api/products/:id      -> remove an item       (admin only)
//         POST   /api/prices/bulk       -> raise/lower prices   (admin only)
//         GET    /api/compare?q=...     -> other stores' prices (admin only)
//         GET    /api/orders            -> see placed orders    (admin only)
//         PUT    /api/orders/:id        -> change order status  (admin only)
//    3. Saves everything to plain files so nothing needs a database:
//         data/products.json  -> every item (name, price, picture, ...)
//         data/orders.json    -> every order shoppers place
//         public/uploads/     -> the item pictures the admin uploads
//
//  Zero dependencies: only needs Node.js 18 or newer. Start with `npm start`.
//
//  SETTINGS (change with environment variables when starting the server):
//    PORT            which port to listen on            (default 3000)
//    ADMIN_PASSWORD  password for the admin page        (default "changeme")
//                    -> ALWAYS set a real one before going live, e.g.
//                       ADMIN_PASSWORD="my-secret" npm start
//    SERPAPI_KEY     key for the price-comparison / deals API (optional).
//                    Get one free at https://serpapi.com (Google Shopping).
//                    Without it the admin still gets one-click search links
//                    to Amazon, Walmart, Target, eBay and Best Buy.
// =============================================================================

import http from 'node:http';
import { readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

// ---------- Store rules (edit these to change how the shop works) ----------
const STORE = {
  MAX_PRICE: 20,              // The shop's rule: nothing costs more than $20.
  MIN_PRICE: 0.01,            // Smallest allowed price.
  MAX_IMAGE_MB: 5,            // Largest picture the admin can upload.
  // Product types from the client's layout. Shown in the menu, shop filter
  // and admin form. Add a new type here and it appears everywhere.
  CATEGORIES: ['Decor', 'Tech', 'Clothes', 'Toys', 'Other'],
  // Clothes are browsed by season. Other types don't use this field.
  SEASONS: ['Spring', 'Summer', 'Fall', 'Winter', 'All Season'],
};

// ---------- Paths & settings ----------
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const UPLOAD_DIR = join(PUBLIC_DIR, 'uploads');
const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data'); // DATA_DIR lets tests use a temp folder
const PRODUCTS_FILE = join(DATA_DIR, 'products.json');
const ORDERS_FILE = join(DATA_DIR, 'orders.json');
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SERPAPI_KEY = process.env.SERPAPI_KEY || '';

// File types the server is allowed to send. Add more here if needed.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

// =============================================================================
//  FILE STORAGE HELPERS
//  Data is kept in JSON files. Writes go to a temp file first, then get renamed,
//  so a crash mid-save can never leave a half-written (broken) file behind.
// =============================================================================
async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback; // file not created yet
    throw err;
  }
}

// Saves are queued one after another so two saves never overlap.
let writeQueue = Promise.resolve();
function writeJson(file, value) {
  writeQueue = writeQueue.then(async () => {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
    await rename(tmp, file);
  });
  return writeQueue;
}

const loadProducts = () => readJson(PRODUCTS_FILE, []);
const saveProducts = (list) => writeJson(PRODUCTS_FILE, list);
const loadOrders = () => readJson(ORDERS_FILE, []);
const saveOrders = (list) => writeJson(ORDERS_FILE, list);

// Short random id like "itm_3f9a1c2b" used for new items and orders.
const newId = (prefix) => `${prefix}_${randomBytes(4).toString('hex')}`;

// =============================================================================
//  PICTURE UPLOADS
//  The admin page sends a picture as a "data URL" (text form of the image).
//  We check it really is a JPG/PNG/WEBP/GIF by looking at its first bytes,
//  then save it into public/uploads/ and return its web address.
// =============================================================================
const IMAGE_SIGNATURES = [
  { ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: '.gif', test: (b) => b.slice(0, 4).toString('ascii') === 'GIF8' },
  { ext: '.webp', test: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
];

async function saveUploadedImage(dataUrl) {
  const match = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(dataUrl || '');
  if (!match) throw httpError(400, 'Picture must be a JPG, PNG, WEBP or GIF file.');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > STORE.MAX_IMAGE_MB * 1024 * 1024) {
    throw httpError(400, `Picture is too large (max ${STORE.MAX_IMAGE_MB} MB).`);
  }
  const kind = IMAGE_SIGNATURES.find((s) => s.test(bytes));
  if (!kind) throw httpError(400, 'Picture must be a JPG, PNG, WEBP or GIF file.');
  await mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${Date.now()}-${randomBytes(3).toString('hex')}${kind.ext}`;
  await writeFile(join(UPLOAD_DIR, name), bytes);
  return `uploads/${name}`; // address the pages use in <img src="...">
}

// Deletes an uploaded picture when its item is removed or its picture replaced.
// Only touches files inside public/uploads/ (never the sample images).
async function deleteUploadedImage(path) {
  if (typeof path !== 'string' || !path.startsWith('uploads/')) return;
  const file = normalize(join(PUBLIC_DIR, path));
  if (!file.startsWith(UPLOAD_DIR + sep)) return;
  await unlink(file).catch(() => {});
}

// =============================================================================
//  ITEM VALIDATION
//  Every item saved must follow the product format (see README.md and
//  data/product-template.json). This is where the $20 cap is enforced.
// =============================================================================
function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function validateProduct(input, existing = {}) {
  const name = cleanText(input.name ?? existing.name, 100);
  if (!name) throw httpError(400, 'Item name is required.');

  const price = Math.round(Number(input.price ?? existing.price) * 100) / 100;
  if (!Number.isFinite(price) || price < STORE.MIN_PRICE || price > STORE.MAX_PRICE) {
    throw httpError(400, `Price must be between $${STORE.MIN_PRICE.toFixed(2)} and $${STORE.MAX_PRICE.toFixed(2)}.`);
  }

  let category = cleanText(input.category ?? existing.category, 40);
  if (!STORE.CATEGORIES.includes(category)) category = 'Other';

  const quantity = Math.max(0, Math.floor(Number(input.quantity ?? existing.quantity ?? 1)) || 0);

  // Season only matters for Clothes; everything else is stored as "".
  let season = cleanText(input.season ?? existing.season, 20);
  if (category !== 'Clothes') season = '';
  else if (!STORE.SEASONS.includes(season)) season = 'All Season';

  return {
    name,
    price,
    category,
    season,
    description: cleanText(input.description ?? existing.description, 2000),
    condition: cleanText(input.condition ?? existing.condition ?? 'Good', 40),
    quantity,
    featured: Boolean(input.featured ?? existing.featured ?? false),
  };
}

// =============================================================================
//  PRICE CHANGES
//  Whenever an item's price changes we remember the old one:
//    - "wasPrice" shows a crossed-out "Was $X" on the shop when the price drops.
//    - "priceHistory" keeps every change so the admin can see what happened.
// =============================================================================
function applyPriceChange(item, newPrice) {
  if (newPrice === item.price) return item;
  const history = Array.isArray(item.priceHistory) ? item.priceHistory : [];
  history.push({ from: item.price, to: newPrice, at: new Date().toISOString() });
  return {
    ...item,
    price: newPrice,
    wasPrice: newPrice < item.price ? item.price : null, // only show "was" for markdowns
    priceHistory: history.slice(-20),                     // keep the last 20 changes
  };
}

// =============================================================================
//  PRICE COMPARISON / DEALS FROM OTHER STORES
//  Uses SerpApi's Google Shopping search (set SERPAPI_KEY). Results are cached
//  for 30 minutes so repeated searches don't use up the API allowance.
//  "links" are always returned: direct searches on big store websites.
// =============================================================================
const STORE_LINKS = [
  { store: 'Amazon', url: (q) => `https://www.amazon.com/s?k=${q}` },
  { store: 'Walmart', url: (q) => `https://www.walmart.com/search?q=${q}` },
  { store: 'Target', url: (q) => `https://www.target.com/s?searchTerm=${q}` },
  { store: 'eBay', url: (q) => `https://www.ebay.com/sch/i.html?_nkw=${q}` },
  { store: 'Best Buy', url: (q) => `https://www.bestbuy.com/site/searchpage.jsp?st=${q}` },
  { store: 'Google Shopping', url: (q) => `https://www.google.com/search?tbm=shop&q=${q}` },
];
const compareCache = new Map(); // search text -> { at, results }

async function comparePrices(query) {
  const q = cleanText(query, 120);
  if (!q) throw httpError(400, 'Type something to search for.');
  const encoded = encodeURIComponent(q);
  const links = STORE_LINKS.map((s) => ({ store: s.store, url: s.url(encoded) }));
  if (!SERPAPI_KEY) return { query: q, apiEnabled: false, results: [], links };

  const key = q.toLowerCase();
  const cached = compareCache.get(key);
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return { query: q, apiEnabled: true, results: cached.results, links };

  const url = `https://serpapi.com/search.json?engine=google_shopping&gl=us&hl=en&q=${encoded}&api_key=${SERPAPI_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw httpError(502, `Price API error (${res.status}). Check SERPAPI_KEY.`);
  const data = await res.json();
  const results = (data.shopping_results || [])
    .map((r) => ({
      title: r.title,
      store: r.source,
      price: typeof r.extracted_price === 'number' ? r.extracted_price : null,
      oldPrice: typeof r.extracted_old_price === 'number' ? r.extracted_old_price : null, // set when the store has it on sale
      link: r.product_link || r.link,
      thumbnail: r.thumbnail,
    }))
    .filter((r) => r.price !== null && r.link)
    .sort((a, b) => a.price - b.price)
    .slice(0, 40);
  compareCache.set(key, { at: Date.now(), results });
  return { query: q, apiEnabled: true, results, links };
}

// =============================================================================
//  ADMIN LOGIN
//  The admin page sends the password in an "X-Admin-Password" header on every
//  admin request. Compared in constant time so it can't be guessed by timing.
// =============================================================================
function isAdmin(req) {
  const given = String(req.headers['x-admin-password'] || '');
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(ADMIN_PASSWORD).digest();
  return timingSafeEqual(a, b);
}

function requireAdmin(req) {
  if (!isAdmin(req)) throw httpError(401, 'Wrong admin password.');
}

// =============================================================================
//  SMALL HTTP HELPERS
// =============================================================================
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Reads the JSON a page sent. Limit is a bit over the picture size limit
// because pictures arrive as base64 text (about 4/3 larger than the file).
async function readBody(req, limitBytes = (STORE.MAX_IMAGE_MB * 1.4 + 1) * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw httpError(413, 'Upload is too large.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Request was not valid JSON.');
  }
}

// =============================================================================
//  API ROUTES — what happens for each /api/... address
// =============================================================================
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'products', ':id']
  const [, resource, id] = parts;
  const method = req.method;

  // ---- Store settings (price cap, categories) so pages stay in sync ----
  if (resource === 'config' && method === 'GET') {
    return sendJson(res, 200, {
      maxPrice: STORE.MAX_PRICE, categories: STORE.CATEGORIES, seasons: STORE.SEASONS,
      maxImageMb: STORE.MAX_IMAGE_MB, priceApi: Boolean(SERPAPI_KEY),
    });
  }

  // ---- Admin login check ----
  if (resource === 'login' && method === 'POST') {
    requireAdmin(req);
    return sendJson(res, 200, { ok: true });
  }

  // ---- Items for sale ----
  if (resource === 'products') {
    const products = await loadProducts();

    if (method === 'GET' && !id) return sendJson(res, 200, products);

    if (method === 'GET' && id) {
      const item = products.find((p) => p.id === id);
      if (!item) throw httpError(404, 'Item not found.');
      return sendJson(res, 200, item);
    }

    if (method === 'POST' && !id) {
      requireAdmin(req);
      const body = await readBody(req);
      const item = { id: newId('itm'), ...validateProduct(body), image: '', createdAt: new Date().toISOString() };
      if (body.imageData) item.image = await saveUploadedImage(body.imageData);
      products.unshift(item); // newest first
      await saveProducts(products);
      return sendJson(res, 201, item);
    }

    if (method === 'PUT' && id) {
      requireAdmin(req);
      const index = products.findIndex((p) => p.id === id);
      if (index === -1) throw httpError(404, 'Item not found.');
      const body = await readBody(req);
      const fields = validateProduct(body, products[index]);
      let updated = applyPriceChange(products[index], fields.price);
      updated = { ...updated, ...fields, updatedAt: new Date().toISOString() };
      if (body.imageData) {
        await deleteUploadedImage(products[index].image);
        updated.image = await saveUploadedImage(body.imageData);
      } else if (body.removeImage) {
        await deleteUploadedImage(products[index].image);
        updated.image = '';
      }
      products[index] = updated;
      await saveProducts(products);
      return sendJson(res, 200, updated);
    }

    if (method === 'DELETE' && id) {
      requireAdmin(req);
      const item = products.find((p) => p.id === id);
      if (!item) throw httpError(404, 'Item not found.');
      await deleteUploadedImage(item.image);
      await saveProducts(products.filter((p) => p.id !== id));
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- Bulk price change: e.g. "-25% on all Winter Clothes" ----
  // Body: { percent: -25, category: "Clothes" | "all", season: "Winter" | "" }
  // New prices are rounded to the nearest $0.25 and kept within the $20 cap.
  if (resource === 'prices' && id === 'bulk' && method === 'POST') {
    requireAdmin(req);
    const body = await readBody(req, 4 * 1024);
    const percent = Number(body.percent);
    if (!Number.isFinite(percent) || percent <= -100 || percent > 100) throw httpError(400, 'Percent must be between -99 and 100.');
    const products = await loadProducts();
    let changed = 0;
    const next = products.map((p) => {
      if (body.category && body.category !== 'all' && p.category !== body.category) return p;
      if (body.season && p.season !== body.season) return p;
      let price = Math.round(p.price * (1 + percent / 100) * 4) / 4;
      price = Math.min(STORE.MAX_PRICE, Math.max(0.25, price));
      if (price === p.price) return p;
      changed++;
      return { ...applyPriceChange(p, price), updatedAt: new Date().toISOString() };
    });
    await saveProducts(next);
    return sendJson(res, 200, { changed });
  }

  // ---- Compare prices / find deals at other stores ----
  if (resource === 'compare' && method === 'GET') {
    requireAdmin(req);
    return sendJson(res, 200, await comparePrices(url.searchParams.get('q')));
  }

  // ---- Orders ----
  if (resource === 'orders') {
    // A shopper checks out. Prices are looked up on the server (never trusted
    // from the browser) and stock is reduced so items can't be oversold.
    if (method === 'POST' && !id) {
      const body = await readBody(req, 64 * 1024);
      const customer = {
        name: cleanText(body.customer?.name, 100),
        email: cleanText(body.customer?.email, 200),
        phone: cleanText(body.customer?.phone, 40),
        notes: cleanText(body.customer?.notes, 1000),
      };
      if (!customer.name) throw httpError(400, 'Please enter your name.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email)) throw httpError(400, 'Please enter a valid email.');
      if (!Array.isArray(body.items) || !body.items.length) throw httpError(400, 'Your cart is empty.');

      const products = await loadProducts();
      const lines = [];
      for (const { id: itemId, qty } of body.items) {
        const product = products.find((p) => p.id === itemId);
        const want = Math.floor(Number(qty));
        if (!product) throw httpError(400, 'An item in your cart is no longer available.');
        if (!(want >= 1)) throw httpError(400, 'Invalid quantity.');
        if (want > product.quantity) throw httpError(400, `Only ${product.quantity} left of "${product.name}".`);
        lines.push({ id: product.id, name: product.name, price: product.price, qty: want });
      }
      for (const line of lines) products.find((p) => p.id === line.id).quantity -= line.qty;

      const total = Math.round(lines.reduce((sum, l) => sum + l.price * l.qty, 0) * 100) / 100;
      const order = { id: newId('ord'), createdAt: new Date().toISOString(), status: 'new', customer, items: lines, total };
      const orders = await loadOrders();
      orders.unshift(order);
      await saveProducts(products);
      await saveOrders(orders);
      return sendJson(res, 201, { id: order.id, total });
    }

    if (method === 'GET' && !id) {
      requireAdmin(req);
      return sendJson(res, 200, await loadOrders());
    }

    // Admin marks an order as paid / completed / cancelled.
    if (method === 'PUT' && id) {
      requireAdmin(req);
      const body = await readBody(req, 4 * 1024);
      const allowed = ['new', 'paid', 'completed', 'cancelled'];
      if (!allowed.includes(body.status)) throw httpError(400, 'Unknown status.');
      const orders = await loadOrders();
      const order = orders.find((o) => o.id === id);
      if (!order) throw httpError(404, 'Order not found.');
      // Cancelling puts the items back in stock; un-cancelling takes them out again.
      const wasCancelled = order.status === 'cancelled';
      const nowCancelled = body.status === 'cancelled';
      if (wasCancelled !== nowCancelled) {
        const products = await loadProducts();
        for (const line of order.items) {
          const product = products.find((p) => p.id === line.id);
          if (product) product.quantity = Math.max(0, product.quantity + (nowCancelled ? line.qty : -line.qty));
        }
        await saveProducts(products);
      }
      order.status = body.status;
      await saveOrders(orders);
      return sendJson(res, 200, order);
    }
  }

  throw httpError(404, 'Unknown API address.');
}

// =============================================================================
//  STATIC FILES — sends pages, styles, scripts and pictures from /public
// =============================================================================
async function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(PUBLIC_DIR, rel));
  // Safety: refuse anything that tries to escape the public folder (e.g. "../").
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) throw httpError(403, 'Forbidden');
  const type = MIME[extname(file).toLowerCase()];
  if (!type || !existsSync(file)) throw httpError(404, 'Not found');
  const body = await readFile(file);
  res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

// =============================================================================
//  START THE SERVER
// =============================================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (url.pathname.startsWith('/api/')) sendJson(res, status, { error: status === 500 ? 'Server error.' : err.message });
    else {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 404 ? 'Page not found' : err.message);
    }
  }
});

await mkdir(DATA_DIR, { recursive: true });
await mkdir(UPLOAD_DIR, { recursive: true });
server.listen(PORT, () => {
  console.log(`Lost and Found is running at http://localhost:${PORT}`);
  if (ADMIN_PASSWORD === 'changeme') {
    console.log('WARNING: using the default admin password "changeme". Set ADMIN_PASSWORD before going live.');
  }
});
