"""
Replaying what a till sold while it had no network.

The rule the whole feature rests on: by the time one of these arrives, the money
is in the drawer and the customer has walked in. The server's job is to record
that faithfully and report what does not add up — never to refuse it, because a
refusal here does not undo the sale, it strands it in a browser, outside pretix
and outside the journal.
"""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils import translation
from django.utils.timezone import now
from pretix.base.models import Order

from pretix_openpos.models import PosSale

from .conftest import sell


def offline_sale(till, positions, at=None, charged=None, sent_at=None, **kwargs):
    """A sale rung up with no network, arriving late."""
    total = charged or sum(
        (Decimal(p["price"]) * p["count"] for p in positions), Decimal("0.00")
    )
    offline = {
        "recorded_at": (at or (now() - timedelta(hours=2))).isoformat(),
        "charged_total": str(total),
    }
    if sent_at is not None:
        offline["sent_at"] = sent_at.isoformat()
    return sell(till, positions, offline=offline, **kwargs)


@pytest.mark.django_db
def test_the_order_is_created_at_what_the_customer_actually_paid(till, event, ticket):
    ticket.default_price = Decimal("12.00")
    ticket.save(update_fields=["default_price"])

    body = offline_sale(till, [{"item": ticket.pk, "count": 1, "price": "10.00"}]).json()

    # Anything else would print an invoice for a sum nobody handed over.
    assert body["order"]["total"] == "10.00"
    assert Order.objects.get(code=body["order"]["code"]).total == Decimal("10.00")


@pytest.mark.django_db
def test_a_price_that_moved_during_the_dropout_is_reported(till, event, ticket):
    ticket.default_price = Decimal("12.00")
    ticket.save(update_fields=["default_price"])

    body = offline_sale(till, [{"item": ticket.pk, "count": 1, "price": "10.00"}]).json()

    assert body["off_tariff"] == [
        {
            "item": ticket.pk,
            "item_name": "Entrée",
            "variation": None,
            "variation_name": None,
            "charged": "10.00",
            "tariff": "12.00",
        }
    ]
    # And on the journal line itself, so it survives the tariff being edited again.
    sale = PosSale.objects.get(seq=body["journal_seq"])
    assert sale.positions[0]["tariff_price"] == "12.00"

    # And in the order's own history, which is where somebody looks when one
    # order's total does not match the price list two days later. The till's
    # resync panel used to be the only place this was ever said.
    entry = (
        Order.objects.get(code=body["order"]["code"])
        .all_logentries()
        .get(action_type="pretix_openpos.order.off_tariff")
    )
    assert entry.parsed_data["lines"][0]["charged"] == "10.00"
    assert "10.00" in entry.display() and "12.00" in entry.display()
    assert "Entrée" in entry.display()


@pytest.mark.django_db
def test_a_sale_at_the_current_tariff_reports_nothing(till, ticket):
    body = offline_sale(till, [{"item": ticket.pk, "count": 1, "price": "10.00"}]).json()

    assert body["off_tariff"] == []


@pytest.mark.django_db
def test_the_journal_dates_the_sale_when_the_money_moved(till, event, ticket):
    paid_at = now() - timedelta(hours=3)

    body = offline_sale(
        till, [{"item": ticket.pk, "count": 1, "price": "10.00"}], at=paid_at
    ).json()

    sale = PosSale.objects.get(seq=body["journal_seq"])
    assert abs(sale.datetime - paid_at) < timedelta(seconds=1)
    assert sale.offline is True
    # The order's own creation date stays honest: it really was created now.
    order = Order.objects.get(code=body["order"]["code"])
    assert order.datetime > paid_at + timedelta(hours=1)
    # But the payment carries the moment at the door, because that is what
    # reports read.
    assert abs(order.payments.first().payment_date - paid_at) < timedelta(seconds=1)


