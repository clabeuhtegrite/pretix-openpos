"""
What an event took, read from the till journal.

One computation for the two places that show it — the till's closing screen and
the back office's *Ventes* page — so the two can never disagree about what a
figure means.

Everything comes from the journal and nothing from pretix' orders. The journal
is what reconciles against the drawer: it holds the deposits handed back, which
no order can carry, and it survives the test-mode purge that takes orders away.
Every row carries a snapshot of what was sold, so the breakdown by product is
the journal read line by line — and a line that was cancelled is there twice,
once sold and once reversed, which is exactly what makes it net out.

The rule that keeps the whole report honest: every euro in the total is in
exactly one product line, the deposits or, for a row with no lines at all, the
``unallocated`` remainder, which is said rather than dropped. So the sections
always add up to the total, and a section that did not would be a bug visible
on screen rather than a figure quietly off.
"""
from decimal import Decimal

from pretix.base.models import Device, ItemVariation

from .models import PosSale

ZERO = Decimal("0.00")
CENT = Decimal("0.01")

#: What the report reads of each journal row.
ROW_FIELDS = (
    "seq", "kind", "datetime", "device_id", "device_serial", "device_name",
    "payment_type", "total", "positions", "testmode", "cancels_seq",
)


def money(amount):
    """
    An amount as the API writes it.

    Quantized because SQLite hands sums back with the trailing zeros gone —
    "50" where PostgreSQL says "50.00" — and this string is API surface.
    """
    return str(amount.quantize(CENT))


def journal_rows(queryset, subevent=None):
    """
    The journal rows of ``queryset`` in ``seq`` order, as plain dicts.

    With ``subevent``, only the rows of that date of a series. Every line of a
    series sale names the date it was sold for, and a reversal copies the lines
    it reverses, so a cancellation made a week later still lands on the evening
    whose takings it corrects. Filtered here rather than in the database
    because the date lives inside the JSON snapshot, which SQLite cannot search
    and PostgreSQL could only through an operator the test suite never runs.
    """
    rows = queryset.order_by("seq").values(*ROW_FIELDS)
    for row in rows.iterator(chunk_size=2000):
        if subevent is not None and not any(
            line.get("subevent") == subevent.pk for line in row["positions"] or ()
        ):
            continue
        yield row


class Figures:
    """Sales counted, and money per payment type, for one slice of the journal."""

    __slots__ = ("count", "cancellations", "cancelled_total", "deposit_refunds", "cash", "card")

    def __init__(self):
        self.count = 0
        self.cancellations = 0
        #: What the cancellations gave back, negative, already in cash and card.
        self.cancelled_total = ZERO
        self.deposit_refunds = 0
        self.cash = ZERO
        self.card = ZERO

    def add(self, row, reverses):
        """
        Count one row in. ``reverses`` is the kind of row a cancellation undoes.

        Sales, not journal rows: a cancellation or a returned cup is not a
        customer served, and counting one would say six when four were. Their
        money is another matter, and nets off on its own sign. A cancellation
        is counted as the sale it undoes, never as the rows it writes: undoing
        a basket that had cups handed back in it writes two, and "two
        cancellations" for one customer is the count that sends somebody
        looking for a second one.
        """
        if row["kind"] == PosSale.KIND_SALE:
            self.count += 1
        elif row["kind"] == PosSale.KIND_DEPOSIT_REFUND:
            self.deposit_refunds += 1
        else:
            self.cancelled_total += row["total"]
            if reverses == PosSale.KIND_SALE:
                self.cancellations += 1
        if row["payment_type"] == PosSale.PAYMENT_CARD:
            self.card += row["total"]
        elif row["payment_type"] == PosSale.PAYMENT_CASH:
            self.cash += row["total"]

    @property
    def total(self):
        return self.cash + self.card

    def as_dict(self):
        return {
            "count": self.count,
            "cancellations": self.cancellations,
            "cancelled_total": money(self.cancelled_total),
            "deposit_refunds": self.deposit_refunds,
            "cash": money(self.cash),
            "card": money(self.card),
            "total": money(self.total),
        }


