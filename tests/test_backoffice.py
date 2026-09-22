"""
The screens the organiser uses: the tariff, the journal, and pretix' own order
page — which the plugin renders part of, and once turned into a 500 for every
cash sale.
"""
from decimal import Decimal

import pytest

from pretix_openpos.models import PosPrice, PosSale

from .conftest import sell


def prices_url(event):
    return f"/control/event/{event.organizer.slug}/{event.slug}/openpos/prices/"


def sales_url(event):
    return f"/control/event/{event.organizer.slug}/{event.slug}/openpos/sales/"


def form(event, **prices):
    """The price form as the browser posts it: one field per sellable line."""
    return {f"price_{key}": value for key, value in prices.items()}


@pytest.mark.django_db
def test_the_tariff_lists_every_sellable_line(backoffice, event, ticket, shirt):
    item, small, large = shirt

    page = backoffice.get(prices_url(event)).content.decode()

    assert "Entrée" in page
    assert f'name="price_{ticket.pk}_"' in page
    # A product with options is priced per option, never as a whole.
    assert f'name="price_{item.pk}_{small.pk}"' in page
    assert f'name="price_{item.pk}_{large.pk}"' in page
    assert f'name="price_{item.pk}_"' not in page


@pytest.mark.django_db
def test_saving_a_price_creates_the_override(backoffice, event, ticket):
    backoffice.post(prices_url(event), form(event, **{f"{ticket.pk}_": "8.50"}))

    assert PosPrice.objects.get(event=event, item=ticket).price == Decimal("8.50")


@pytest.mark.django_db
def test_a_comma_is_a_decimal_separator(backoffice, event, ticket):
    # The keyboard this is typed on has a comma where the point is.
    backoffice.post(prices_url(event), form(event, **{f"{ticket.pk}_": "8,50"}))

    assert PosPrice.objects.get(event=event, item=ticket).price == Decimal("8.50")


@pytest.mark.django_db
def test_emptying_a_field_goes_back_to_the_online_price(backoffice, event, ticket):
    PosPrice.objects.create(event=event, item=ticket, price=Decimal("8.00"))

    backoffice.post(prices_url(event), form(event, **{f"{ticket.pk}_": ""}))

    assert not PosPrice.objects.filter(event=event, item=ticket).exists()


@pytest.mark.django_db
def test_a_negative_price_is_refused(backoffice, event, ticket):
    backoffice.post(prices_url(event), form(event, **{f"{ticket.pk}_": "-1.00"}))

    assert not PosPrice.objects.filter(event=event).exists()


@pytest.mark.django_db
def test_one_bad_price_saves_none_of_the_others(backoffice, event, ticket, beer):
    """
    The form means what it says, or it says nothing.

    Both halves used to run in one loop inside a transaction that was committed
    anyway when errors were reported: a single mistyped price saved every other
    line while telling the organiser nothing had been saved. The tariff is what
    the till charges, so "I thought it had not gone through" is not an
    acceptable state to leave somebody in.
    """
    response = backoffice.post(
        prices_url(event),
        form(event, **{f"{ticket.pk}_": "8.00", f"{beer.pk}_": "trois euros"}),
    )

    assert response.status_code == 200
    assert not PosPrice.objects.filter(event=event).exists()


@pytest.mark.django_db
def test_a_bad_price_does_not_undo_an_existing_one_either(backoffice, event, ticket, beer):
    PosPrice.objects.create(event=event, item=ticket, price=Decimal("8.00"))

    backoffice.post(
        prices_url(event),
        form(event, **{f"{ticket.pk}_": "", f"{beer.pk}_": "trois euros"}),
    )

    # Clearing the first field was part of the same refused submission.
    assert PosPrice.objects.get(event=event, item=ticket).price == Decimal("8.00")


