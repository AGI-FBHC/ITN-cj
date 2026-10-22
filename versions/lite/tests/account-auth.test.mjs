import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const api = (process.env.ZHIXUN_TEST_API || "http://127.0.0.1:8312/api").replace(/\/$/, "");

async function call(path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  return { status: response.status, data };
}

test("account registration, first-login detection and returning login", async () => {
  const account = `auth-${randomUUID()}@example.com`;
  const password = "TestPass123";
  const registered = await call("/auth/register", {
    method: "POST",
    body: { account, password, displayName: "首次登录学习者" },
  });
  assert.equal(registered.status, 200);
  assert.equal(registered.data.profile, null);
  assert.equal(typeof registered.data.token, "string");

  const firstBootstrap = await call("/bootstrap", { token: registered.data.token });
  assert.equal(firstBootstrap.status, 200);
  assert.equal(firstBootstrap.data.profile, null, "A new account must enter onboarding");

  const profile = {
    name: "首次登录学习者",
    roleLabel: "研究生",
    goalLabel: "考研升学",
    subjectValues: ["ds"],
  };
  const saved = await call("/profile", {
    method: "PUT",
    token: registered.data.token,
    body: profile,
  });
  assert.equal(saved.status, 200);

  const returning = await call("/auth/login", {
    method: "POST",
    body: { account, password },
  });
  assert.equal(returning.status, 200);
  assert.equal(returning.data.userId, registered.data.userId);
  assert.deepEqual(returning.data.profile, profile, "Returning login must recover the profile");

  const freshBootstrap = await call("/bootstrap", { token: returning.data.token });
  assert.equal(freshBootstrap.status, 200);
  assert.deepEqual(freshBootstrap.data.profile, profile);

  const wrong = await call("/auth/login", {
    method: "POST",
    body: { account, password: "WrongPass123" },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.message, "账号或密码不正确");

  const duplicate = await call("/auth/register", {
    method: "POST",
    body: { account, password, displayName: "重复账号" },
  });
  assert.equal(duplicate.status, 409);
});