def line_amount(line):
    """What one journal line came to, signed as it was written."""
    if line.get("line_total") is not None:
        return Decimal(str(line["line_total"]))
    return Decimal(str(line.get("unit_price") or "0")) * int(line.get("count") or 0)


def summarise(event, rows, *, device=None, night_of=None):
    """
    The takings of ``rows``, overall and broken down every way they are read.

    ``rows`` comes from :func:`journal_rows`. ``device`` is the one asking, so
    its own line can be singled out. ``night_of`` maps a moment to the evening
    it belongs to, for the split by evening — which only says anything when the
    rows span more than one.

    Test-mode rows are counted apart and kept out of every other figure: that
    money never existed, and it must not reach the figure a drawer is counted
    against.
    """
    from .api.views import deposit_item

    rows = list(rows)
    real = [row for row in rows if not row["testmode"]]
    test = [row for row in rows if row["testmode"]]

    # What each cancellation reverses. Usually a row that is in the slice as
    # well; not always — the back office filters by evening, and a sale can be
    # reversed on a later one — so the few that are missing are asked for.
    kinds = {row["seq"]: row["kind"] for row in rows}
    missing = {
        row["cancels_seq"]
        for row in real
        if row["kind"] == PosSale.KIND_CANCELLATION and row["cancels_seq"] not in kinds
    } - {None}
    if missing:
        kinds.update(
            PosSale.objects.filter(event=event, seq__in=missing).values_list("seq", "kind")
        )

    def origin(row):
        """The kind of money a row moves: a reversal moves its original's, backwards."""
        if row["kind"] == PosSale.KIND_CANCELLATION:
            return kinds.get(row["cancels_seq"], PosSale.KIND_SALE)
        return row["kind"]

    # The deposit is a product like any other when it is sold, and it is kept
    # out of the products all the same: a cup deposit is money held for
    # somebody until the cup comes back, not something the evening sold. It is
    # whatever product is set as the deposit now, and whatever product was
    # ever handed back as one, should the setting have moved during the night.
    deposit_ids = set()
    configured = deposit_item(event)
    if configured is not None:
        deposit_ids.add(configured.pk)
    for row in real:
        if origin(row) == PosSale.KIND_DEPOSIT_REFUND:
            deposit_ids.update(line.get("item") for line in row["positions"] or ())

    overall = Figures()
    mine = Figures()
    tests = Figures()
    by_device = {}
    by_night = {}
    products = {}
    taken = {"count": 0, "total": ZERO}
    returned = {"count": 0, "total": ZERO}
    allocated = ZERO

    for row in test:
        tests.add(row, origin(row))

    for row in real:
        kind = origin(row)
        overall.add(row, kind)
        here = device is not None and row["device_id"] == device.pk
        if here:
            mine.add(row, kind)

        # By device: the serial is the till's identity and survives the
        # device being deleted; the name is only what somebody reads.
        bucket = by_device.setdefault(
            row["device_serial"] or row["device_id"] or "",
            {"id": row["device_id"], "serial": row["device_serial"], "name": "",
             "current": False, "figures": Figures()},
        )
        bucket["figures"].add(row, kind)
        bucket["name"] = row["device_name"] or bucket["name"]
        bucket["current"] = bucket["current"] or here

        if night_of is not None:
            by_night.setdefault(night_of(row["datetime"]), Figures()).add(row, kind)

        for line in row["positions"] or ():
            count = int(line.get("count") or 0)
            amount = line_amount(line)
            allocated += amount
            if kind == PosSale.KIND_DEPOSIT_REFUND:
                returned["count"] += count
                returned["total"] += amount
                continue
            if line.get("item") in deposit_ids:
                taken["count"] += count
                taken["total"] += amount
                continue
            product = products.setdefault(
                (line.get("item"), line.get("variation")),
                {"count": 0, "total": ZERO, "item_name": "", "variation_name": None},
            )
            product["count"] += count
            product["total"] += amount
            # The journal's own names, for a product deleted since. The latest
            # wins, which is the name the product had last.
            product["item_name"] = line.get("item_name") or product["item_name"]
            product["variation_name"] = line.get("variation_name") or product["variation_name"]

    return {
        "event": overall.as_dict(),
        "device": mine.as_dict() if device is not None else None,
        "testmode": tests.as_dict() if test else None,
        "categories": categories(event, products),
        "deposits": (
            {
                "taken": {"count": taken["count"], "total": money(taken["total"])},
                "returned": {"count": returned["count"], "total": money(returned["total"])},
                "total": money(taken["total"] + returned["total"]),
            }
            if taken["count"] or returned["count"] or taken["total"] or returned["total"]
            else None
        ),
        # What no line accounts for: a row written with no lines at all. None
        # on any journal the till wrote itself, and said when it is not, so the
        # sections always add up to the total above them.
        "unallocated": (
            money(overall.total - allocated) if overall.total != allocated else None
        ),
        "devices": device_lines(by_device),
        "nights": [
            {"date": night.isoformat(), **figures.as_dict()}
            for night, figures in sorted(by_night.items())
        ],
        # By the clock, not by seq: a sale replayed after a dropout arrives
        # late and was rung up early.
        "first": min(row["datetime"] for row in real).isoformat() if real else None,
        "last": max(row["datetime"] for row in real).isoformat() if real else None,
    }


