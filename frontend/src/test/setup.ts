/**
 * The suite runs in plain Node: no DOM, no localStorage. storage.ts only needs
 * the Storage contract, so a Map behind it is enough — and keeps the tests free
 * of a browser environment they do not otherwise use.
 */
const store = new Map<string, string>();

const localStorageShim: Storage = {
  get length() {
    return store.size;
  },
  clear: () => {
    store.clear();
  },
  getItem: (key) => store.get(key) ?? null,
  key: (index) => [...store.keys()][index] ?? null,
  removeItem: (key) => {
    store.delete(key);
  },
  setItem: (key, value) => {
    store.set(key, String(value));
  },
};

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageShim,
  configurable: true,
});
