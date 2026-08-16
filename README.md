# pretix-openpos

An open-source point of sale for [pretix](https://pretix.eu), driven by a
progressive web app. Sell tickets at the door from any tablet or phone with a
browser — no native app, no per-device licence.

pretix already has an excellent POS product, pretixPOS. It is an Android app
backed by a pretix Enterprise plugin, and for a self-hosted installation that
licence is the expensive part. This is a smaller, narrower alternative for
people who need a till, run pretix themselves, and would rather not pay for one.

**Status: alpha.** The backend is covered by an end-to-end test and the whole
flow works, including a network dropout exercised by actually stopping the
server, but it has not yet been through a real event. Read the scope section
before deciding it fits.

## What it does

- A touch-friendly till that runs in Safari or Chrome, installed to the home
  screen. Opened in a plain browser tab it shows install instructions instead —
  append `?browser=1` once to override that on a device.
- **Pairing by scanning** the QR code pretix shows for a device, or by typing
  the code.
- **Scanning tickets at the door**: continuous camera scanning, a verdict
  readable at arm's length, and a keyboard-wedge/manual fallback. It calls
  pretix' own check-in RPC, so the rules engine and every refusal reason come
  from pretix rather than a reimplementation.
- **A live head count** on the scanning screen: how many people are inside right
  now, counted over admission products only and across every door and till.
  Tapping it opens a flow chart of tickets expected → admitted → on site →
  scanned back out, with the breakdown per product.
- A dedicated **`openpos` sales channel**, so you pick product by product what
  is sellable at the door — including products that exist *only* on site.
- **On-site pricing**: a separate tariff per product, because pretix itself has
  no concept of a price per sales channel.
- **Cash** with change calculation, and **card** taken on a standalone terminal
  and recorded against the order.
- Orders land in pretix as ordinary paid orders on the POS channel, with the
  cash/card split visible in pretix' own reporting.
- **Immediate check-in**: the ticket is checked in as it is sold, so the
  customer walks straight in and there is nothing to hand over.
- **Offline mode.** A network dropout does not stop the till: it keeps selling
  from the tariff it cached, keeps scanning against a guest list it carries, and
  queues everything. On reconnection the queue replays in order under the same
  idempotency keys — a replay never sells twice — and the app reports what needs
  a human: prices that moved while it was cut off, tickets contested on replay.
- **Transaction history and cancellation**, scoped to the till in your hands:
  cancelling issues a credit note, records the refund and appends a reversing
  journal entry — the original sale is never touched — and the items go back in
  the basket so the corrected order is rung up as a new sale.
- An **append-only journal**, hash-chained so that editing history after the
  fact is detectable.
- Per-till and per-cashier takings for the day.

## What it deliberately does not do

Being clear about this up front will save you an evaluation:

- **No offline cancellations.** A credit note needs the server, so corrections
  wait for the network. Selling and scanning do not.
- **No partial refunds** from the till. A sale is cancelled whole, then rung up
  again corrected; refunding two of three beers is a back-office job.
- **No receipt printing** and no ticket printing.
- **No check-in questions.** Scanning sends `questions_supported: false`, so a
  product that requires answers at the door is refused with a clear reason
  rather than half-checked-in. Use pretixSCAN for those.
- **QR codes only** when scanning. jsQR does not read Code128 or PDF417; tickets
  printed with a non-QR barcode have to be typed or read with a
  keyboard-wedge scanner.
- **No Tap to Pay.** Stripe only exposes Tap to Pay through its native iOS and
  Android SDKs, so it is impossible from a web app. Integrated card payments
  would mean a server-driven Stripe Terminal reader; see the roadmap.
- **No fiscal certification.** The journal is designed so that compliance work
  is possible later, but no claim is made about French, German or Austrian
  cash-register law. If you are VAT-liable, talk to your accountant first.

## How it works

```
iPad / iPhone / laptop                pretix server
┌────────────────────┐               ┌──────────────────────────────┐
│  PWA (React + TS)  │  device token │  pretix_openpos plugin       │
│                    │──────────────▶│                              │
│  catalogue         │               │  /openpos/config             │
│  basket            │               │  /openpos/catalog            │
│  cash keypad       │◀──────────────│  /openpos/checkout           │
│  history           │   order + QR  │  /openpos/history            │
└────────────────────┘               │  /openpos/cancel             │
                                     │  /openpos/summary            │
                                     │                              │
                                     │  → OrderCreateSerializer     │
                                     │  → PosSale journal           │
                                     │  → perform_checkin           │
                                     └──────────────────────────────┘
```

Two decisions are worth calling out because they are what make it safe to run a
till this way:

**The client never sends a price.** It sends product ids and quantities, and the
server resolves what that costs. A tampered-with or simply out-of-date app
cannot sell a 40 € ticket for 4 €.

**Every checkout carries an idempotency key.** It is minted when the payment
panel opens and reused for every retry, so a timeout that actually committed
comes back as the original sale instead of charging the customer twice. This is
the single most common way a homegrown POS loses money.

Authentication uses pretix' own **device tokens** — the same mechanism pretixSCAN
uses. Each till has its own credential, revocable from the organizer settings,
and a custom security profile narrows it down to the POS endpoints and nothing
else.

## Requirements

- A self-hosted pretix, **2024.7.0 or newer** (that is when the sales channel
  type API landed).
- Python 3.11+.
- HTTPS. Service workers, the wake lock and home-screen installation all require
  a secure context.

pretix Hosted does not allow custom plugins, so this cannot be used there.

## Installation

```bash
pip install pretix-openpos
```

Then, in your pretix installation:

```bash
python -m pretix migrate
python -m pretix rebuild
```

If you run pretix in Docker or Kubernetes, [`deploy/Dockerfile`](deploy/Dockerfile)
bakes the plugin into the official image:

```bash
cd frontend && npm run build && cd ..
docker build --platform linux/amd64 -f deploy/Dockerfile -t registry/pretix-openpos:0.1.0 .
```

Two things that bite:

- **Build the frontend first.** The PWA bundle is generated, not committed. An
  image built without it starts fine and then 500s on the till's own JavaScript.
- **`--platform linux/amd64` on an Apple Silicon Mac.** An arm64 image builds,
  pushes and passes every manifest check, then gets refused by the kubelet at
  pull time on an amd64 node.

Pin the base image to the same immutable patch tag your cluster already runs
rather than to a rolling minor.

## Setting it up

1. **Enable the plugin** on your event, under *Settings → Plugins*.
2. **Make products sellable at the till.** On each product, under *Availability*,
   tick the **Open POS** sales channel.
3. **Set the on-site prices** under *Open POS → On-site prices*. Leave a field
   empty to charge the same as the online shop.
4. **Choose the check-in list** under *Open POS → Settings*, so tickets are
   checked in as they are sold. Leave it empty to sell without checking in. The
   same screen has **Issue invoices for till sales**, on by default: it is what
   lets a cancellation from the till issue a credit note. It covers the Open POS
   channel only — your webshop keeps its own invoicing rules — and unticking it
   hands the decision back to them.
5. **Create a device** under the organizer's *Devices*: give it access to the
   event and pick the **Open POS** security profile. pretix shows a pairing QR
   code.
6. **Open `https://your-pretix/openpos/`** on the tablet, add it to the home
   screen, then launch it from the icon and scan the pairing QR code.

One device can sell for several events: any event with the plugin enabled shows
up in *Settings → Event*, and switching does not require re-pairing.

### Naming the app

The label under the home-screen icon defaults to “Open POS”. Set your own:

```bash
python -m pretix shell -c "
from pretix.base.settings import GlobalSettingsObject
GlobalSettingsObject().settings.set('openpos_app_name', 'Your venue')"
```

It is a global setting because the manifest is served from a single URL. Devices
already installed keep the old name until re-added to the home screen.

## Development

Everything runs in Docker; you do not need a local pretix.

```bash
docker compose up --build                                   # pretix on :8000
docker compose exec pretix python -m pretix shell < dev/seed.py   # demo data
```

The seed prints a device pairing code. The backend can then be exercised
end-to-end without a browser:

```bash
python3 dev/smoke_test.py <pairing-code>
```

The frontend is built into the plugin's static directory:

```bash
cd frontend
npm install
npm run build      # writes pretix_openpos/static/pretix_openpos/pwa/
npm run dev        # or: Vite on :5174, proxying /api to :8000
```

Sign in to the backend at http://localhost:8000/control/ with
`admin@localhost` / `admin`.

## Roadmap

Roughly in the order they would earn their keep:

1. **Server-driven Stripe Terminal.** The plugin pushes the amount to a Stripe
   Reader S700 or WisePOS E through the Stripe API and the app watches for the
   result. This keeps the PWA a PWA — no native app, no LAN requirement — and is
   the only realistic path to integrated card payments here.
2. **Refunds and cancellations**, with a permission model so not every volunteer
   can void a sale.
3. **A real cash session**: opening float, blind count at close, Z report.
4. **Offline queueing**, which needs quota pre-allocation per till and conflict
   resolution on sync. Large piece of work; only worth it with a real use case.
5. **Receipt printing** over Star CloudPRNT or Epson ePOS, both of which work
   from iOS because they are network protocols rather than Bluetooth.

## License

AGPL-3.0-or-later, matching pretix itself. See [LICENSE](LICENSE).

This project is not affiliated with or endorsed by pretix GmbH.
