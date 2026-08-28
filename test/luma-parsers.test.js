import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLumaCalendarItems,
  parseLumaCalendarPage,
  parseLumaEventPage,
} from "../src/luma-parsers.js";

test("parseLumaCalendarPage reads public Calendar metadata", () => {
  const html = lumaPage({
    calendar: {
      api_id: "cal-platform",
      slug: "theplatform",
      name: "Platform 月台",
      description_short: "台北車站旁的活動聚落。",
      timezone: "Asia/Taipei",
      geo_city: "Taipei",
      geo_country: "Taiwan",
    },
  });

  assert.deepEqual(parseLumaCalendarPage(html, "https://luma.com/theplatform"), {
    id: "cal-platform",
    slug: "theplatform",
    name: "Platform 月台",
    description: "台北車站旁的活動聚落。",
    timezone: "Asia/Taipei",
    city: "Taipei",
    country: "Taiwan",
    url: "https://luma.com/theplatform",
  });
});

test("parseLumaCalendarItems normalizes Luma registration and external events", () => {
  const events = parseLumaCalendarItems({
    entries: [
      {
        api_id: "calev-1",
        platform: "luma",
        event: {
          api_id: "evt-1",
          name: "Luma Event",
          url: "abc123",
          start_at: "2026-09-01T11:00:00.000Z",
          end_at: "2026-09-01T13:00:00.000Z",
          timezone: "Asia/Taipei",
          geo_address_info: { address: "Platform" },
        },
        hosts: [{ name: "Host A" }],
        registration_availability: "open",
        guest_count: 56,
        ticket_count: 56,
        ticket_info: {
          is_free: true,
          is_sold_out: false,
          is_near_capacity: false,
          require_approval: true,
          spots_remaining: 64,
        },
      },
      {
        api_id: "calev-2",
        platform: "external",
        event: {
          name: "KKTIX Event",
          url: "https://platform.kktix.cc/events/demo",
          start_at: "2026-10-01T11:00:00.000Z",
          timezone: "Asia/Taipei",
          host: "Platform 月台",
        },
      },
    ],
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].url, "https://luma.com/abc123");
  assert.equal(events[0].registration.currentlyOpen, true);
  assert.equal(events[0].registration.guestCount, 56);
  assert.equal(events[0].registration.spotsRemaining, 64);
  assert.equal(events[1].platform, "external");
  assert.equal(events[1].registration, null);
  assert.deepEqual(events[1].hosts, ["Platform 月台"]);
});

test("parseLumaEventPage reads event, location, registration, and ticket types", () => {
  const initialData = {
    calendar: { api_id: "cal-platform", slug: "theplatform", name: "Platform 月台", timezone: "Asia/Taipei" },
    event: {
      api_id: "evt-1",
      url: "abc123",
      name: "Luma Event",
      start_at: "2026-09-01T11:00:00.000Z",
      end_at: "2026-09-01T13:00:00.000Z",
      timezone: "Asia/Taipei",
      location_type: "offline",
      coordinate: { latitude: 25.05, longitude: 121.51 },
      geo_address_info: {
        address: "Platform",
        full_address: "Taipei, Taiwan",
        city: "Taipei",
        country: "Taiwan",
      },
    },
    hosts: [{ name: "Host A", username: "host-a" }],
    registration_availability: "open",
    guest_count: 92,
    ticket_count: 92,
    sold_out: false,
    waitlist_active: false,
    ticket_info: { is_free: true, spots_remaining: 28, require_approval: true, is_sold_out: false },
    ticket_types: [
      {
        api_id: "ticket-1",
        name: "Standard",
        type: "free",
        num_tickets_registered: 92,
        spots_remaining: null,
        require_approval: true,
      },
    ],
  };
  const structured = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: "Luma Event",
    description: "Event description",
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    organizer: { "@type": "Organization", name: "Platform 月台", url: "https://luma.com/theplatform" },
    offers: { availability: "https://schema.org/InStock", name: "General Admission", price: 0, priceCurrency: "usd" },
  };
  const result = parseLumaEventPage(lumaPage(initialData, structured), "https://luma.com/abc123");

  assert.equal(result.name, "Luma Event");
  assert.equal(result.description, "Event description");
  assert.equal(result.status, "EventScheduled");
  assert.equal(result.registration.currentlyOpen, true);
  assert.equal(result.registration.spotsRemaining, 28);
  assert.equal(result.location.fullAddress, "Taipei, Taiwan");
  assert.deepEqual(result.hosts, [{ name: "Host A", username: "host-a" }]);
  assert.equal(result.tickets[0].registered, 92);
  assert.equal(result.tickets[0].spotsRemaining, null);
  assert.deepEqual(result.offers[0], {
    name: "General Admission",
    availability: "InStock",
    price: 0,
    currency: "USD",
  });
});

function lumaPage(data, structured = null) {
  const nextData = { props: { pageProps: { initialData: { kind: "test", data } } } };
  return `<!doctype html><html><head>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>
    ${structured ? `<script type="application/ld+json">${JSON.stringify(structured)}</script>` : ""}
  </head><body></body></html>`;
}
