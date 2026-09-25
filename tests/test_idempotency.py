"""
One sale, however many requests carry it — and whenever they arrive.

``test_checkout`` covers the retry that comes after the first attempt has
finished. These are the ones that do not wait for it: a till whose request
timed out while the server was still working, polls stacking up behind a slow
SumUp and confirming the same payment twice. Two attempts under one key, both
past the look-up before either has committed, used to create an order each —
and the second one stayed, paid, with a ticket in it and no journal line.

On one database connection, a test cannot run two attempts side by side. What
it can do is have the first attempt commit at the exact moment the second one
is exposed to it: after the second has looked the key up and found nothing,
before it writes. That is what :func:`overlapping` arranges. The real thing, on
two connections, is at the bottom, for PostgreSQL.
"""
import threading
import time
from contextlib import contextmanager
from decimal import Decimal
from types import SimpleNamespace

import pytest
from django.db import OperationalError, connection, connections
from django.utils.timezone import now
from pretix.base.models import Checkin, Order

from pretix_openpos.api import sales
from pretix_openpos.models import PosSale

from .conftest import Till, sell


def overlapping(monkeypatch, till, positions, key, **kwargs):
    """
    Have another attempt at this sale commit while the next one is under way.

    Hooked where the second attempt has already looked its key up and found
    nothing — the first was not finished — and has not written anything yet:
    exactly where a first attempt still running on another worker would
    commit. Returns a dict that holds the first attempt's answer once it ran.
    """
    real = sales.drawer_session_for
    first = {}

    def racing(*args, **kw):
        if "response" not in first:
            first["response"] = None
            first["response"] = sell(till, positions, idempotency_key=key, **kwargs)
        return real(*args, **kw)

    monkeypatch.setattr(sales, "drawer_session_for", racing)
    return first


@pytest.mark.django_db
def test_an_attempt_that_overlapped_the_first_answers_as_its_replay(
    monkeypatch, till, event, ticket, checkin_list
):
    event.settings.set("openpos_checkin_list", checkin_list.pk)
    first = overlapping(monkeypatch, till, [{"item": ticket.pk, "count": 1}], "race-key-1")

    second = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="race-key-1")

    assert first["response"].status_code == 201
    # What a retry a second later would have got: the sale, not a second one.
    assert second.status_code == 200, second.content
    body = second.json()
    assert body["replayed"] is True
    assert body["order"]["code"] == first["response"].json()["order"]["code"]
    # One order, one journal line, one person through the door.
    assert Order.objects.filter(event=event).count() == 1
    assert PosSale.objects.filter(event=event).count() == 1
    assert Checkin.objects.filter(position__order__event=event).count() == 1


@pytest.mark.django_db
def test_the_last_place_taken_by_the_first_attempt_does_not_refuse_the_second(
    monkeypatch, till, event, ticket
):
    """
    The refusal that would have gone out without the second look.

    The first attempt sold the last place, and the second — the same customer,
    the same money — reached pretix' quota check just after it. Refused, the
    till would have told the cashier the sale did not go through.
    """
    ticket.quotas.update(size=1)
    overlapping(monkeypatch, till, [{"item": ticket.pk, "count": 1}], "last-place-1")

    second = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="last-place-1")

    assert second.status_code == 200, second.content
    assert second.json()["replayed"] is True
    assert Order.objects.filter(event=event).count() == 1


@pytest.mark.django_db
def test_an_order_is_never_kept_beside_another_attempts_journal_line(
    monkeypatch, till, event, ticket
):
    """
    The last line of defence, for a writer that did not wait for the key.

    The wait is PostgreSQL's; on any other database, or for an attempt that
    got past it some other way, the journal's unique key is what notices. The
    order this attempt had already created goes with the rollback, and the
    answer is the replay.
    """
    monkeypatch.setattr(sales, "hold_idempotency_key", lambda event, key: None)
    first = overlapping(monkeypatch, till, [{"item": ticket.pk, "count": 1}], "safety-key-1")

    second = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="safety-key-1")

    assert second.status_code == 200, second.content
    assert second.json()["replayed"] is True
    assert second.json()["order"]["code"] == first["response"].json()["order"]["code"]
    assert Order.objects.filter(event=event).count() == 1
    assert PosSale.objects.filter(event=event).count() == 1


