#!/usr/bin/env bun

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  Page,
  type PageBody,
  type RequestOptions,
  TransferAuthorization,
  Zazu,
  ZazuConflictError,
  ZazuError,
  type ZazuResponse,
} from "@getzazu/sdk";
// Bun's bundler inlines JSON imports at compile time, so `bun build
// --compile` produces a self-contained binary that already knows the
// version — no runtime read required. Source-of-truth is package.json
// so the release script bumping it automatically updates --version.
import packageJson from "../package.json" with { type: "json" };

const CLI_VERSION = packageJson.version;
const DEFAULT_BASE_URL = "https://ma.manza.finance";
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const FORMATS = new Set(["json", "pretty", "raw"]);
const LIST_PAGE_SIZE = 100;

const GLOBAL_FLAGS = new Set([
  "api-key",
  "api-key-stdin",
  "base-url",
  "output",
  "api-version",
  "timeout-ms",
  "format",
  "debug",
  "help",
  "json",
  "pretty",
  "quiet",
  "version",
]);

const BOOLEAN_FLAGS = new Set([
  "all",
  "api-key-stdin",
  "debug",
  "help",
  "json",
  "pretty",
  "quiet",
  "version",
  "stdin",
]);

const HELP = `Zazu CLI

Usage:
  zazu [global flags] <resource> <command> [flags]

Global flags:
  --api-key <key>       API bearer token. Env: ZAZU_API_KEY
  --api-key-stdin       Read API key from stdin for zazu login
  --base-url <url>      API host. Env: ZAZU_BASE_URL. Default: ${DEFAULT_BASE_URL}
  --api-version <date>  Zazu-Version header. Env: ZAZU_VERSION
  --timeout-ms <ms>     Request timeout in milliseconds. Env: ZAZU_TIMEOUT_MS. Default: ${DEFAULT_REQUEST_TIMEOUT_MS}
  --output <format>     json, pretty, or raw. Default: json
  --format <format>     Alias for --output
  --json                Print compact JSON
  --pretty              Print indented JSON
  --quiet               Suppress successful response output
  --debug               Print request details to stderr
  --version             Print CLI version
  --help                Show this help

Commands:
  zazu login [--api-key-stdin] [--base-url <url>]
  zazu logout
  zazu config get [api-key|api-base|api-version]
  zazu config set <api-key|api-base|api-version> <value>
  zazu config unset <api-key|api-base|api-version>

  zazu entity get
  zazu status

  zazu accounts list [--status value] [--currency-code value] [--limit n] [--cursor value] [--all|--max-items n]
  zazu accounts get <id>
  zazu accounts transactions <account-id> [--operation value] [--posted-after time] [--posted-before time] [--limit n] [--cursor value] [--all|--max-items n]
  zazu accounts transaction <account-id> <transaction-id>
  zazu transactions list --account-id <account-id> [--operation value] [--posted-after time] [--posted-before time] [--limit n] [--cursor value] [--all|--max-items n]
  zazu transactions get --account-id <account-id> <transaction-id>

  zazu customers list [--q value] [--limit n] [--cursor value] [--all|--max-items n]
  zazu customers get <id>
  zazu customers create [--data json|--file path|--stdin] [customer flags]
  zazu customers update <id> [--data json|--file path|--stdin] [customer flags]
  zazu customers delete <id>

  zazu invoices list [--status value] [--customer-id id] [--limit n] [--cursor value] [--all|--max-items n]
  zazu invoices get <id>
  zazu invoices create [--data json|--file path|--stdin] [invoice flags]
  zazu invoices update <id> [--data json|--file path|--stdin] [invoice flags]
  zazu invoices send <id>
  zazu invoices mark-as-paid <id>
  zazu invoices cancel <id>
  zazu invoices credit-note <id>
  zazu invoices delete <id>
  zazu invoices payment-link <id> --account-id <account-id>

  zazu payment-links list [--status value] [--link-type value] [--limit n] [--cursor value] [--all|--max-items n]
  zazu payment-links get <id>
  zazu payment-links create [--data json|--file path|--stdin] [payment link flags]
  zazu payment-links cancel <id>

  zazu transfers create [--data json|--file path|--stdin] [transfer flags] [--client-reference ref]
  zazu transfers get <id>
  zazu transfers authorize <id> --authorization-id <id> --signature <hex>
  zazu transfers decline <id> --authorization-id <id> [--reason text]
  zazu transfers sign --secret-env <VAR> --payment-id <id> --nonce <nonce> --amount <decimal> --currency-code <code> --account-id <id> (--external-account-id <id>|--destination-account-id <id>) [--client-reference ref]

  zazu beneficiaries list [--limit n] [--cursor value] [--all|--max-items n]
  zazu beneficiaries get <id>
  zazu beneficiaries create [--data json|--file path|--stdin] [beneficiary flags]
  zazu beneficiaries accounts list <beneficiary-id> [--limit n] [--cursor value] [--all|--max-items n]
  zazu beneficiaries accounts get <beneficiary-id> <account-id>
  zazu beneficiaries accounts create <beneficiary-id> [--data json|--file path|--stdin] [account flags]

  zazu payee-trust-requests create --external-account-id <id> [--external-account-id <id> ...]
  zazu payee-trust-requests get <id>

  zazu webhook-endpoints list [--limit n] [--cursor value] [--all|--max-items n]
  zazu webhook-endpoints get <id>
  zazu webhook-endpoints create [--data json|--file path|--stdin] [--url url] [--description text] [--event value]
  zazu webhook-endpoints update <id> [--data json|--file path|--stdin] [--url url] [--description text] [--event value]
  zazu webhook-endpoints delete <id>
  zazu webhook-endpoints test <id>
  zazu webhook-endpoints regenerate-secret <id>
  zazu webhook-endpoints enable <id>
  zazu webhook-endpoints disable <id>

  zazu checkout-sessions create [--data json|--file path|--stdin] [--account-id id] [--amount amount] [--currency-code value] [--success-url url] [--cancel-url url] [--description text] [--customer-email email] [--metadata json]
  zazu checkout-sessions get <id>

  zazu request <method> <path> [--data json|--file path|--stdin] [--query key=value]
`;