@pytest.mark.django_db
def test_a_quota_that_ran_out_during_the_dropout_does_not_strand_the_sale(
    till, event, ticket
):
    """
    The hole this closes.

    Selling online carried on while the till was cut off, and the room filled
    up. Refusing the replay would leave a paid sale with no order behind it and
    no journal line either — recorded nowhere but in one tablet's browser
    storage, which is the one place an append-only journal exists to avoid.
    """
    ticket.quotas.update(size=0)

    body = offline_sale(till, [{"item": ticket.pk, "count": 1, "price": "10.00"}]).json()

    assert Order.objects.get(code=body["order"]["code"]).total == Decimal("10.00")
    # Findable afterwards, which is what makes it a fact to reconcile rather
    # than a fact to discover.
    assert PosSale.objects.get(seq=body["journal_seq"]).offline is True


@pytest.mark.django_db
def test_a_till_that_is_online_still_cannot_oversell(till, event, ticket):
    ticket.quotas.update(size=0)

    response = sell(till, [{"item": ticket.pk, "count": 1}])

    # Nothing has been taken yet, so the quota is exactly what should stop this.
    assert response.status_code == 400
    assert not Order.objects.filter(event=event).exists()


@pytest.mark.django_db
def test_a_product_pulled_from_the_till_during_the_dropout_is_still_recorded(
    till, event, ticket
):
    ticket.limit_sales_channels.clear()

    body = offline_sale(till, [{"item": ticket.pk, "count": 1, "price": "10.00"}]).json()

    assert Order.objects.get(code=body["order"]["code"]).total == Decimal("10.00")


@pytest.mark.django_db
def test_an_option_switched_off_during_the_dropout_is_still_recorded(till, shirt):
    item, small, _large = shirt
    small.active = False
    small.save()

    body = offline_sale(
        till, [{"item": item.pk, "variation": small.pk, "count": 1, "price": "15.00"}]
    ).json()

    assert body["order"]["total"] == "15.00"


@pytest.mark.django_db
def test_an_option_that_never_existed_is_still_refused(till, shirt):
    item, _small, large = shirt

    response = offline_sale(
        till, [{"item": item.pk, "variation": large.pk + 999, "count": 1, "price": "15.00"}]
    )

    # Forgiving about the catalogue moving is not the same as inventing a
    # product: there is nothing here to create an order position from.
    assert response.status_code == 400


@pytest.mark.django_db
def test_lines_that_do_not_add_up_to_the_total_charged_are_refused(till, ticket):
    response = offline_sale(
        till, [{"item": ticket.pk, "count": 2, "price": "10.00"}], charged=Decimal("10.00")
    )

    # The checksum against a queue corrupted in storage. Guessing which half is
    # right is the one thing not to do with money.
    assert response.status_code == 400


@pytest.mark.django_db
def test_a_partly_priced_basket_is_refused(till, ticket, beer):
    response = sell(
        till,
        [
            {"item": ticket.pk, "count": 1, "price": "10.00"},
            {"item": beer.pk, "count": 1},
        ],
        offline={"recorded_at": now().isoformat(), "charged_total": "13.00"},
    )

    assert response.status_code == 400


@pytest.mark.django_db
def test_an_offline_sale_cannot_carry_an_expected_total(till, ticket):
    response = offline_sale(
        till, [{"item": ticket.pk, "count": 1, "price": "10.00"}], expected_total="10.00"
    )

    # It answers a question the till could not have asked while it was cut off.
    assert response.status_code == 400


@pytest.mark.django_db
def test_a_sale_dated_in_the_future_is_refused(till, ticket):
    response = offline_sale(
        till, [{"item": ticket.pk, "count": 1, "price": "10.00"}], at=now() + timedelta(days=1)
    )

    assert response.status_code == 400


@pytest.mark.django_db
def test_a_sale_older_than_a_week_is_refused(till, ticket):
    response = offline_sale(
        till, [{"item": ticket.pk, "count": 1, "price": "10.00"}], at=now() - timedelta(days=8)
    )

    # A night is hours; a week is somebody replaying an old backup.
    assert response.status_code == 400


