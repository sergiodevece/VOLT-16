"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../dist/sw.js"), "utf8");
const scope = "https://example.github.io/volt16/";

function setup(caches) {
  const handlers = {};
  vm.runInNewContext(source, {
    self: {
      registration: { scope },
      location: { origin: "https://example.github.io" },
      clients: { claim: async () => {} },
      addEventListener: (name, handler) => { handlers[name] = handler; },
    },
    caches,
    URL,
    fetch: async () => { throw new Error("offline"); },
  });
  return handlers;
}

test("activation preserves other apps and other VOLT/16 installations on the same origin", async () => {
  const keys = [
    `volt16:${scope}:shell-v5`,
    `volt16:${scope}:shell-v6`,
    `volt16:${scope}:shell-v7`,
    "habit-quest-v1",
    "volt16:https://example.github.io/another-volt16/:shell-v5",
  ];
  const removed = [];
  const handlers = setup({ keys: async () => keys, delete: async (key) => removed.push(key) });
  let activation;
  handlers.activate({ waitUntil: (promise) => { activation = promise; } });
  await activation;
  assert.deepEqual(removed, [`volt16:${scope}:shell-v5`, `volt16:${scope}:shell-v6`]);
});

test("offline requests read only this installation's cache", async () => {
  const opened = [];
  const cached = { body: "VOLT/16" };
  const request = { method: "GET", url: `${scope}index.html` };
  const handlers = setup({
    open: async (key) => {
      opened.push(key);
      return { match: async (actual) => { assert.equal(actual, request); return cached; } };
    },
    match: () => { throw new Error("Must not search other apps' caches"); },
  });
  let response;
  handlers.fetch({ request, respondWith: (promise) => { response = promise; } });
  assert.equal(await response, cached);
  assert.deepEqual(opened, [`volt16:${scope}:shell-v7`]);
});