const COMMAND_HELP = {
  accounts: `Zazu CLI - accounts

Usage:
  zazu accounts list [--status value] [--currency-code value] [--limit n] [--cursor value] [--all|--max-items n]
  zazu accounts get <id>
  zazu accounts transactions <account-id> [--operation value] [--posted-after time] [--posted-before time] [--limit n] [--cursor value] [--all|--max-items n]
  zazu accounts transaction <account-id> <transaction-id>
`,
  "checkout-sessions": `Zazu CLI - checkout-sessions

Usage:
  zazu checkout-sessions create [--data json|--file path|--stdin] [--account-id id] [--amount amount] [--currency-code value] [--success-url url] [--cancel-url url] [--description text] [--customer-email email] [--metadata json]
  zazu checkout-sessions get <id>
`,
  config: `Zazu CLI - config

Usage:
  zazu config get [api-key|api-base|api-version]
  zazu config set <api-key|api-base|api-version> <value>
  zazu config unset <api-key|api-base|api-version>
`,
  customers: `Zazu CLI - customers

Usage:
  zazu customers list [--q value] [--limit n] [--cursor value] [--all|--max-items n]
  zazu customers get <id>
  zazu customers create [--data json|--file path|--stdin] [--company-name value] [--email value] [--billing-address json]
  zazu customers update <id> [--data json|--file path|--stdin] [--company-name value] [--email value] [--billing-address json]
  zazu customers delete <id>
`,
  entity: `Zazu CLI - entity

Usage:
  zazu entity get
`,
  invoices: `Zazu CLI - invoices

Usage:
  zazu invoices list [--status value] [--customer-id id] [--limit n] [--cursor value] [--all|--max-items n]
  zazu invoices get <id>
  zazu invoices create [--data json|--file path|--stdin] [invoice flags]
  zazu invoices update <id> [--data json|--file path|--stdin] [invoice flags]
  zazu invoices send <id>
  zazu invoices mark-as-paid <id>
  zazu invoices cancel <id>
  zazu invoices credit-note <id>
  zazu invoices delete <id>
  zazu invoices payment-link <id> --account-id <account-id>
`,
  login: `Zazu CLI - login

Usage:
  zazu login [--api-key-stdin] [--base-url <url>]

Use zazu login for an interactive hidden prompt, or pipe a key with --api-key-stdin for scripts.
`,
  logout: `Zazu CLI - logout

Usage:
  zazu logout
`,
  "payment-links": `Zazu CLI - payment-links

Usage:
  zazu payment-links list [--status value] [--link-type value] [--limit n] [--cursor value] [--all|--max-items n]
  zazu payment-links get <id>
  zazu payment-links create [--data json|--file path|--stdin] [--account-id id] [--amount amount] [--description text] [--payment-reference ref]
  zazu payment-links cancel <id>
`,
  transfers: `Zazu CLI - transfers

Creating a transfer never executes it by itself. A draft inside your
machine-authorization envelope (trusted payee, within limits) is sent to
the enrolled authorizer as a payment.authorization_requested webhook;
answer it with \`authorize\` or \`decline\`, using an API key other than
the one that created the draft. Every other draft goes to the in-app
approval flow. Poll \`get\` (requested → processing → completed/failed)
or use the transfer.executed webhook.

\`sign\` computes the authorization signature locally. It reads the
signing secret from the environment variable named by --secret-env and
never takes the secret as an argument. Pass --amount exactly as the API
returns it (e.g. "2500.0", not "2500"), or the signature will not match.

Usage:
  zazu transfers create [--data json|--file path|--stdin] [--account-id id] [--beneficiary-id id|--destination-account-id id] [--amount amount] [--payment-reference ref] [--external-account-id id] [--currency-code code] [--internal-notes text] [--client-reference ref]
  zazu transfers get <id>
  zazu transfers authorize <id> --authorization-id <id> --signature <hex>
  zazu transfers decline <id> --authorization-id <id> [--reason text]
  zazu transfers sign --secret-env <VAR> --payment-id <id> --nonce <nonce> --amount <decimal> --currency-code <code> --account-id <id> (--external-account-id <id>|--destination-account-id <id>) [--client-reference ref]
`,
  beneficiaries: `Zazu CLI - beneficiaries

Saved transfer recipients and their bank accounts. There is no update or
delete via the API.

Usage:
  zazu beneficiaries list [--limit n] [--cursor value] [--all|--max-items n]
  zazu beneficiaries get <id>
  zazu beneficiaries create [--data json|--file path|--stdin] [--beneficiary-type individual|business] [--person-name value] [--company-name value] [--email value] [--phone-number value]
  zazu beneficiaries accounts list <beneficiary-id> [--limit n] [--cursor value] [--all|--max-items n]
  zazu beneficiaries accounts get <beneficiary-id> <account-id>
  zazu beneficiaries accounts create <beneficiary-id> [--data json|--file path|--stdin] [--account-number value] [--name value] [--country-code value] [--currency-code value] [--account-type bank] [--bank-identifier value]
`,
  "payee-trust-requests": `Zazu CLI - payee-trust-requests

Ask to trust payees for machine-authorized transfers. A member with
payment-authorize permission approves the request in the app.

Usage:
  zazu payee-trust-requests create --external-account-id <id> [--external-account-id <id> ...]
  zazu payee-trust-requests get <id>
`,
  request: `Zazu CLI - request

Usage:
  zazu request <method> <path> [--data json|--file path|--stdin] [--query key=value]
`,
  status: `Zazu CLI - status

Usage:
  zazu status
`,
  transactions: `Zazu CLI - transactions

Usage:
  zazu transactions list --account-id <account-id> [--operation value] [--posted-after time] [--posted-before time] [--limit n] [--cursor value] [--all|--max-items n]
  zazu transactions get --account-id <account-id> <transaction-id>
`,
  "webhook-endpoints": `Zazu CLI - webhook-endpoints

Usage:
  zazu webhook-endpoints list [--limit n] [--cursor value] [--all|--max-items n]
  zazu webhook-endpoints get <id>
  zazu webhook-endpoints create [--data json|--file path|--stdin] [--url url] [--description text] [--event value]
  zazu webhook-endpoints update <id> [--data json|--file path|--stdin] [--url url] [--description text] [--event value]
  zazu webhook-endpoints delete <id>
  zazu webhook-endpoints test <id>
  zazu webhook-endpoints regenerate-secret <id>
  zazu webhook-endpoints enable <id>
  zazu webhook-endpoints disable <id>
`,
};