@pytest.mark.django_db
def test_returned_cups_alone_are_paid_out_once_however_they_overlap(
    monkeypatch, till, event, deposit
):
    # A basket of returned cups is a journal row keyed on the till's key
    # itself, with no order: the same guard has to hold for it.
    monkeypatch.setattr(sales, "hold_idempotency_key", lambda event, key: None)
    cups = [{"item": deposit.pk, "count": 2, "refund": True}]
    overlapping(monkeypatch, till, cups, "cups-key-1")

    second = sell(till, cups, idempotency_key="cups-key-1")

    assert second.status_code == 200, second.content
    assert second.json()["replayed"] is True
    assert PosSale.objects.filter(event=event).count() == 1


@pytest.mark.django_db
def test_a_sale_whose_payout_row_cannot_be_written_leaves_no_order(
    till, event, beer, deposit
):
    """
    The deposit half is held to the same rule as the sale.

    Its key is derived from the sale's, and finding it taken means the journal
    and this request disagree about what happened. Handing that row back as
    this sale's payout was the old answer; now nothing this request wrote is
    kept, the order included, and the fault is left to be seen.
    """
    PosSale.record(
        event=event, order=None, device=None, cashier="", payment_type="cash",
        total=Decimal("-1.00"), positions=[], idempotency_key="payout-key-1:refund",
        kind=PosSale.KIND_DEPOSIT_REFUND,
    )

    with pytest.raises(PosSale.AlreadyRecorded):
        sell(
            till,
            [
                {"item": beer.pk, "count": 1},
                {"item": deposit.pk, "count": 1, "refund": True},
            ],
            idempotency_key="payout-key-1",
        )

    assert not Order.objects.filter(event=event).exists()
    assert PosSale.objects.filter(event=event).count() == 1


@pytest.mark.django_db
def test_a_key_shaped_like_a_payout_key_is_refused(till, event, beer):
    response = sell(till, [{"item": beer.pk, "count": 1}], idempotency_key="some-sale:refund")

    # It would name the deposit half of another sale.
    assert response.status_code == 400
    assert "idempotency_key" in response.json()
    assert not PosSale.objects.filter(event=event).exists()


@pytest.mark.django_db
def test_the_journal_says_so_when_asked_not_to_hand_back_an_existing_row(event):
    first = PosSale.record(
        event=event, order=None, device=None, cashier="", payment_type="cash",
        total=Decimal("-1.00"), positions=[], idempotency_key="journal-key-1",
        kind=PosSale.KIND_DEPOSIT_REFUND,
    )

    with pytest.raises(PosSale.AlreadyRecorded) as refused:
        PosSale.record(
            event=event, order=None, device=None, cashier="", payment_type="cash",
            total=Decimal("-2.00"), positions=[], idempotency_key="journal-key-1",
            kind=PosSale.KIND_DEPOSIT_REFUND, existing_ok=False,
        )

    assert refused.value.sale == first
    # The default is unchanged: the back office's reversals rely on it.
    again = PosSale.record(
        event=event, order=None, device=None, cashier="", payment_type="cash",
        total=Decimal("-2.00"), positions=[], idempotency_key="journal-key-1",
        kind=PosSale.KIND_DEPOSIT_REFUND,
    )
    assert again == first


# -- a retry is answered whatever it says now ---------------------------------


