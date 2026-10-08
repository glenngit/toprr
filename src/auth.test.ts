import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  generateApiKey,
  hashApiKey,
  apiKeyMatches,
  signSession,
  verifySignedSession,
  randomToken,
} from "./auth.js";

test("password hash verifies correct password and rejects wrong one", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$/);
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
});

test("password hashes are salted (same password -> different hashes)", async () => {
  const a = await hashPassword("samePass123");
  const b = await hashPassword("samePass123");
  assert.notEqual(a, b, "salt should make the two hashes differ");
  assert.equal(await verifyPassword("samePass123", a), true);
  assert.equal(await verifyPassword("samePass123", b), true);
});

test("verifyPassword returns false for malformed hashes (no throw)", async () => {
  assert.equal(await verifyPassword("x", ""), false);
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
  assert.equal(await verifyPassword("x", "scrypt$bad"), false);
});

test("API key: generate, hash at rest, constant-time match", () => {
  const { plaintext, hash } = generateApiKey();
  assert.ok(plaintext.length >= 32);
  assert.equal(hash, hashApiKey(plaintext));
  assert.equal(apiKeyMatches(plaintext, hash), true);
  assert.equal(apiKeyMatches("wrong", hash), false);
  assert.equal(apiKeyMatches("", hash), false);
  assert.equal(apiKeyMatches(plaintext, ""), false);
});

test("session signature round-trips and rejects tampering", () => {
  const secret = randomToken(32);
  const sid = randomToken(32);
  const signed = signSession(sid, secret);
  assert.equal(verifySignedSession(signed, secret), sid);
  // Tampered signature.
  assert.equal(verifySignedSession(signed + "x", secret), null);
  // Wrong secret.
  assert.equal(verifySignedSession(signed, randomToken(32)), null);
  // Garbage.
  assert.equal(verifySignedSession("nodot", secret), null);
});

test("randomToken is unique and URL-safe", () => {
  const a = randomToken();
  const b = randomToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});