class CliError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.globals.version) {
    console.log(CLI_VERSION);
    return;
  }

  if (parsed.globals.help) {
    console.log(helpFor(parsed.positionals));
    return;
  }

  if (parsed.positionals.length === 0) {
    console.log(HELP);
    return;
  }

  if (isLocalCommand(parsed.positionals[0])) {
    // Recovery commands (login/logout/config) must work even if the
    // stored config is corrupted — that's exactly when you need them.
    const storedConfig = await loadStoredConfig({ ignoreInvalid: true });
    await runLocalCommand(parsed, storedConfig);
    return;
  }

  const storedConfig = await loadStoredConfig();

  const config = {
    apiKey: parsed.globals["api-key"] || process.env.ZAZU_API_KEY || storedConfig.api_key || "",
    baseURL: stripTrailingSlash(
      parsed.globals["base-url"] ||
        process.env.ZAZU_BASE_URL ||
        storedConfig.base_url ||
        DEFAULT_BASE_URL,
    ),
    apiVersion:
      parsed.globals["api-version"] || process.env.ZAZU_VERSION || storedConfig.api_version || "",
    requestTimeoutMs: parseOptionalPositiveInteger(
      parsed.globals["timeout-ms"] || process.env.ZAZU_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS,
      "timeout-ms",
    ),
    output: outputFormat(parsed.globals),
    quiet: Boolean(parsed.globals.quiet),
    debug: Boolean(parsed.globals.debug),
  };

  if (!FORMATS.has(config.output)) {
    throw new CliError(`Invalid output format "${config.output}". Use json, pretty, or raw.`);
  }

  if (isTransferResource(parsed.positionals[0]) && parsed.positionals[1] === "sign") {
    await signTransferAuthorization(parsed.flags, config);
    return;
  }

  const request = buildRequest(parsed.positionals, parsed.flags);
  await send(config, request);
}

function helpFor(positionals) {
  return COMMAND_HELP[positionals[0]] || HELP;
}

function parseArgs(argv) {
  const globals: Record<string, unknown> = {};
  const flags: Record<string, unknown> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (!token.startsWith("--") || token === "-") {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const eq = raw.indexOf("=");
    const key = kebab(raw.slice(0, eq === -1 ? raw.length : eq));
    let value = eq === -1 ? undefined : raw.slice(eq + 1);

    if (value === undefined && BOOLEAN_FLAGS.has(key)) {
      value = true;
    } else if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        throw new CliError(`Missing value for --${key}.`);
      }
    }

    const target = GLOBAL_FLAGS.has(key) ? globals : flags;
    if (target[key] === undefined) {
      target[key] = value;
    } else if (Array.isArray(target[key])) {
      target[key].push(value);
    } else {
      target[key] = [target[key], value];
    }
  }

  return { globals, flags, positionals };
}

function buildRequest(positionals, flags) {
  const [resource, command, arg] = positionals;

  switch (resource) {
    case "status":
      return { method: "GET", path: "/api/entity" };
    case "entity":
      requireCommand(command, "get", "entity");
      return { method: "GET", path: "/api/entity" };
    case "accounts":
      return accountRequest(positionals.slice(1), flags);
    case "transactions":
      return transactionRequest(command, arg, flags);
    case "customers":
      return customerRequest(command, arg, flags);
    case "invoices":
      return invoiceRequest(command, arg, flags);
    case "payment-links":
    case "payment_links":
      return paymentLinkRequest(command, arg, flags);
    case "transfers":
    case "transfer-drafts":
    case "transfer_drafts":
      return transferDraftRequest(command, arg, flags);
    case "beneficiaries":
      return beneficiaryRequest(positionals.slice(1), flags);
    case "payee-trust-requests":
    case "payee_trust_requests":
      return payeeTrustRequestRequest(command, arg, flags);
    case "webhook-endpoints":
    case "webhook_endpoints":
      return webhookEndpointRequest(command, arg, flags);
    case "checkout-sessions":
    case "checkout_sessions":
      return checkoutSessionRequest(command, arg, flags);
    case "request":
      return rawRequest(positionals.slice(1), flags);
    default:
      throw new CliError(`Unknown command "${resource}". Run zazu --help.`);
  }
}

function accountRequest(args, flags) {
  const [command, id, transactionId] = args;

  switch (command) {
    case "list":
      return listRequest(
        "/api/accounts",
        pick(flags, ["status", "currency-code", "cursor", "limit"]),
        flags,
      );
    case "get":
      requireValue(id, "account id");
      return { method: "GET", path: `/api/accounts/${encodeURIComponent(id)}` };
    case "transactions":
      requireValue(id, "account id");
      return listRequest(
        `/api/accounts/${encodeURIComponent(id)}/transactions`,
        pick(flags, ["operation", "posted-after", "posted-before", "cursor", "limit"]),
        flags,
      );
    case "transaction":
      requireValue(id, "account id");
      requireValue(transactionId, "transaction id");
      return {
        method: "GET",
        path: `/api/accounts/${encodeURIComponent(id)}/transactions/${encodeURIComponent(transactionId)}`,
      };
    default:
      throw new CliError("Usage: zazu accounts list|get|transactions|transaction");
  }
}

function transactionRequest(command, id, flags) {
  const accountId = flags["account-id"];
  requireValue(accountId, "account id. Use --account-id <id>");

  switch (command) {
    case "list":
      return listRequest(
        `/api/accounts/${encodeURIComponent(accountId)}/transactions`,
        pick(flags, ["operation", "posted-after", "posted-before", "cursor", "limit"]),
        flags,
      );
    case "get":
      requireValue(id, "transaction id");
      return {
        method: "GET",
        path: `/api/accounts/${encodeURIComponent(accountId)}/transactions/${encodeURIComponent(id)}`,
      };
    default:
      throw new CliError("Usage: zazu transactions list|get --account-id <account-id>");
  }
}

function customerRequest(command, id, flags) {
  switch (command) {
    case "list":
      return listRequest("/api/customers", pick(flags, ["q", "cursor", "limit"]), flags);
    case "get":
      requireValue(id, "customer id");
      return { method: "GET", path: `/api/customers/${encodeURIComponent(id)}` };
    case "create":
      return {
        method: "POST",
        path: "/api/customers",
        body: bodyFromFlags(flags, customerBody(flags)),
      };
    case "update":
      requireValue(id, "customer id");
      return {
        method: "PATCH",
        path: `/api/customers/${encodeURIComponent(id)}`,
        body: bodyFromFlags(flags, customerBody(flags)),
      };
    case "delete":
      requireValue(id, "customer id");
      return { method: "DELETE", path: `/api/customers/${encodeURIComponent(id)}` };
    default:
      throw new CliError("Usage: zazu customers list|get|create|update|delete");
  }
}