#: What a retry may say that the first attempt did not.
RETRY_CHANGES = {
    # The tariff moved after the sale: the figure the till quotes is stale.
    "a stale expected total": {"expected_total": "3.00"},
    # A request the checkout would refuse outright on its own.
    "no lines at all": {"positions": []},
    "a payment type it no longer knows": {"payment_type": "cheque"},
    # An offline sale retried long after its window had closed.
    "an offline block from years ago": {
        "offline": {
            "recorded_at": "2020-01-01T20:00:00+00:00",
            "charged_total": "10.00",
        },
    },
}


@pytest.mark.django_db
@pytest.mark.parametrize("change", list(RETRY_CHANGES))
def test_a_retry_of_a_recorded_sale_gets_it_back_whatever_it_now_says(
    till, event, ticket, change
):
    first = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="said-once-1")
    ticket.default_price = Decimal("12.00")
    ticket.save(update_fields=["default_price"])

    body = {
        "idempotency_key": "said-once-1",
        "positions": [{"item": ticket.pk, "count": 1}],
        "payment_type": "cash",
        **RETRY_CHANGES[change],
    }
    retry = till.post("checkout", body)

    # Refused, it told the till the sale had not gone through — and the
    # cashier took the money again for a sale that already had.
    assert retry.status_code == 200, retry.content
    assert retry.json()["replayed"] is True
    assert retry.json()["order"]["code"] == first.json()["order"]["code"]
    assert Order.objects.filter(event=event).count() == 1


@pytest.mark.django_db
@pytest.mark.parametrize("key", [None, "short", {"not": "a key"}, ""])
def test_a_request_with_no_usable_key_is_still_refused(till, event, ticket, key):
    body = {"positions": [{"item": ticket.pk, "count": 1}], "payment_type": "cash"}
    if key is not None:
        body["idempotency_key"] = key

    response = till.post("checkout", body)

    # There is nothing to look up, and nothing to make a retry safe with.
    assert response.status_code == 400
    assert "idempotency_key" in response.json()
    assert not Order.objects.filter(event=event).exists()


@pytest.mark.django_db
def test_a_request_that_is_not_an_object_is_refused(till, event):
    response = till.post("checkout", ["not", "a", "sale"])

    assert response.status_code == 400
    assert not Order.objects.filter(event=event).exists()


@pytest.mark.django_db
def test_a_refusal_decided_while_the_same_sale_was_committing_becomes_its_replay(
    monkeypatch, till, event, ticket
):
    """
    Judged against a catalogue the first attempt had just moved.

    The second attempt was checked before its transaction, while the first was
    committing the very same sale. A refusal from then is about a sale nobody
    had recorded yet — and by the time it would be sent, somebody has.
    """
    overlapping(
        monkeypatch, till, [{"item": ticket.pk, "count": 1}], "late-no-1",
        expected_total="10.00",
    )

    second = sell(
        till, [{"item": ticket.pk, "count": 1}], idempotency_key="late-no-1",
        expected_total="99.00",
    )

    assert second.status_code == 200, second.content
    assert second.json()["replayed"] is True
    assert Order.objects.filter(event=event).count() == 1


@pytest.mark.django_db
def test_a_refusal_of_a_sale_nobody_recorded_stands(monkeypatch, till, event, ticket):
    response = sell(
        till, [{"item": ticket.pk, "count": 1}], idempotency_key="plain-no-1",
        expected_total="99.00",
    )

    assert response.status_code == 400
    assert response.json()["code"] == "price_changed"


# -- the tail, once ------------------------------------------------------------


@pytest.mark.django_db
def test_the_invoice_and_the_entry_are_written_once_when_a_retry_finishes_first(
    monkeypatch, till, event, ticket, checkin_list
):
    """
    Two requests for one sale, both finishing its tail.

    The retry found the sale committed and did the invoice and the check-in
    before the first attempt got to them. The first then finds both done:
    no second invoice, no second entry — and it still tells its till the
    customer is in, because they are.
    """
    event.settings.set("openpos_checkin_list", checkin_list.pk)
    real = sales.CheckoutActions._post_commit
    retry = {}

    def retry_gets_there_first(self, request, order):
        real(self, request, order)
        if "response" not in retry:
            retry["response"] = None
            retry["response"] = sell(
                till, [{"item": ticket.pk, "count": 1}], idempotency_key="tail-key-1"
            )

    monkeypatch.setattr(sales.CheckoutActions, "_post_commit", retry_gets_there_first)

    first = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="tail-key-1")

    assert retry["response"].json()["replayed"] is True
    assert retry["response"].json()["checked_in"] == 1
    assert first.status_code == 201
    assert first.json()["checked_in"] == 1
    order = Order.objects.get(event=event)
    assert Checkin.objects.filter(position__order=order).count() == 1
    assert order.invoices.count() == 1