@pytest.mark.django_db
def test_a_refused_form_comes_back_with_what_was_typed(backoffice, event, ticket, beer):
    response = backoffice.post(
        prices_url(event),
        form(event, **{f"{ticket.pk}_": "8.00", f"{beer.pk}_": "trois euros"}),
    )

    page = response.content.decode()
    # In the fields themselves, not merely quoted back in the error message:
    # nothing was written, so re-rendering the inputs from the database would
    # silently throw away every other edit made alongside the one that was wrong.
    assert 'value="8.00"' in page
    assert 'value="trois euros"' in page


@pytest.mark.django_db
def test_a_valid_form_is_saved_whole(backoffice, event, ticket, beer):
    backoffice.post(
        prices_url(event),
        form(event, **{f"{ticket.pk}_": "8.00", f"{beer.pk}_": "2.50"}),
    )

    assert PosPrice.objects.get(item=ticket).price == Decimal("8.00")
    assert PosPrice.objects.get(item=beer).price == Decimal("2.50")


@pytest.mark.django_db
def test_the_tariff_is_closed_to_somebody_who_may_only_read_orders(reader, event, ticket):
    response = reader.get(prices_url(event))

    assert response.status_code == 403


@pytest.mark.django_db
def test_the_journal_page_adds_the_takings_up_per_till(backoffice, till, event, ticket, beer):
    sell(till, [{"item": ticket.pk, "count": 2}], cashier="Camille",
         idempotency_key="sale-one-xx")
    sell(till, [{"item": beer.pk, "count": 1}], payment_type="card",
         cashier="Camille", idempotency_key="sale-two-xx")

    page = backoffice.get(sales_url(event)).content.decode()

    assert "Caisse bar · Camille" in page
    assert "23.00" in page


@pytest.mark.django_db
def test_the_journal_page_says_when_the_chain_no_longer_adds_up(
    backoffice, till, event, ticket
):
    sell(till, [{"item": ticket.pk, "count": 1}])
    context = backoffice.get(sales_url(event)).context

    assert context["tampered_with"] is None

    PosSale.objects.filter(event=event, seq=1).update(total=Decimal("1.00"))

    # Surfaced rather than silently trusted.
    assert backoffice.get(sales_url(event)).context["tampered_with"].seq == 1


@pytest.mark.django_db
def test_the_journal_exports_as_one_file(backoffice, till, event, ticket, beer):
    sell(till, [{"item": ticket.pk, "count": 2}, {"item": beer.pk, "count": 1}],
         cashier="Camille")

    response = backoffice.get(sales_url(event) + "?export=csv")

    assert response.status_code == 200
    body = b"".join(response.streaming_content).decode("utf-8")
    # The BOM stops Excel guessing at the encoding; the delimiter is what a
    # French-locale Excel expects.
    assert body.startswith("﻿")
    assert "seq;kind;datetime" in body
    assert "2× Entrée + 1× Bière" in body
    assert "Camille" in body


@pytest.mark.django_db
def test_a_cash_sale_does_not_break_pretix_own_order_page(backoffice, till, event, ticket):
    """
    The bug no HTTP smoke test could have caught.

    Amounts live in the payment info as strings, because that is what belongs
    in JSON, and pretix' ``money`` filter raises TypeError on anything but a
    Decimal. The exception fired while rendering the *order* page, so every
    cash sale turned the backend order view into a 500 — invisible from the
    till, invisible from the API, and only found by opening an order by hand.
    """
    sale = sell(till, [{"item": ticket.pk, "count": 1}], cash_given="20.00").json()

    response = backoffice.get(
        f"/control/event/{event.organizer.slug}/{event.slug}"
        f"/orders/{sale['order']['code']}/"
    )

    assert response.status_code == 200
    page = response.content.decode()
    assert "20.00" in page
    assert "10.00" in page


@pytest.mark.django_db
def test_the_settings_screen_saves_the_check_in_list(backoffice, event, checkin_list):
    url = f"/control/event/{event.organizer.slug}/{event.slug}/openpos/"

    response = backoffice.post(
        url, {"openpos_checkin_list": str(checkin_list.pk), "openpos_invoices": "on"}
    )

    assert response.status_code in (200, 302)
    event.settings.flush()
    assert event.settings.get("openpos_checkin_list", as_type=int) == checkin_list.pk