def device_lines(by_device):
    """
    One line per device that wrote to the journal, the biggest first.

    Named as pretix names the device now, since that is the name on the tablet
    and in the device list; the name the journal recorded stands in for one
    that has been deleted. A row with no device at all was written from the
    back office.
    """
    ids = [bucket["id"] for bucket in by_device.values() if bucket["id"]]
    names = dict(Device.objects.filter(pk__in=ids).values_list("pk", "name")) if ids else {}
    lines = [
        {
            "name": names.get(bucket["id"]) or bucket["name"] or bucket["serial"] or None,
            "serial": bucket["serial"] or None,
            "current": bucket["current"],
            **bucket["figures"].as_dict(),
        }
        for bucket in by_device.values()
    ]
    lines.sort(key=lambda line: (line["serial"] is None, -Decimal(line["total"]), line["name"] or ""))
    return lines


def categories(event, products):
    """
    The products sold, grouped under their category, in the order of the shop.

    The order of the shop rather than best sellers first: this is read by
    somebody looking for one product, and the grid they sell from is the map
    they already have. Categories and names are pretix' current ones, since a
    product renamed during the evening is still one product; one deleted since
    keeps the name the journal wrote down and joins the products that have no
    category. A product whose sales were all reversed is left out — a row of
    zeros is a line to read past, not information.
    """
    item_ids = {item for item, _variation in products if item}
    variation_ids = {variation for _item, variation in products if variation}
    items = {
        item.pk: item
        for item in event.items.filter(pk__in=item_ids).select_related("category")
    }
    variations = {
        variation.pk: variation
        for variation in ItemVariation.objects.filter(item__event=event, pk__in=variation_ids)
    }

    groups = {}
    for (item_id, variation_id), product in products.items():
        if product["count"] == 0 and product["total"] == ZERO:
            continue
        item = items.get(item_id)
        variation = variations.get(variation_id)
        category = item.category if item is not None else None
        group = groups.setdefault(
            category.pk if category else None,
            {
                "id": category.pk if category else None,
                # None for "no category", which each screen names in its own
                # language rather than in whatever this request was answered in.
                "name": str(category.name) if category else None,
                "order": (0, category.position, category.pk) if category else (1, 0, 0),
                "count": 0,
                "total": ZERO,
                "items": [],
            },
        )
        group["count"] += product["count"]
        group["total"] += product["total"]
        group["items"].append(
            {
                "item": item_id,
                "variation": variation_id,
                "name": str(item.name) if item is not None else product["item_name"],
                "variation_name": (
                    str(variation.value) if variation is not None else product["variation_name"]
                ),
                "count": product["count"],
                "total": money(product["total"]),
                "order": (
                    (0, item.position, item.pk) if item is not None else (1, 0, 0),
                    (variation.position, variation.pk) if variation is not None else (0, 0),
                    product["item_name"],
                ),
            }
        )

    result = []
    for group in sorted(groups.values(), key=lambda g: g["order"]):
        group["items"].sort(key=lambda line: line["order"])
        for line in group["items"]:
            del line["order"]
        del group["order"]
        group["total"] = money(group["total"])
        result.append(group)
    return result
