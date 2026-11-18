import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
// The suite is the CLI's contract: it runs against the compiled binary
// (MANZA_CLI_BIN, default dist/manza). A zazu symlink to it checks that
// the old name gets no special treatment since 2.0.
const cli = path.resolve(root, process.env.MANZA_CLI_BIN || path.join("dist", "manza"));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const cliVersion = packageJson.version;
const zazuDir = await mkdtemp(path.join(os.tmpdir(), "manza-cli-zazu-"));
const zazuShim = path.join(zazuDir, "zazu");
await symlink(cli, zazuShim);
// Blank every MANZA_* and removed ZAZU_* variable so the developer's shell
// can't leak into a test. An empty value counts as unset.
const BLANK_ENV = {
  MANZA_API_KEY: "",
  MANZA_BASE_URL: "",
  MANZA_API_VERSION: "",
  MANZA_TIMEOUT_MS: "",
  ZAZU_API_KEY: "",
  ZAZU_BASE_URL: "",
  ZAZU_VERSION: "",
  ZAZU_API_VERSION: "",
  ZAZU_TIMEOUT_MS: "",
};

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

    const config = JSON.parse(
      await readFile(path.join(configHome, "manza", "config.json"), "utf8"),
    );
    assert.equal(config.api_key, "sk_live_abcdefghijklmnopqrstuvwxyz1234567890");
    assert.equal(config.base_url, "https://api.example.test");

    const get = await runCli(["config", "get", "--pretty"], { configHome });
    assert.deepEqual(JSON.parse(get.stdout), {
      api_key: "sk_live_...7890",
      api_base: "https://api.example.test",
      api_version: null,
      config_path: path.join(configHome, "manza", "config.json"),
    });

    const unset = await runCli(["logout", "--pretty"], { configHome });
    assert.deepEqual(JSON.parse(unset.stdout), { ok: true });

    const afterLogout = JSON.parse(
      await readFile(path.join(configHome, "manza", "config.json"), "utf8"),
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
    await mkdir(path.join(configHome, "manza"), { recursive: true });
    await writeFile(path.join(configHome, "manza", "config.json"), "{not-json", "utf8");

    const result = await runCli(["invoices", "--help"], { configHome });
    assert.match(result.stdout, /Manza CLI - invoices/);
    assert.match(
      result.stdout,
      /manza invoices create \[--data json\|--file path\|--stdin\] \[--account-id id\] \[--generate-payment-link true\|false\]/,
    );
    assert.doesNotMatch(result.stdout, /payment-link </);
    assert.doesNotMatch(result.stdout, /Global flags:/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("version does not require readable config", async () => {
  const configHome = await tempConfigHome();

  try {
    await mkdir(path.join(configHome, "manza"), { recursive: true });
    await writeFile(path.join(configHome, "manza", "config.json"), "{not-json", "utf8");

    const result = await runCli(["--version"], { configHome });
    assert.equal(result.stdout, `${cliVersion}\n`);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("recovery commands tolerate a corrupt stored config", async () => {
  const configHome = await tempConfigHome();

  try {
    await mkdir(path.join(configHome, "manza"), { recursive: true });
    await writeFile(path.join(configHome, "manza", "config.json"), "{not-json", "utf8");

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

    const stored = JSON.parse(
      await readFile(path.join(configHome, "manza", "config.json"), "utf8"),
    );
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
    assert.match(result.stderr, /manza login/);
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
    res.setHeader("Manza-Version", "2026-04-29");
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
      manza_version: "2026-04-29",
    });
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("a plan limit error prints its kind, current and max", async () => {
  const configHome = await tempConfigHome();
  let status = 422;
  let partial = false;
  const server = await createServer((_req, res) => {
    res.setHeader("X-Request-Id", "req_456");
    const error = {
      type: "plan_limit_reached",
      message: "Plan limit reached for invoices: 10 of 10",
      kind: "invoices",
      current: 10,
      max: 10,
    };
    if (partial) {
      delete error.current;
      delete error.max;
    }
    sendJSON(res, { error }, status);
  });
  const args = [
    "--api-key",
    "sk_live_test",
    "--base-url",
    server.baseURL,
    "invoices",
    "create",
    "--customer-id",
    "cus_1",
  ];

  try {
    const result = await runCli(args, { configHome, reject: false });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      `${JSON.stringify({
        error: {
          type: "plan_limit_reached",
          message: "Plan limit reached for invoices: 10 of 10",
          kind: "invoices",
          current: 10,
          max: 10,
        },
        status: 422,
        kind: "invoices",
        current: 10,
        max: 10,
        request_id: "req_456",
      })}\n`,
    );

    // A value the API leaves out is not printed as 0.
    partial = true;
    const missing = await runCli(args, { configHome, reject: false });
    assert.deepEqual(Object.keys(JSON.parse(missing.stderr)), [
      "error",
      "status",
      "kind",
      "request_id",
    ]);
    partial = false;

    // Only a 422 is a plan cap: the same type on a 500 prints as usual.
    status = 500;
    const server500 = await runCli(args, { configHome, reject: false });
    assert.equal(server500.code, 1);
    const payload = JSON.parse(server500.stderr);
    assert.equal(payload.status, 500);
    assert.deepEqual(Object.keys(payload), ["error", "status", "request_id"]);
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
        "--transfer-method",
        "instant",
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
        url: "/api/payments",
        body: JSON.stringify({
          account_id: "acc_123",
          beneficiary_id: "ben_123",
          amount: "150.00",
          payment_reference: "INV-001",
          client_reference: "po_1",
          transfer_method: "instant",
        }),
      },
      { method: "GET", url: "/api/payments/td_123", body: "" },
      { method: "GET", url: "/api/beneficiaries?limit=5", body: "" },
      { method: "GET", url: "/api/beneficiaries/ben_123", body: "" },
    ]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("invoice commands send account_id and generate_payment_link", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, body: await readRequestBody(req) });
    sendJSON(res, { id: "inv_1", generate_payment_link: true });
  });
  const api = ["--api-key", "sk_live_test", "--base-url", server.baseURL];

  try {
    await runCli(
      [
        ...api,
        "invoices",
        "create",
        "--customer-id",
        "cus_1",
        "--account-id",
        "acc_1",
        "--issue-date",
        "2026-11-14",
        "--due-date",
        "2026-12-14",
        "--generate-payment-link",
        "true",
        "--item",
        '{"description":"Consulting","quantity":1,"unit_price":"150.00"}',
      ],
      { configHome },
    );
    await runCli(
      [
        ...api,
        "invoices",
        "update",
        "inv_1",
        "--account-id",
        "acc_2",
        "--generate-payment-link",
        "false",
      ],
      { configHome },
    );
    await runCli([...api, "invoices", "update", "inv_1", "--data", '{"account_id":"acc_3"}'], {
      configHome,
    });

    assert.deepEqual(requests, [
      {
        method: "POST",
        url: "/api/invoices",
        body: JSON.stringify({
          customer_id: "cus_1",
          issue_date: "2026-11-14",
          due_date: "2026-12-14",
          account_id: "acc_1",
          generate_payment_link: true,
          items: [{ description: "Consulting", quantity: 1, unit_price: "150.00" }],
        }),
      },
      {
        method: "PATCH",
        url: "/api/invoices/inv_1",
        body: JSON.stringify({ account_id: "acc_2", generate_payment_link: false }),
      },
      {
        method: "PATCH",
        url: "/api/invoices/inv_1",
        body: JSON.stringify({ account_id: "acc_3" }),
      },
    ]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("invoices payment-link is gone: it points at --generate-payment-link and sends nothing", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    sendJSON(res, { ok: true });
  });
  const api = ["--api-key", "sk_live_test", "--base-url", server.baseURL];

  try {
    for (const command of ["payment-link", "payment_link"]) {
      const result = await runCli([...api, "invoices", command, "inv_1", "--account-id", "acc_1"], {
        configHome,
        reject: false,
      });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "manza invoices payment-link was removed in 2.0: the API no longer has it. Pass --account-id <id> --generate-payment-link true to invoices create or update.\n",
      );
    }

    const usage = await runCli([...api, "invoices", "bogus", "inv_1"], {
      configHome,
      reject: false,
    });
    assert.equal(usage.code, 1);
    assert.equal(
      usage.stderr,
      "Usage: manza invoices list|get|create|update|send|mark-as-paid|cancel|credit-note|delete\n",
    );
    assert.deepEqual(requests, []);
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
        url: "/api/payments/td_123/authorize",
        body: JSON.stringify({ authorization_id: "auth_1", signature: "abc123" }),
      },
      {
        method: "POST",
        url: "/api/payments/td_123/decline",
        body: JSON.stringify({ authorization_id: "auth_1", reason: "not mine" }),
      },
      {
        method: "POST",
        url: "/api/payments/td_124/decline",
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

test("transfers get prints the payment's approval in words on stderr", async () => {
  const configHome = await tempConfigHome();
  const payments = {
    "/api/payments/pay_refused": {
      id: "pay_refused",
      status: "requested",
      authorization: {
        id: "auth_1",
        status: "refused",
        expires_at: "2026-10-30T12:00:00Z",
        refusal_reason: "over_daily_limit",
      },
    },
    "/api/payments/pay_pending": {
      id: "pay_pending",
      authorization: {
        id: "auth_2",
        status: "pending",
        expires_at: "2026-10-30T13:00:00Z",
        refusal_reason: null,
      },
    },
    "/api/payments/pay_authorized": {
      id: "pay_authorized",
      authorization: { id: "auth_3", status: "authorized", refusal_reason: null },
    },
    "/api/payments/pay_expired": {
      id: "pay_expired",
      authorization: { id: "auth_4", status: "expired", refusal_reason: "expired" },
    },
    "/api/payments/pay_unknown": {
      id: "pay_unknown",
      authorization: { id: "auth_5", status: "refused", refusal_reason: "brand_new_reason" },
    },
    "/api/payments/pay_declined": {
      id: "pay_declined",
      authorization: { id: "auth_6", status: "declined", refusal_reason: null },
    },
    "/api/payments/pay_superseded": {
      id: "pay_superseded",
      authorization: { id: "auth_7", status: "superseded", refusal_reason: null },
    },
    "/api/payments/pay_rail_limit": {
      id: "pay_rail_limit",
      transfer_method: "instant",
      authorization: { id: "auth_8", status: "superseded", refusal_reason: "rail_limit_exceeded" },
    },
    "/api/payments/pay_none": { id: "pay_none", authorization: null },
    "/api/payments/pay_legacy": { id: "pay_legacy", status: "requested" },
  };
  const server = await createServer((req, res) => sendJSON(res, payments[req.url]));
  const api = ["--api-key", "sk_live_test", "--base-url", server.baseURL];
  const get = (id, extra = []) =>
    runCli([...api, ...extra, "transfers", "get", id], { configHome });

  try {
    const refused = await get("pay_refused");
    assert.deepEqual(JSON.parse(refused.stdout), payments["/api/payments/pay_refused"]);
    assert.equal(
      refused.stderr,
      "Approval: sent to your approvers: This amount plus the last 24 hours' authorized total is above the limit per 24 hours (over_daily_limit)\n",
    );

    assert.equal(
      (await get("pay_pending")).stderr,
      "Approval: challenge sent to your authorizer (expires 2026-10-30T13:00:00Z)\n",
    );
    assert.equal((await get("pay_authorized")).stderr, "Approval: authorized\n");
    assert.equal(
      (await get("pay_expired")).stderr,
      "Approval: sent to your approvers: Nobody answered the challenge within one hour (expired)\n",
    );
    assert.equal(
      (await get("pay_unknown")).stderr,
      "Approval: sent to your approvers: brand_new_reason\n",
    );
    assert.equal(
      (await get("pay_declined")).stderr,
      "Approval: declined by your authorizer; the payment is deleted\n",
    );
    assert.equal(
      (await get("pay_superseded")).stderr,
      "Approval: superseded; sent to your approvers\n",
    );
    assert.equal(
      (await get("pay_rail_limit")).stderr,
      "Approval: sent to your approvers: The challenge was authorized, but the transfer's rail (an instant transfer's daily cap) refused it before anything was sent (rail_limit_exceeded)\n",
    );
    assert.equal(
      (await get("pay_none")).stderr,
      "Approval: no transfer authorizer was enrolled when this payment was created; it went to your approvers\n",
    );

    const legacy = await get("pay_legacy");
    assert.equal(legacy.stdout, '{"id":"pay_legacy","status":"requested"}\n');
    assert.equal(legacy.stderr, "");

    const quiet = await get("pay_refused", ["--quiet"]);
    assert.equal(quiet.stdout, "");
    assert.equal(quiet.stderr, "");
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("transfers commands name the payment id they miss", async () => {
  const configHome = await tempConfigHome();

  try {
    const result = await runCli(["--api-key", "sk_live_test", "transfers", "get"], {
      configHome,
      reject: false,
    });
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "Missing payment id.\n");
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("transfer-authorizer get prints the JSON and a summary on stderr", async () => {
  const configHome = await tempConfigHome();
  const day = 24 * 60 * 60 * 1000;
  const inDays = (days) => new Date(Date.now() + days * day).toISOString();
  const authorizer = (overrides) => ({
    status: "active",
    suspension_reason: null,
    currency_code: "MAD",
    per_transfer_limit: "5000.0",
    daily_limit: "20000.0",
    daily_authorized_total: "1500.5",
    secret_expires_at: inDays(30),
    webhook_endpoint_id: "weh_1",
    enrolled_at: "2026-09-01T00:00:00Z",
    ...overrides,
  });
  let body = authorizer({});
  let status = 200;
  const requests = [];
  const server = await createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (typeof body === "string") {
      res.writeHead(status, { "Content-Type": "text/html" });
      res.end(body);
      return;
    }
    sendJSON(res, body, status);
  });
  const api = ["--api-key", "sk_live_test", "--base-url", server.baseURL];

  try {
    const active = await runCli([...api, "transfer-authorizer", "get"], { configHome });
    assert.deepEqual(JSON.parse(active.stdout), body);
    assert.equal(
      active.stderr,
      [
        "Transfer authorizer: active",
        "Limits: 5000.0 MAD per transfer, 20000.0 MAD per 24 hours",
        "Last 24 hours: 1500.5 MAD authorized, 18499.5 MAD remaining",
        `Secret expires: ${body.secret_expires_at}`,
        "Webhook endpoint: weh_1",
        "",
      ].join("\n"),
    );

    body = authorizer({ trust_new_payees: true, new_payee_limit: "1000.0" });
    const trusting = await runCli([...api, "transfer-authorizer", "get"], { configHome });
    assert.match(
      trusting.stderr,
      /\nLimits: [^\n]+\nNew payees: approved up to 1000\.0 MAD per transfer\nLast 24 hours: /,
    );

    body = authorizer({ trust_new_payees: false, new_payee_limit: null });
    const notTrusting = await runCli([...api, "transfer-authorizer", "get"], { configHome });
    assert.match(
      notTrusting.stderr,
      /\nNew payees: not approved \(Approve transfers to new payees is off\)\nLast 24 hours: /,
    );

    body = authorizer({ secret_expires_at: inDays(3) });
    const soon = await runCli([...api, "transfer_authorizer", "get"], { configHome });
    assert.match(
      soon.stderr,
      new RegExp(
        `Secret expires: ${body.secret_expires_at} \\(within 7 days: an approver rotates it in the app\\)\n`,
      ),
    );

    body = authorizer({
      status: "suspended",
      suspension_reason: "secret_expired",
      daily_authorized_total: "25000.0",
      secret_expires_at: inDays(-1),
    });
    const suspended = await runCli([...api, "transfer-authorizer", "get"], { configHome });
    assert.match(
      suspended.stderr,
      /^Transfer authorizer: suspended \(secret_expired: the signing secret expired\)\n/,
    );
    assert.match(suspended.stderr, /Last 24 hours: 25000\.0 MAD authorized, 0\.0 MAD remaining\n/);
    assert.match(
      suspended.stderr,
      /Secret expires: \S+ \(expired: an approver rotates it in the app and resumes\)\n/,
    );

    const quiet = await runCli([...api, "--quiet", "transfer-authorizer", "get"], { configHome });
    assert.equal(quiet.stdout, "");
    assert.equal(quiet.stderr, "");

    status = 404;
    body = { error: { type: "not_found_error", message: "Not found" } };
    const missing = await runCli([...api, "transfer-authorizer", "get"], {
      configHome,
      reject: false,
    });
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, "");
    assert.equal(
      missing.stderr,
      "No transfer authorizer enrolled: Settings → Developer → Transfer approval\n",
    );

    // A 404 that is not the API's not_found_error (a wrong --base-url, an
    // older API) keeps the usual error output.
    body = "<html>Not Found</html>";
    const elsewhere = await runCli([...api, "transfer-authorizer", "get"], {
      configHome,
      reject: false,
    });
    assert.equal(elsewhere.code, 1);
    assert.deepEqual(JSON.parse(elsewhere.stderr), {
      error: { message: "Not found", type: null, param: null },
      status: 404,
    });

    const usage = await runCli([...api, "transfer-authorizer", "list"], {
      configHome,
      reject: false,
    });
    assert.equal(usage.code, 1);
    assert.equal(usage.stderr, "Usage: manza transfer-authorizer get\n");

    assert.ok(requests.every((request) => request === "GET /api/transfer_authorizer"));
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

// The verification gate from getmanza/cli#24.
const WEBHOOK_BODY = '{"event":"test.ping","event_id":"0199a1b2-0000-7000-8000-000000000010"}';
const WEBHOOK_FLAGS = [
  "--secret",
  "whsec_test_vector_secret",
  "--timestamp",
  "1767225600",
  "--signature",
  "970fdd13680015f73dbd172884498c6fd1e07d5b5c41aae081272598607fea75",
];

test("webhooks verify checks a captured delivery from stdin or --file", async () => {
  const configHome = await tempConfigHome();
  const bodyFile = path.join(configHome, "body.json");
  await writeFile(bodyFile, WEBHOOK_BODY, "utf8");

  try {
    const stdin = await runCliWithInput(
      ["webhooks", "verify", ...WEBHOOK_FLAGS, "--no-tolerance"],
      WEBHOOK_BODY,
      { configHome },
    );
    assert.equal(stdin.code, 0);
    assert.equal(stdin.stdout, "valid\n");
    assert.equal(stdin.stderr, "");

    const file = await runCli(
      ["webhooks", "verify", ...WEBHOOK_FLAGS, "--no-tolerance", "--file", bodyFile],
      { configHome },
    );
    assert.equal(file.stdout, "valid\n");

    const fromEnv = await runCli(
      [
        "webhooks",
        "verify",
        ...WEBHOOK_FLAGS.slice(2),
        "--secret-env",
        "WEBHOOK_SECRET",
        "--no-tolerance",
        "--file",
        bodyFile,
      ],
      { configHome, env: { WEBHOOK_SECRET: "whsec_test_vector_secret" } },
    );
    assert.equal(fromEnv.stdout, "valid\n");

    const upper = await runCliWithInput(
      [
        "webhooks",
        "verify",
        ...WEBHOOK_FLAGS.slice(0, 4),
        "--signature",
        WEBHOOK_FLAGS[5].toUpperCase(),
        "--no-tolerance",
      ],
      WEBHOOK_BODY,
      { configHome },
    );
    assert.equal(upper.stdout, "valid\n");

    const reserialized = await runCliWithInput(
      ["webhooks", "verify", ...WEBHOOK_FLAGS, "--no-tolerance"],
      `${WEBHOOK_BODY}\n`,
      { configHome, reject: false },
    );
    assert.equal(reserialized.code, 1);
    assert.equal(reserialized.stdout, "");
    assert.equal(reserialized.stderr, "invalid webhook signature\n");

    const stale = await runCli(["webhooks", "verify", ...WEBHOOK_FLAGS, "--file", bodyFile], {
      configHome,
      reject: false,
    });
    assert.equal(stale.code, 1);
    assert.equal(
      stale.stderr,
      "webhook timestamp outside tolerance (the signature matches; pass --no-tolerance to check a captured delivery)\n",
    );
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("webhooks verify needs no config: a corrupt one does not block it", async () => {
  const configHome = await tempConfigHome();

  try {
    await mkdir(path.join(configHome, "manza"), { recursive: true });
    await writeFile(path.join(configHome, "manza", "config.json"), "{not-json", "utf8");

    const piped = await runCliWithInput(
      ["webhooks", "verify", ...WEBHOOK_FLAGS, "--no-tolerance"],
      WEBHOOK_BODY,
      { configHome },
    );
    assert.equal(piped.stdout, "valid\n");

    // Global flags given on the command line are still checked.
    const badFormat = await runCliWithInput(
      ["--format", "bogus", "webhooks", "verify", ...WEBHOOK_FLAGS, "--no-tolerance"],
      WEBHOOK_BODY,
      { configHome, reject: false },
    );
    assert.equal(badFormat.code, 1);
    assert.equal(badFormat.stderr, 'Invalid output format "bogus". Use json, pretty, or raw.\n');

    const badTimeout = await runCliWithInput(
      ["--timeout-ms", "abc", "webhooks", "verify", ...WEBHOOK_FLAGS, "--no-tolerance"],
      WEBHOOK_BODY,
      { configHome, reject: false },
    );
    assert.equal(badTimeout.code, 1);
    assert.equal(badTimeout.stderr, 'Invalid --timeout-ms "abc". Use a positive integer.\n');
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("webhooks verify requires the secret, timestamp and signature", async () => {
  const configHome = await tempConfigHome();
  const without = (name) => {
    const index = WEBHOOK_FLAGS.indexOf(`--${name}`);
    return WEBHOOK_FLAGS.filter((_, i) => i !== index && i !== index + 1);
  };

  try {
    for (const [name, message] of [
      ["secret", "Missing webhook signing secret. Use --secret-env <VAR> or --secret <secret>.\n"],
      ["timestamp", "Missing timestamp. Use --timestamp <X-Manza-Timestamp>.\n"],
      ["signature", "Missing signature. Use --signature <X-Manza-Signature>.\n"],
    ]) {
      const result = await runCliWithInput(["webhooks", "verify", ...without(name)], WEBHOOK_BODY, {
        configHome,
        reject: false,
      });
      assert.equal(result.code, 1);
      assert.equal(result.stderr, message);
    }

    const badTimestamp = await runCliWithInput(
      ["webhooks", "verify", ...without("timestamp"), "--timestamp", "2026-01-01"],
      WEBHOOK_BODY,
      { configHome, reject: false },
    );
    assert.equal(badTimestamp.code, 1);
    assert.equal(
      badTimestamp.stderr,
      'Invalid --timestamp "2026-01-01". Use the delivery\'s X-Manza-Timestamp (Unix seconds).\n',
    );

    const both = await runCliWithInput(
      ["webhooks", "verify", ...WEBHOOK_FLAGS, "--secret-env", "WEBHOOK_SECRET"],
      WEBHOOK_BODY,
      { configHome, reject: false },
    );
    assert.equal(both.code, 1);
    assert.equal(both.stderr, "Pass exactly one of --secret-env or --secret.\n");

    const unset = await runCliWithInput(
      ["webhooks", "verify", ...without("secret"), "--secret-env", "NOPE_UNSET_VAR"],
      WEBHOOK_BODY,
      { configHome, reject: false },
    );
    assert.equal(unset.code, 1);
    assert.equal(unset.stderr, "Environment variable NOPE_UNSET_VAR is not set.\n");

    const usage = await runCli(["webhooks", "list"], { configHome, reject: false });
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /^Usage: manza webhooks verify /);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("transfer-authorizer and webhooks help list their commands", async () => {
  const configHome = await tempConfigHome();

  try {
    const authorizer = await runCli(["transfer-authorizer", "--help"], { configHome });
    assert.match(authorizer.stdout, /Manza CLI - transfer-authorizer/);
    assert.match(authorizer.stdout, /manza transfer-authorizer get/);

    const webhooks = await runCli(["webhooks", "--help"], { configHome });
    assert.match(webhooks.stdout, /Manza CLI - webhooks/);
    assert.match(
      webhooks.stdout,
      /manza webhooks verify \(--secret-env <VAR>\|--secret <secret>\)/,
    );

    const top = await runCli(["--help"], { configHome });
    assert.match(top.stdout, /manza transfer-authorizer get/);
    assert.match(top.stdout, /manza webhooks verify/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

const LISTEN_SECRET = "whsec_listen_test";
// Odd on purpose: key order, double spaces and a nested array must reach
// the local server byte-for-byte.
const LISTEN_BODY_1 = '{"type":"transfer.executed",  "id":"evt_1","data":{"z":1, "a":[2,1]}}';
const LISTEN_BODY_2 = '{"type":"payment_link.paid","id":"evt_2" ,"data":{}}';
const LISTEN_FRAME_1 = {
  id: "whd_1",
  event_type: "transfer.executed",
  event_id: "evt_1",
  body: LISTEN_BODY_1,
};
const LISTEN_FRAME_2 = {
  id: "whd_2",
  event_type: "payment_link.paid",
  event_id: "evt_2",
  body: LISTEN_BODY_2,
};

test("listen forwards each frame byte-for-byte, signed with the listen secret", async () => {
  const configHome = await tempConfigHome();
  const capture = await createCapture();
  const api = await createListenApi(({ res }) => {
    sseOpen(res);
    sseWebhook(res, "1-0", LISTEN_FRAME_1);
    sseWebhook(res, "2-0", LISTEN_FRAME_2);
  });
  const hook = `${capture.baseURL}/hooks`;
  const run = startCli(
    [
      ...listenApi(api),
      "listen",
      "--forward-to",
      hook,
      "--events",
      "transfer.executed,payment_link.paid",
    ],
    { configHome },
  );

  try {
    await waitFor(() => capture.hits.length === 2, "two forwarded events");
    run.child.kill("SIGINT");
    const result = await run.exited;

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.deepEqual(
      api.requests.map((r) => [r.method, r.url, r.body]),
      [
        [
          "POST",
          "/api/webhook_listeners",
          '{"events":["transfer.executed","payment_link.paid"],"authorizer":false}',
        ],
        ["GET", "/api/webhook_listeners/stream?name=wl_1", ""],
        ["DELETE", "/api/webhook_listeners/wl_1", ""],
      ],
    );

    const [first, second] = capture.hits;
    assert.equal(first.method, "POST");
    assert.equal(first.url, "/hooks");
    assert.equal(first.body, LISTEN_BODY_1);
    assert.equal(second.body, LISTEN_BODY_2);
    assert.equal(first.headers["content-type"], "application/json");
    for (const prefix of ["x-manza", "x-zazu"]) {
      assert.equal(first.headers[`${prefix}-event`], "transfer.executed");
      assert.equal(first.headers[`${prefix}-event-id`], "evt_1");
      assert.equal(first.headers[`${prefix}-delivery-id`], "whd_1");
      assert.match(first.headers[`${prefix}-signature`], /^[0-9a-f]{64}$/);
      assert.match(first.headers[`${prefix}-timestamp`], /^\d+$/);
    }
    assert.equal(second.headers["x-manza-delivery-id"], "whd_2");

    // Signed at forward time: verifies within the 5-minute tolerance.
    const bodyFile = path.join(configHome, "forwarded.json");
    await writeFile(bodyFile, first.body, "utf8");
    const verify = await runCli(
      [
        "webhooks",
        "verify",
        "--secret-env",
        "LISTEN_SECRET",
        "--timestamp",
        first.headers["x-manza-timestamp"],
        "--signature",
        first.headers["x-manza-signature"],
        "--file",
        bodyFile,
      ],
      { configHome, env: { LISTEN_SECRET } },
    );
    assert.equal(verify.stdout, "valid\n");

    assert.match(
      result.stderr,
      /^Ready! Listening for transfer\.executed, payment_link\.paid\. Your listen signing secret is whsec_listen_test \(\^C to quit\)\n/,
    );
    assert.doesNotMatch(result.stderr, /first answer wins/);
    const lines = result.stderr.trimEnd().split("\n").slice(1);
    const stamp = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}`;
    const url = hook.replace(/[.]/g, "\\.");
    assert.equal(lines.length, 4);
    assert.match(lines[0], new RegExp(`^${stamp}  --> transfer\\.executed \\[evt_1\\]$`));
    assert.match(lines[1], new RegExp(`^${stamp}  <-- \\[200\\] POST ${url} \\(\\d+ ms\\)$`));
    assert.match(lines[2], new RegExp(`^${stamp}  --> payment_link\\.paid \\[evt_2\\]$`));
    assert.match(lines[3], new RegExp(`^${stamp}  <-- \\[200\\] POST ${url} \\(\\d+ ms\\)$`));
  } finally {
    run.child.kill("SIGKILL");
    await api.close();
    await capture.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("listen --authorizer warns, --format json prints a line per event, a 500 keeps listening", async () => {
  const configHome = await tempConfigHome();
  const capture = await createCapture((hit) => (hit === 1 ? 500 : 204));
  const api = await createListenApi(({ res }) => {
    sseOpen(res);
    sseWebhook(res, "1-0", LISTEN_FRAME_1);
    sseWebhook(res, "2-0", LISTEN_FRAME_2);
    sseClosed(res);
  });
  const hook = `${capture.baseURL}/hooks`;

  try {
    const result = await startCli(
      [...listenApi(api), "--format", "json", "listen", "--authorizer", "--forward-to", hook],
      { configHome },
    ).exited;

    assert.equal(result.code, 1);
    assert.deepEqual(
      api.requests.map((r) => [r.method, r.url, r.body]),
      [
        ["POST", "/api/webhook_listeners", '{"events":[],"authorizer":true}'],
        ["GET", "/api/webhook_listeners/stream?name=wl_1", ""],
      ],
    );
    assert.equal(capture.hits.length, 2);

    const out = result.stdout.trimEnd().split("\n");
    assert.equal(out.length, 2);
    assert.match(
      out[0],
      /^\{"event_id":"evt_1","event_type":"transfer\.executed","status":500,"duration_ms":\d+\}$/,
    );
    assert.match(
      out[1],
      /^\{"event_id":"evt_2","event_type":"payment_link\.paid","status":204,"duration_ms":\d+\}$/,
    );

    assert.match(
      result.stderr,
      /^Ready! Listening for all events and transfer challenges\. Your listen signing secret is whsec_listen_test \(\^C to quit\)\n/,
    );
    assert.match(
      result.stderr,
      /Challenges also go to your registered authorizer; the first answer wins\. Five bad signatures suspend the authorizer for everyone using it\.\n/,
    );
    assert.match(result.stderr, / {2}<-- \[500\] POST /);
    assert.match(result.stderr, / {2}<-- \[204\] POST /);
    assert.match(
      result.stderr,
      /Listener closed by the server: the API key was revoked or the session was closed elsewhere\.\n$/,
    );
  } finally {
    await api.close();
    await capture.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("listen prints [ERR] when the local server refuses and keeps listening until SIGTERM", async () => {
  const configHome = await tempConfigHome();
  const closed = await createServer(() => {});
  const refused = `${closed.baseURL}/hooks`;
  await closed.close();
  const api = await createListenApi(({ res }) => {
    sseOpen(res);
    sseWebhook(res, "1-0", LISTEN_FRAME_1);
    sseWebhook(res, "2-0", LISTEN_FRAME_2);
  });
  const run = startCli([...listenApi(api), "--json", "listen", "--forward-to", refused], {
    configHome,
  });

  try {
    await waitFor(() => (run.out.stderr.match(/\[ERR\]/g) || []).length === 2, "two [ERR] lines");
    run.child.kill("SIGTERM");
    const result = await run.exited;

    assert.equal(result.code, 0);
    assert.match(result.stderr, / {2}<-- \[ERR\] .*refused/);
    assert.deepEqual(api.requests.at(-1), {
      method: "DELETE",
      url: "/api/webhook_listeners/wl_1",
      body: "",
      lastEventId: null,
    });
    const out = result.stdout.trimEnd().split("\n");
    assert.equal(out.length, 2);
    const line = JSON.parse(out[0]);
    assert.deepEqual(Object.keys(line), [
      "event_id",
      "event_type",
      "status",
      "duration_ms",
      "error",
    ]);
    assert.equal(line.status, null);
    assert.match(line.error, /refused/);
  } finally {
    run.child.kill("SIGKILL");
    await api.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("listen renews an expired session and resumes forwarding", async () => {
  const configHome = await tempConfigHome();
  const capture = await createCapture();
  const api = await createListenApi(({ name, connection, res }) => {
    if (name === "wl_1" && connection === 1) {
      sseOpen(res);
      sseWebhook(res, "1-0", LISTEN_FRAME_1);
      res.end();
    } else if (name === "wl_1") {
      sendJSON(res, { error: { type: "not_found_error", message: "Listener not found" } }, 404);
    } else {
      sseOpen(res);
      sseWebhook(res, "1-0", LISTEN_FRAME_2);
      sseClosed(res);
    }
  });

  try {
    const result = await startCli(
      [...listenApi(api), "listen", "--forward-to", `${capture.baseURL}/hooks`],
      { configHome },
    ).exited;

    assert.equal(result.code, 1);
    assert.deepEqual(
      api.requests.map((r) => [r.method, r.url, r.lastEventId]),
      [
        ["POST", "/api/webhook_listeners", null],
        ["GET", "/api/webhook_listeners/stream?name=wl_1", null],
        ["GET", "/api/webhook_listeners/stream?name=wl_1", "1-0"],
        ["POST", "/api/webhook_listeners", null],
        ["GET", "/api/webhook_listeners/stream?name=wl_2", null],
      ],
    );
    assert.deepEqual(
      capture.hits.map((hit) => hit.body),
      [LISTEN_BODY_1, LISTEN_BODY_2],
    );
    assert.equal((result.stderr.match(/Session renewed\n/g) || []).length, 1);
  } finally {
    await api.close();
    await capture.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("listen --print-secret prints only the secret and closes the session", async () => {
  const configHome = await tempConfigHome();
  const api = await createListenApi(() => {
    throw new Error("--print-secret must not open the stream");
  });

  try {
    const result = await runCli([...listenApi(api), "listen", "--print-secret"], { configHome });

    assert.equal(result.stdout, `${LISTEN_SECRET}\n`);
    assert.equal(result.stderr, "");
    assert.deepEqual(
      api.requests.map((r) => [r.method, r.url]),
      [
        ["POST", "/api/webhook_listeners"],
        ["DELETE", "/api/webhook_listeners/wl_1"],
      ],
    );
  } finally {
    await api.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("listen requires --forward-to and explains a 403 on --authorizer", async () => {
  const configHome = await tempConfigHome();
  const forbidden = {
    error: { type: "permission_error", message: "API key lacks the transfers:authorize scope" },
  };
  const api = await createListenApi(() => {}, { createStatus: 403, createBody: forbidden });

  try {
    const usage = await runCli([...listenApi(api), "listen"], { configHome, reject: false });
    assert.equal(usage.code, 1);
    assert.equal(usage.stdout, "");
    assert.equal(usage.stderr, "Missing forward URL. Use --forward-to <url>.\n");
    assert.deepEqual(api.requests, []);

    const denied = await runCli(
      [...listenApi(api), "listen", "--authorizer", "--forward-to", "http://127.0.0.1:1/hooks"],
      { configHome, reject: false },
    );
    assert.equal(denied.code, 1);
    assert.equal(denied.stdout, "");
    const [errorLine, hint] = denied.stderr.trimEnd().split("\n");
    assert.deepEqual(JSON.parse(errorLine), { ...forbidden, status: 403 });
    assert.equal(
      hint,
      "--authorizer needs an API key with the transfers:authorize scope and an IP allowlist.",
    );
    assert.deepEqual(
      api.requests.map((r) => [r.method, r.url]),
      [["POST", "/api/webhook_listeners"]],
    );
  } finally {
    await api.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("listen help lists the command", async () => {
  const configHome = await tempConfigHome();

  try {
    const listen = await runCli(["listen", "--help"], { configHome });
    assert.match(listen.stdout, /Manza CLI - listen/);
    assert.match(
      listen.stdout,
      /manza listen --forward-to <url> \[--events type,type\] \[--authorizer\]/,
    );
    assert.match(listen.stdout, /manza listen --print-secret/);

    const top = await runCli(["--help"], { configHome });
    assert.match(top.stdout, /manza listen --forward-to <url>/);
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

// Shared v2 vectors from manza-ruby spec/manza/transfer_authorization_spec.rb.
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
        "--transfer-method",
        "eft",
      ],
      { configHome, env },
    );
    assert.deepEqual(JSON.parse(external.stdout), {
      signature: "904da7d0b73b2c919ffa1ae64d262ce5825ee4d2c8420fd70a3d257353e6c43a",
      signature_input:
        "manza.transfer-authorization.v2|0199a1b2-0000-7000-8000-000000000001|n0nce-0123456789abcdef|2500.0|MAD|0199a1b2-0000-7000-8000-000000000002|ext:0199a1b2-0000-7000-8000-000000000003|po_1|eft",
    });

    // No --transfer-method: the payment's rail was null, an empty segment.
    const noMethod = await runCli(
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
    assert.deepEqual(JSON.parse(noMethod.stdout), {
      signature: "029dd12924a846d7af2f4aecb61e4f4f9bd64d37315230864fb03917adc29edf",
      signature_input:
        "manza.transfer-authorization.v2|0199a1b2-0000-7000-8000-000000000001|n0nce-0123456789abcdef|2500.0|MAD|0199a1b2-0000-7000-8000-000000000002|ext:0199a1b2-0000-7000-8000-000000000003|po_1|",
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
    assert.deepEqual(JSON.parse(own.stdout), {
      signature: "a21ccf43b94f23d7a595a36bd788c27c7adbc5686a5ad4427b22d9957568c9fb",
      signature_input:
        "manza.transfer-authorization.v2|0199a1b2-0000-7000-8000-000000000001|n0nce-0123456789abcdef|2500.0|MAD|0199a1b2-0000-7000-8000-000000000002|own:0199a1b2-0000-7000-8000-000000000004||",
    });
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
    assert.match(result.stdout, /Manza CLI - payee-trust-requests/);
    assert.match(result.stdout, /manza payee-trust-requests get <id>/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("a ~/.config/zazu login is no longer read or copied (removed in 2.0)", async () => {
  const configHome = await tempConfigHome();
  const legacyPath = path.join(configHome, "zazu", "config.json");
  const manzaPath = path.join(configHome, "manza", "config.json");
  const requests = [];
  const server = await createServer((req, res) => {
    requests.push(req.url);
    sendJSON(res, { id: "entity_1" });
  });

  try {
    await mkdir(path.dirname(legacyPath), { recursive: true });
    const legacy = `${JSON.stringify(
      { api_key: "sk_live_legacy_key_1234", base_url: server.baseURL, api_version: "legacy" },
      null,
      2,
    )}\n`;
    await writeFile(legacyPath, legacy, "utf8");

    const entity = await runCli(["entity", "get"], { configHome, reject: false });
    assert.equal(entity.code, 1);
    assert.match(entity.stderr, /Missing API key/);
    assert.deepEqual(requests, []);

    const before = JSON.parse((await runCli(["config", "get"], { configHome })).stdout);
    assert.deepEqual(before, {
      api_key: null,
      api_base: "https://ma.manza.finance",
      api_version: null,
      config_path: manzaPath,
    });

    await runCli(["config", "set", "api-version", "2026-11-13"], { configHome });
    assert.deepEqual(JSON.parse(await readFile(manzaPath, "utf8")), { api_version: "2026-11-13" });
    assert.equal(await readFile(legacyPath, "utf8"), legacy);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("a corrupt manza config is an error, not a silent fallback to the legacy one", async () => {
  const configHome = await tempConfigHome();

  try {
    await mkdir(path.join(configHome, "zazu"), { recursive: true });
    await mkdir(path.join(configHome, "manza"), { recursive: true });
    await writeFile(
      path.join(configHome, "zazu", "config.json"),
      JSON.stringify({ api_key: "sk_live_legacy" }),
    );
    await writeFile(path.join(configHome, "manza", "config.json"), "{not-json");

    const result = await runCli(["entity", "get"], { configHome, reject: false });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid JSON/);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("MANZA_* env vars configure requests without warnings", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer((req, res) => {
    requests.push({
      authorization: req.headers.authorization,
      version: req.headers["manza-version"],
    });
    sendJSON(res, { id: "entity_1" });
  });

  try {
    const result = await runCli(["entity", "get"], {
      configHome,
      env: {
        MANZA_API_KEY: "sk_live_manza",
        MANZA_BASE_URL: server.baseURL,
        MANZA_API_VERSION: "2026-10-01",
        ZAZU_API_KEY: "sk_live_ignored",
        ZAZU_BASE_URL: "http://127.0.0.1:9",
        ZAZU_VERSION: "ignored",
      },
    });

    assert.equal(result.stderr, "");
    assert.deepEqual(requests, [{ authorization: "Bearer sk_live_manza", version: "2026-10-01" }]);
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("ZAZU_* env vars are no longer read (removed in 2.0)", async () => {
  const configHome = await tempConfigHome();
  const requests = [];
  const server = await createServer((req, res) => {
    requests.push({
      authorization: req.headers.authorization,
      version: req.headers["manza-version"] ?? null,
    });
    sendJSON(res, { id: "entity_1" });
  });

  try {
    const keyOnly = await runCli(["entity", "get"], {
      configHome,
      reject: false,
      env: { ZAZU_API_KEY: "sk_live_legacy", ZAZU_BASE_URL: server.baseURL },
    });
    assert.equal(keyOnly.code, 1);
    assert.equal(
      keyOnly.stderr,
      "Missing API key. Run `manza login`, set MANZA_API_KEY, or pass --api-key.\n",
    );
    assert.deepEqual(requests, []);

    // Neither the CLI's ZAZU_VERSION nor the SDK's ZAZU_API_VERSION pins the
    // request, and an invalid ZAZU_TIMEOUT_MS is not parsed.
    const rest = await runCli(["entity", "get"], {
      configHome,
      env: {
        MANZA_API_KEY: "sk_live_manza",
        MANZA_BASE_URL: server.baseURL,
        ZAZU_VERSION: "2026-03-27",
        ZAZU_API_VERSION: "2026-03-27",
        ZAZU_TIMEOUT_MS: "abc",
      },
    });
    assert.deepEqual(JSON.parse(rest.stdout), { id: "entity_1" });
    assert.equal(rest.stderr, "");
    assert.deepEqual(requests, [{ authorization: "Bearer sk_live_manza", version: null }]);

    // manza-go still falls back to ZAZU_*: the CLI hides them from it, so it
    // prints no deprecation warning of its own.
    const flags = await runCli(
      ["--api-key", "sk_live_flag", "--base-url", server.baseURL, "entity", "get"],
      { configHome, env: { ZAZU_API_KEY: "sk_live_legacy", ZAZU_BASE_URL: "http://127.0.0.1:9" } },
    );
    assert.equal(flags.stderr, "");
    assert.deepEqual(requests.at(-1), { authorization: "Bearer sk_live_flag", version: null });

    const login = await runCli(["login", "--api-key", "sk_live_new_key_5678"], {
      configHome,
      env: { ZAZU_BASE_URL: server.baseURL },
    });
    assert.equal(JSON.parse(login.stdout).base_url, "https://ma.manza.finance");
    assert.equal(login.stderr, "");
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("API errors fall back to the legacy Zazu-Version response header", async () => {
  const configHome = await tempConfigHome();
  const server = await createServer((_req, res) => {
    res.setHeader("Zazu-Version", "2026-04-29");
    sendJSON(res, { error: { message: "Not found", type: "not_found" } }, 404);
  });

  try {
    const result = await runCli(
      ["--api-key", "sk_live_test", "--base-url", server.baseURL, "entity", "get"],
      { configHome, reject: false },
    );

    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).manza_version, "2026-04-29");
  } finally {
    await server.close();
    await rm(configHome, { recursive: true, force: true });
  }
});

test("a binary named zazu is plain manza: no deprecation notice (removed in 2.0)", async () => {
  const configHome = await tempConfigHome();

  try {
    const result = await runCli(["--version"], { configHome, script: zazuShim });
    assert.equal(result.stdout, `${cliVersion}\n`);
    assert.equal(result.stderr, "");
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

test("the npm package no longer installs a zazu command", async () => {
  const publish = await readFile(path.join(root, "scripts", "npm-publish"), "utf8");
  assert.match(publish, /"bin": \{ "manza": "bin\/manza\.js" \}/);
  assert.doesNotMatch(publish, /zazu/i);
});

test("help says Manza CLI and documents the MANZA_* env vars", async () => {
  const configHome = await tempConfigHome();

  try {
    const result = await runCli(["--help"], { configHome });
    assert.match(result.stdout, /^Manza CLI/);
    assert.match(result.stdout, /Env: MANZA_API_KEY/);
    assert.match(result.stdout, /Manza-Version header\. Env: MANZA_API_VERSION/);
    assert.match(result.stdout, /Default: https:\/\/ma\.manza\.finance/);
    assert.doesNotMatch(result.stdout, /zazu/i);
  } finally {
    await rm(configHome, { recursive: true, force: true });
  }
});

// startCli spawns a long-running command (manza listen): the test signals
// it and awaits `exited`, or lets it end by itself.
function startCli(args, { configHome, env: extraEnv = {} } = {}) {
  const env = { ...process.env, XDG_CONFIG_HOME: configHome, ...BLANK_ENV, ...extraEnv };
  const child = spawn(cli, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const out = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    out.stderr += chunk;
  });
  const exited = new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, ...out }));
  });
  return { child, out, exited };
}

async function waitFor(condition, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function listenApi(api) {
  return ["--api-key", "sk_live_test", "--base-url", api.baseURL];
}

// createListenApi mocks POST/DELETE /api/webhook_listeners and hands each
// stream connection to onStream({ name, connection, res }); connection
// counts that session's connects from 1.
async function createListenApi(onStream, { createStatus = 201, createBody } = {}) {
  const requests = [];
  const streams = [];
  let sessions = 0;
  const server = await createServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({
      method: req.method,
      url: req.url,
      body,
      lastEventId: req.headers["last-event-id"] ?? null,
    });
    if (req.method === "POST" && req.url === "/api/webhook_listeners") {
      if (createStatus !== 201) {
        sendJSON(res, createBody, createStatus);
        return;
      }
      sessions += 1;
      const params = JSON.parse(body);
      sendJSON(
        res,
        {
          id: `wl_${sessions}`,
          events: params.events,
          authorizer: params.authorizer,
          expires_at: "2026-11-19T04:00:00Z",
          stream_url: `/api/webhook_listeners/stream?name=wl_${sessions}`,
          signing_secret: LISTEN_SECRET,
        },
        201,
      );
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    const name = new URL(req.url, "http://localhost").searchParams.get("name");
    const connection = requests.filter((r) => r.method === "GET" && r.url === req.url).length;
    streams.push(res);
    onStream({ name, connection, res });
  });

  return {
    baseURL: server.baseURL,
    requests,
    close: async () => {
      for (const res of streams) res.end();
      await server.close();
    },
  };
}

// createCapture is the developer's local server: it records each request
// and answers status(hitNumber).
async function createCapture(status = () => 200) {
  const hits = [];
  const server = await createServer(async (req, res) => {
    const body = await readRequestBody(req);
    hits.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(status(hits.length));
    res.end();
  });
  return { ...server, hits };
}

function sseOpen(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.write(": connected\n\n");
}

function sseWebhook(res, streamId, frame) {
  res.write(`id: ${streamId}\nevent: webhook\ndata: ${JSON.stringify(frame)}\n\n`);
}

function sseClosed(res) {
  res.write("event: listener_closed\ndata: {}\n\n");
}

async function runCli(args, { configHome, reject = true, env: extraEnv = {}, script = cli } = {}) {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: configHome,
    ...BLANK_ENV,
    ...extraEnv,
  };

  try {
    const result = await execFileAsync(script, args, { env });
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
    ...BLANK_ENV,
  };

  return new Promise((resolve, rejectPromise) => {
    const child = spawn(cli, args, { env, stdio: ["pipe", "pipe", "pipe"] });
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "manza-cli-test-"));
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