@pytest.mark.django_db
def test_turning_till_invoicing_off_takes_the_channel_out_of_pretix_own_list(
    backoffice, event
):
    url = f"/control/event/{event.organizer.slug}/{event.slug}/openpos/"

    backoffice.post(url, {"openpos_checkin_list": ""})

    event.settings.flush()
    # Leaving pretix' own channel list behind would produce an event that half
    # agrees with itself.
    assert "openpos" not in event.settings.get(
        "invoice_generate_sales_channels", as_type=list
    )


@pytest.mark.django_db
def test_the_sales_column_counts_customers_served_and_nothing_else(
    backoffice, till, event, beer, deposit
):
    # Money and count are read differently from the same rows. Four beers and
    # three cups given back is one customer, nine euros: counting the payout
    # as a sale would say two, and a volunteer reconciling a shift reads that
    # column as "how many people did I serve".
    from .conftest import sell

    sell(till, [
        {"item": beer.pk, "count": 4},
        {"item": deposit.pk, "count": 3, "refund": True},
    ])

    context = backoffice.get(sales_url(event)).context

    assert context["totals"]["count"] == 1
    assert context["totals"]["total"] == Decimal("9.00")


@pytest.mark.django_db
def test_test_mode_takings_are_kept_off_the_figure_the_drawer_is_counted_against(
    backoffice, till, event, ticket
):
    # A rehearsal sale and a real one are the same shape in the journal, and a
    # volunteer counting the drawer at 2am against a total that quietly
    # includes yesterday's testing would come up short for no reason.
    from .conftest import sell

    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="reelle-01")
    event.testmode = True
    event.save()
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="essai-001")

    context = backoffice.get(sales_url(event)).context

    assert context["totals"]["count"] == 1
    assert context["totals"]["total"] == Decimal("10.00")
    assert context["testmode_totals"]["count"] == 1
    assert context["testmode_totals"]["total"] == Decimal("10.00")


@pytest.mark.django_db
def test_an_event_that_never_ran_a_rehearsal_says_nothing_about_test_mode(
    backoffice, till, event, ticket
):
    # A line reading "test mode: 0.00" on every event's page is noise that
    # trains people to skip the section that matters.
    from .conftest import sell

    sell(till, [{"item": ticket.pk, "count": 1}])

    assert backoffice.get(sales_url(event)).context["testmode_totals"] is None


@pytest.mark.django_db
def test_a_sale_from_a_till_that_has_since_been_deleted_is_still_counted(
    backoffice, till, event, ticket, device
):
    # The journal outlives the device: the row carries the serial and the name
    # it was written with, and a deleted till must not take its takings with it.
    from pretix_openpos.models import PosSale

    from .conftest import sell

    sell(till, [{"item": ticket.pk, "count": 1}])
    PosSale.objects.filter(event=event).update(device=None, device_name="", device_serial="")

    context = backoffice.get(sales_url(event)).context

    assert context["totals"]["count"] == 1
    assert len(context["by_device"]) == 1


# -- card payments that never became a sale ---------------------------------
#
# The one thing the journal cannot show by construction: the takings are
# recomputed from it, so a card charged without a sale behind it is missing
# from every figure on the page rather than wrong in one of them.


def put_on_reader(till, positions, key):
    return till.post(
        "terminal/start", {"idempotency_key": key, "positions": positions}
    )


@pytest.mark.django_db
def test_a_card_charged_with_no_sale_behind_it_is_listed(
    backoffice, till, event, ticket, reader_till, sumup
):
    from pretix_openpos.models import PosTerminalPayment

    put_on_reader(till, [{"item": ticket.pk, "count": 1}], "abandonne-01")
    payment = PosTerminalPayment.objects.get(idempotency_key="abandonne-01")
    sumup.pay(payment.client_transaction_id, transaction_id="tx_perdue")
    # The cardholder paid and the till never came back — dropped tablet, dead
    # battery, closed browser. Nothing else in pretix will ever mention it.
    till.get("terminal/status", idempotency_key="abandonne-01")

    context = backoffice.get(sales_url(event)).context

    assert [row["payment"].idempotency_key for row in context["unresolved_card"]] == [
        "abandonne-01"
    ]
    assert context["unresolved_card"][0]["paid"] is True
    assert context["unresolved_card"][0]["till"] == "Caisse bar"
    # And the reference a human searches the SumUp dashboard by is on the page.
    assert "tx_perdue" in backoffice.get(sales_url(event)).content.decode()


