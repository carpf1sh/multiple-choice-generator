'use strict';

// Loads app.js into a sandbox with just enough of a browser to boot it, and
// returns its internal functions and state. location.protocol is 'file:', so
// init() stops at the "start the server" screen without fetching anything.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

const EXPORTS = [
  'state', 'esc', 'shuffle', 'shuffleOptions', 'groupBy', 'clamp', 'pct', 'formatDuration',
  'domainKeyFor', 'normalize', 'examList', 'largestRemainder', 'allocate', 'priorityScore',
  'orderByPriority', 'interleave', 'pickFromDomain', 'currentWeights', 'availableByDomain', 'planTest',
];

function fakeElement() {
  return {
    dataset: {},
    textContent: '',
    innerHTML: '',
    setAttribute() {},
    addEventListener() {},
    querySelector: () => fakeElement(),
    querySelectorAll: () => [],
  };
}

function loadApp() {
  const storage = new Map();
  const document = fakeElement();
  document.documentElement = fakeElement();
  const sandbox = {
    console,
    document,
    location: { protocol: 'file:' },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    fetch: () => { throw new Error('tests must not fetch'); },
    setInterval: () => 0,
    clearInterval: () => {},
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.scrollTo = () => {};
  sandbox.confirm = () => true;

  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(`${source}\n;globalThis.__app = { ${EXPORTS.join(', ')} };`, sandbox, { filename: 'app.js' });
  return sandbox.__app;
}

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

module.exports = { loadApp, readJson, ROOT };
