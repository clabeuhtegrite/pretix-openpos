"""
Each association's share of an evening: what it sold, and who holds its money.

Several associations run an evening together and each keeps its own books: one
sold the tickets online, one took the money at the door, one ran the bar. pretix
has one issuer of invoices per event and no report that splits a sales channel
or a category, so none of its screens can hand each of them their part. This is
that part, computed rather than stored:

- **Online**: every order that did not come from a till, read from pretix'
  orders — the products of the paid ones, and the money of all of them, since
  an order refunded, or half paid by transfer, has moved some.
- **At the counters**: the till journal, the rows the takings are read from
  (:mod:`pretix_openpos.takings`), sorted into the door and the bar line by
  line: by the counter the line's category is reserved for on *Who sells
  what*; failing that, by the other lines of the same sale; failing that, by
  the role of the device that rang it up.

Each part belongs to the association the event names for it
(:mod:`pretix_openpos.associations`). A part with no association is shown on
its own rather than folded into another one, and a line nothing can place is
shown as not attributed: every euro is on exactly one line, and the lines add
up to what the tills and the webshop took.

Money is not always where it belongs. A card taken by a reader lands in the
SumUp account of whoever owns it; the cash of a drawer goes home with whoever
keeps that drawer; the webshop pays out to the account its payment provider
was set up with. So every euro is followed to the association holding it, and
what one holds of another's is the transfers at the bottom of the statement:
who owes whom, and why. Money nobody has said anything about — a card taken on
somebody's phone, a drawer nobody named a keeper for — is held by the
association it belongs to, and owes nothing.
"""
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal

from django.db.models import Count, Sum
from django.utils.translation import gettext_lazy as _
from pretix.base.models import Order, OrderFee, OrderPayment, OrderPosition, OrderRefund

from .associations import PART_LABELS, PART_ONLINE, PARTS, online_holder, shares, sumup_holder
from .channels import POS_CHANNEL
from .models import PosAssociation, PosCategory, PosDevice, PosSale, PosTerminalPayment
from .takings import ZERO, categories, journal_rows, line_amount

CENT = Decimal("0.01")

#: How a euro came in, as the statement's columns name it.
CASH = "cash"
CARD = "card"
ONLINE = "online"

#: Why a euro is with an association that is not the one it belongs to.
VIA_READER = "reader"
VIA_DRAWER = "drawer"
VIA_ONLINE = "online"

#: pretix' names for its kinds of fee, translated when they are shown.
FEE_NAMES = dict(OrderFee.FEE_TYPES)

#: What the statement reads of each journal row, beyond what the takings read.
EXTRA_FIELDS = (
    "idempotency_key",
    "drawer_session__drawer__held_by",
    "drawer_session__drawer__name",
)


class Share:
    """
    What one association took — or one part of the evening nobody has given
    to an association, or the lines nothing could place.
    """

    def __init__(self, association=None, part=None):
        self.association = association
        #: Only when no association counts it: the statement then names the
        #: part itself. ``None`` with no association is "not attributed".
        self.part = part
        #: Every part whose money is in here, for the line under the name.
        self.parts = set()
        self.products = {}
        self.fees = {}
        self.taken = {"count": 0, "total": ZERO}
        self.returned = {"count": 0, "total": ZERO}
        #: Journal rows written with no lines: said, rather than dropped.
        self.unallocated = ZERO
        self.money = {CASH: ZERO, CARD: ZERO, ONLINE: ZERO}

    @property
    def label(self):
        if self.association is not None:
            return self.association.name
        if self.part is not None:
            return str(PART_LABELS[self.part])
        return str(_("Not attributed"))

    @property
    def order(self):
        """Associations in the order of the parts they count, then the loose ends."""
        first = min((PARTS.index(part) for part in self.parts), default=len(PARTS))
        return (
            0 if self.association is not None else 1 if self.part is not None else 2,
            first,
            self.label.lower(),
        )

    def add_line(self, line, amount, *, deposit_taken, deposit_returned):
        count = int(line.get("count") or 0)
        if deposit_returned:
            self.returned["count"] += count
            self.returned["total"] += amount
        elif deposit_taken:
            self.taken["count"] += count
            self.taken["total"] += amount
        elif line.get("item") is None:
            # A fee — what a cancellation kept — which names no product. Named
            # by its type in the language of the page, as the webshop's fees
            # are, so a fee kept at the till and one kept online are one line.
            name = FEE_NAMES.get(line.get("fee")) or line.get("item_name") or ""
            fee = self.fees.setdefault(str(name), {"count": 0, "total": ZERO})
            fee["count"] += count
            fee["total"] += amount
        else:
            product = self.products.setdefault(
                (line.get("item"), line.get("variation")),
                {"count": 0, "total": ZERO, "item_name": "", "variation_name": None},
            )
            product["count"] += count
            product["total"] += amount
            product["item_name"] = line.get("item_name") or product["item_name"]
            product["variation_name"] = line.get("variation_name") or product["variation_name"]

    def as_dict(self, event):
        sold = sum((p["total"] for p in self.products.values()), ZERO) + sum(
            (f["total"] for f in self.fees.values()), ZERO
        )
        deposits = self.taken["total"] + self.returned["total"]
        total = self.money[CASH] + self.money[CARD] + self.money[ONLINE]
        has_deposits = any(
            (self.taken["count"], self.returned["count"], self.taken["total"], self.returned["total"])
        )
        return {
            "label": self.label,
            "association": self.association,
            "part": self.part,
            "parts": [str(PART_LABELS[part]) for part in PARTS if part in self.parts],
            "categories": [
                {
                    **group,
                    "total": Decimal(group["total"]),
                    "items": [{**item, "total": Decimal(item["total"])} for item in group["items"]],
                }
                for group in categories(event, self.products)
            ],
            "fees": [
                {"name": name, "count": fee["count"], "total": fee["total"]}
                for name, fee in sorted(self.fees.items())
                if fee["count"] or fee["total"]
            ],
            "deposits": (
                {"taken": dict(self.taken), "returned": dict(self.returned), "total": deposits}
                if has_deposits else None
            ),
            "unallocated": self.unallocated or None,
            "sold": sold,
            "deposits_total": deposits,
            "cash": self.money[CASH],
            "card": self.money[CARD],
            "online": self.money[ONLINE],
            "total": total,
            # Online only, in practice: money of orders that were not counted
            # as sold (half paid, or refunded without being cancelled). At the
            # tills a euro is sold and paid in the same row, and this is zero.
            "gap": (total - sold - deposits - self.unallocated) or None,
        }