@pytest.mark.django_db
def test_replaying_the_same_offline_sale_twice_sells_it_once(till, event, ticket):
    first = offline_sale(
        till, [{"item": ticket.pk, "count": 1, "price": "10.00"}],
        idempotency_key="queued-sale-1",
    )
    second = offline_sale(
        till, [{"item": ticket.pk, "count": 1, "price": "10.00"}],
        idempotency_key="queued-sale-1",
    )

    assert first.status_code == 201
    assert second.status_code == 200
    assert Order.objects.filter(event=event).count() == 1


@pytest.mark.django_db
def test_a_replayed_basket_with_an_unpriced_line_is_refused_whole(till, ticket, beer):
    """
    A queue entry damaged in storage. The prices of a sale taken offline come
    from the lines, so a line without one leaves no figure at all — and
    guessing the missing half would put a number nobody handed over on an
    invoice.
    """
    response = offline_sale(
        till,
        [{"item": ticket.pk, "count": 1, "price": "10.00"}, {"item": beer.pk, "count": 1}],
        charged="10.00",
    )

    assert response.status_code == 400
    assert "must carry the price charged" in str(response.json()["positions"])


# -- a till whose clock is wrong ------------------------------------------------
#
# A till dates what it queues by its own clock, and says what that clock reads
# when it sends the queue (``sent_at``). The difference with the server's is the
# error that is in every date the till wrote, and it is taken out before the
# sale is judged or stored.


def journal_row(body):
    return PosSale.objects.get(seq=body["journal_seq"])


def clock_entry(body):
    return (
        Order.objects.get(code=body["order"]["code"])
        .all_logentries()
        .filter(action_type="pretix_openpos.order.clock_corrected")
        .first()
    )


@pytest.mark.django_db
def test_a_till_six_minutes_fast_no_longer_has_its_queue_refused(till, ticket, device):
    """
    The case this exists for: an iPad whose clock runs six minutes fast.

    It dated a sale rung up half a minute ago five and a half minutes into the
    future, and the replay refused it as dated in the future — every sale of
    the dropout, for customers who had paid and walked in.
    """
    fast = timedelta(minutes=6)
    rung_up = now() - timedelta(seconds=30)
    line = [{"item": ticket.pk, "count": 1, "price": "10.00"}]

    refused = offline_sale(till, line, at=rung_up + fast, idempotency_key="fast-old-1")
    assert refused.status_code == 400

    response = offline_sale(
        till, line, at=rung_up + fast, sent_at=now() + fast, idempotency_key="fast-new-1"
    )

    assert response.status_code == 201, response.content
    body = response.json()
    assert -362 <= body["clock_correction_seconds"] <= -358
    # The journal and the payment carry the moment the money moved, on the
    # server's clock.
    assert abs(journal_row(body).datetime - rung_up) < timedelta(seconds=3)
    order = Order.objects.get(code=body["order"]["code"])
    assert abs(order.payments.first().payment_date - rung_up) < timedelta(seconds=3)
    # And the order says it was corrected, from what, by how much, on which till.
    entry = clock_entry(body)
    assert entry.parsed_data["seconds"] == body["clock_correction_seconds"]
    assert entry.parsed_data["device"] == device.name
    with translation.override("en"):
        text = str(entry.display())
    assert "fast" in text and "6 min" in text and device.name in text


@pytest.mark.django_db
def test_a_till_days_slow_is_corrected_the_other_way(till, event, ticket):
    # A tablet whose battery ran flat came back a week and a day behind: its
    # sale from an hour ago looked too old to replay.
    slow = timedelta(days=8)
    rung_up = now() - timedelta(hours=1)

    response = offline_sale(
        till, [{"item": ticket.pk, "count": 1, "price": "10.00"}],
        at=rung_up - slow, sent_at=now() - slow,
    )

    assert response.status_code == 201, response.content
    body = response.json()
    assert body["clock_correction_seconds"] >= 8 * 86400 - 2
    assert abs(journal_row(body).datetime - rung_up) < timedelta(seconds=3)
    with translation.override("en"):
        text = str(clock_entry(body).display())
    assert "slow" in text and "8 d" in text


