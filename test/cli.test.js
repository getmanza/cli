import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "bin", "zazu.ts");
const runtime = process.env.ZAZU_CLI_RUNTIME || "bun";
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const cliVersion = packageJson.version;

test("login stores a masked API key and config commands can read and remove it", async () => {
  const configHome = await tempConfigHome();

  try {
    const login = await runCliWithInput(
      ["login", "--api-key-stdin", "--base-url", "https://api.example.test", "--pretty"],
      "sk_live_abcdefghijklmnopqrstuvwxyz1234567890\n",
      { configHome },
    );
    assert.deepEqual(JSON.parse(login.stdout), {
      ok: true,
      api_key: "sk_live_...7890",
      base_url: "https://api.example.test",
    });

    const config = JSON.parse(await readFile(path.join(configHome, "zazu", "config.json"), "utf8"));
    assert.equal(config.api_key, "sk_live_abcdefghijklmnopqrstuvwxyz1234567890");
    assert.equal(config.base_url, "https://api.example.test");

    const get = await runCli(["config", "get", "--pretty"], { configHome });
    assert.deepEqual(JSON.parse(get.stdout), {
      api_key: "sk_live_...7890",
      api_base: "https://api.example.test",
      api_version: null,
      config_path: path.join(configHome, "zazu", "config.json"),
    });

    const unset = await runCli(["logout", "--pretty"], { configHome });
    assert.deepEqual(JSON.parse(unset.stdout), { ok: true });

    const afterLogout = JSON.parse(
      await readFile(path.join(configHome, "zazu", "config.json"), "utf8"),
    );
    assert.equal(afterLogout.api_key, undefined);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("login still accepts --api-key for backwards compatibility", async () => {
  const configHome = await tempConfigHome();

  try {
    const login = await runCli(
      ["login", "--api-key", "sk_live_abcdefghijklmnopqrstuvwxyz1234567890", "--pretty"],
      { configHome },
    );
    assert.deepEqual(JSON.parse(login.stdout), {
      ok: true,
      api_key: "sk_live_...7890",
      base_url: "https://ma.manza.finance",
    });
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("resource help does not require authentication", async () => {
  const configHome = await tempConfigHome();

  try {
    await mkdir(path.join(configHome, "zazu"), { recursive: true });
    await writeFile(path.join(configHome, "zazu", "config.json"), "{not-json", "utf8");

    const result = await runCli(["invoices", "--help"], { configHome });
    assert.match(result.stdout, /Zazu CLI - invoices/);
    assert.match(result.stdout, /zazu invoices payment-link <id> --account-id <account-id>/);
    assert.doesNotMatch(result.stdout, /Global flags:/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("version does not require readable config", async () => {
  const configHome = await tempConfigHome();

  try {
    await mkdir(path.join(configHome, "zazu"), { recursive: true });
    await writeFile(path.join(configHome, "zazu", "config.json"), "{not-json", "utf8");

    const result = await runCli(["--version"], { configHome });
    assert.equal(result.stdout, `${cliVersion}\n`);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("recovery commands tolerate a corrupt stored config", async () => {
  const configHome = await tempConfigHome();

  try {
    await mkdir(path.join(configHome, "zazu"), { recursive: true });
    await writeFile(path.join(configHome, "zazu", "config.json"), "{not-json", "utf8");

    const login = await runCliWithInput(
      ["login", "--api-key-stdin", "--base-url", "https://api.example.test", "--pretty"],
      "sk_live_abcdefghijklmnopqrstuvwxyz1234567890\n",
      { configHome },
    );
    assert.deepEqual(JSON.parse(login.stdout), {
      ok: true,
      api_key: "sk_live_...7890",
      base_url: "https://api.example.test",
    });

    const stored = JSON.parse(await readFile(path.join(configHome, "zazu", "config.json"), "utf8"));
    assert.equal(stored.api_key, "sk_live_abcdefghijklmnopqrstuvwxyz1234567890");
    assert.equal(stored.base_url, "https://api.example.test");
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("login validates API key shape before storing", async () => {
  const configHome = await tempConfigHome();

  try {
    const result = await runCli(["login", "--api-key", "not-a-key"], { configHome, reject: false });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /API key must start with sk_live_ or sk_test_/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("login accepts test API keys", async () => {
  const configHome = await tempConfigHome();

  try {
    const login = await runCli(
      ["login", "--api-key", "sk_test_abcdefghijklmnopqrstuvwxyz1234567890", "--pretty"],
      { configHome },
    );
    assert.deepEqual(JSON.parse(login.stdout), {
      ok: true,
      api_key: "sk_test_...7890",
      base_url: "https://ma.manza.finance",
    });
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("missing non-boolean flag values return a clear error", async () => {
  const configHome = await tempConfigHome();

  try {
    const result = await runCli(["entity", "get", "--api-key"], { configHome, reject: false });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Missing value for --api-key/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("config set supports api-base and api-version", async () => {
  const configHome = await tempConfigHome();

  try {
    const base = await runCli(["config", "set", "api-base", "https://api.zazu.test", "--pretty"], {
      configHome,
    });
    assert.deepEqual(JSON.parse(base.stdout), { ok: true, api_base: "https://api.zazu.test" });

    const version = await runCli(["config", "set", "api-version", "2026-04-29", "--pretty"], {
      configHome,
    });
    assert.deepEqual(JSON.parse(version.stdout), { ok: true, api_version: "2026-04-29" });

    const get = JSON.parse((await runCli(["config", "get", "--pretty"], { configHome })).stdout);
    assert.equal(get.api_base, "https://api.zazu.test");
    assert.equal(get.api_version, "2026-04-29");
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("missing API key returns a useful error", async () => {
  const configHome = await tempConfigHome();

  try {
    const result = await runCli(["entity", "get"], { configHome, reject: false });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Missing API key/);
    assert.match(result.stderr, /zazu login/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("top-level transactions list maps to account transactions endpoint", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    sendJSON(res, { data: [], has_more: false, next_cursor: null });
  });

  try {
    const result = await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "transactions",
        "list",
        "--account-id",
        "acct_123",
        "--operation",
        "credit",
        "--limit",
        "25",
      ],
      { configHome },
    );

    assert.deepEqual(JSON.parse(result.stdout), { data: [], has_more: false, next_cursor: null });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].url, "/api/accounts/acct_123/transactions?operation=credit&limit=25");
    assert.equal(requests[0].authorization, "Bearer sk_live_test");
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("--max-items follows cursors and aggregates list data", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer((req, res) => {
    requests.push(req.url);

    if (req.url === "/api/invoices?limit=2") {
      sendJSON(res, {
        data: [{ id: "inv_1" }, { id: "inv_2" }],
        has_more: true,
        next_cursor: "cursor_2",
      });
      return;
    }

    if (req.url === "/api/invoices?limit=1&cursor=cursor_2") {
      sendJSON(res, { data: [{ id: "inv_3" }], has_more: true, next_cursor: "cursor_3" });
      return;
    }

    sendJSON(res, { error: { message: `Unexpected URL: ${req.url}` } }, 500);
  });

  try {
    const result = await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "invoices",
        "list",
        "--max-items",
        "3",
        "--limit",
        "2",
        "--pretty",
      ],
      { configHome },
    );

    assert.deepEqual(JSON.parse(result.stdout), {
      data: [{ id: "inv_1" }, { id: "inv_2" }, { id: "inv_3" }],
      has_more: true,
      next_cursor: "cursor_3",
    });
    assert.deepEqual(requests, ["/api/invoices?limit=2", "/api/invoices?limit=1&cursor=cursor_2"]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("--quiet suppresses successful output", async () => {
  const configHome = await tempConfigHome();
  const server = await createServer((_req, res) => {
    sendJSON(res, { id: "entity_1" });
  });

  try {
    const result = await runCli(
      ["--api-key", "sk_live_test", "--base-url", server.baseURL, "--quiet", "entity", "get"],
      { configHome },
    );

    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("API errors include response status and body", async () => {
  const configHome = await tempConfigHome();
  const server = await createServer((_req, res) => {
    res.setHeader("X-Request-Id", "req_123");
    res.setHeader("Zazu-Version", "2026-04-29");
    sendJSON(
      res,
      {
        error: {
          message: "API key lacks the required scope: accounts:read",
          type: "insufficient_scope",
        },
      },
      403,
    );
  });

  try {
    const result = await runCli(
      ["--api-key", "sk_live_test", "--base-url", server.baseURL, "accounts", "list", "--pretty"],
      { configHome, reject: false },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), {
      error: {
        message: "API key lacks the required scope: accounts:read",
        type: "insufficient_scope",
      },
      status: 403,
      request_id: "req_123",
      zazu_version: "2026-04-29",
    });
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("requests time out with a clear error", async () => {
  const configHome = await tempConfigHome();
  const server = await createServer(() => {});

  try {
    const result = await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "--timeout-ms",
        "1",
        "entity",
        "get",
      ],
      { configHome, reject: false },
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Request timed out after 1ms/);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("transfer and beneficiary commands map to the API endpoints", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer(async (req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      body: await readRequestBody(req),
    });
    if (req.url.startsWith("/api/beneficiaries?")) {
      sendJSON(res, { data: [], has_more: false, next_cursor: null });
      return;
    }
    sendJSON(res, { ok: true });
  });

  try {
    await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "transfers",
        "create",
        "--account-id",
        "acc_123",
        "--beneficiary-id",
        "ben_123",
        "--amount",
        "150.00",
        "--payment-reference",
        "INV-001",
        "--client-reference",
        "po_1",
      ],
      { configHome },
    );

    await runCli(
      ["--api-key", "sk_live_test", "--base-url", server.baseURL, "transfers", "get", "td_123"],
      { configHome },
    );

    await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "beneficiaries",
        "list",
        "--limit",
        "5",
      ],
      { configHome },
    );

    await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "beneficiaries",
        "get",
        "ben_123",
      ],
      { configHome },
    );

    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "/api/transfer_drafts",
        body: JSON.stringify({
          account_id: "acc_123",
          beneficiary_id: "ben_123",
          amount: "150.00",
          payment_reference: "INV-001",
          client_reference: "po_1",
        }),
      },
      { method: "GET", url: "/api/transfer_drafts/td_123", body: "" },
      { method: "GET", url: "/api/beneficiaries?limit=5", body: "" },
      { method: "GET", url: "/api/beneficiaries/ben_123", body: "" },
    ]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("webhook endpoint commands map to the API endpoints", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer(async (req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      body: await readRequestBody(req),
    });
    sendJSON(res, { ok: true });
  });

  try {
    await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "webhook-endpoints",
        "create",
        "--url",
        "https://example.com/webhooks/zazu",
        "--description",
        "Production",
        "--event",
        "payment_link.paid",
        "--event",
        "transfer.executed",
      ],
      { configHome },
    );

    await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "webhook-endpoints",
        "regenerate-secret",
        "weh_123",
      ],
      { configHome },
    );

    await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "webhook-endpoints",
        "disable",
        "weh_123",
      ],
      { configHome },
    );

    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "/api/webhook_endpoints",
        body: JSON.stringify({
          url: "https://example.com/webhooks/zazu",
          description: "Production",
          events: ["payment_link.paid", "transfer.executed"],
        }),
      },
      {
        method: "POST",
        url: "/api/webhook_endpoints/weh_123/regenerate_secret",
        body: "",
      },
      {
        method: "POST",
        url: "/api/webhook_endpoints/weh_123/disable",
        body: "",
      },
    ]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("webhook endpoints list supports pagination", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer((req, res) => {
    requests.push(req.url);
    sendJSON(res, { data: [], has_more: false, next_cursor: null });
  });

  try {
    await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "webhook-endpoints",
        "list",
        "--limit",
        "25",
      ],
      { configHome },
    );

    assert.deepEqual(requests, ["/api/webhook_endpoints?limit=25"]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("checkout session commands map to the API endpoints", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer(async (req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      body: await readRequestBody(req),
    });
    sendJSON(res, { ok: true });
  });

  try {
    await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "checkout-sessions",
        "create",
        "--account-id",
        "acc_123",
        "--amount",
        "100.00",
        "--success-url",
        "https://example.com/ok?session_id={CHECKOUT_SESSION_ID}",
        "--cancel-url",
        "https://example.com/cancel",
        "--description",
        "Order #1",
        "--customer-email",
        "buyer@example.com",
        "--metadata",
        '{"order_id":"ORD-1"}',
      ],
      { configHome },
    );

    await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "checkout-sessions",
        "get",
        "cs_123",
      ],
      { configHome },
    );

    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "/api/checkout_sessions",
        body: JSON.stringify({
          account_id: "acc_123",
          amount: "100.00",
          success_url: "https://example.com/ok?session_id={CHECKOUT_SESSION_ID}",
          cancel_url: "https://example.com/cancel",
          description: "Order #1",
          customer_email: "buyer@example.com",
          metadata: { order_id: "ORD-1" },
        }),
      },
      {
        method: "GET",
        url: "/api/checkout_sessions/cs_123",
        body: "",
      },
    ]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("beneficiary create and external account commands map to the API endpoints", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, body: await readRequestBody(req) });
    if (req.method === "GET" && req.url.includes("?")) {
      sendJSON(res, { data: [], has_more: false, next_cursor: null });
      return;
    }
    sendJSON(res, { ok: true });
  });
  const api = ["--api-key", "sk_live_test", "--base-url", server.baseURL];

  try {
    await runCli(
      [
        ...api,
        "beneficiaries",
        "create",
        "--beneficiary-type",
        "business",
        "--company-name",
        "Acme SARL",
        "--email",
        "ap@acme.test",
        "--phone-number",
        "+212600000000",
      ],
      { configHome },
    );
    await runCli([...api, "beneficiaries", "accounts", "list", "ben_123", "--limit", "5"], {
      configHome,
    });
    await runCli([...api, "beneficiaries", "accounts", "get", "ben_123", "ext_456"], {
      configHome,
    });
    await runCli(
      [
        ...api,
        "beneficiaries",
        "accounts",
        "create",
        "ben_123",
        "--account-number",
        "007780000000000000000012",
        "--name",
        "Main",
        "--country-code",
        "MA",
        "--currency-code",
        "MAD",
      ],
      { configHome },
    );

    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "/api/beneficiaries",
        body: JSON.stringify({
          beneficiary_type: "business",
          company_name: "Acme SARL",
          email: "ap@acme.test",
          phone_number: "+212600000000",
        }),
      },
      { method: "GET", url: "/api/beneficiaries/ben_123/external_accounts?limit=5", body: "" },
      { method: "GET", url: "/api/beneficiaries/ben_123/external_accounts/ext_456", body: "" },
      {
        method: "POST",
        url: "/api/beneficiaries/ben_123/external_accounts",
        body: JSON.stringify({
          account_number: "007780000000000000000012",
          name: "Main",
          country_code: "MA",
          currency_code: "MAD",
        }),
      },
    ]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("beneficiary external accounts list follows cursors with --all", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer((req, res) => {
    requests.push(req.url);
    if (req.url === "/api/beneficiaries/ben_123/external_accounts?limit=100") {
      sendJSON(res, { data: [{ id: "ext_1" }], has_more: true, next_cursor: "c2" });
      return;
    }
    sendJSON(res, { data: [{ id: "ext_2" }], has_more: false, next_cursor: null });
  });

  try {
    const result = await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "beneficiaries",
        "accounts",
        "list",
        "ben_123",
        "--all",
      ],
      { configHome },
    );

    assert.deepEqual(JSON.parse(result.stdout), {
      data: [{ id: "ext_1" }, { id: "ext_2" }],
      has_more: false,
      next_cursor: null,
    });
    assert.deepEqual(requests, [
      "/api/beneficiaries/ben_123/external_accounts?limit=100",
      "/api/beneficiaries/ben_123/external_accounts?limit=100&cursor=c2",
    ]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("transfer authorize and decline map to the API endpoints", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, body: await readRequestBody(req) });
    sendJSON(res, { id: "auth_1", status: "authorized" });
  });
  const api = ["--api-key", "sk_live_test", "--base-url", server.baseURL];

  try {
    const authorize = await runCli(
      [
        ...api,
        "transfers",
        "authorize",
        "td_123",
        "--authorization-id",
        "auth_1",
        "--signature",
        "abc123",
      ],
      { configHome },
    );
    assert.deepEqual(JSON.parse(authorize.stdout), { id: "auth_1", status: "authorized" });

    await runCli(
      [
        ...api,
        "transfers",
        "decline",
        "td_123",
        "--authorization-id",
        "auth_1",
        "--reason",
        "not mine",
      ],
      { configHome },
    );
    await runCli([...api, "transfers", "decline", "td_124", "--authorization-id", "auth_2"], {
      configHome,
    });

    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "/api/transfer_drafts/td_123/authorize",
        body: JSON.stringify({ authorization_id: "auth_1", signature: "abc123" }),
      },
      {
        method: "POST",
        url: "/api/transfer_drafts/td_123/decline",
        body: JSON.stringify({ authorization_id: "auth_1", reason: "not mine" }),
      },
      {
        method: "POST",
        url: "/api/transfer_drafts/td_124/decline",
        body: JSON.stringify({ authorization_id: "auth_2" }),
      },
    ]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("transfer authorize requires --authorization-id and --signature", async () => {
  const configHome = await tempConfigHome();

  try {
    const noSignature = await runCli(
      [
        "--api-key",
        "sk_live_test",
        "transfers",
        "authorize",
        "td_123",
        "--authorization-id",
        "auth_1",
      ],
      { configHome, reject: false },
    );
    assert.equal(noSignature.code, 1);
    assert.match(noSignature.stderr, /Missing signature/);

    const authorizeNoAuthorization = await runCli(
      ["--api-key", "sk_live_test", "transfers", "authorize", "td_123", "--signature", "abc123"],
      { configHome, reject: false },
    );
    assert.equal(authorizeNoAuthorization.code, 1);
    assert.match(authorizeNoAuthorization.stderr, /Missing authorization id/);

    const noAuthorization = await runCli(
      ["--api-key", "sk_live_test", "transfers", "decline", "td_123"],
      { configHome, reject: false },
    );
    assert.equal(noAuthorization.code, 1);
    assert.match(noAuthorization.stderr, /Missing authorization id/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("a duplicate client reference prints the existing payment_id", async () => {
  const configHome = await tempConfigHome();
  const server = await createServer((_req, res) => {
    sendJSON(
      res,
      {
        error: {
          type: "duplicate_client_reference",
          message: "client_reference has already been used",
          payment_id: "td_existing",
        },
      },
      409,
    );
  });

  try {
    const result = await runCli(
      [
        "--api-key",
        "sk_live_test",
        "--base-url",
        server.baseURL,
        "transfers",
        "create",
        "--account-id",
        "acc_123",
        "--beneficiary-id",
        "ben_123",
        "--amount",
        "10.00",
        "--client-reference",
        "po_1",
      ],
      { configHome, reject: false },
    );

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const payload = JSON.parse(result.stderr);
    assert.equal(payload.status, 409);
    assert.equal(payload.payment_id, "td_existing");
    assert.equal(payload.error.type, "duplicate_client_reference");
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("payee trust request commands map to the API endpoints", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, body: await readRequestBody(req) });
    sendJSON(res, { id: "ptr_1", status: "pending" });
  });
  const api = ["--api-key", "sk_live_test", "--base-url", server.baseURL];

  try {
    await runCli(
      [
        ...api,
        "payee-trust-requests",
        "create",
        "--external-account-id",
        "ext_1",
        "--external-account-id",
        "ext_2",
      ],
      { configHome },
    );
    await runCli([...api, "payee-trust-requests", "create", "--external-account-id", "ext_3"], {
      configHome,
    });
    await runCli([...api, "payee-trust-requests", "get", "ptr_1"], { configHome });

    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "/api/payee_trust_requests",
        body: JSON.stringify({ external_account_ids: ["ext_1", "ext_2"] }),
      },
      {
        method: "POST",
        url: "/api/payee_trust_requests",
        body: JSON.stringify({ external_account_ids: ["ext_3"] }),
      },
      { method: "GET", url: "/api/payee_trust_requests/ptr_1", body: "" },
    ]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("payee trust request create requires an external account id", async () => {
  const configHome = await tempConfigHome();

  try {
    const result = await runCli(["--api-key", "sk_live_test", "payee-trust-requests", "create"], {
      configHome,
      reject: false,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Missing external account id/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

// Shared vector from zazu-ruby spec/zazu/transfer_authorization_spec.rb.
const SIGN_FIELDS = [
  "--payment-id",
  "0199a1b2-0000-7000-8000-000000000001",
  "--nonce",
  "n0nce-0123456789abcdef",
  "--amount",
  "2500.0",
  "--currency-code",
  "MAD",
  "--account-id",
  "0199a1b2-0000-7000-8000-000000000002",
];

test("transfers sign reproduces the shared signer vector without an API key", async () => {
  const configHome = await tempConfigHome();
  const env = { AUTHORIZER_SECRET: "whsec_test_vector_secret" };

  try {
    const external = await runCli(
      [
        "transfers",
        "sign",
        "--secret-env",
        "AUTHORIZER_SECRET",
        ...SIGN_FIELDS,
        "--external-account-id",
        "0199a1b2-0000-7000-8000-000000000003",
        "--client-reference",
        "po_1",
      ],
      { configHome, env },
    );
    assert.deepEqual(JSON.parse(external.stdout), {
      signature: "6e8eaec0f89a4eb3b22df1133b3d6dfebfa8505c34c58ed0ff192516e4223078",
      signature_input:
        "manza.transfer-authorization.v1|0199a1b2-0000-7000-8000-000000000001|n0nce-0123456789abcdef|2500.0|MAD|0199a1b2-0000-7000-8000-000000000002|ext:0199a1b2-0000-7000-8000-000000000003|po_1",
    });

    const own = await runCli(
      [
        "transfers",
        "sign",
        "--secret-env",
        "AUTHORIZER_SECRET",
        ...SIGN_FIELDS,
        "--destination-account-id",
        "0199a1b2-0000-7000-8000-000000000004",
      ],
      { configHome, env },
    );
    assert.equal(
      JSON.parse(own.stdout).signature,
      "af9440b1de1bebb51f381ce43e3d0d27b6a4ccb99dcd548c0b5435ff4fdd1895",
    );
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("transfers sign refuses a missing secret and a plain --secret argument", async () => {
  const configHome = await tempConfigHome();
  const payee = ["--external-account-id", "ext_1"];

  try {
    const unset = await runCli(
      ["transfers", "sign", "--secret-env", "NOPE_UNSET_VAR", ...SIGN_FIELDS, ...payee],
      { configHome, reject: false },
    );
    assert.equal(unset.code, 1);
    assert.match(unset.stderr, /NOPE_UNSET_VAR is not set/);

    const plain = await runCli(
      ["transfers", "sign", "--secret", "whsec_test_vector_secret", ...SIGN_FIELDS, ...payee],
      { configHome, reject: false },
    );
    assert.equal(plain.code, 1);
    assert.match(plain.stderr, /--secret-env/);
    assert.doesNotMatch(plain.stdout, /signature/);

    const bothPayees = await runCli(
      [
        "transfers",
        "sign",
        "--secret-env",
        "AUTHORIZER_SECRET",
        ...SIGN_FIELDS,
        ...payee,
        "--destination-account-id",
        "acc_2",
      ],
      { configHome, reject: false, env: { AUTHORIZER_SECRET: "s" } },
    );
    assert.equal(bothPayees.code, 1);
    assert.match(bothPayees.stderr, /exactly one of/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("payee-trust-requests help lists its commands", async () => {
  const configHome = await tempConfigHome();

  try {
    const result = await runCli(["payee-trust-requests", "--help"], { configHome });
    assert.match(result.stdout, /Zazu CLI - payee-trust-requests/);
    assert.match(result.stdout, /zazu payee-trust-requests get <id>/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

async function runCli(args, { configHome, reject = true, env: extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    ZAZU_API_KEY: "",
    ZAZU_BASE_URL: "",
    ZAZU_VERSION: "",
    ...extraEnv,
  };

  try {
    const result = await execFileAsync(runtime, [cli, ...args], { env });
    return { ...result, code: 0 };
  } catch (error) {
    if (reject) throw error;
    return {
      code: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
}

async function runCliWithInput(args, input, { configHome, reject = true, timeoutMs = 10000 } = {}) {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    ZAZU_API_KEY: "",
    ZAZU_BASE_URL: "",
    ZAZU_VERSION: "",
  };

  return new Promise((resolve, rejectPromise) => {
    const child = spawn(runtime, [cli, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.removeAllListeners("error");
      child.removeAllListeners("close");
      fn(value);
    };

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      const error = new Error(`Command timed out after ${timeoutMs}ms`);
      error.code = 124;
      error.stdout = stdout;
      error.stderr = stderr;
      finish(rejectPromise, error);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(rejectPromise, error));
    child.on("close", (code) => {
      const result = { code, stdout, stderr };
      if (code !== 0 && reject) {
        const error = new Error(`Command failed with exit code ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        finish(rejectPromise, error);
      } else {
        finish(resolve, result);
      }
    });

    child.stdin.end(input);
  });
}

async function tempConfigHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zazu-cli-test-"));
  return dir;
}

async function createServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseURL: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function sendJSON(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
