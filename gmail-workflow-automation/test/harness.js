/**
 * harness.js — load the .gs sources into a Node sandbox so the pure logic can
 * be tested without a Google account.
 *
 * Apps Script concatenates every .gs file into one global scope, which is
 * exactly what `vm.runInContext` gives us. Apps Script services are left
 * undefined on purpose: anything that reaches for GmailApp or SpreadsheetApp
 * here is a function that should not have been pure, and the test will say so.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const FILES = [
  'Config.gs', 'Workflow.gs', 'Transcript.gs',
  'Prompt.gs', 'Classifier.gs', 'Digest.gs', 'Store.gs'
];

function loadSandbox() {
  const sandbox = {
    console,
    Date, Math, JSON, Intl, RegExp, String, Number, Object, Array, Boolean, isNaN, parseInt, parseFloat,
    // Captures whatever the code tries to POST, so the request shape is testable.
    __fetches: [],
    UrlFetchApp: {
      fetch(url, options) {
        sandbox.__fetches.push({ url, options });
        return {
          getResponseCode: () => sandbox.__nextStatus ?? 200,
          getContentText: () => sandbox.__nextBody ?? '{}'
        };
      }
    },
    Utilities: { sleep() {} },          // no formatDate: forces the Intl path
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => sandbox.__props[k] || null,
        setProperty: (k, v) => { sandbox.__props[k] = v; }
      })
    },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'ops@example.com' }) },
    __props: { ANTHROPIC_API_KEY: 'test-key' }
  };
  vm.createContext(sandbox);
  for (const f of FILES) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    try {
      vm.runInContext(code, sandbox, { filename: f });
    } catch (e) {
      throw new Error(`loading ${f}: ${e.message}`);
    }
  }
  return sandbox;
}

// ---- a very small assertion library ---------------------------------------

const state = { pass: 0, fail: 0, failures: [], group: '' };

function group(name) { state.group = name; console.log(`\n\x1b[1m${name}\x1b[0m`); }

function check(name, cond, detail) {
  if (cond) {
    state.pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    state.fail++;
    state.failures.push(`${state.group} :: ${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \x1b[31m✗ ${name}\x1b[0m${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  check(name, a === b, a === b ? '' : `got ${a}, expected ${b}`);
}

function near(name, actual, expected, tol) {
  const ok = Math.abs(actual - expected) <= (tol ?? 1e-9);
  check(name, ok, ok ? '' : `got ${actual}, expected ~${expected}`);
}

function report() {
  console.log(`\n${state.fail === 0 ? '\x1b[32m' : '\x1b[31m'}${state.pass} passed, ${state.fail} failed\x1b[0m`);
  if (state.failures.length) {
    console.log('\nFailures:');
    state.failures.forEach((f) => console.log('  - ' + f));
  }
  return state.fail === 0;
}

module.exports = { loadSandbox, group, check, eq, near, report };
