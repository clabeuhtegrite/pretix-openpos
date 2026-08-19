"""
The append-only journal.

Rows are never updated and never deleted, and each carries the hash of its
predecessor — so altering an earlier sale invalidates every hash after it and
verification points at the first row that no longer adds up. These tests are the
only place the guarantee is actually checked, which is the point: everything
else in the plugin assumes it.
"""
from decimal import Decimal

import pytest

from pretix_openpos.models import GENESIS_HASH, PosSale

from .conftest import sell


def journal(event):
    return list(PosSale.objects.filter(event=event).order_by("seq"))


@pytest.mark.django_db
def test_the_first_row_chains_onto_nothing(till, event, ticket):
    sell(till, [{"item": ticket.pk, "count": 1}])

    first = journal(event)[0]
    assert first.seq == 1
    assert first.previous_hash == GENESIS_HASH
    assert first.hash == first.compute_hash()


@pytest.mark.django_db
def test_every_row_carries_the_hash_of_the_one_before(till, event, ticket):
    for n in range(4):
        sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key=f"sale-{n}-xxxx")

    rows = journal(event)
    assert [row.seq for row in rows] == [1, 2, 3, 4]
    for previous, row in zip(rows, rows[1:]):
        assert row.previous_hash == previous.hash
    assert PosSale.verify_chain(event) is None


@pytest.mark.django_db
def test_editing_an_amount_behind_the_ledger_is_caught(till, event, ticket):
    for n in range(3):
        sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key=f"sale-{n}-xxxx")

    # Straight through the database, which is the only way this can happen at
    # all: the model refuses to update a row.
    PosSale.objects.filter(event=event, seq=2).update(total=Decimal("1.00"))

    bad = PosSale.verify_chain(event)
    assert bad is not None
    assert bad.seq == 2


@pytest.mark.django_db
def test_the_row_reported_is_the_first_one_that_stopped_adding_up(till, event, ticket):
    for n in range(5):
        sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key=f"sale-{n}-xxxx")

    PosSale.objects.filter(event=event, seq=2).update(cashier="somebody else")

    # Not seq 3, whose previous_hash is now wrong too: the point of the chain is
    # to name where history was touched, not where the damage first shows.
    assert PosSale.verify_chain(event).seq == 2


@pytest.mark.django_db
def test_removing_a_row_from_the_middle_is_caught(till, event, ticket):
    for n in range(3):
        sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key=f"sale-{n}-xxxx")

    PosSale.objects.filter(event=event, seq=2).delete()

    # The sequence is gapless by construction, so the gap alone gives it away.
    assert PosSale.verify_chain(event).seq == 3


@pytest.mark.django_db
def test_a_row_cannot_be_modified_through_the_model(till, event, ticket):
    sell(till, [{"item": ticket.pk, "count": 1}])
    sale = journal(event)[0]

    sale.total = Decimal("1.00")
    with pytest.raises(ValueError):
        sale.save()


@pytest.mark.django_db
def test_a_row_cannot_be_deleted_through_the_model(till, event, ticket):
    sell(till, [{"item": ticket.pk, "count": 1}])

    with pytest.raises(ValueError):
        journal(event)[0].delete()


@pytest.mark.django_db
def test_an_older_row_is_verified_under_the_shape_it_was_written_with(
    till, event, ticket, device
):
    """
    A hash chain cannot be extended in place.

    Adding a field to the hashed payload would invalidate every row written
    before it, and verification would report tampering on an untouched journal.
    So the payload is versioned and each row records the version it was written
    under. This builds a row the way version 1 wrote them and checks the chain
    still verifies across the version boundary.
    """
    sell(till, [{"item": ticket.pk, "count": 1}])
    first = journal(event)[0]

    old = PosSale(
        event=event,
        seq=2,
        datetime=first.datetime,
        device=device,
        device_serial=device.unique_serial,
        cashier="",
        order=first.order,
        order_code=first.order_code,
        payment_type=PosSale.PAYMENT_CASH,
        total=Decimal("10.00"),
        positions=[],
        idempotency_key="written-long-ago",
        hash_version=1,
        previous_hash=first.hash,
    )
    old.hash = old.compute_hash()
    old.save()
    # A version-1 payload carries none of the fields added since.
    assert "testmode" not in old._hash_payload()
    assert "offline" not in old._hash_payload()

    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="after-the-old")

    assert PosSale.verify_chain(event) is None
    assert journal(event)[2].previous_hash == old.hash