function invoiceRequest(command, id, flags) {
  switch (command) {
    case "list":
      return listRequest(
        "/api/invoices",
        pick(flags, ["status", "customer-id", "cursor", "limit"]),
        flags,
      );
    case "get":
      requireValue(id, "invoice id");
      return { method: "GET", path: `/api/invoices/${encodeURIComponent(id)}` };
    case "create":
      return {
        method: "POST",
        path: "/api/invoices",
        body: bodyFromFlags(flags, invoiceBody(flags)),
      };
    case "update":
      requireValue(id, "invoice id");
      return {
        method: "PATCH",
        path: `/api/invoices/${encodeURIComponent(id)}`,
        body: bodyFromFlags(flags, invoiceBody(flags)),
      };
    case "send":
      requireValue(id, "invoice id");
      return { method: "POST", path: `/api/invoices/${encodeURIComponent(id)}/send` };
    case "mark-as-paid":
    case "mark_as_paid":
      requireValue(id, "invoice id");
      return { method: "POST", path: `/api/invoices/${encodeURIComponent(id)}/mark_as_paid` };
    case "cancel":
      requireValue(id, "invoice id");
      return { method: "POST", path: `/api/invoices/${encodeURIComponent(id)}/cancel` };
    case "credit-note":
    case "credit_note":
      requireValue(id, "invoice id");
      return { method: "POST", path: `/api/invoices/${encodeURIComponent(id)}/credit_note` };
    case "delete":
      requireValue(id, "invoice id");
      return { method: "DELETE", path: `/api/invoices/${encodeURIComponent(id)}` };
    case "payment-link":
    case "payment_link":
      requireValue(id, "invoice id");
      return {
        method: "POST",
        path: `/api/invoices/${encodeURIComponent(id)}/payment_link`,
        body: bodyFromFlags(flags, pick(flags, ["account-id"])),
      };
    default:
      throw new CliError(
        "Usage: zazu invoices list|get|create|update|send|mark-as-paid|cancel|credit-note|delete|payment-link",
      );
  }
}

function paymentLinkRequest(command, id, flags) {
  switch (command) {
    case "list":
      return listRequest(
        "/api/payment_links",
        pick(flags, ["status", "link-type", "cursor", "limit"]),
        flags,
      );
    case "get":
      requireValue(id, "payment link id");
      return { method: "GET", path: `/api/payment_links/${encodeURIComponent(id)}` };
    case "create":
      return {
        method: "POST",
        path: "/api/payment_links",
        body: bodyFromFlags(flags, paymentLinkBody(flags)),
      };
    case "cancel":
      requireValue(id, "payment link id");
      return { method: "POST", path: `/api/payment_links/${encodeURIComponent(id)}/cancel` };
    default:
      throw new CliError("Usage: zazu payment-links list|get|create|cancel");
  }
}

// Transfers, beneficiaries, and payee trust requests call the typed SDK
// resource methods through `call`; `method`/`path` stay for --debug.
function transferDraftRequest(command, id, flags) {
  switch (command) {
    case "create":
      return {
        method: "POST",
        path: "/api/transfer_drafts",
        body: bodyFromFlags(flags, transferDraftBody(flags)),
        call: (client: Zazu, { body }) => client.transferDrafts.create(body),
      };
    case "get":
      requireValue(id, "transfer draft id");
      return {
        method: "GET",
        path: `/api/transfer_drafts/${encodeURIComponent(id)}`,
        call: (client: Zazu) => client.transferDrafts.get(id),
      };
    case "authorize": {
      requireValue(id, "transfer draft id");
      const authorizationId = flags["authorization-id"];
      const signature = flags.signature;
      requireValue(authorizationId, "authorization id. Use --authorization-id <id>");
      requireValue(signature, "signature. Use --signature <hex>");
      return {
        method: "POST",
        path: `/api/transfer_drafts/${encodeURIComponent(id)}/authorize`,
        call: (client: Zazu) =>
          client.transferDrafts.authorize(id, {
            authorization_id: String(authorizationId),
            signature: String(signature),
          }),
      };
    }
    case "decline": {
      requireValue(id, "transfer draft id");
      const authorizationId = flags["authorization-id"];
      requireValue(authorizationId, "authorization id. Use --authorization-id <id>");
      const reason = flags.reason === undefined ? undefined : String(flags.reason);
      return {
        method: "POST",
        path: `/api/transfer_drafts/${encodeURIComponent(id)}/decline`,
        call: (client: Zazu) =>
          client.transferDrafts.decline(id, { authorization_id: String(authorizationId), reason }),
      };
    }
    default:
      throw new CliError("Usage: zazu transfers create|get|authorize|decline|sign");
  }
}

function beneficiaryRequest(args, flags) {
  const [command, id] = args;

  switch (command) {
    case "list":
      return {
        ...listRequest("/api/beneficiaries", pick(flags, ["cursor", "limit"]), flags),
        call: (client: Zazu, { query }) => client.beneficiaries.list(listParams(query)),
      };
    case "get":
      requireValue(id, "beneficiary id");
      return {
        method: "GET",
        path: `/api/beneficiaries/${encodeURIComponent(id)}`,
        call: (client: Zazu) => client.beneficiaries.get(id),
      };
    case "create":
      return {
        method: "POST",
        path: "/api/beneficiaries",
        body: bodyFromFlags(flags, beneficiaryBody(flags)),
        call: (client: Zazu, { body }) => client.beneficiaries.create(body),
      };
    case "accounts":
    case "external-accounts":
    case "external_accounts":
      return beneficiaryAccountRequest(args.slice(1), flags);
    default:
      throw new CliError("Usage: zazu beneficiaries list|get|create|accounts");
  }
}

function beneficiaryAccountRequest(args, flags) {
  const [command, beneficiaryId, id] = args;
  const basePath = `/api/beneficiaries/${encodeURIComponent(beneficiaryId)}/external_accounts`;

  switch (command) {
    case "list":
      requireValue(beneficiaryId, "beneficiary id");
      return {
        ...listRequest(basePath, pick(flags, ["cursor", "limit"]), flags),
        call: (client: Zazu, { query }) =>
          client.beneficiaries.listExternalAccounts(beneficiaryId, listParams(query)),
      };
    case "get":
      requireValue(beneficiaryId, "beneficiary id");
      requireValue(id, "external account id");
      return {
        method: "GET",
        path: `${basePath}/${encodeURIComponent(id)}`,
        call: (client: Zazu) => client.beneficiaries.getExternalAccount(beneficiaryId, id),
      };
    case "create":
      requireValue(beneficiaryId, "beneficiary id");
      return {
        method: "POST",
        path: basePath,
        body: bodyFromFlags(flags, externalAccountBody(flags)),
        call: (client: Zazu, { body }) =>
          client.beneficiaries.createExternalAccount(beneficiaryId, body),
      };
    default:
      throw new CliError("Usage: zazu beneficiaries accounts list|get|create <beneficiary-id>");
  }
}