class Book:
    """The shares of one evening, and what each association holds of the others'."""

    def __init__(self, event):
        self.by_part = shares(event)
        self.shares = {}
        #: ``(holder pk, owner pk) → {(why, which) → amount}``
        self.owed = defaultdict(lambda: defaultdict(lambda: ZERO))
        #: Reader money, while nobody has said whose SumUp account it is.
        self.reader_unheld = ZERO
        #: Money an association holds for a part nobody has given one to.
        self.unplaced = ZERO

    def share(self, part):
        association = self.by_part.get(part) if part else None
        key = ("association", association.pk) if association else ("part", part)
        share = self.shares.get(key)
        if share is None:
            share = self.shares[key] = Share(association, None if association else part)
        if part:
            share.parts.add(part)
        return share

    def held(self, share, holder, reason, amount):
        """Say that ``amount`` of ``share``'s money is with ``holder``."""
        if not amount or reason is None:
            return
        if holder is None:
            if reason[0] == VIA_READER:
                self.reader_unheld += amount
            return
        if share.association is None:
            self.unplaced += amount
            return
        if holder.pk != share.association.pk:
            self.owed[(holder.pk, share.association.pk)][reason] += amount

    def transfers(self, associations):
        """
        Who owes whom, one line per pair of associations, netted.

        Netted because two associations that each hold some of the other's
        money settle it with one transfer, not two; the details keep both
        directions, so the figure can be checked against what it came from.
        """
        pairs = defaultdict(list)
        for (holder, owner), reasons in self.owed.items():
            pairs[tuple(sorted((holder, owner)))].append((holder, owner, reasons))
        lines = []
        for (first, second), directions in pairs.items():
            net = ZERO
            details = []
            for holder, owner, reasons in directions:
                sign = 1 if (holder, owner) == (first, second) else -1
                for (why, which), amount in sorted(reasons.items()):
                    if not amount:
                        continue
                    net += sign * amount
                    details.append(
                        {
                            "holder": associations[holder],
                            "owner": associations[owner],
                            "why": why,
                            "which": which,
                            "amount": amount,
                        }
                    )
            if not net:
                continue
            payer, payee = (first, second) if net > 0 else (second, first)
            lines.append(
                {
                    "payer": associations[payer],
                    "payee": associations[payee],
                    "amount": abs(net),
                    "details": details,
                }
            )
        lines.sort(key=lambda line: (line["payer"].name.lower(), line["payee"].name.lower()))
        return lines


