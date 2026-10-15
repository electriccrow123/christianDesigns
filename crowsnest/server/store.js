// A small JSON-file document store with the same shape as the artifact database:
// documents at even-length slash paths, collections at odd-length ones.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function createFileStore(file) {
  let docs = {};
  try {
    docs = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    docs = {};
  }
  let version = 1;
  let timer = null;
  let writing = Promise.resolve();
  const flush = () => {
    timer = null;
    writing = writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      await writeFile(tmp, JSON.stringify(docs));
      await rename(tmp, file);
    }).catch((e) => console.error('store write failed:', e.message));
  };
  const changed = () => {
    version++;
    if (!timer) timer = setTimeout(flush, 400);
  };
  const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
  return {
    kind: 'file',
    get version() {
      return version;
    },
    async get(path) {
      return clone(docs[path]);
    },
    async set(path, data) {
      docs[path] = clone(data);
      changed();
    },
    async update(path, data) {
      docs[path] = { ...(docs[path] || {}), ...clone(data) };
      changed();
    },
    async remove(path) {
      delete docs[path];
      changed();
    },
    async list(collection, { orderBy, dir = 'asc', limit = 100 } = {}) {
      const depth = collection.split('/').length + 1;
      const rows = Object.keys(docs)
        .filter((k) => k.startsWith(collection + '/') && k.split('/').length === depth)
        .map((k) => ({ id: k.split('/').pop(), ...clone(docs[k]) }));
      if (orderBy) rows.sort((a, b) => ((a[orderBy] ?? Infinity) > (b[orderBy] ?? Infinity) ? 1 : -1) * (dir === 'desc' ? -1 : 1));
      return rows.slice(0, Math.min(1000, limit));
    },
    async close() {
      if (timer) {
        clearTimeout(timer);
        flush();
      }
      await writing;
    },
  };
}
