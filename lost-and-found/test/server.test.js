// Tests for the Lost & Found server API. Run with: npm test
// Starts the real server on a spare port with a temporary copy of the data.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const ADMIN = { 'X-Admin-Password': 'test-pw', 'Content-Type': 'application/json' };
let server, dataDir;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'lf-test-'));
  await cp(new URL('../data/products.json', import.meta.url), join(dataDir, 'products.json'));
  server = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: 'test-pw', DATA_DIR: dataDir, SERPAPI_KEY: '' },
  });
  await new Promise((resolve) => server.stdout.on('data', (d) => String(d).includes('running') && resolve()));
});
after(async () => { server.kill(); await rm(dataDir, { recursive: true, force: true }); });

const json = async (path, opts) => { const r = await fetch(BASE + path, opts); return { status: r.status, body: await r.json() }; };

test('lists products and serves pages', async () => {
  const { body } = await json('/api/products');
  assert.ok(body.length >= 5);
  assert.equal((await fetch(BASE + '/shop.html')).status, 200);
  assert.equal((await fetch(BASE + '/../server.js')).status, 404);
});

test('admin routes need the password', async () => {
  const r = await json('/api/products', { method: 'POST', body: JSON.stringify({ name: 'x', price: 5 }) });
  assert.equal(r.status, 401);
});

test('rejects prices over $20', async () => {
  const r = await json('/api/products', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'Too much', price: 25, category: 'Tech' }) });
  assert.equal(r.status, 400);
});

test('add item with picture, change price, delete', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const add = await json('/api/products', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'Test Lamp', price: 15, category: 'Decor', imageData: png }) });
  assert.equal(add.status, 201);
  assert.match(add.body.image, /^uploads\/.+\.png$/);
  assert.equal((await fetch(`${BASE}/${add.body.image}`)).status, 200);

  const cut = await json(`/api/products/${add.body.id}`, { method: 'PUT', headers: ADMIN, body: JSON.stringify({ price: 10 }) });
  assert.equal(cut.body.price, 10);
  assert.equal(cut.body.wasPrice, 15);
  assert.equal(cut.body.priceHistory.length, 1);

  assert.equal((await json(`/api/products/${add.body.id}`, { method: 'DELETE', headers: ADMIN })).status, 200);
  assert.equal((await fetch(`${BASE}/${add.body.image}`)).status, 404);
});

test('season only kept for clothes', async () => {
  const r = await json('/api/products', { method: 'POST', headers: ADMIN, body: JSON.stringify({ name: 'Toy', price: 3, category: 'Toys', season: 'Winter' }) });
  assert.equal(r.body.season, '');
  await json(`/api/products/${r.body.id}`, { method: 'DELETE', headers: ADMIN });
});

test('bulk price change stays within the cap', async () => {
  const r = await json('/api/prices/bulk', { method: 'POST', headers: ADMIN, body: JSON.stringify({ percent: 100, category: 'all' }) });
  assert.ok(r.body.changed > 0);
  const { body } = await json('/api/products');
  assert.ok(body.every((p) => p.price <= 20));
});

test('order uses server prices, reduces stock, restocks on cancel', async () => {
  const { body: before } = await json('/api/products/itm_sample03');
  const r = await json('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ id: 'itm_sample03', qty: 2, price: 0.01 }], customer: { name: 'Sam', email: 'sam@example.com' } }),
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, before.price * 2);
  assert.equal((await json('/api/products/itm_sample03')).body.quantity, before.quantity - 2);

  await json(`/api/orders/${r.body.id}`, { method: 'PUT', headers: ADMIN, body: JSON.stringify({ status: 'cancelled' }) });
  assert.equal((await json('/api/products/itm_sample03')).body.quantity, before.quantity);

  const over = await json('/api/orders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ id: 'itm_sample03', qty: 99 }], customer: { name: 'Sam', email: 'sam@example.com' } }),
  });
  assert.equal(over.status, 400);
});

test('compare without API key still returns store links', async () => {
  const r = await json('/api/compare?q=lamp', { headers: ADMIN });
  assert.equal(r.body.apiEnabled, false);
  assert.ok(r.body.links.some((l) => l.store === 'Walmart'));
});