def till_part(book, event, subevent):
    """
    Sort the journal of ``event`` into the door and the bar. Returns how many
    test-mode rows were left out.
    """
    from .api.catalog import deposit_item

    rows = list(
        journal_rows(PosSale.objects.filter(event=event), subevent, extra=EXTRA_FIELDS)
    )
    real = [row for row in rows if not row["testmode"]]

    # The row whose money a reversal moves back, for three things it does not
    # carry itself: what kind of money it was, which device took it, and under
    # which key — the key being how a reader payment is told from a card
    # taken on a phone. Two steps at most, as in the takings: a reactivation,
    # the cancellation it undoes, and the row that one reversed. Unlike the
    # takings, which can be asked for a few nights of a longer journal, the
    # statement reads every row of the event or of one date, and a reversal
    # copies the lines of the row it reverses, date included: the row is
    # always among those read.
    reversals = (PosSale.KIND_CANCELLATION, PosSale.KIND_REACTIVATION)
    known = {
        row["seq"]: (row["kind"], row["cancels_seq"], row["device_id"], row["idempotency_key"])
        for row in rows
    }

    def origin(row):
        kind, target, device, key = (
            row["kind"], row["cancels_seq"], row["device_id"], row["idempotency_key"],
        )
        for _step in range(2):
            if kind not in reversals:
                break
            kind, target, device, key = known.get(target, (PosSale.KIND_SALE, None, device, key))
        return kind, device, key

    deposit_ids = set()
    configured = deposit_item(event)
    if configured is not None:
        deposit_ids.add(configured.pk)
    for row in real:
        if origin(row)[0] == PosSale.KIND_DEPOSIT_REFUND:
            deposit_ids.update(line.get("item") for line in row["positions"] or ())

    reserved = PosCategory.reserved(event)
    category_of = dict(event.items.values_list("pk", "category_id"))
    roles = dict(
        PosDevice.objects.filter(device__organizer=event.organizer).values_list("device_id", "role")
    )
    # Settled by a reader, as PosTerminalPayment.settling has it: the money is
    # in the SumUp account, and so is a refund of it.
    by_reader = set(
        PosTerminalPayment.objects.filter(
            event=event, status=PosTerminalPayment.STATUS_SUCCESSFUL
        ).exclude(transaction_id="").values_list("idempotency_key", flat=True)
    )
    associations = {
        association.pk: association
        for association in PosAssociation.objects.filter(organizer=event.organizer)
    }
    reader_holder = sumup_holder(event.organizer)

    def reserved_part(line):
        item = line.get("item")
        return reserved.get(category_of.get(item)) if item is not None else None

    for row in real:
        kind, device_id, key = origin(row)
        lines = row["positions"] or []
        placed = [reserved_part(line) for line in lines]
        decided = {part for part in placed if part}
        # A line no category places — a free amount, the fee a cancellation
        # kept — goes with the rest of its sale when the rest agrees, and
        # with the counter of the device that rang it up otherwise.
        fallback = next(iter(decided)) if len(decided) == 1 else (roles.get(device_id) or None)

        if row["payment_type"] == PosSale.PAYMENT_CARD:
            channel = CARD
            if key in by_reader:
                holder, reason = reader_holder, (VIA_READER, "")
            else:
                # Taken on somebody's phone, in whatever account that phone
                # uses: nobody here knows whose, so it is with its owner.
                holder, reason = None, None
        else:
            channel = CASH
            holder = associations.get(row["drawer_session__drawer__held_by"])
            reason = (VIA_DRAWER, row["drawer_session__drawer__name"] or "")

        allocated = ZERO
        for line, part in zip(lines, placed):
            share = book.share(part or fallback)
            amount = line_amount(line)
            allocated += amount
            share.add_line(
                line,
                amount,
                deposit_taken=line.get("item") in deposit_ids,
                deposit_returned=kind == PosSale.KIND_DEPOSIT_REFUND,
            )
            share.money[channel] += amount
            book.held(share, holder, reason, amount)

        rest = row["total"] - allocated
        if rest:
            share = book.share(fallback)
            share.unallocated += rest
            share.money[channel] += rest
            book.held(share, holder, reason, rest)

    return len(rows) - len(real)


def _first_dates(order_ids):
    """``order id → date id`` of each order's first position, cancelled ones included."""
    first = {}
    for order_id, subevent_id in (
        OrderPosition.all.filter(order_id__in=order_ids)
        .order_by("order_id", "positionid", "pk")
        .values_list("order_id", "subevent_id")
    ):
        first.setdefault(order_id, subevent_id)
    return first