function payeeTrustRequestRequest(command, id, flags) {
  switch (command) {
    case "create": {
      const externalAccountIds = arrayify(flags["external-account-id"]).map(String);
      requireValue(externalAccountIds[0], "external account id. Use --external-account-id <id>");
      return {
        method: "POST",
        path: "/api/payee_trust_requests",
        call: (client: Zazu) =>
          client.payeeTrustRequests.create({ external_account_ids: externalAccountIds }),
      };
    }
    case "get":
      requireValue(id, "payee trust request id");
      return {
        method: "GET",
        path: `/api/payee_trust_requests/${encodeURIComponent(id)}`,
        call: (client: Zazu) => client.payeeTrustRequests.get(id),
      };
    default:
      throw new CliError("Usage: zazu payee-trust-requests create|get");
  }
}

// The SDK's list methods take a numeric limit; flags arrive as strings.
function listParams(query) {
  return {
    limit: query?.limit === undefined ? undefined : Number(query.limit),
    cursor: query?.cursor,
  };
}

function webhookEndpointRequest(command, id, flags) {
  switch (command) {
    case "list":
      return listRequest("/api/webhook_endpoints", pick(flags, ["cursor", "limit"]), flags);
    case "get":
      requireValue(id, "webhook endpoint id");
      return { method: "GET", path: `/api/webhook_endpoints/${encodeURIComponent(id)}` };
    case "create":
      return {
        method: "POST",
        path: "/api/webhook_endpoints",
        body: bodyFromFlags(flags, webhookEndpointBody(flags)),
      };
    case "update":
      requireValue(id, "webhook endpoint id");
      return {
        method: "PATCH",
        path: `/api/webhook_endpoints/${encodeURIComponent(id)}`,
        body: bodyFromFlags(flags, webhookEndpointBody(flags)),
      };
    case "delete":
      requireValue(id, "webhook endpoint id");
      return { method: "DELETE", path: `/api/webhook_endpoints/${encodeURIComponent(id)}` };
    case "test":
      requireValue(id, "webhook endpoint id");
      return { method: "POST", path: `/api/webhook_endpoints/${encodeURIComponent(id)}/test` };
    case "regenerate-secret":
    case "regenerate_secret":
    case "rotate-secret":
    case "rotate_secret":
      requireValue(id, "webhook endpoint id");
      return {
        method: "POST",
        path: `/api/webhook_endpoints/${encodeURIComponent(id)}/regenerate_secret`,
      };
    case "enable":
      requireValue(id, "webhook endpoint id");
      return { method: "POST", path: `/api/webhook_endpoints/${encodeURIComponent(id)}/enable` };
    case "disable":
      requireValue(id, "webhook endpoint id");
      return { method: "POST", path: `/api/webhook_endpoints/${encodeURIComponent(id)}/disable` };
    default:
      throw new CliError(
        "Usage: zazu webhook-endpoints list|get|create|update|delete|test|regenerate-secret|enable|disable",
      );
  }
}

function checkoutSessionRequest(command, id, flags) {
  switch (command) {
    case "get":
      requireValue(id, "checkout session id");
      return { method: "GET", path: `/api/checkout_sessions/${encodeURIComponent(id)}` };
    case "create":
      return {
        method: "POST",
        path: "/api/checkout_sessions",
        body: bodyFromFlags(flags, checkoutSessionBody(flags)),
      };
    default:
      throw new CliError("Usage: zazu checkout-sessions create|get");
  }
}

function listRequest(pathValue, query, flags) {
  const maxItems = parseOptionalPositiveInteger(flags["max-items"], "max-items");
  const all = Boolean(flags.all) || maxItems !== undefined;
  const pageLimit = parseOptionalPositiveInteger(query.limit, "limit");
  const nextQuery = { ...query };

  if (all && pageLimit === undefined) {
    nextQuery.limit = maxItems === undefined ? LIST_PAGE_SIZE : Math.min(maxItems, LIST_PAGE_SIZE);
  }

  return {
    method: "GET",
    path: pathValue,
    query: nextQuery,
    paginate: all,
    maxItems,
    pageLimit,
  };
}

function rawRequest(args, flags) {
  const [method, path] = args;
  requireValue(method, "HTTP method");
  requireValue(path, "request path");

  return {
    method: method.toUpperCase(),
    path: path.startsWith("/") ? path : `/${path}`,
    query: queryPairs(flags.query),
    body: bodyFromFlags(flags, {}),
  };
}

function customerBody(flags) {
  const body = pick(flags, [
    "person-name",
    "company-name",
    "email",
    "phone",
    "tax-id",
    "ice-number",
    "customer-type",
  ]);

  if (flags["billing-address"] !== undefined) {
    body.billing_address = parseMaybeJSON(flags["billing-address"], "billing-address");
  }

  return body;
}

function invoiceBody(flags) {
  const body = pick(flags, [
    "customer-id",
    "currency-code",
    "issue-date",
    "due-date",
    "reference",
    "notes",
    "payment-terms",
    "send-to-email",
  ]);

  if (flags.item !== undefined) {
    body.items = parseArrayJSON(flags.item, "item");
  }
  if (flags.discount !== undefined) {
    body.discounts = parseArrayJSON(flags.discount, "discount");
  }

  return body;
}

function paymentLinkBody(flags) {
  return pick(flags, [
    "account-id",
    "amount",
    "title",
    "description",
    "payment-reference",
    "expires-at",
    "link-type",
    "redirect-url",
    "max-payments",
  ]);
}

function transferDraftBody(flags) {
  return pick(flags, [
    "account-id",
    "beneficiary-id",
    "external-account-id",
    "destination-account-id",
    "amount",
    "currency-code",
    "payment-reference",
    "internal-notes",
    "client-reference",
  ]);
}

function beneficiaryBody(flags) {
  return pick(flags, ["beneficiary-type", "person-name", "company-name", "email", "phone-number"]);
}

function externalAccountBody(flags) {
  return pick(flags, [
    "account-number",
    "name",
    "country-code",
    "currency-code",
    "account-type",
    "bank-identifier",
  ]);
}

function webhookEndpointBody(flags) {
  const body = pick(flags, ["url", "description"]);

  if (flags.event !== undefined && flags.events !== undefined) {
    throw new CliError("Use only one of --event or --events.");
  }

  if (flags.event !== undefined) {
    body.events = arrayify(flags.event).map((event) => String(event));
  } else if (flags.events !== undefined) {
    body.events = parseStringList(flags.events, "events");
  }

  return body;
}

