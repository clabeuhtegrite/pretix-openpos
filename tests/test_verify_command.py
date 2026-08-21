"""
The full journal audit.

The back-office sales page walks the chain from an anchored checkpoint, which
is cheap and deliberately cannot see an edit made behind the anchor. This
command is the other half of that bargain: the full walk from row one, meant
for a cron job or for the day somebody doubts the journal. If it does not fail
loudly on a doctored row, the cheap check has nothing standing behind it.
"""
import pytest
from django.core.management import CommandError, call_command

from pretix_openpos.models import PosSale

from .conftest import sell


def run(**options):
    """Run the audit and hand back what it printed."""
    from io import StringIO

    out = StringIO()
    call_command("openpos_verify_journal", stdout=out, **options)
    return out.getvalue()


@pytest.mark.django_db
def test_an_intact_journal_passes_and_says_how_much_it_checked(till, event, ticket):
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="sale-0001")
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="sale-0002")

    output = run()

    assert "ok" in output
    assert f"{event.organizer.slug}/{event.slug}" in output
    assert "2 rows" in output


@pytest.mark.django_db
def test_an_edited_amount_fails_the_audit_and_names_the_row(till, event, ticket):
    # The whole point of hash-chaining the journal: an amount changed straight
    # in the database, after the fact, is detectable.
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="sale-0001")
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="sale-0002")
    doctored = PosSale.objects.filter(event=event).order_by("seq").first()
    PosSale.objects.filter(pk=doctored.pk).update(total="1.00")

    with pytest.raises(CommandError) as failure:
        run()

    assert f"{event.organizer.slug}/{event.slug}" in str(failure.value)


@pytest.mark.django_db
def test_a_row_deleted_from_the_middle_fails_the_audit(till, event, ticket):
    # Gapless sequence numbers are half the guarantee; the chain is the other.
    for key in ("sale-0001", "sale-0002", "sale-0003"):
        sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key=key)
    PosSale.objects.filter(event=event, seq=2).delete()

    with pytest.raises(CommandError):
        run()


@pytest.mark.django_db
def test_it_can_be_pointed_at_one_event(till, event, ticket):
    sell(till, [{"item": ticket.pk, "count": 1}])

    output = run(event=f"{event.organizer.slug}/{event.slug}")

    assert f"{event.organizer.slug}/{event.slug}" in output


@pytest.mark.django_db
def test_an_event_with_no_journal_is_an_error_rather_than_a_silent_pass(
    till, event, ticket
):
    # Answering "ok" for an event whose journal it never found would be the
    # worst possible outcome for an audit tool.
    sell(till, [{"item": ticket.pk, "count": 1}])

    with pytest.raises(CommandError, match="No Open POS journal"):
        run(event="asso/pas-cet-evenement")


@pytest.mark.django_db
def test_an_installation_that_has_never_sold_anything_passes_quietly(event):
    assert run() == ""


@pytest.mark.django_db
def test_every_event_is_audited_when_none_is_named(till, another_till, event, ticket):
    # A second till on the same event, so the journal has rows from both.
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="sale-0001")
    sell(another_till, [{"item": ticket.pk, "count": 1}], idempotency_key="sale-0002")

    output = run()

    assert "2 rows" in output