def _money_on(subevent, net):
    """
    The part of each order's money that is ``subevent``'s.

    An order is paid as a whole, and a pass for two evenings is one payment for
    both, so its money is split in proportion of what it holds for each date.
    Its fees go with its first date, as they do in :func:`online_part`. An
    order that holds nothing any more — cancelled, a fee kept — belongs to the
    date of its first position.
    """
    first = _first_dates(list(net))
    on_date = defaultdict(lambda: ZERO)
    whole = defaultdict(lambda: ZERO)
    for row in (
        OrderPosition.objects.filter(order_id__in=list(net))
        .values("order_id", "subevent_id")
        .annotate(value=Sum("price"))
        .order_by()
    ):
        whole[row["order_id"]] += row["value"]
        if row["subevent_id"] == subevent.pk:
            on_date[row["order_id"]] += row["value"]
    for row in (
        OrderFee.objects.filter(order_id__in=list(net))
        .values("order_id")
        .annotate(value=Sum("value"))
        .order_by()
    ):
        whole[row["order_id"]] += row["value"]
        if first.get(row["order_id"]) == subevent.pk:
            on_date[row["order_id"]] += row["value"]

    total = ZERO
    for order_id, amount in net.items():
        if whole[order_id]:
            total += (amount * on_date[order_id] / whole[order_id]).quantize(
                CENT, rounding=ROUND_HALF_UP
            )
        elif first.get(order_id) == subevent.pk:
            total += amount
    return total


def online_part(book, event, subevent):
    """
    Every order of ``event`` that no till made: what was sold, and what was paid.

    Sold is read off the paid orders, as pretix' own order overview counts
    them; paid is the money of every order, cancelled and pending ones
    included, as pretix sums an order's payments and refunds. The two differ
    only by what is still moving — a transfer half received, a refund made
    without cancelling — and the statement says by how much.
    """
    orders = Order.objects.filter(event=event, testmode=False).exclude(
        sales_channel__identifier=POS_CHANNEL
    )
    paid = orders.filter(status=Order.STATUS_PAID)

    positions = OrderPosition.objects.filter(order__in=paid)
    if subevent is not None:
        positions = positions.filter(subevent=subevent)
    for row in (
        positions.values("item_id", "variation_id")
        .annotate(n=Count("pk"), total=Sum("price"))
        .order_by()
    ):
        product = book.share(PART_ONLINE).products.setdefault(
            (row["item_id"], row["variation_id"]),
            {"count": 0, "total": ZERO, "item_name": "", "variation_name": None},
        )
        product["count"] += row["n"]
        product["total"] += row["total"]

    fees = OrderFee.objects.filter(order__in=paid)
    if subevent is not None:
        # A fee names no date: it goes with the order's first one.
        first = _first_dates(list(paid.values_list("pk", flat=True)))
        fees = fees.filter(
            order_id__in=[order for order, date in first.items() if date == subevent.pk]
        )
    for row in fees.values("fee_type").annotate(n=Count("pk"), total=Sum("value")).order_by():
        fee = book.share(PART_ONLINE).fees.setdefault(
            str(FEE_NAMES.get(row["fee_type"], row["fee_type"])), {"count": 0, "total": ZERO}
        )
        fee["count"] += row["n"]
        fee["total"] += row["total"]

    net = defaultdict(lambda: ZERO)
    for order_id, amount in (
        OrderPayment.objects.filter(
            order__in=orders,
            state__in=(OrderPayment.PAYMENT_STATE_CONFIRMED, OrderPayment.PAYMENT_STATE_REFUNDED),
        )
        .values("order_id")
        .annotate(s=Sum("amount"))
        .values_list("order_id", "s")
        .order_by()
    ):
        net[order_id] += amount
    for order_id, amount in (
        OrderRefund.objects.filter(
            order__in=orders,
            state__in=(
                OrderRefund.REFUND_STATE_DONE,
                OrderRefund.REFUND_STATE_TRANSIT,
                OrderRefund.REFUND_STATE_CREATED,
            ),
        )
        .values("order_id")
        .annotate(s=Sum("amount"))
        .values_list("order_id", "s")
        .order_by()
    ):
        net[order_id] -= amount
    money = (
        _money_on(subevent, net) if subevent is not None and net
        else sum(net.values(), ZERO)
    )
    if money:
        share = book.share(PART_ONLINE)
        share.money[ONLINE] += money
        book.held(share, online_holder(event), (VIA_ONLINE, ""), money)


def statement(event, subevent=None):
    """
    The evening of ``event`` — in a series, of ``subevent``, or of every date
    with ``None`` — shared between its associations.
    """
    book = Book(event)
    test_rows = till_part(book, event, subevent)
    online_part(book, event, subevent)

    associations = {
        association.pk: association
        for association in PosAssociation.objects.filter(organizer=event.organizer)
    }
    lines = [share.as_dict(event) for share in sorted(book.shares.values(), key=lambda s: s.order)]
    totals = {
        key: sum((line[key] for line in lines), ZERO)
        for key in ("sold", "deposits_total", "cash", "card", "online", "total")
    }
    return {
        "shares": lines,
        "totals": totals,
        "transfers": book.transfers(associations),
        "reader_unheld": book.reader_unheld or None,
        "unplaced": book.unplaced or None,
        "missing_parts": [
            str(PART_LABELS[part]) for part in PARTS if book.by_part.get(part) is None
        ],
        "test_rows": test_rows,
    }