function checkoutSessionBody(flags) {
  const body = pick(flags, [
    "account-id",
    "amount",
    "currency-code",
    "success-url",
    "cancel-url",
    "description",
    "customer-email",
  ]);

  if (flags.metadata !== undefined) {
    body.metadata = parseJSON(flags.metadata, "metadata");
  }

  return body;
}

function pick(flags, names): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    if (flags[name] !== undefined) {
      out[snake(name)] = coerceValue(flags[name]);
    }
  }
  return out;
}

function queryPairs(value) {
  const values = arrayify(value);
  const query: Record<string, string> = {};
  for (const item of values) {
    if (item === undefined) continue;
    const text = String(item);
    const eq = text.indexOf("=");
    if (eq === -1) {
      throw new CliError(`Invalid --query "${text}". Use key=value.`);
    }
    query[text.slice(0, eq)] = text.slice(eq + 1);
  }
  return query;
}

async function bodyFromFlags(flags, body) {
  let base = {};
  const bodySources = ["data", "file", "stdin"].filter((name) => flags[name] !== undefined);
  if (bodySources.length > 1) {
    throw new CliError("Use only one of --data, --file, or --stdin.");
  }

  if (flags.data !== undefined) {
    base = parseJSON(flags.data, "data");
  } else if (flags.file !== undefined) {
    base = parseJSON(await fs.readFile(flags.file, "utf8"), flags.file);
  } else if (flags.stdin !== undefined) {
    base = parseJSON(await readStdin(), "stdin");
  }

  if (!isObject(base)) {
    throw new CliError("Request body must be a JSON object.");
  }

  return { ...base, ...body };
}

async function send(config, request) {
  if (!config.apiKey) {
    throw new CliError("Missing API key. Run `zazu login`, set ZAZU_API_KEY, or pass --api-key.");
  }

  if (request.paginate) {
    await sendPaginated(config, request);
    return;
  }

  try {
    const sdkResponse = await fetchRequest(config, request);
    printOutput(sdkResponse.body, config);
  } catch (error) {
    handleSendError(error, config);
  }
}

async function sendPaginated(config, request) {
  // Per-page size: caller's --limit if given, otherwise the SDK page cap.
  const requestedLimit = parseOptionalPositiveInteger(request.query?.limit, "limit");
  const pageLimit = requestedLimit ?? request.pageLimit ?? LIST_PAGE_SIZE;

  // The fetcher closure adapts each page's limit to what's still
  // needed. When --max-items is set, the last page's request shrinks
  // so the API doesn't return more rows than we'll keep.
  const baseQuery = { ...(request.query || {}), limit: pageLimit };
  delete baseQuery.cursor;
  const initialCursor = request.query?.cursor ?? null;
  const data: unknown[] = [];

  const fetchPage = async (cursor: string | null): Promise<Page<unknown>> => {
    const query: Record<string, unknown> = { ...baseQuery };
    if (cursor) query.cursor = cursor;
    if (request.maxItems !== undefined) {
      const remaining = request.maxItems - data.length;
      query.limit = Math.min(pageLimit, Math.max(remaining, 1), LIST_PAGE_SIZE);
    }
    const response = await fetchRequest(config, { ...request, query });
    return new Page<unknown>(response as never, fetchPage);
  };

  let firstPage: Page<unknown>;
  try {
    firstPage = await fetchPage(initialCursor);
  } catch (error) {
    handleSendError(error, config);
    return;
  }

  // Walk pages with the SDK's chained `next()`, capping at maxItems.
  // We track the most recent page so the printed envelope can keep
  // any extra fields the API returned alongside data/has_more/next_cursor.
  let lastPage: Page<unknown> = firstPage;
  let truncated = false;

  let page: Page<unknown> | null = firstPage;
  while (page !== null) {
    lastPage = page;
    for (const item of page.data) {
      if (request.maxItems !== undefined && data.length >= request.maxItems) break;
      data.push(item);
    }
    if (request.maxItems !== undefined && data.length >= request.maxItems) {
      // Cap reached on this page — stop without fetching the next.
      truncated = page.hasMore;
      break;
    }
    try {
      page = await page.next();
    } catch (error) {
      handleSendError(error, config);
      return;
    }
  }

  // Output envelope mirrors the previous shape: spread the last page's
  // raw body so any extra API fields survive, then override data,
  // has_more, and next_cursor to reflect aggregated state.
  const lastBody = (lastPage.response.body ?? {}) as PageBody<unknown> & Record<string, unknown>;
  printOutput(
    {
      ...lastBody,
      data,
      has_more: truncated,
      next_cursor: truncated ? lastPage.nextCursor : null,
    },
    config,
  );
}

// Handle errors from any fetchRequest call uniformly: SDK errors with
// a status code go through printError; connection/configuration errors
// surface as CliError; unknown errors rethrow so we can see the stack.
function handleSendError(error: unknown, config): void {
  if (error instanceof ZazuError && error.status !== undefined) {
    printError(error, config.output);
    process.exitCode = 1;
    return;
  }
  if (error instanceof ZazuError) {
    throw new CliError(error.message);
  }
  throw error;
}

// HTTP transport via @getzazu/sdk. The SDK handles auth headers, JSON
// serialization, AbortController-based timeouts, and the 9-class error
// hierarchy — we just thread arguments through and let it throw on
// non-2xx, which our send/sendPaginated catch.
//
// One Zazu client cached per (apiKey, baseURL, apiVersion, timeout)
// tuple so paginated calls don't re-instantiate.
let cachedClient: Zazu | null = null;
let cachedClientKey: string | null = null;

function clientFor(config): Zazu {
  const key = [
    config.baseURL,
    config.apiKey,
    config.apiVersion ?? "",
    config.requestTimeoutMs,
  ].join("|");
  if (cachedClient && cachedClientKey === key) return cachedClient;
  cachedClient = new Zazu({
    apiKey: config.apiKey,
    baseUrl: config.baseURL,
    apiVersion: config.apiVersion ?? undefined,
    timeoutMs: config.requestTimeoutMs,
  });
  cachedClientKey = key;
  return cachedClient;
}

function normalizePath(value: string): string {
  if (value.startsWith("/api/") || value === "/api") return value;
  return `/api${value.startsWith("/") ? value : `/${value}`}`;
}

