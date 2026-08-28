import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  detectPageProblem,
  isAuthenticatedDashboard,
  isSellingStatus,
  parseEventDashboard,
  parseOrganizationEvents,
} from "../src/kktix-parsers.js";

const fixtures = new URL("./fixtures/", import.meta.url);

test("parseOrganizationEvents extracts events, metadata, and pagination", async () => {
  const html = await readFile(new URL("organization-events.html", fixtures), "utf8");
  const result = parseOrganizationEvents(html, "https://kktix.com/dashboard/organizations/platform/events");

  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events[0], {
    slug: "stopover-20260826",
    name: "🚉 Platform Stopover, August 2026",
    status: "已發布",
    schedule: "2026/08/26 19:00(+0800) ~ 2026/08/26 21:30(+0800)",
    dashboardUrl: "https://kktix.com/dashboard/events/stopover-20260826",
  });
  assert.equal(result.events[1].slug, "originals-20261003");
  assert.equal(result.events[1].status, "未發佈");
  assert.equal(result.nextUrl, "https://kktix.com/dashboard/organizations/platform/events?page=2");
});

test("parseOrganizationEvents excludes the dashboard create-event route", () => {
  const html = `
    <a href="/dashboard/events/new">建立活動</a>
    <article><h2>Real Event</h2><a href="/dashboard/events/real-event">活動主控台</a></article>
  `;
  const result = parseOrganizationEvents(html, "https://kktix.com/dashboard/organizations/platform/events");
  assert.deepEqual(result.events.map((event) => event.slug), ["real-event"]);
});

test("parseOrganizationEvents pairs a minor action row with its preceding event data row", () => {
  const html = `
    <table>
      <tbody>
        <tr><td>Platform Originals: Demo</td><td>2026/10/03 13:30(+0800)~16:00</td><td>Published</td></tr>
        <tr class="minor"><td><a href="/dashboard/events/demo-event">Event Dashboard</a> <a>Orders</a></td></tr>
      </tbody>
    </table>
  `;
  const result = parseOrganizationEvents(html, "https://kktix.com/dashboard/organizations/platform/events");
  assert.deepEqual(result.events[0], {
    slug: "demo-event",
    name: "Platform Originals: Demo",
    status: "Published",
    schedule: "2026/10/03 13:30(+0800)~16:00",
    dashboardUrl: "https://kktix.com/dashboard/events/demo-event",
  });
});

test("parseEventDashboard extracts ticket sales status", async () => {
  const html = await readFile(new URL("event-dashboard.html", fixtures), "utf8");
  const result = parseEventDashboard(html, "https://kktix.com/dashboard/events/originals-20261003");

  assert.equal(result.slug, "originals-20261003");
  assert.equal(result.name, "🚆 Platform Originals: 曼報");
  assert.deepEqual(result.inventory, { available: 50, sold: 3, remaining: 47 });
  assert.deepEqual(result.totalAmount, { currency: "TWD", amount: 1970, display: "TWD$1,970" });
  assert.equal(result.tickets.length, 2);
  assert.deepEqual(result.tickets[0], {
    name: "早鳥票",
    salePeriod: "~ 2026/09/20 12:00(+0800)",
    status: "販售中",
    price: { currency: "TWD", amount: 590, display: "TWD$590" },
    quantity: 30,
    unlimited: false,
    paid: 2,
    pending: 1,
    invalid: 0,
    void: 0,
  });
  assert.equal(result.currentlySelling, true);
  assert.deepEqual(result.warnings, []);
});

test("sale status detection excludes waiting and ended tickets", () => {
  assert.equal(isSellingStatus("販售中"), true);
  assert.equal(isSellingStatus("On sale"), true);
  assert.equal(isSellingStatus("尚未開賣"), false);
  assert.equal(isSellingStatus("結束販售"), false);
  assert.equal(isSellingStatus("Not available"), false);
});

test("detectPageProblem distinguishes Cloudflare, login, and permissions", () => {
  assert.equal(detectPageProblem("<title>Just a moment...</title>", "https://kktix.com/dashboard"), "cloudflare");
  assert.equal(
    detectPageProblem("<body>Verifying you are human. This may take a few seconds.</body>", "https://kktix.com/"),
    "cloudflare",
  );
  assert.equal(
    detectPageProblem('<form><input id="user_login"><input type="password"></form>', "https://kktix.com/users/sign_in"),
    "authentication",
  );
  assert.equal(detectPageProblem("<body>您沒有權限查看此頁</body>", "https://kktix.com/dashboard"), "authorization");
});

test("isAuthenticatedDashboard requires real dashboard evidence, not only a temporary dashboard URL", () => {
  const url = "https://kktix.com/dashboard/organizations/platform/events";
  assert.equal(isAuthenticatedDashboard("<html><body></body></html>", url), false);
  assert.equal(isAuthenticatedDashboard("<html><body><h1>活動列表</h1></body></html>", url), true);
  assert.equal(
    isAuthenticatedDashboard('<html><body><input type="password"></body></html>', "https://kktix.com/users/sign_in"),
    false,
  );
});