@pytest.mark.django_db
def test_an_invoice_failing_in_the_database_still_leaves_the_check_in(
    monkeypatch, till, event, ticket, checkin_list
):
    # The tail runs in one transaction, and on PostgreSQL a statement that
    # fails poisons it: without a savepoint of its own, an invoice that broke
    # in the database took the customer's check-in down with it.
    event.settings.set("openpos_checkin_list", checkin_list.pk)

    def broken(*args, **kwargs):
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM a_table_that_does_not_exist")

    monkeypatch.setattr(sales, "generate_invoice", broken)

    body = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    assert body["checked_in"] == 1
    order = Order.objects.get(event=event)
    assert order.invoices.count() == 0
    assert order.all_logentries().filter(
        action_type="pretix.event.order.invoice.failed"
    ).exists()


# -- the lock itself, on any database ---------------------------------------------
#
# The lock is PostgreSQL's, and the tests that watch it hold two attempts apart
# only run there (below). What it is asked to lock, and what the till is told
# when the wait runs out, can be checked anywhere: the connection is stood in
# for, at the one place the lock is taken.


class _PostgresStandIn:
    """What the lock would have sent PostgreSQL, and PostgreSQL giving up on it."""

    vendor = "postgresql"

    def __init__(self, gives_up=False):
        self.gives_up = gives_up
        self.statements = []

    @contextmanager
    def cursor(self):
        yield self

    def execute(self, sql, params=None):
        self.statements.append((sql, params))
        if self.gives_up and "pg_advisory_xact_lock" in sql:
            raise OperationalError("canceling statement due to lock timeout")

    def lock_taken(self):
        return next(params for sql, params in self.statements if "pg_advisory_xact_lock" in sql)


@pytest.mark.django_db
def test_every_worker_takes_the_same_lock_for_the_same_sale(monkeypatch, event):
    stand_in = _PostgresStandIn()
    monkeypatch.setattr(sales, "connection", stand_in)

    def lock_for(on_event, key):
        stand_in.statements.clear()
        sales._lock_idempotency_key(on_event, key)
        return stand_in.lock_taken()

    # A number no worker could arrive at differently: fixed by the event and
    # the key alone, not by anything a process picks for itself at start-up
    # the way Python's own hash() does.
    assert lock_for(SimpleNamespace(pk=1), "stable-key-01") == [sales.KEY_LOCK_CLASS, -1913388828]
    assert lock_for(event, "same-key-01") == lock_for(event, "same-key-01")
    assert lock_for(event, "same-key-01") != lock_for(event, "other-key-01")
    assert lock_for(event, "same-key-01") != lock_for(SimpleNamespace(pk=event.pk + 1), "same-key-01")
    # Waited on for a bounded time, which then stops applying to the rest of
    # the transaction: pretix' own locks further on keep their own patience.
    assert [sql for sql, _params in stand_in.statements] == [
        f"SET LOCAL lock_timeout = '{sales.KEY_WAIT_SECONDS}s'",
        "SELECT pg_advisory_xact_lock(%s, %s)",
        "SET LOCAL lock_timeout TO DEFAULT",
    ]