async function fetchRequest(config, request) {
  const path = normalizePath(request.path);
  const resolvedBody = request.body instanceof Promise ? await request.body : request.body;
  const hasBody =
    resolvedBody && typeof resolvedBody === "object" && Object.keys(resolvedBody).length > 0;

  if (config.debug) {
    const url = buildURL(config.baseURL, request.path, request.query);
    console.error(`${request.method} ${url.toString()}`);
  }

  if (request.call) {
    const result = await request.call(clientFor(config), {
      query: request.query,
      body: resolvedBody ?? {},
    });
    return result instanceof Page ? (result.response as ZazuResponse) : result;
  }

  const opts: RequestOptions = { params: request.query };
  if (hasBody) opts.body = resolvedBody;

  return clientFor(config).request(request.method, path, opts);
}

async function signTransferAuthorization(flags, config) {
  if (flags.secret !== undefined) {
    throw new CliError(
      "Never pass the signing secret as an argument. Put it in an environment variable and use --secret-env <VAR>.",
    );
  }

  const secretEnv = flags["secret-env"];
  requireValue(secretEnv, "secret env var. Use --secret-env <VAR>");
  const secret = process.env[String(secretEnv)];
  if (!secret) {
    throw new CliError(`Environment variable ${secretEnv} is not set.`);
  }

  for (const name of ["payment-id", "nonce", "amount", "currency-code", "account-id"]) {
    requireValue(flags[name], `--${name}`);
  }

  try {
    const signatureInput = TransferAuthorization.signatureInput({
      payment_id: String(flags["payment-id"]),
      nonce: String(flags.nonce),
      amount: String(flags.amount),
      currency_code: String(flags["currency-code"]),
      account_id: String(flags["account-id"]),
      payee: TransferAuthorization.payeeFor({
        external_account_id: optionalString(flags["external-account-id"]),
        destination_account_id: optionalString(flags["destination-account-id"]),
      }),
      client_reference: optionalString(flags["client-reference"]),
    });
    const signature = await TransferAuthorization.sign({ secret, signature_input: signatureInput });
    printOutput({ signature, signature_input: signatureInput }, config);
  } catch (error) {
    if (error instanceof ZazuError) throw new CliError(error.message);
    throw error;
  }
}

function optionalString(value) {
  return value === undefined ? undefined : String(value);
}

function buildURL(baseURL, path, query = {}) {
  const normalizedPath =
    path.startsWith("/api/") || path === "/api"
      ? path
      : `/api${path.startsWith("/") ? path : `/${path}`}`;
  const url = new URL(normalizedPath, `${baseURL}/`);

  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function printOutput(value, config) {
  if (config.quiet) {
    return;
  }

  if (value === "" || value === undefined || value === null) {
    return;
  }

  if (config.output === "raw") {
    console.log(typeof value === "string" ? value : JSON.stringify(value));
    return;
  }

  console.log(JSON.stringify(value, null, config.output === "pretty" ? 2 : 0));
}

function printError(error: ZazuError, format) {
  const body = error.body;
  if (format === "raw") {
    if (typeof body === "string") {
      console.error(body);
    } else if (body == null && typeof error.message === "string") {
      console.error(error.message);
    } else {
      console.error(JSON.stringify(body ?? error.message));
    }
    return;
  }

  const payload: Record<string, unknown> = isObject(body)
    ? { ...body }
    : { error: { message: error.message, type: error.type, param: error.param } };
  payload.status = error.status;
  if (error instanceof ZazuConflictError && error.paymentId) payload.payment_id = error.paymentId;
  if (error.requestId) payload.request_id = error.requestId;
  const zazuVersion = error.headers?.get("zazu-version");
  if (zazuVersion) payload.zazu_version = zazuVersion;
  console.error(JSON.stringify(payload, null, format === "pretty" ? 2 : 0));
}

function parseArrayJSON(value, label) {
  return arrayify(value).map((item) => parseJSON(item, label));
}

function parseStringList(value, label) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseStringList(item, label));
  }

  const text = String(value);
  if (text.trim().startsWith("[")) {
    const parsed = parseJSON(text, label);
    if (!Array.isArray(parsed)) {
      throw new CliError(`Invalid JSON for ${label}: expected an array.`);
    }
    return parsed.map((item) => String(item));
  }

  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMaybeJSON(value, label) {
  if (value === "null") return null;
  return parseJSON(value, label);
}

function parseJSON(value, label) {
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new CliError(`Invalid JSON for ${label}: ${error.message}`);
  }
}

function parseOptionalPositiveInteger(value, label) {
  if (value === undefined) return undefined;
  if (value === true) {
    throw new CliError(`Missing value for --${label}.`);
  }

  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new CliError(`Invalid --${label} "${value}". Use a positive integer.`);
  }

  return number;
}

function coerceValue(value) {
  if (Array.isArray(value)) {
    return value.map(coerceValue);
  }
  if (value === true) {
    return true;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  return value;
}

async function readStdin({ requirePipe = false } = {}): Promise<string> {
  if (process.stdin.isTTY) {
    if (requirePipe) {
      throw new CliError(
        "No stdin input detected. Pipe the API key into `zazu login --api-key-stdin`.",
      );
    }

    throw new CliError("Unable to read stdin.");
  }

  process.stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let data = "";

    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
    process.stdin.on("error", (error) => {
      reject(new CliError(`Unable to read stdin: ${error.message}`));
    });
  });
}