@pytest.mark.django_db
def test_a_clock_within_a_minute_is_left_alone(till, ticket):
    rung_up = now() - timedelta(hours=1)

    response = offline_sale(
        till, [{"item": ticket.pk, "count": 1, "price": "10.00"}],
        at=rung_up, sent_at=now() + timedelta(seconds=40),
    )

    # Forty seconds is a request in flight or a clock drifting, not a wrong
    # clock: nothing is moved, and nothing is said.
    body = response.json()
    assert body["clock_correction_seconds"] == 0
    assert abs(journal_row(body).datetime - rung_up) < timedelta(seconds=1)
    assert clock_entry(body) is None


@pytest.mark.django_db
def test_an_older_till_that_sends_no_clock_is_judged_as_before(till, ticket):
    rung_up = now() - timedelta(hours=1)

    body = offline_sale(
        till, [{"item": ticket.pk, "count": 1, "price": "10.00"}], at=rung_up
    ).json()

    assert body["clock_correction_seconds"] == 0
    assert abs(journal_row(body).datetime - rung_up) < timedelta(seconds=1)


@pytest.mark.django_db
@pytest.mark.parametrize(
    "rung_up_real",
    [
        # Still in the future once the till's clock is accounted for.
        timedelta(minutes=20),
        # Still older than a week.
        -timedelta(days=8),
    ],
)
def test_the_window_still_applies_once_the_clock_is_corrected(till, ticket, rung_up_real):
    fast = timedelta(hours=1)

    response = offline_sale(
        till, [{"item": ticket.pk, "count": 1, "price": "10.00"}],
        at=now() + rung_up_real + fast, sent_at=now() + fast,
    )

    assert response.status_code == 400
    assert "recorded_at" in response.json()["offline"]


@pytest.mark.django_db
def test_a_basket_of_returned_cups_is_corrected_too(till, event, deposit):
    # No order to write the trace on — the journal row and the answer carry it.
    fast = timedelta(minutes=10)
    rung_up = now() - timedelta(minutes=2)

    body = offline_sale(
        till, [{"item": deposit.pk, "count": 1, "refund": True, "price": "-1.00"}],
        at=rung_up + fast, sent_at=now() + fast,
    ).json()

    assert body["clock_correction_seconds"] <= -598
    assert abs(journal_row(body).datetime - rung_up) < timedelta(seconds=3)


@pytest.mark.django_db
def test_a_sale_rung_up_online_reports_no_correction(till, ticket):
    body = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    assert body["clock_correction_seconds"] == 0


@pytest.mark.django_db
def test_the_till_is_told_the_server_s_clock(till):
    from datetime import datetime, timezone

    body = till.get("config").json()

    # UTC, with milliseconds at most, which every browser's Date can read.
    assert body["server_time"].endswith("+00:00")
    server = datetime.fromisoformat(body["server_time"])
    assert server.tzinfo is not None
    assert abs(server - datetime.now(timezone.utc)) < timedelta(seconds=5)
    assert len(body["server_time"].split(".")[1]) == len("123+00:00")


@pytest.mark.django_db
@pytest.mark.parametrize(
    "seconds, says",
    [(-75, "1 min 15 s"), (-7260, "2 h 1 min"), (90000, "1 d 1 h")],
)
def test_a_correction_is_said_in_the_units_a_person_would_use(event, seconds, says):
    from pretix_openpos.logdisplay import ClockCorrected

    class Entry:
        pass

    entry = Entry()
    entry.event = event
    with translation.override("en"):
        text = str(ClockCorrected().display(entry, {
            "seconds": seconds,
            "recorded_at": "2026-08-16T21:00:00+00:00",
            "claimed_at": "not a date",
            "device": "",
        }))

    assert says in text
    assert ("fast" if seconds < 0 else "slow") in text
    # What was written, when it cannot be read as a date; a till, when none is named.
    assert "not a date" in text
    assert "a till" in text