@pytest.mark.django_db
def test_a_sale_whose_key_stays_held_is_answered_not_now(monkeypatch, till, event, ticket):
    monkeypatch.setattr(sales, "connection", _PostgresStandIn(gives_up=True))

    response = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="held-key-01")

    # A 5xx, which the app sends again under the same key, rather than a 4xx,
    # which it would list as a refused sale.
    assert response.status_code == 503
    assert response["Retry-After"] == "2"
    assert response.json() == {
        "detail": "This sale is still being recorded. Try again in a moment.",
        "code": "sale_in_progress",
    }
    assert not PosSale.objects.exists()
    assert not Order.objects.filter(event=event).exists()


# -- two real connections, for PostgreSQL ---------------------------------------


def _on_postgresql():
    if connection.vendor != "postgresql":
        pytest.skip("advisory locks are PostgreSQL's; SQLite lets one writer in at a time")


def _in_thread(target):
    """Run ``target`` on a thread of its own, with a connection of its own."""
    result = {}

    def run():
        try:
            result["value"] = target()
        except BaseException as exc:
            result["error"] = exc
        finally:
            connections.close_all()

    thread = threading.Thread(target=run)
    thread.start()
    return thread, result


@pytest.mark.django_db(transaction=True)
def test_two_workers_on_one_sale_make_one_order(monkeypatch, event, ticket, device):
    _on_postgresql()
    real = sales.hold_drawer_session
    inside = threading.Event()
    writers = []

    def slow(session, payment_type):
        # The first attempt holds the key, inside its transaction, while the
        # second one arrives.
        writers.append(threading.get_ident())
        if not inside.is_set():
            inside.set()
            time.sleep(1)
        return real(session, payment_type)

    monkeypatch.setattr(sales, "hold_drawer_session", slow)
    basket = [{"item": ticket.pk, "count": 1}]

    first, first_result = _in_thread(
        lambda: sell(Till(device, event), basket, idempotency_key="two-workers-1")
    )
    assert inside.wait(10)
    second, second_result = _in_thread(
        lambda: sell(Till(device, event), basket, idempotency_key="two-workers-1")
    )
    first.join(30)
    second.join(30)

    assert "error" not in first_result and "error" not in second_result
    answers = sorted(r["value"].status_code for r in (first_result, second_result))
    assert answers == [200, 201]
    assert second_result["value"].json()["replayed"] is True
    assert Order.objects.filter(event=event).count() == 1
    assert PosSale.objects.filter(event=event).count() == 1
    # And it was the wait that did it, not the journal's unique key: the
    # second attempt never got as far as writing anything to roll back.
    assert len(writers) == 1


@pytest.mark.django_db(transaction=True)
def test_an_attempt_stuck_behind_another_is_told_to_come_back(
    monkeypatch, event, ticket, device
):
    _on_postgresql()
    monkeypatch.setattr(sales, "KEY_WAIT_SECONDS", 1)
    real = sales.hold_drawer_session
    inside = threading.Event()

    def stuck(session, payment_type):
        if not inside.is_set():
            inside.set()
            time.sleep(3)
        return real(session, payment_type)

    monkeypatch.setattr(sales, "hold_drawer_session", stuck)
    basket = [{"item": ticket.pk, "count": 1}]

    first, first_result = _in_thread(
        lambda: sell(Till(device, event), basket, idempotency_key="stuck-key-1")
    )
    assert inside.wait(10)
    started = now()
    waiting = sell(Till(device, event), basket, idempotency_key="stuck-key-1")
    waited = (now() - started).total_seconds()
    first.join(30)

    # Not a refusal: a 5xx is what the app retries, under the same key. And
    # not a worker held for as long as the other attempt is stuck.
    assert waiting.status_code == 503
    assert waiting.json()["code"] == "sale_in_progress"
    assert waiting["Retry-After"] == "2"
    assert waited < 2.5
    assert first_result["value"].status_code == 201
    # And the retry, once the first has committed, is its replay.
    retry = sell(Till(device, event), basket, idempotency_key="stuck-key-1")
    assert retry.status_code == 200
    assert Order.objects.filter(event=event).count() == 1
