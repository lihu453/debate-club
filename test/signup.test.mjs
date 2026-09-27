import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { createApp, createDatabase } from "../server.mjs";

const validSignup = {
  fullName: "林同学",
  grade: "高一",
  phone: "13800138000",
  position: "尚未确定",
  introduction: "我喜欢倾听不同观点，也想练习清晰表达。"
};

let temporaryDirectory;
let database;
let server;
let baseUrl;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "debate-club-test-"));
  database = createDatabase(join(temporaryDirectory, "signups.sqlite"));
  server = createServer(createApp(database, { signupLimit: 20 }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  database?.close();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test("accepts a valid signup and persists it without exposing a listing endpoint", async () => {
  const response = await fetch(`${baseUrl}/api/signups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(validSignup)
  });
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.message, "报名信息已提交。");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM signups").get().count, 1);
  assert.equal(database.prepare("SELECT full_name FROM signups").get().full_name, validSignup.fullName);

  const listing = await fetch(`${baseUrl}/api/signups`);
  assert.equal(listing.status, 404);
});

test("rejects malformed fields and does not write invalid submissions", async () => {
  const invalidSignup = { ...validSignup, position: "未知辩位" };
  const response = await fetch(`${baseUrl}/api/signups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(invalidSignup)
  });
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.match(result.error, /意向辩位/);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM signups").get().count, 1);
});

test("rejects non-JSON form submissions", async () => {
  const response = await fetch(`${baseUrl}/api/signups`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "not json"
  });
  assert.equal(response.status, 415);
});

test("serves the single-page website with security headers", async () => {
  const response = await fetch(baseUrl);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /辩论社/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});