@pytest.mark.django_db
def test_the_hashed_payload_covers_what_a_reversal_is(till, event, ticket):
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()
    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-key-1"})

    reversal = journal(event)[1]
    payload = reversal._hash_payload()
    # Everything that distinguishes a reversal from a sale is inside the hash,
    # so a reversal cannot be quietly turned into a sale or pointed at another row.
    assert '"kind":"cancellation"' in payload
    assert f'"cancels_seq":{sale["journal_seq"]}' in payload
    assert PosSale.verify_chain(event) is None


def rows_hashed(monkeypatch):
    """Count the rows a verification walk actually re-hashes."""
    counted = []
    original = PosSale.compute_hash

    def counting(self):
        counted.append(self.seq)
        return original(self)

    monkeypatch.setattr(PosSale, "compute_hash", counting)
    return counted


@pytest.mark.django_db
def test_verification_resumes_from_where_it_last_got_to(
    till, event, ticket, real_cache, monkeypatch
):
    for n in range(6):
        sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key=f"sale-{n}-xxxx")

    walked = rows_hashed(monkeypatch)
    assert PosSale.verify_chain_cached(event) is None
    assert walked == [1, 2, 3, 4, 5, 6]

    walked.clear()
    assert PosSale.verify_chain_cached(event) is None
    # Nothing left to check: the back-office page must not re-hash a whole
    # festival's journal every time somebody opens it.
    assert walked == []

    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="sale-late-x")
    walked.clear()
    assert PosSale.verify_chain_cached(event) is None
    assert walked == [7]


@pytest.mark.django_db
def test_a_row_written_after_the_anchor_is_still_checked(till, event, ticket, real_cache):
    for n in range(6):
        sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key=f"sale-{n}-xxxx")
    PosSale.verify_chain_cached(event)
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="sale-late-x")

    PosSale.objects.filter(event=event, seq=7).update(total=Decimal("1.00"))

    # Which is the question the page is actually asking: has the journal held
    # since it was last looked at?
    assert PosSale.verify_chain_cached(event).seq == 7


@pytest.mark.django_db
def test_the_full_audit_finds_what_a_checkpoint_cannot(till, event, ticket, real_cache):
    """
    The checkpoint skips work, it does not stand witness.

    Rows at or behind the anchor are not re-hashed, so an amount edited straight
    in the database with its hash left alone is invisible to the cached walk.
    That is a deliberate trade — the alternative is re-hashing a festival on
    every page load — and it is exactly why the full walk exists and why
    ``openpos_verify_journal`` is the thing to run when somebody doubts the
    journal.
    """
    for n in range(6):
        sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key=f"sale-{n}-xxxx")
    PosSale.verify_chain_cached(event)

    PosSale.objects.filter(event=event, seq=2).update(total=Decimal("1.00"))

    assert PosSale.verify_chain_cached(event) is None
    assert PosSale.verify_chain(event).seq == 2


@pytest.mark.django_db
def test_a_checkpoint_that_no_longer_matches_is_not_an_alarm(
    till, event, ticket, real_cache
):
    """
    A cache is evicted for a hundred ordinary reasons.

    A restart, memory pressure, a deploy — and a checkpoint that no longer
    matches has to cost one full walk, not an accusation. An alarm that fires
    every time Redis comes back is an alarm nobody keeps listening to.
    """
    for n in range(3):
        sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key=f"sale-{n}-xxxx")
    PosSale.verify_chain_cached(event)

    real_cache.clear()

    assert PosSale.verify_chain_cached(event) is None


@pytest.mark.django_db
def test_the_management_command_fails_loudly_on_a_broken_journal(till, event, ticket):
    from django.core.management import CommandError, call_command

    for n in range(3):
        sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key=f"sale-{n}-xxxx")
    call_command("openpos_verify_journal")

    PosSale.objects.filter(event=event, seq=2).update(total=Decimal("1.00"))

    with pytest.raises(CommandError):
        call_command("openpos_verify_journal")


@pytest.mark.django_db
def test_recording_the_same_sale_twice_appends_once(till, event, ticket):
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="steady-key-3")
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="steady-key-3")

    assert PosSale.objects.filter(event=event).count() == 1


@pytest.mark.django_db
def test_cancelled_seqs_answers_from_the_journal(till, event, ticket):
    first = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="sale-one-xx").json()
    second = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="sale-two-xx").json()
    till.post("cancel", {"seq": first["journal_seq"], "idempotency_key": "cancel-key-1"})

    assert PosSale.cancelled_seqs(event, [first["journal_seq"], second["journal_seq"]]) == {
        first["journal_seq"]
    }
