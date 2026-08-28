import assert from "node:assert/strict";
import test from "node:test";
import { LumaClient, normalizeLumaSlug } from "../src/luma-browser.js";

test("normalizeLumaSlug accepts Luma slugs and URLs but rejects other hosts", () => {
  assert.equal(normalizeLumaSlug("theplatform", "Calendar"), "theplatform");
  assert.equal(normalizeLumaSlug("https://luma.com/pzkyaeuz", "活動"), "pzkyaeuz");
  assert.equal(normalizeLumaSlug("https://lu.ma/pzkyaeuz?tk=abc", "活動"), "pzkyaeuz");
  assert.throws(() => normalizeLumaSlug("https://example.com/pzkyaeuz", "活動"), /luma\.com 或 lu\.ma/);
});

test("LumaClient lists public calendar items through the page API", async () => {
  const client = new LumaClient({ calendar: "theplatform", quiet: true });
  client.started = true;
  client.load = async () => ({
    url: "https://luma.com/theplatform",
    html: lumaCalendarPage(),
  });
  let fetchedUrl = null;
  client.fetchJson = async (url) => {
    fetchedUrl = new URL(url);
    return {
      entries: [
        {
          api_id: "calev-1",
          platform: "luma",
          event: { api_id: "evt-1", name: "Demo", url: "demo123", start_at: "2026-09-01T11:00:00Z" },
          registration_availability: "open",
          guest_count: 3,
          ticket_info: { spots_remaining: 7, is_sold_out: false },
        },
      ],
      has_more: false,
    };
  };

  const result = await client.listEvents();
  assert.equal(result.calendar.slug, "theplatform");
  assert.equal(result.count, 1);
  assert.equal(result.events[0].registration.guestCount, 3);
  assert.equal(fetchedUrl.hostname, "api.luma.com");
  assert.equal(fetchedUrl.searchParams.get("calendar_api_id"), "cal-platform");
  assert.equal(fetchedUrl.searchParams.get("period"), "future");
});

function lumaCalendarPage() {
  const nextData = {
    props: {
      pageProps: {
        initialData: {
          data: {
            calendar: {
              api_id: "cal-platform",
              slug: "theplatform",
              name: "Platform 月台",
              timezone: "Asia/Taipei",
            },
          },
        },
      },
    },
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>`;
}
