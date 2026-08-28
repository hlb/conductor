import assert from "node:assert/strict";
import test from "node:test";
import { extractKktixEventSlug, fetchUnifiedReport, mergeUnifiedReport } from "../src/report.js";

test("extractKktixEventSlug recognizes public KKTIX event URLs only", () => {
  assert.equal(
    extractKktixEventSlug("https://platform.kktix.cc/events/originals-20261003"),
    "originals-20261003",
  );
  assert.equal(extractKktixEventSlug("https://kktix.com/events/demo_event/"), "demo_event");
  assert.equal(extractKktixEventSlug("http://platform.kktix.cc/events/demo"), null);
  assert.equal(extractKktixEventSlug("https://example.com/events/demo"), null);
  assert.equal(extractKktixEventSlug("https://platform.kktix.cc/account/orders"), null);
});

test("fetchUnifiedReport uses Luma as the event list and hydrates linked KKTIX events", async () => {
  const calls = [];
  const lumaResult = sampleLumaResult();
  const lumaClient = {
    async start() {
      calls.push("luma:start");
    },
    async listEvents() {
      calls.push("luma:list");
      return lumaResult;
    },
    async close() {
      calls.push("luma:close");
    },
  };
  let candidates = null;
  const kktixClient = {
    organization: "platform",
    async start() {
      calls.push("kktix:start");
    },
    async getEventStatuses(value) {
      candidates = value;
      calls.push("kktix:statuses");
      return sampleKktixResult();
    },
    async close() {
      calls.push("kktix:close");
    },
  };

  const result = await fetchUnifiedReport({ lumaClient, kktixClient, quiet: true });
  assert.deepEqual(calls, [
    "luma:start",
    "luma:list",
    "luma:close",
    "kktix:start",
    "kktix:statuses",
    "kktix:close",
  ]);
  assert.deepEqual(candidates, [
    { slug: "kktix-demo", name: "KKTIX Demo", status: null, schedule: null },
  ]);
  assert.equal(result.count, 3);
  assert.deepEqual(result.summary, { luma: 1, kktix: 1, external: 1, failures: 0 });
  assert.equal(result.events[0].source, "luma");
  assert.deepEqual(result.events[0].registration, {
    status: "open",
    currentlyOpen: true,
    registered: 91,
    remaining: 29,
    capacity: 120,
    requireApproval: true,
    soldOut: false,
    waitlistActive: false,
  });
  assert.equal(result.events[1].source, "kktix");
  assert.equal(result.events[1].registration.registered, 4);
  assert.equal(result.events[1].registration.remaining, 116);
  assert.equal(result.events[1].registration.capacity, 120);
  assert.equal(result.events[2].source, "external");
});

test("mergeUnifiedReport keeps a KKTIX row when its dashboard lookup fails", () => {
  const lumaResult = sampleLumaResult();
  const kktixResult = {
    organization: "platform",
    events: [],
    failures: [{ slug: "kktix-demo", name: "KKTIX Demo", reason: "登入狀態失效" }],
  };
  const result = mergeUnifiedReport(lumaResult, kktixResult);

  assert.equal(result.count, 3);
  assert.equal(result.summary.failures, 1);
  assert.equal(result.events[1].source, "kktix");
  assert.equal(result.events[1].registration, null);
  assert.equal(result.events[1].failure, "登入狀態失效");
  assert.deepEqual(result.failures, [
    {
      source: "kktix",
      slug: "kktix-demo",
      name: "KKTIX Demo",
      reason: "登入狀態失效",
    },
  ]);
});

function sampleLumaResult() {
  return {
    calendar: { id: "cal-platform", slug: "theplatform", name: "Platform 月台" },
    events: [
      {
        id: "evt-luma",
        slug: "luma-demo",
        platform: "luma",
        name: "Luma Demo",
        url: "https://luma.com/luma-demo",
        startAt: "2026-08-29T05:30:00.000Z",
        endAt: "2026-08-29T08:30:00.000Z",
        timezone: "Asia/Taipei",
        location: "Platform",
        registration: {
          availability: "open",
          currentlyOpen: true,
          guestCount: 91,
          spotsRemaining: 29,
          requireApproval: true,
          soldOut: false,
          waitlistActive: false,
        },
      },
      {
        id: "external-kktix",
        slug: null,
        platform: "external",
        name: "KKTIX Demo",
        url: "https://platform.kktix.cc/events/kktix-demo",
        startAt: "2026-09-01T11:00:00.000Z",
        endAt: null,
        timezone: "Asia/Taipei",
        location: "Platform",
        registration: null,
      },
      {
        id: "external-other",
        slug: null,
        platform: "external",
        name: "Other Demo",
        url: "https://example.com/events/other-demo",
        startAt: "2026-09-02T11:00:00.000Z",
        endAt: null,
        timezone: "Asia/Taipei",
        location: "Platform",
        registration: null,
      },
    ],
  };
}

function sampleKktixResult() {
  return {
    organization: "platform",
    scanned: 1,
    succeeded: 1,
    events: [
      {
        slug: "kktix-demo",
        name: "KKTIX Demo",
        inventory: { sold: 4, remaining: 116 },
        currentlySelling: true,
        tickets: [{ name: "一般票", status: "In Stock" }],
      },
    ],
    failures: [],
  };
}
