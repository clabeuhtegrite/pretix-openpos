"""
The two payment providers.

They exist so the cash/card split shows up in pretix' own order views and
reports without the POS keeping a parallel set of books. The money is always in
the drawer before the order exists, so the interesting part is not taking a
payment — it is that these must never be offered as if they could, and that the
order page must render for a sale they are attached to.

That last one is not hypothetical: amounts live in the payment info as strings,
because that is what belongs in JSON, and pretix' ``money`` filter raises
TypeError on anything but a Decimal. The exception fired while rendering the
*order* page, so every cash sale turned the backend order view into a 500 —
invisible from the till, invisible from the API, and found by opening an order
by hand.
"""
from decimal import Decimal

import pytest

from pretix_openpos.payment import CARD, CASH, OpenPosCardProvider, OpenPosCashProvider, _decimal_or_none

from .conftest import sell


@pytest.fixture
def cash(event):
    return OpenPosCashProvider(event)


@pytest.mark.django_db
def test_the_two_methods_are_named_the_way_the_journal_names_them(event):
    # The identifiers are written into orders; renaming one silently orphans
    # every sale already recorded under it.
    assert OpenPosCashProvider(event).identifier == CASH
    assert OpenPosCardProvider(event).identifier == CARD


@pytest.mark.django_db
def test_neither_is_ever_offered_in_the_webshop(event, cash):
    # There is no way for a customer on the internet to put money in a drawer
    # in a room they are not in.
    assert cash.is_allowed(None) is False
    assert cash.is_allowed(None, total=Decimal("10.00")) is False


@pytest.mark.django_db
def test_neither_is_offered_when_an_order_is_changed_in_the_back_office(event, cash):
    assert cash.order_change_allowed(None) is False


@pytest.mark.django_db
def test_there_is_nothing_to_configure(event, cash):
    # Everything about them is driven by the till.
    assert cash.settings_form_fields == {}


@pytest.mark.django_db
def test_it_is_enabled_so_the_identifier_resolves_when_a_paid_order_is_created(event, cash):
    # Enabled, but never visible: is_allowed is what governs the checkout.
    assert cash.is_enabled is True


@pytest.mark.django_db
def test_it_renders_nothing_into_a_checkout_it_takes_no_part_in(event, cash):
    assert cash.payment_form_render(None, Decimal("10.00")) == ""
    assert cash.checkout_confirm_render(None) == ""


@pytest.mark.django_db
def test_a_payment_wired_up_by_hand_is_simply_confirmed(event, cash, ticket, till):
    # Never reached in practice; the money is in the drawer before the order
    # exists. It still has to do the right thing if somebody wires it up.
    from pretix.base.models import Order

    sell(till, [{"item": ticket.pk, "count": 1}])
    payment = Order.objects.get(event=event).payments.first()
    payment.state = "created"
    payment.save()

    cash.execute_payment(None, payment)

    payment.refresh_from_db()
    assert payment.state == "confirmed"


@pytest.mark.django_db
def test_the_back_office_shows_what_was_handed_over_and_what_went_back(
    event, cash, till, ticket
):
    from pretix.base.models import Order

    sell(till, [{"item": ticket.pk, "count": 1}], cash_given="20.00")
    payment = Order.objects.get(event=event).payments.first()

    html = cash.payment_control_render(None, payment)

    assert "20.00" in html
    assert "10.00" in html


@pytest.mark.django_db
def test_the_order_page_renders_for_a_payment_carrying_no_amounts(event, cash, till, ticket):
    # A card sale records neither, and the template has to survive it.
    from pretix.base.models import Order

    sell(till, [{"item": ticket.pk, "count": 1}], payment_type="card")
    payment = Order.objects.get(event=event).payments.first()

    assert cash.payment_control_render(None, payment) != ""


@pytest.mark.django_db
def test_the_order_page_renders_for_a_payment_with_no_info_at_all(event, cash, till, ticket):
    from pretix.base.models import Order

    sell(till, [{"item": ticket.pk, "count": 1}])
    payment = Order.objects.get(event=event).payments.first()
    payment.info = ""
    payment.save()

    assert cash.payment_control_render(None, payment) != ""


def test_an_amount_becomes_the_decimal_the_money_filter_demands():
    assert _decimal_or_none("20.00") == Decimal("20.00")


def test_a_missing_amount_stays_missing_rather_than_becoming_zero():
    # Zero change and no change are different things on a card sale.
    assert _decimal_or_none(None) is None
    assert _decimal_or_none("") is None


def test_something_that_is_not_an_amount_is_dropped_rather_than_thrown_on():
    # Whatever is in there, the order page must still render.
    assert _decimal_or_none("not a number") is None
    assert _decimal_or_none([]) is None