@pytest.mark.django_db
def test_a_basket_left_on_a_reader_is_listed_once_nobody_is_coming_back(
    backoffice, till, event, ticket, reader_till, sumup
):
    from django.utils.timezone import now

    from pretix_openpos.models import PosTerminalPayment
    from pretix_openpos.views import UNRESOLVED_AFTER

    put_on_reader(till, [{"item": ticket.pk, "count": 1}], "en-attente-01")

    # Still within the window: a customer rummaging for their wallet is not an
    # incident, and a row here on every slow payment is a row nobody reads.
    assert backoffice.get(sales_url(event)).context["unresolved_card"] == []

    PosTerminalPayment.objects.filter(idempotency_key="en-attente-01").update(
        created=now() - UNRESOLVED_AFTER * 2
    )

    context = backoffice.get(sales_url(event)).context

    assert len(context["unresolved_card"]) == 1
    # Flagged as unknown rather than as charged: whether the money moved is
    # exactly what nobody here can say.
    assert context["unresolved_card"][0]["paid"] is False


@pytest.mark.django_db
def test_a_card_payment_that_became_a_sale_is_not_listed(
    backoffice, till, event, ticket, reader_till, sumup
):
    from pretix_openpos.models import PosTerminalPayment

    put_on_reader(till, [{"item": ticket.pk, "count": 1}], "vendue-01")
    payment = PosTerminalPayment.objects.get(idempotency_key="vendue-01")
    sumup.pay(payment.client_transaction_id, transaction_id="tx_ok")
    till.get("terminal/status", idempotency_key="vendue-01")
    sell(
        till,
        [{"item": ticket.pk, "count": 1}],
        payment_type="card",
        idempotency_key="vendue-01",
    )

    # The ordinary card sale. The section exists to be empty on a normal night.
    assert backoffice.get(sales_url(event)).context["unresolved_card"] == []
    assert "Card payments with no sale" not in backoffice.get(
        sales_url(event)
    ).content.decode()


@pytest.mark.django_db
def test_a_refusal_is_not_something_to_chase(
    backoffice, till, event, ticket, reader_till, sumup
):
    from pretix_openpos.models import PosTerminalPayment

    put_on_reader(till, [{"item": ticket.pk, "count": 1}], "refusee-01")
    PosTerminalPayment.objects.filter(idempotency_key="refusee-01").update(
        status=PosTerminalPayment.STATUS_FAILED
    )

    # A declined card is the system working. Nothing was taken, so there is
    # nothing to give back and nothing to ring up.
    assert backoffice.get(sales_url(event)).context["unresolved_card"] == []


@pytest.mark.django_db
def test_a_payment_already_sent_back_is_settled(
    backoffice, till, event, ticket, reader_till, sumup
):
    from django.utils.timezone import now

    from pretix_openpos.models import PosTerminalPayment

    put_on_reader(till, [{"item": ticket.pk, "count": 1}], "rendue-01")
    payment = PosTerminalPayment.objects.get(idempotency_key="rendue-01")
    sumup.pay(payment.client_transaction_id, transaction_id="tx_rendue")
    till.get("terminal/status", idempotency_key="rendue-01")

    assert len(backoffice.get(sales_url(event)).context["unresolved_card"]) == 1

    PosTerminalPayment.objects.filter(pk=payment.pk).update(refunded=now())

    # Somebody dealt with it. Leaving the row up would have the next person
    # refund it a second time.
    assert backoffice.get(sales_url(event)).context["unresolved_card"] == []