async function promptSecret(label) {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    typeof process.stdin.setRawMode !== "function"
  ) {
    throw new CliError(
      `Cannot prompt for ${label} in a non-interactive shell. Use --api-key-stdin.`,
    );
  }

  const stdin = process.stdin;
  const previousRawMode = stdin.isRaw;

  return new Promise((resolve, reject) => {
    let value = "";

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(previousRawMode);
      stdin.pause();
    };

    const finish = () => {
      cleanup();
      process.stdout.write("\n");
      resolve(value.trim());
    };

    const cancel = () => {
      cleanup();
      process.stdout.write("\n");
      reject(new CliError("Login cancelled.", 130));
    };

    const onData = (chunk) => {
      const text = chunk.toString("utf8");

      for (const char of text) {
        if (char === "\u0003") {
          cancel();
          return;
        }

        if (char === "\r" || char === "\n") {
          finish();
          return;
        }

        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }

        value += char;
      }
    };

    process.stdout.write(`${label}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function validateApiKey(apiKey) {
  if (!apiKey.startsWith("sk_live_") && !apiKey.startsWith("sk_test_")) {
    throw new CliError("API key must start with sk_live_ or sk_test_.");
  }
}

function requireCommand(actual, expected, resource) {
  if (actual !== expected) {
    throw new CliError(`Usage: zazu ${resource} ${expected}`);
  }
}

function requireValue(value, label) {
  if (!value) {
    throw new CliError(`Missing ${label}.`);
  }
}

function outputFormat(globals) {
  if (globals.pretty) return "pretty";
  if (globals.json) return "json";
  return globals.output || globals.format || "json";
}

function isTransferResource(resource) {
  return ["transfers", "transfer-drafts", "transfer_drafts"].includes(resource);
}

function isLocalCommand(resource) {
  return ["login", "logout", "config"].includes(resource);
}

async function runLocalCommand(parsed, storedConfig) {
  const [resource, command, name, value] = parsed.positionals;
  const config = {
    output: outputFormat(parsed.globals),
    quiet: Boolean(parsed.globals.quiet),
  };

  if (!FORMATS.has(config.output)) {
    throw new CliError(`Invalid output format "${config.output}". Use json, pretty, or raw.`);
  }

  switch (resource) {
    case "login":
      await loginCommand(parsed, storedConfig, config);
      return;
    case "logout":
      await logoutCommand(storedConfig, config);
      return;
    case "config":
      await configCommand(command, name, value, storedConfig, config);
      return;
    default:
      throw new CliError(`Unknown command "${resource}". Run zazu --help.`);
  }
}

async function loginCommand(parsed, storedConfig, outputConfig) {
  const apiKey = await loginApiKey(parsed);
  if (!apiKey) {
    throw new CliError("Usage: zazu login [--api-key-stdin] [--base-url <url>]");
  }

  validateApiKey(apiKey);

  const nextConfig = { ...storedConfig, api_key: apiKey };
  const baseURL = parsed.globals["base-url"] || process.env.ZAZU_BASE_URL;
  if (baseURL) {
    nextConfig.base_url = stripTrailingSlash(baseURL);
  }

  await saveStoredConfig(nextConfig);
  printOutput(
    { ok: true, api_key: maskSecret(apiKey), base_url: nextConfig.base_url || DEFAULT_BASE_URL },
    outputConfig,
  );
}

async function loginApiKey(parsed) {
  if (parsed.globals["api-key-stdin"] || parsed.flags["api-key-stdin"]) {
    return (await readStdin({ requirePipe: true })).trim();
  }

  return (
    parsed.globals["api-key"] ||
    parsed.flags["api-key"] ||
    parsed.positionals[1] ||
    process.env.ZAZU_API_KEY ||
    (await promptSecret("API key"))
  );
}

async function logoutCommand(storedConfig, outputConfig) {
  const nextConfig = { ...storedConfig };
  delete nextConfig.api_key;
  await saveStoredConfig(nextConfig);
  printOutput({ ok: true }, outputConfig);
}

async function configCommand(command, name, value, storedConfig, outputConfig) {
  switch (command) {
    case "get":
    case undefined:
      printOutput(readConfigValue(storedConfig, name), outputConfig);
      return;
    case "set":
      requireValue(name, "config key");
      requireValue(value, "config value");
      await setConfigValue(storedConfig, name, value);
      printOutput(
        { ok: true, [publicConfigKey(name)]: displayConfigValue(name, value) },
        outputConfig,
      );
      return;
    case "unset":
      requireValue(name, "config key");
      await unsetConfigValue(storedConfig, name);
      printOutput({ ok: true }, outputConfig);
      return;
    default:
      throw new CliError("Usage: zazu config get|set|unset [api-key|api-base|api-version]");
  }
}

function readConfigValue(storedConfig, name) {
  if (!name) {
    return {
      api_key: storedConfig.api_key ? maskSecret(storedConfig.api_key) : null,
      api_base: storedConfig.base_url || DEFAULT_BASE_URL,
      api_version: storedConfig.api_version || null,
      config_path: storedConfigPath(),
    };
  }

  const key = normalizedConfigKey(name);
  if (key === "api_key")
    return { api_key: storedConfig.api_key ? maskSecret(storedConfig.api_key) : null };
  if (key === "base_url") return { api_base: storedConfig.base_url || DEFAULT_BASE_URL };
  if (key === "api_version") return { api_version: storedConfig.api_version || null };

  throw new CliError(`Unknown config key "${name}". Use api-key, api-base, or api-version.`);
}

async function setConfigValue(storedConfig, name, value) {
  const key = normalizedConfigKey(name);
  const nextConfig = { ...storedConfig };

  if (key === "api_key") {
    nextConfig.api_key = value;
  } else if (key === "base_url") {
    nextConfig.base_url = stripTrailingSlash(value);
  } else if (key === "api_version") {
    nextConfig.api_version = value;
  } else {
    throw new CliError(`Unknown config key "${name}". Use api-key, api-base, or api-version.`);
  }

  await saveStoredConfig(nextConfig);
}

async function unsetConfigValue(storedConfig, name) {
  const key = normalizedConfigKey(name);
  const nextConfig = { ...storedConfig };

  if (key === "api_key") {
    delete nextConfig.api_key;
  } else if (key === "base_url") {
    delete nextConfig.base_url;
  } else if (key === "api_version") {
    delete nextConfig.api_version;
  } else {
    throw new CliError(`Unknown config key "${name}". Use api-key, api-base, or api-version.`);
  }

  await saveStoredConfig(nextConfig);
}

function normalizedConfigKey(name) {
  switch (kebab(name)) {
    case "api-key":
      return "api_key";
    case "api-base":
    case "base-url":
      return "base_url";
    case "api-version":
      return "api_version";
    default:
      return name;
  }
}

function displayConfigValue(name, value) {
  return normalizedConfigKey(name) === "api_key" ? maskSecret(value) : value;
}

function publicConfigKey(name) {
  return normalizedConfigKey(name) === "base_url" ? "api_base" : normalizedConfigKey(name);
}

async function loadStoredConfig({ ignoreInvalid = false } = {}) {
  let raw: string;
  try {
    raw = await fs.readFile(storedConfigPath(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }

  try {
    return parseJSON(raw, storedConfigPath());
  } catch (error) {
    if (ignoreInvalid) return {};
    throw error;
  }
}

async function saveStoredConfig(config) {
  const filePath = storedConfigPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function storedConfigPath() {
  const root = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(root, "zazu", "config.json");
}

function maskSecret(value) {
  const text = String(value);
  if (text.length <= 12) return "********";
  return `${text.slice(0, 8)}...${text.slice(-4)}`;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function kebab(value) {
  return value.replace(/_/g, "-");
}

function snake(value) {
  return value.replace(/-/g, "_");
}

function arrayify(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

main().catch((error) => {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exit(error.exitCode);
  }

  console.error(error.stack || error.message);
  process.exit(1);
});
