# pretix-openpos

An open-source point of sale for [pretix](https://pretix.eu), driven by a
progressive web app. Sell tickets at the door from any tablet or phone with a
browser — no native app, no per-device licence.

**[clabeuhtegrite.github.io/pretix-openpos](https://clabeuhtegrite.github.io/pretix-openpos/)**
— the same introduction with screenshots, in English, French, Spanish and German.

pretix already has an excellent POS product, pretixPOS. It is an Android app
backed by a pretix Enterprise plugin, and for a self-hosted installation that
licence is the expensive part. This is a smaller, narrower alternative for
people who need a till, run pretix themselves, and would rather not pay for one.

**Status: alpha.** The whole flow works and is covered by tests that all run on
every push — the backend against a real pretix, the till's own code from
integer-cent arithmetic up to what a cashier can press, and an end-to-end run
against a live stack on PostgreSQL with several tills writing to one journal at
once. Both suites are held to a coverage floor, so a screen nobody tests fails
the build rather than shipping. It has run a real event — one night, one door
and one bar, several hundred people — and is in production for the association
it was written for. Read the scope section before deciding it fits.

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
  scanned back out, with the breakdown per product and a table of the event's
  scans per device.
- **A scan counter that survives the phone**: what this device and every door
  have scanned for the event, counted by the server from pretix' own check-ins
  rather than by the page, so leaving the app, a reload or the next morning does
  not reset it.
- **A role per device**: a tablet is the bar *till* or the *door*, assigned in
  the back office. A till opens on the product grid; a door opens on the scanner
  and steps out to the grid to sell a ticket on the spot. A device nobody has
  assigned keeps doing both, so the split takes effect only where it is chosen.
  The role is stored server-side rather than in the app, which is what makes the
  one rule attached to it enforceable: a till with a card reader assigned cannot
  record a card payment that reader did not validate — not from a stale app, not
  from an edited one, and not from the offline queue.
- **Each counter sells its own categories.** Reserve a product category for the
  bar or for the door, and a device offers only what it is there to sell — no
  more coming out of a scan onto the whole grid with the beer one row under the
  entry. Set per category rather than per device, because a device is paired
  once and a category belongs to one event. The catalogue is only the polite
  half: the server refuses the same line whatever the app sends. A sale already
  paid for and replayed from the offline queue is the exception — it is
  recorded, marked and reported, because refusing would leave the money in the
  drawer with no trace of it at all.
- **A SumUp card reader, driven by the server.** Pair a SumUp Solo to your
  account from the back office, give it to a till, and choosing "card" there
  puts the basket on the reader and waits for the customer. The server prices
  the basket when it asks for the card and books the order from that same
  priced basket, so the charge and the order cannot disagree. Cancelling such a
  sale refunds the card by itself. SumUp's callback is never believed — it only
  makes the server go and ask over an authenticated connection — so an
  installation SumUp cannot reach works identically, a second or two slower.
- A dedicated **`openpos` sales channel**, so a product can be limited to the
  door, kept off it, or made to exist *only* on site.
- **One price per product**, pretix' own. The till has no price list of its
  own and cannot have one: charging more at the door is a *product* of its own,
  limited to the `openpos` channel and priced in pretix like everything else.
  The takings of a product are then the takings of a product, whichever counter
  rang it up.
- **A free amount**, for what has no product of its own — a broken glass, a
  donation, a plate at a stand. The cashier types the figure and a reason; the
  reason is kept on the journal line and on the order. Off unless the organiser
  sets a product aside for it, which is what keeps the till's "never sends a
  price" rule meaningful everywhere else.
- **Cup deposits, taken and handed back.** The deposit is an ordinary product;
  the return is a button that takes its price off the basket, so "two beers and
  I am returning three cups" is one transaction and one amount to settle. A
  return is not a pretix order — an order cannot total less than nothing, and
  the queue at closing time is people returning cups and buying nothing — so it
  is recorded in the till journal, where the takings and the drawer are
  reconciled. Cash only: a card refund is always made against an original
  transaction, and nothing links cups returned at closing time to the round that
  sold them.
- **A light palette as well as a dark one**, following the tablet unless told
  otherwise. Dark does not glare in a dim room; light stays readable at an
  outdoor bar at two in the afternoon.
- **Cash** with change calculation, and **card** — either taken on a standalone
  terminal and recorded against the order, or, on a till that has one, taken by
  a **SumUp card reader the server drives** (see below).
- Orders land in pretix as ordinary paid orders on the POS channel, with the
  cash/card split visible in pretix' own reporting.
- **Immediate check-in**: the ticket is checked in as it is sold, so the
  customer walks straight in and there is nothing to hand over.
- **Offline mode.** A network dropout does not stop the till: it keeps selling
  from the tariff it cached, keeps scanning against a guest list it carries, and
  queues everything. On reconnection the queue replays in order under the same
  idempotency keys — a replay never sells twice — and the app reports what needs
  a human: prices that moved while it was cut off, tickets contested on replay.
  A queued sale is never refused for something that changed while the till was
  cut off, either: the money is already in the drawer, so a quota that ran out
  or a product pulled from the till in the meantime is recorded as a fact to
  reconcile rather than left stranded in a browser. Those rows are marked
  `offline` in the journal, which is how you find them afterwards. Scans are
  sent the way pretix expects an offline scan to be, so its check-in history
  and export mark them as offline scans — refusals given offline included —
  and a scan whose request fails mid-way is answered from the guest list and
  kept rather than lost.
- **Transaction history and cancellation**, scoped to the till in your hands:
  cancelling issues a credit note, records the refund and appends a reversing
  journal entry — the original sale is never touched — and the items go back in
  the basket so the corrected order is rung up as a new sale. A till's sale
  cancelled in pretix itself — the order page, the REST API, a whole event
  called off — is reversed in the journal too, in the name of whoever did it,
  and pretix' own refund dialog sends a reader's card payment back through
  SumUp.
- **Cash drawers**, as many as the venue has. Create one per physical drawer
  in the back office and give it its tills — two tablets at one bar can share
  one. A drawer is opened on the till with a float counted note by note or
  typed in, takes money in and out with a reason each time, is counted blind
  at closing (the till shows what it should hold only once the count is
  written down) and closes on that count. Each evening gets a closing report in
  the back office, with every figure the expected cash is made of and the
  difference it closed on. A till with a drawer takes cash only while that
  drawer is open — except a sale replayed from the offline queue, which is
  never refused and lands in the opening that was running when the customer
  paid. Card money never goes near a drawer.
- An **append-only journal**, hash-chained so that editing history after the
  fact is detectable. Each drawer's ledger is chained the same way.
- **Takings for the event**, on the till and in the back office: cash and
  card, per till and per cashier, product by product under each category,
  deposits apart and cancellations netted off. In a series, the takings of
  the date the till is selling.

## What it deliberately does not do

Being clear about this up front will save you an evaluation:

- **No offline cancellations.** A credit note needs the server, so corrections
  wait for the network. Selling and scanning do not.
- **No partial refunds** from the till. A sale is cancelled whole, then rung up
  again corrected; refunding two of three beers is a back-office job.
- **No open refund to a card.** SumUp only refunds against a transaction of its
  own, up to its amount, so a returned cup deposit is paid out of the drawer.
  Cancelling a card sale is a different matter and is fully automatic.
- **A returned deposit is not in pretix.** It lives in the till journal and its
  CSV export, and it is netted off the takings there. pretix sees the sale that
  went with it and nothing else, which is also the honest reading: the beers
  were sold for what they cost, and money went out for cups. Two consequences
  follow — returning a cup does not put stock back (give the deposit product an
  unlimited quota), and cancelling a mixed sale credits the order without
  undoing the return that rode along with it.
- **No receipt printing** and no ticket printing.
- **No drawer kick.** A cash drawer here is the money and its ledger; nothing
  opens a physical drawer, which would need a receipt printer to hang it from.
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
                                     │  /openpos/drawer             │
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
cannot sell a 40 € ticket for 4 €. The free-amount button is the one deliberate
exception, and it is fenced in: the amount is only accepted on the single
product the organiser set aside for it, only above zero, and only with a reason
attached. A returned deposit is not an exception at all — the till says a line
is a return, and the server takes the product's price and negates it.

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

Not on PyPI yet, so it is installed from the repository. Pin a commit if you
would rather not follow `main`.

```bash
pip install "pretix-openpos @ git+https://github.com/clabeuhtegrite/pretix-openpos"
```

Then, in your pretix installation:

```bash
python -m pretix migrate
python -m pretix rebuild
```

If you run pretix in Docker or Kubernetes, [`deploy/Dockerfile`](deploy/Dockerfile)
bakes the plugin into the official image:

```bash
docker build --platform linux/amd64 -f deploy/Dockerfile -t registry/pretix-openpos:0.21.0 .
```

The PWA bundle is built inside the image, from the tree you are building, so the
JavaScript the till runs and the plugin serving it always carry the same version
number. Nothing needs building by hand first.

One thing that bites: **`--platform linux/amd64` on an Apple Silicon Mac.** An
arm64 image builds, pushes and passes every manifest check, then gets refused by
the kubelet at pull time on an amd64 node.

Pin the base image to the same immutable patch tag your cluster already runs
rather than to a rolling minor.

## Setting it up

1. **Enable the plugin** on your event, under *Settings → Plugins*.
2. **Decide what is sellable at the till.** pretix puts a product on every sales
   channel unless you say otherwise, so everything shows up at the till to begin
   with. To split the two catalogues, set a product's *Availability* to specific
   channels and pick from there — including products that exist *only* on
   **Open POS**. Every product needs a quota, unlimited if need be: one attached
   to none shows as sold out at the till, as it would in the shop.
3. **Price the products in pretix**, on the products themselves. The till
   charges that price and no other. To charge more at the door than in advance,
   make it a separate product on the **Open POS** channel — "Door entry", say —
   rather than looking for a second price: one name is worth one price, and
   that is what keeps the takings readable afterwards.
4. **Choose the check-in list** under *Open POS → Settings*, so tickets are
   checked in as they are sold. It is in the *Settings* menu on the plugin's
   card from step 1; the sidebar's **Open POS** menu leads to the event's other
   two screens only. Leave it empty to sell without checking in. The
   same screen has **Issue invoices for till sales**, on by default: it is what
   lets a cancellation from the till issue a credit note. It covers the Open POS
   channel only — your webshop keeps its own invoicing rules — and unticking it
   hands the decision back to them.
5. **Optionally, turn on the two extra buttons**, at the bottom of the same
   screen. Both are off until you name a product for them, and each product
   needs a quota and the Open POS channel like any other:
   - *Product for free-amount sales* — a "Misc" product at 0.00, which every
     free amount is booked against.
   - *Cup deposit product* — the deposit itself, which you also sell from the
     grid. Naming it here adds the **deposit back** button. Give it an
     unlimited quota: a returned cup does not put stock back.
6. **Create a device** under the organizer's *Devices*: give it access to the
   event and pick the **Open POS** security profile. pretix shows a pairing QR
   code.
7. **Open `https://your-pretix/openpos/`** on the tablet, add it to the home
   screen, then launch it from the icon and scan the pairing QR code.
8. **Say what the device is for** under the organizer's *Open POS → Till
   devices*: **till** for the bar, **door** for the entrance. Leaving it
   unassigned is a fine answer and the default — the device then does both, as
   every device did before this screen existed.
9. **Optionally, set up a card reader.** Under *Open POS → Card readers*, enter
   your SumUp merchant code and an API key, then pair a reader with the code it
   shows on its own screen. Give that reader to a till back on the *Till
   devices* screen, and that till takes card payments through it and nowhere
   else — the server refuses a card sale the reader did not validate. Every
   other device goes on as before.
10. **Optionally, set up cash drawers.** Under *Open POS → Cash drawers*, create
    one per physical drawer, with the float it usually starts on, then give
    each till its drawer on the *Till devices* screen. From then on that till
    asks for its drawer to be opened on a counted float before it takes cash,
    and closes the evening on a blind count. A device with no drawer takes cash
    exactly as before.

One device can sell for several events: every event it has access to and that
has the plugin enabled can be picked in *Settings → Event*, whether or not its
shop is online, and switching does not require re-pairing. An event the device
reaches without the plugin is named there with the reason rather than left out,
and a till whose event will not open — Open POS switched off there, a series
with nothing on tonight — offers its other events on the error screen.

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

The seed prints a device pairing code. Sign in to the backend at
http://localhost:8000/control/ with `admin@localhost` / `admin`.

The frontend is built into the plugin's static directory:

```bash
cd frontend
npm install
npm run build      # writes pretix_openpos/static/pretix_openpos/pwa/
npm run dev        # or: Vite on :5174, proxying /api to :8000
```

### Tests

Everything runs on every push, and everything runs from one command on a laptop:

```bash
scripts/preflight.sh          # the lot: the same checks CI runs, in the same order
scripts/preflight.sh --fast   # all but the end-to-end run and the image build
```

Only Docker is needed for the backend halves of it; nothing has to be installed
on the machine.

**The frontend suite** covers the till itself — the queue-replay rules, the
offline door verdicts, integer-cent arithmetic, the change due on an order
corrected against a credit, and every screen a cashier can press: what is
greyed out at the quota, what cannot be confirmed short, what the door does
with a T-shirt on an all-products list. It runs on jsdom under a coverage floor
set in `frontend/vite.config.ts`, so a component nobody tests shows up as the
zero it is and fails the run.

```bash
cd frontend && npm test              # or npm run test:coverage
```

**The backend suite** talks to the plugin over HTTP through a real pretix — real
ORM, real order pipeline, real check-in service, real device authentication — on
SQLite with pretix' own test settings. It has its own coverage floor, in
`pyproject.toml`. It needs pretix installed:

```bash
pip install pretix && pip install --no-deps -e . && pip install pytest pytest-django pytest-cov
pytest --cov
```

Or, without touching your machine:

```bash
docker build -f dev/Dockerfile.test -t pretix-openpos-test .
docker run --rm -v "$PWD:/plugin" pretix-openpos-test
```

**The end-to-end run** boots pretix on PostgreSQL, seeds it and fires every
script in `dev/` at it. It is not redundant with the two suites above: it
exercises what only exists in a whole running system — the journal's savepoint
handling under concurrent tills, which is forgiving on SQLite and unforgiving on
PostgreSQL; the back-office pages rendered through a real session; the arrivals
histogram over three seeded events; and the offline replay over real HTTP.

```bash
dev/integration.sh                       # boots, runs, tears down
OPENPOS_KEEP_STACK=1 dev/integration.sh  # leave it up on :8001 to poke at
```

The individual scripts still take a running stack and a pairing code, which is
what to reach for when one of them fails:

```bash
python3 dev/smoke_test.py <pairing-code>
python3 dev/concurrency_test.py <pairing-code>
docker compose exec -T pretix python -m pretix shell < dev/backoffice_test.py
docker compose exec -T pretix python -m pretix shell < dev/arrivals_test.py
```

**The production image** is built in CI too, and checked for the one thing that
fails nowhere else: that the PWA bundle is in it and collected. An image whose
`pretix rebuild` was skipped builds perfectly and then 500s on its own
JavaScript.

## Roadmap

Roughly in the order they would earn their keep:

1. **A permission model for cancelling.** Reversing a sale works today and is
   scoped to the till that made it; what is missing is a way to say that not
   every volunteer may do it.
2. **Partial refunds**, so two of three beers can be given back without
   cancelling the sale whole and ringing it up again.
3. **Receipt printing** over Star CloudPRNT or Epson ePOS, both of which work
   from iOS because they are network protocols rather than Bluetooth.

## License

Apache-2.0. See [LICENSE](LICENSE).

pretix itself is AGPLv3 with an additional permission, and a plugin running
beside it forms a combined work, so what you may do with this code in practice
follows from pretix' licence rather than from this one. Apache-2.0 is what
[pretix recommends for plugins](https://docs.pretix.eu/trust/licensing/faq/) and
what they use for their own: a plugin under pure AGPL would be incompatible with
that additional permission, and would oblige whoever installs it to publish the
source of *every* plugin in the same environment, even for their own events.
Licensing this one permissively keeps that off the people who run it.

This project is not affiliated with or endorsed by pretix GmbH.
