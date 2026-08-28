import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCookieHeader } from "../src/kktix-auth.js";
import { KktixClient, toAgentBrowserState } from "../src/kktix-browser.js";

test("toAgentBrowserState creates an ephemeral state accepted by agent-browser", () => {
  const cookies = parseCookieHeader("_kktix_session=secret; __Host-device=trusted");
  const state = toAgentBrowserState(cookies);

  assert.deepEqual(state.origins, []);
  assert.deepEqual(state.cookies[0], {
    name: "_kktix_session",
    value: "secret",
    domain: ".kktix.com",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
  });
  assert.equal(state.cookies[1].domain, "kktix.com");
  assert.equal(state.cookies[1].path, "/");
});

test("authenticateState saves reusable agent-browser state and matching User-Agent securely", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "conductor-test-"));
  const authStatePath = path.join(directory, "auth-state.json");
  const client = new KktixClient({
    organization: "platform",
    cookies: [],
    headed: true,
    authStatePath,
    quiet: true,
  });
  client.started = true;
  client.readPage = async () => ({
    html: "<html><body><h1>活動列表</h1></body></html>",
    url: "https://kktix.com/dashboard/organizations/platform/events",
  });
  client.run = async (args) => {
    if (args[0] === "cookies") {
      return { cookies: [{ name: "_kktix_session", domain: ".kktix.com" }] };
    }
    if (args[0] === "eval") return { result: "Mozilla/5.0 TestChrome/1.0" };
    if (args[0] === "state" && args[1] === "save") {
      await writeFile(
        args[2],
        JSON.stringify({ cookies: [{ name: "_kktix_session", domain: ".kktix.com" }], origins: [] }),
      );
    }
    return {};
  };
  let headlessVerified = false;
  client.verifySavedStateHeadless = async () => {
    headlessVerified = true;
  };

  try {
    const result = await client.authenticateState();
    assert.equal(result.authStatePath, authStatePath);
    assert.equal(result.headlessVerified, true);
    assert.equal(headlessVerified, true);
    assert.equal((await stat(authStatePath)).mode & 0o777, 0o600);
    const metadata = JSON.parse(await readFile(`${authStatePath}.meta.json`, "utf8"));
    assert.equal(metadata.userAgent, "Mozilla/5.0 TestChrome/1.0");
    assert.equal((await stat(`${authStatePath}.meta.json`)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("auto-connect uses the existing Chrome without loading state or closing the browser", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "conductor-auto-connect-test-"));
  const executable = path.join(directory, "fake-agent-browser.mjs");
  const callsPath = path.join(directory, "calls.jsonl");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.KKTIX_TEST_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv.includes("--version")) {
  process.stdout.write("agent-browser test\\n");
} else {
  process.stdout.write(JSON.stringify({ success: true, data: { url: "https://example.com" } }) + "\\n");
}
`,
    { mode: 0o755 },
  );

  const previousCallsPath = process.env.KKTIX_TEST_CALLS;
  process.env.KKTIX_TEST_CALLS = callsPath;
  const client = new KktixClient({
    organization: "platform",
    cookies: [],
    autoConnect: true,
    authStatePath: path.join(directory, "invalid-state.json"),
    agentBrowserCommand: executable,
    externalIdleTimeoutMs: 0,
    quiet: true,
  });

  try {
    await client.start();
    assert.equal(client.agentBrowserEnvironment().AGENT_BROWSER_HOME, process.env.AGENT_BROWSER_HOME);
    client.externalTabCreated = true;
    await client.close();
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.some((args) => args.includes("--auto-connect") && args.includes("get")), true);
    assert.equal(calls.some((args) => args.includes("state")), false);
    assert.equal(
      calls.some((args) => args.includes("--auto-connect") && args.slice(-2).join(" ") === "tab close"),
      true,
    );
    assert.equal(calls.some((args) => args.at(-1) === "close" && args.at(-2) !== "tab"), false);
  } finally {
    if (previousCallsPath === undefined) delete process.env.KKTIX_TEST_CALLS;
    else process.env.KKTIX_TEST_CALLS = previousCallsPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test("auth auto-connect imports only KKTIX cookies before headless verification", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "conductor-import-test-"));
  const authStatePath = path.join(directory, "auth-state.json");
  const client = new KktixClient({
    organization: "platform",
    cookies: [],
    autoConnect: true,
    authStatePath,
    quiet: true,
  });
  client.started = true;
  client.load = async () => ({
    html: "<html><body><h1>活動列表</h1></body></html>",
    url: "https://kktix.com/dashboard/organizations/platform/events",
  });
  client.run = async (args) => {
    if (args[0] === "cookies") {
      return {
        cookies: [
          {
            name: "_kktix_session",
            value: "kktix-secret",
            domain: ".kktix.com",
            path: "/",
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
          { name: "github_session", value: "must-not-be-saved", domain: ".github.com", path: "/" },
        ],
      };
    }
    if (args[0] === "eval") return { result: "Mozilla/5.0 TestChrome/1.0" };
    return {};
  };
  let headlessVerified = false;
  client.verifySavedStateHeadless = async () => {
    headlessVerified = true;
  };

  try {
    const result = await client.authenticateState();
    const state = JSON.parse(await readFile(authStatePath, "utf8"));
    assert.equal(result.headlessVerified, true);
    assert.equal(headlessVerified, true);
    assert.equal(state.cookies.length, 1);
    assert.equal(state.cookies[0].domain, ".kktix.com");
    assert.equal(state.cookies.some((cookie) => cookie.domain.includes("github.com")), false);
    assert.deepEqual(state.origins, []);
    assert.equal((await stat(authStatePath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("listEventStatuses gets every event detail and reports individual failures", async () => {
  const client = new KktixClient({
    organization: "platform",
    cookies: [],
    eventScanDelayMs: 0,
    quiet: true,
  });
  client.started = true;
  client.listEvents = async () => [
    { slug: "event-a", name: "Event A", status: "已發布", schedule: "2026/10/01" },
    { slug: "event-b", name: "Event B", status: "未發布", schedule: "2026/11/01" },
  ];
  client.getEvent = async (slug) => {
    if (slug === "event-b") throw new Error("detail unavailable");
    return {
      slug,
      name: "KKTIX",
      schedule: null,
      inventory: { available: 10, sold: 2, remaining: 8 },
      tickets: [{ status: "In Stock" }],
      currentlySelling: true,
      warnings: [],
    };
  };

  const result = await client.listEventStatuses();
  assert.equal(result.scanned, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.events[0].name, "Event A");
  assert.equal(result.events[0].schedule, "2026/10/01");
  assert.equal(result.events[0].publicationStatus, "已發布");
  assert.deepEqual(result.failures, [{ slug: "event-b", name: "Event B", reason: "detail unavailable" }]);
});

test("listEventStatuses isolates each detail when using reusable auth state", async () => {
  const client = new KktixClient({
    organization: "platform",
    cookies: [],
    authStatePath: "/tmp/test-kktix-auth-state.json",
    eventScanDelayMs: 0,
    eventScanConcurrency: 1,
    quiet: true,
  });
  client.started = true;
  client.listEvents = async () => [
    { slug: "event-a", name: "Event A", status: "已發布", schedule: null },
    { slug: "event-b", name: "Event B", status: "已發布", schedule: null },
  ];
  let restarts = 0;
  client.restartBrowserSession = async () => {
    restarts += 1;
  };
  client.getEvent = async (slug) => ({
    slug,
    name: slug,
    schedule: null,
    inventory: { available: 1, sold: 0, remaining: 1 },
    tickets: [],
    currentlySelling: false,
    warnings: [],
  });

  const result = await client.listEventStatuses();
  assert.equal(restarts, 2);
  assert.equal(result.succeeded, 2);
});

test("getEventStatuses runs isolated headless sessions with bounded concurrency", async () => {
  const client = new KktixClient({
    organization: "platform",
    cookies: [],
    authStatePath: "/tmp/test-kktix-auth-state.json",
    eventScanConcurrency: 2,
    quiet: true,
  });
  client.started = true;
  let active = 0;
  let maxActive = 0;
  let created = 0;
  let closed = 0;
  client.createEventScanClient = () => {
    created += 1;
    return {
      async start() {},
      async getEvent(slug) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, slug === "event-a" ? 20 : 5));
        active -= 1;
        return {
          slug,
          name: slug,
          schedule: null,
          inventory: { available: 1, sold: 0, remaining: 1 },
          tickets: [],
          currentlySelling: false,
          warnings: [],
        };
      },
      async close() {
        closed += 1;
      },
    };
  };

  const candidates = [
    { slug: "event-a", name: "Event A", status: "已發布", schedule: null },
    { slug: "event-b", name: "Event B", status: "已發布", schedule: null },
    { slug: "event-c", name: "Event C", status: "已發布", schedule: null },
  ];
  const result = await client.getEventStatuses(candidates);

  assert.equal(maxActive, 2);
  assert.equal(created, 3);
  assert.equal(closed, 3);
  assert.deepEqual(result.events.map((event) => event.slug), ["event-a", "event-b", "event-c"]);
  assert.equal(result.succeeded, 3);
});

test("KktixClient rejects unsafe concurrency values", () => {
  assert.throws(
    () => new KktixClient({ organization: "platform", cookies: [], eventScanConcurrency: 9 }),
    /1 到 8/,
  );
});
