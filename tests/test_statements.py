"""
Each association's share of an evening, and who owes whom.

Several associations run one evening and each keeps its own books: one sells
the tickets online, one takes the money at the door, one runs the bar. pretix
issues every invoice of an event in one name and has no report split by sales
channel or category, so the split is this plugin's to make, from what it
already knows: the channel an order came from, the category a till line is
reserved for, the role of the device that rang it up.

Most tests here place journal rows by hand, as the takings tests do, so that
each one reads as the evening it describes. A few go through the real till, to
show that what a till writes is what these read.
"""
from datetime import timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from django.utils.timezone import now
from pretix.base.models import Device, ItemCategory, Order, OrderFee, OrderPayment, OrderPosition, OrderRefund
from pretix.base.models.devices import generate_api_token

from pretix_openpos.associations import PART_BAR, PART_DOOR, PART_ONLINE, SHARE_SETTINGS
from pretix_openpos.models import (
    PosAssociation, PosCategory, PosDevice, PosDrawer, PosDrawerSession, PosSale, PosTerminalPayment,
    reversed_positions,
)
from pretix_openpos.statements import statement
from pretix_openpos.takings import line_amount

from .conftest import sell, staff
from .test_series import a_date, series_event
from .test_summary import line

D = Decimal

PARTS = {"online": PART_ONLINE, "door": PART_DOOR, "bar": PART_BAR}


def statements_url(event, query=""):
    return f"/control/event/{event.organizer.slug}/{event.slug}/openpos/statements/{query}"


@pytest.fixture
def portiers(organizer):
    """The association that sells the tickets, online and at the door."""
    return PosAssociation.objects.create(organizer=organizer, name="Les Portiers")


@pytest.fixture
def comptoir(organizer):
    """The one that runs the bar."""
    return PosAssociation.objects.create(organizer=organizer, name="Le Comptoir")


@pytest.fixture
def counters(event, ticket, beer):
    """Who sells what as the evening is set up: the entries at the door, the drinks at the bar."""
    entries = ItemCategory.objects.create(event=event, name="Entrées", position=0)
    drinks = ItemCategory.objects.create(event=event, name="Boissons", position=1)
    ticket.category = entries
    ticket.save()
    beer.category = drinks
    beer.save()
    PosCategory.objects.create(category=entries, role=PosDevice.ROLE_DOOR)
    PosCategory.objects.create(category=drinks, role=PosDevice.ROLE_TILL)
    return entries, drinks


def a_device(organizer, name, role=None):
    device = Device.objects.create(
        organizer=organizer,
        name=name,
        all_events=True,
        security_profile="openpos",
        api_token=generate_api_token(),
        initialized=now(),
    )
    if role is not None:
        PosDevice.objects.create(device=device, role=role)
    return device


@pytest.fixture
def door(organizer):
    return a_device(organizer, "Porte", PosDevice.ROLE_DOOR)


@pytest.fixture
def bar_till(organizer):
    return a_device(organizer, "Bar", PosDevice.ROLE_TILL)


@pytest.fixture
def loose(organizer):
    """A tablet nobody has given a role to, which sells everything."""
    return a_device(organizer, "Tablette")


def shared(event, **parts):
    """Say which association counts which part of ``event``: ``online=``, ``door=``, ``bar=``."""
    for name, association in parts.items():
        event.settings.set(SHARE_SETTINGS[PARTS[name]], str(association.pk))


def rung(event, device, lines, *, payment_type="cash", kind=PosSale.KIND_SALE, total=None, **kwargs):
    """A journal row, written as the till writes one."""
    return PosSale.record(
        event=event,
        order=None,
        device=device,
        cashier="",
        payment_type=payment_type,
        total=total if total is not None else sum((line_amount(x) for x in lines), D("0.00")),
        positions=lines,
        idempotency_key=kwargs.pop("idempotency_key", uuid4().hex),
        kind=kind,
        **kwargs,
    )


def cancelled(event, sale, device=None, kept=None, **kwargs):
    """
    The reversal of ``sale``, as the back office writes one: no device of its
    own, and with ``kept`` the fee the cancellation kept, on a line of its own.
    """
    positions = reversed_positions(sale.positions)
    total = -sale.total
    if kept is not None:
        positions.append({
            "item": None, "item_name": "Frais d'annulation", "variation": None,
            "variation_name": None, "count": 1, "unit_price": str(kept),
            "line_total": str(kept), "fee": OrderFee.FEE_TYPE_CANCELLATION,
        })
        total += D(str(kept))
    return PosSale.record(
        event=event,
        order=None,
        device=device,
        cashier="",
        payment_type=sale.payment_type,
        total=total,
        positions=positions,
        idempotency_key=f"cancel-{sale.idempotency_key}",
        kind=PosSale.KIND_CANCELLATION,
        cancels_seq=sale.seq,
        **kwargs,
    )


def on_the_reader(event, sale):
    """Say that ``sale`` was paid on a SumUp reader, as a settled terminal payment says."""
    return PosTerminalPayment.objects.create(
        event=event,
        idempotency_key=sale.idempotency_key,
        reader_id="rdr_bar",
        amount=sale.total,
        currency="EUR",
        status=PosTerminalPayment.STATUS_SUCCESSFUL,
        transaction_id=f"TX{sale.seq}",
    )


def a_drawer(organizer, name, held_by=None):
    """An opening of a drawer, to file cash sales under."""
    drawer = PosDrawer.objects.create(organizer=organizer, name=name, held_by=held_by)
    return PosDrawerSession.objects.create(drawer=drawer, opened_at=now())


def bought_online(event, *lines, paid=True, refunded=None, fees=(), testmode=False, status=None):
    """
    An order from the webshop. Each line is ``(item, price)`` or
    ``(item, price, date)``; the order is paid in full unless ``paid`` is false.
    """
    total = sum((D(str(price)) for _item, price, *_date in lines), D("0.00")) + sum(
        (D(str(fee)) for fee in fees), D("0.00")
    )
    order = Order.objects.create(
        event=event,
        status=status or (Order.STATUS_PAID if paid else Order.STATUS_PENDING),
        datetime=now(),
        expires=now() + timedelta(days=1),
        total=total,
        testmode=testmode,
        sales_channel=event.organizer.sales_channels.get(identifier="web"),
    )
    for n, (item, price, *date) in enumerate(lines, start=1):
        OrderPosition.objects.create(
            order=order, item=item, positionid=n, price=D(str(price)),
            subevent=date[0] if date else None,
        )
    for fee in fees:
        OrderFee.objects.create(order=order, fee_type=OrderFee.FEE_TYPE_SERVICE, value=D(str(fee)))
    if paid:
        OrderPayment.objects.create(
            order=order, amount=total, provider="manual",
            state=OrderPayment.PAYMENT_STATE_CONFIRMED, payment_date=now(),
        )
    if refunded is not None:
        OrderRefund.objects.create(
            order=order, amount=D(str(refunded)), provider="manual",
            state=OrderRefund.REFUND_STATE_DONE, source=OrderRefund.REFUND_SOURCE_ADMIN,
        )
    return order


def share_of(report, label):
    (found,) = [share for share in report["shares"] if share["label"] == label]
    return found


def products_of(share):
    return {
        (item["name"], item["variation_name"]): (item["count"], item["total"])
        for group in share["categories"]
        for item in group["items"]
    }


def transfers_of(report):
    return [(t["payer"].name, t["payee"].name, t["amount"]) for t in report["transfers"]]


# -- who counts what ----------------------------------------------------------


@pytest.mark.django_db
def test_each_part_of_the_evening_goes_to_its_association(
    event, counters, ticket, beer, door, bar_till, portiers, comptoir
):
    shared(event, online=portiers, door=portiers, bar=comptoir)
    bought_online(event, (ticket, 10), (ticket, 10))
    rung(event, door, [line(ticket, 1, "10.00")])
    rung(event, bar_till, [line(beer, 4, "3.00")], payment_type="card")

    report = statement(event)

    assert [share["label"] for share in report["shares"]] == ["Les Portiers", "Le Comptoir"]
    tickets = share_of(report, "Les Portiers")
    assert tickets["parts"] == ["Online sales", "Door"]
    assert products_of(tickets) == {("Entrée", None): (3, D("30.00"))}
    assert (tickets["online"], tickets["cash"], tickets["card"]) == (D("20.00"), D("10.00"), D("0.00"))
    assert tickets["total"] == D("30.00")
    bar = share_of(report, "Le Comptoir")
    assert bar["parts"] == ["Bar"]
    assert products_of(bar) == {("Bière", None): (4, D("12.00"))}
    assert (bar["card"], bar["total"]) == (D("12.00"), D("12.00"))
    assert report["totals"]["total"] == D("42.00")
    assert report["missing_parts"] == []
    # Nobody said anybody holds anybody else's money.
    assert report["transfers"] == []


@pytest.mark.django_db
def test_with_no_association_the_evening_is_shown_part_by_part(
    event, counters, ticket, beer, door, bar_till
):
    bought_online(event, (ticket, 10))
    rung(event, door, [line(ticket, 1, "10.00")])
    rung(event, bar_till, [line(beer, 1, "3.00")])

    report = statement(event)

    assert [(share["label"], share["total"]) for share in report["shares"]] == [
        ("Online sales", D("10.00")), ("Door", D("10.00")), ("Bar", D("3.00")),
    ]
    assert report["missing_parts"] == ["Online sales", "Door", "Bar"]


@pytest.mark.django_db
def test_a_part_nobody_counts_stays_under_its_own_name(
    event, counters, ticket, beer, door, bar_till, portiers
):
    """Rather than being folded into whichever association is named."""
    shared(event, online=portiers, door=portiers)
    rung(event, door, [line(ticket, 1, "10.00")])
    rung(event, bar_till, [line(beer, 1, "3.00")])

    report = statement(event)

    assert [share["label"] for share in report["shares"]] == ["Les Portiers", "Bar"]
    assert report["missing_parts"] == ["Bar"]


@pytest.mark.django_db
def test_one_association_can_count_everything(event, counters, ticket, beer, door, bar_till, portiers):
    shared(event, online=portiers, door=portiers, bar=portiers)
    bought_online(event, (ticket, 10))
    rung(event, door, [line(ticket, 1, "10.00")])
    rung(event, bar_till, [line(beer, 1, "3.00")])

    (only,) = statement(event)["shares"]

    assert only["parts"] == ["Online sales", "Door", "Bar"]
    assert only["total"] == D("23.00")


# -- the door or the bar, line by line -----------------------------------------


@pytest.mark.django_db
def test_a_basket_is_split_line_by_line_by_category(
    event, counters, ticket, beer, loose, portiers, comptoir
):
    """A tablet with no role sells both, and each line goes where its category says."""
    shared(event, door=portiers, bar=comptoir)
    rung(event, loose, [line(ticket, 1, "10.00"), line(beer, 2, "3.00")])

    report = statement(event)

    assert share_of(report, "Les Portiers")["cash"] == D("10.00")
    assert share_of(report, "Le Comptoir")["cash"] == D("6.00")


@pytest.mark.django_db
def test_a_category_reserved_for_the_bar_counts_for_the_bar_even_sold_at_the_door(
    event, counters, beer, door, portiers, comptoir
):
    """An offline replay, say: the line is the bar's whatever device rang it up."""
    shared(event, door=portiers, bar=comptoir)
    rung(event, door, [line(beer, 1, "3.00")])

    report = statement(event)

    assert [share["label"] for share in report["shares"]] == ["Le Comptoir"]


@pytest.mark.django_db
def test_a_line_no_category_places_goes_with_the_rest_of_its_sale(
    event, counters, beer, misc, door, portiers, comptoir
):
    """A free amount rung up with two beers is the bar's, even on the door's tablet."""
    shared(event, door=portiers, bar=comptoir)
    rung(event, door, [line(beer, 2, "3.00"), line(misc, 1, "2.50")])

    report = statement(event)

    bar = share_of(report, "Le Comptoir")
    assert products_of(bar) == {("Bière", None): (2, D("6.00")), ("Divers", None): (1, D("2.50"))}
    assert [share["label"] for share in report["shares"]] == ["Le Comptoir"]


@pytest.mark.django_db
def test_a_line_on_its_own_goes_with_the_device_that_sold_it(
    event, counters, misc, door, bar_till, portiers, comptoir
):
    shared(event, door=portiers, bar=comptoir)
    rung(event, door, [line(misc, 1, "5.00")])
    rung(event, bar_till, [line(misc, 1, "2.00")])

    report = statement(event)

    assert share_of(report, "Les Portiers")["cash"] == D("5.00")
    assert share_of(report, "Le Comptoir")["cash"] == D("2.00")


@pytest.mark.django_db
def test_a_basket_that_splits_leaves_its_loose_line_with_the_device(
    event, counters, ticket, beer, misc, bar_till, portiers, comptoir
):
    shared(event, door=portiers, bar=comptoir)
    rung(event, bar_till, [line(ticket, 1, "10.00"), line(beer, 1, "3.00"), line(misc, 1, "1.00")])

    report = statement(event)

    assert share_of(report, "Les Portiers")["cash"] == D("10.00")
    assert share_of(report, "Le Comptoir")["cash"] == D("4.00")


@pytest.mark.django_db
def test_what_nothing_can_place_is_shown_as_not_attributed(
    event, counters, misc, loose, portiers, comptoir
):
    """A free amount on a tablet with no role: the one case nothing decides."""
    shared(event, door=portiers, bar=comptoir)
    rung(event, loose, [line(misc, 1, "4.00")])

    (share,) = statement(event)["shares"]

    assert share["label"] == "Not attributed"
    assert share["association"] is None
    assert share["cash"] == D("4.00")


@pytest.mark.django_db
def test_without_any_category_reserved_the_devices_decide(event, ticket, beer, door, bar_till, portiers, comptoir):
    shared(event, door=portiers, bar=comptoir)
    rung(event, door, [line(ticket, 1, "10.00")])
    rung(event, bar_till, [line(beer, 1, "3.00"), line(ticket, 1, "10.00")])

    report = statement(event)

    assert share_of(report, "Les Portiers")["total"] == D("10.00")
    assert share_of(report, "Le Comptoir")["total"] == D("13.00")


@pytest.mark.django_db
def test_a_row_that_names_no_product_is_counted_rather_than_dropped(
    event, counters, door, bar_till, portiers, comptoir
):
    """Every euro of the journal is on exactly one line of the statement."""
    shared(event, door=portiers, bar=comptoir)
    rung(event, door, [], total=D("7.00"))

    report = statement(event)

    (share,) = report["shares"]
    assert share["label"] == "Les Portiers"
    assert (share["unallocated"], share["cash"], share["sold"]) == (D("7.00"), D("7.00"), D("0.00"))
    assert share["gap"] is None


# -- deposits, cancellations, test mode ---------------------------------------


@pytest.mark.django_db
def test_deposits_are_kept_apart_from_what_was_sold(
    event, counters, beer, deposit, bar_till, comptoir
):
    shared(event, bar=comptoir)
    rung(event, bar_till, [line(beer, 2, "3.00"), line(deposit, 2, "1.00")])
    rung(event, bar_till, [line(deposit, -1, "1.00")], kind=PosSale.KIND_DEPOSIT_REFUND)

    (bar,) = statement(event)["shares"]

    assert products_of(bar) == {("Bière", None): (2, D("6.00"))}
    assert bar["sold"] == D("6.00")
    assert bar["deposits"]["taken"] == {"count": 2, "total": D("2.00")}
    assert bar["deposits"]["returned"] == {"count": -1, "total": D("-1.00")}
    assert bar["deposits_total"] == D("1.00")
    assert bar["cash"] == D("7.00")
    assert bar["gap"] is None


@pytest.mark.django_db
def test_a_cancellation_comes_off_the_share_its_sale_was_in(
    event, counters, beer, misc, door, bar_till, portiers, comptoir
):
    shared(event, door=portiers, bar=comptoir)
    rung(event, bar_till, [line(beer, 1, "3.00")])
    kept = rung(event, door, [line(misc, 1, "5.00")])
    # Cancelled from the back office, which rings nothing up on any device:
    # the loose line still follows the door's tablet that sold it.
    cancelled(event, kept)

    report = statement(event)

    door_share = share_of(report, "Les Portiers")
    assert door_share["total"] == D("0.00")
    assert products_of(door_share) == {}
    assert share_of(report, "Le Comptoir")["total"] == D("3.00")


@pytest.mark.django_db
def test_a_cancelled_reader_payment_is_given_back_by_the_same_account(
    event, counters, beer, bar_till, portiers, comptoir
):
    """The reversal carries no key of its own: it is the sale's that says reader."""
    shared(event, bar=comptoir)
    portiers.organizer.settings.set("openpos_sumup_holder", str(portiers.pk))
    first = rung(event, bar_till, [line(beer, 2, "3.00")], payment_type="card")
    on_the_reader(event, first)
    second = rung(event, bar_till, [line(beer, 1, "3.00")], payment_type="card")
    on_the_reader(event, second)
    cancelled(event, second)

    report = statement(event)

    assert transfers_of(report) == [("Les Portiers", "Le Comptoir", D("6.00"))]


@pytest.mark.django_db
def test_a_cup_handed_back_then_cancelled_is_back_in_the_deposits(event, counters, beer, deposit, bar_till, comptoir):
    shared(event, bar=comptoir)
    rung(event, bar_till, [line(beer, 1, "3.00"), line(deposit, 1, "1.00")])
    handed_back = rung(event, bar_till, [line(deposit, -1, "1.00")], kind=PosSale.KIND_DEPOSIT_REFUND)
    cancelled(event, handed_back)

    (bar,) = statement(event)["shares"]

    assert bar["deposits"]["returned"] == {"count": 0, "total": D("0.00")}
    assert bar["deposits_total"] == D("1.00")
    assert products_of(bar) == {("Bière", None): (1, D("3.00"))}


@pytest.mark.django_db
def test_a_fee_kept_at_the_till_is_named_as_the_webshop_names_it(event, counters, ticket, beer, bar_till, comptoir):
    """So the two land on one line: the journal wrote its name in the event's language."""
    shared(event, online=comptoir, bar=comptoir)
    cancelled(event, rung(event, bar_till, [line(beer, 2, "3.00")]), kept="1.00")
    order = bought_online(event, (ticket, 10), refunded=8)
    OrderPosition.all.filter(order=order).update(canceled=True)
    OrderFee.objects.create(order=order, fee_type=OrderFee.FEE_TYPE_CANCELLATION, value=D("2.00"))

    (share,) = statement(event)["shares"]

    assert share["fees"] == [{"name": "Cancellation fee", "count": 2, "total": D("3.00")}]
    assert products_of(share) == {}
    assert (share["cash"], share["online"], share["gap"]) == (D("1.00"), D("2.00"), None)


@pytest.mark.django_db
def test_a_reactivated_sale_counts_again(event, counters, beer, bar_till, comptoir):
    shared(event, bar=comptoir)
    sale = rung(event, bar_till, [line(beer, 1, "3.00")])
    reversal = cancelled(event, sale)
    PosSale.record(
        event=event, order=None, device=None, cashier="", payment_type="cash",
        total=sale.total, positions=sale.positions, idempotency_key=f"again-{sale.idempotency_key}",
        kind=PosSale.KIND_REACTIVATION, cancels_seq=reversal.seq,
    )

    (bar,) = statement(event)["shares"]

    assert bar["total"] == D("3.00")


@pytest.mark.django_db
def test_test_mode_is_left_out_and_said(event, counters, ticket, beer, bar_till, comptoir):
    shared(event, bar=comptoir)
    rung(event, bar_till, [line(beer, 1, "3.00")], testmode=True)
    bought_online(event, (ticket, 10), testmode=True)

    report = statement(event)

    assert report["shares"] == []
    assert report["test_rows"] == 1


# -- the online sales ---------------------------------------------------------


@pytest.mark.django_db
def test_an_order_not_yet_paid_is_neither_sold_nor_money(event, ticket, portiers):
    shared(event, online=portiers)
    bought_online(event, (ticket, 10), paid=False)

    assert statement(event)["shares"] == []


@pytest.mark.django_db
def test_a_refund_that_did_not_cancel_is_the_gap_between_sold_and_paid(event, ticket, portiers):
    shared(event, online=portiers)
    bought_online(event, (ticket, 10), (ticket, 10), refunded=5)

    (share,) = statement(event)["shares"]

    assert share["sold"] == D("20.00")
    assert share["online"] == D("15.00")
    assert share["gap"] == D("-5.00")


@pytest.mark.django_db
def test_a_cancelled_order_refunded_in_full_leaves_nothing(event, ticket, portiers):
    shared(event, online=portiers)
    bought_online(event, (ticket, 10), refunded=10, status=Order.STATUS_CANCELED)

    assert statement(event)["shares"] == []


@pytest.mark.django_db
def test_the_webshop_fees_are_the_online_association_s(event, ticket, portiers):
    shared(event, online=portiers)
    bought_online(event, (ticket, 10), fees=[D("1.50")])

    (share,) = statement(event)["shares"]

    assert share["fees"] == [{"name": "Service fee", "count": 1, "total": D("1.50")}]
    assert (share["sold"], share["online"], share["gap"]) == (D("11.50"), D("11.50"), None)


@pytest.mark.django_db
def test_an_order_rung_up_at_a_till_is_not_counted_twice(event, till, device, ticket, portiers, comptoir):
    """The till's order is in pretix too; the journal is what counts it."""
    PosDevice.objects.create(device=device, role=PosDevice.ROLE_DOOR)
    shared(event, online=comptoir, door=portiers, bar=portiers)
    response = sell(till, [{"item": ticket.pk, "count": 1}])
    assert response.status_code == 201, response.content

    (share,) = statement(event)["shares"]

    assert share["label"] == "Les Portiers"
    assert (share["cash"], share["online"]) == (D("10.00"), D("0.00"))


# -- who holds the money, and the transfers -----------------------------------


@pytest.mark.django_db
def test_the_bar_s_card_payments_in_the_sumup_account_are_owed_to_the_bar(
    event, organizer, counters, ticket, beer, door, bar_till, portiers, comptoir
):
    shared(event, door=portiers, bar=comptoir)
    organizer.settings.set("openpos_sumup_holder", str(portiers.pk))
    on_the_reader(event, rung(event, bar_till, [line(beer, 5, "3.00")], payment_type="card"))
    on_the_reader(event, rung(event, door, [line(ticket, 1, "10.00")], payment_type="card"))

    report = statement(event)

    (transfer,) = report["transfers"]
    assert (transfer["payer"], transfer["payee"], transfer["amount"]) == (portiers, comptoir, D("15.00"))
    (detail,) = transfer["details"]
    assert (detail["why"], detail["amount"]) == ("reader", D("15.00"))
    assert report["reader_unheld"] is None


@pytest.mark.django_db
def test_a_card_taken_on_a_phone_stays_with_its_owner(event, organizer, counters, beer, bar_till, portiers, comptoir):
    """No reader payment behind the sale: nobody here knows whose account it went to."""
    shared(event, bar=comptoir)
    organizer.settings.set("openpos_sumup_holder", str(portiers.pk))
    rung(event, bar_till, [line(beer, 1, "3.00")], payment_type="card")

    report = statement(event)

    assert report["transfers"] == []
    assert report["reader_unheld"] is None


@pytest.mark.django_db
def test_reader_money_nobody_holds_is_said_rather_than_guessed(event, counters, beer, bar_till, comptoir):
    shared(event, bar=comptoir)
    on_the_reader(event, rung(event, bar_till, [line(beer, 2, "3.00")], payment_type="card"))

    report = statement(event)

    assert report["transfers"] == []
    assert report["reader_unheld"] == D("6.00")


@pytest.mark.django_db
def test_the_door_s_cash_in_the_bar_s_drawer_is_owed_to_the_door(
    event, organizer, counters, ticket, bar_till, portiers, comptoir
):
    shared(event, door=portiers, bar=comptoir)
    opening = a_drawer(organizer, "Caisse du bar", held_by=comptoir)
    rung(event, bar_till, [line(ticket, 2, "10.00")], drawer_session=opening)

    (transfer,) = statement(event)["transfers"]

    assert (transfer["payer"], transfer["payee"], transfer["amount"]) == (comptoir, portiers, D("20.00"))
    (detail,) = transfer["details"]
    assert (detail["why"], detail["which"]) == ("drawer", "Caisse du bar")


@pytest.mark.django_db
def test_two_debts_between_the_same_associations_make_one_transfer(
    event, organizer, counters, ticket, beer, door, bar_till, portiers, comptoir
):
    """The bar keeps 20 € of door cash, the door's SumUp holds 15 € of the bar's: 5 € settle it."""
    shared(event, door=portiers, bar=comptoir)
    organizer.settings.set("openpos_sumup_holder", str(portiers.pk))
    opening = a_drawer(organizer, "Caisse du bar", held_by=comptoir)
    rung(event, bar_till, [line(ticket, 2, "10.00")], drawer_session=opening)
    on_the_reader(event, rung(event, bar_till, [line(beer, 5, "3.00")], payment_type="card"))

    (transfer,) = statement(event)["transfers"]

    assert (transfer["payer"], transfer["payee"], transfer["amount"]) == (comptoir, portiers, D("5.00"))
    assert sorted((d["why"], d["amount"]) for d in transfer["details"]) == [
        ("drawer", D("20.00")), ("reader", D("15.00")),
    ]


@pytest.mark.django_db
def test_debts_that_cancel_out_need_no_transfer(
    event, organizer, counters, ticket, beer, bar_till, portiers, comptoir
):
    shared(event, door=portiers, bar=comptoir)
    organizer.settings.set("openpos_sumup_holder", str(portiers.pk))
    opening = a_drawer(organizer, "Caisse du bar", held_by=comptoir)
    rung(event, bar_till, [line(ticket, 1, "10.00")], drawer_session=opening)
    on_the_reader(event, rung(event, bar_till, [line(beer, 1, "10.00")], payment_type="card"))

    assert statement(event)["transfers"] == []


@pytest.mark.django_db
def test_a_debt_that_came_back_to_nothing_is_left_out_of_the_detail(
    event, organizer, counters, ticket, bar_till, portiers, comptoir
):
    shared(event, door=portiers, bar=comptoir)
    bar = a_drawer(organizer, "Caisse du bar", held_by=comptoir)
    spare = a_drawer(organizer, "Caisse d'appoint", held_by=comptoir)
    rung(event, bar_till, [line(ticket, 2, "10.00")], drawer_session=bar)
    # Sold into the spare drawer and cancelled at the till, which gives the
    # money back out of the same drawer.
    cancelled(event, rung(event, bar_till, [line(ticket, 1, "10.00")], drawer_session=spare),
              device=bar_till, drawer_session=spare)

    (transfer,) = statement(event)["transfers"]

    assert transfer["amount"] == D("20.00")
    assert [detail["which"] for detail in transfer["details"]] == ["Caisse du bar"]


@pytest.mark.django_db
def test_a_drawer_kept_by_its_own_association_owes_nothing(event, organizer, counters, beer, bar_till, comptoir):
    shared(event, bar=comptoir)
    opening = a_drawer(organizer, "Caisse du bar", held_by=comptoir)
    rung(event, bar_till, [line(beer, 3, "3.00")], drawer_session=opening)

    assert statement(event)["transfers"] == []


@pytest.mark.django_db
def test_money_held_for_a_part_nobody_counts_is_said_and_left_out(
    event, organizer, counters, beer, bar_till, portiers
):
    shared(event, door=portiers)
    opening = a_drawer(organizer, "Caisse", held_by=portiers)
    rung(event, bar_till, [line(beer, 2, "3.00")], drawer_session=opening)

    report = statement(event)

    assert report["transfers"] == []
    assert report["unplaced"] == D("6.00")


@pytest.mark.django_db
def test_online_payments_landing_with_another_association_are_owed_back(event, ticket, portiers, comptoir):
    shared(event, online=portiers)
    event.settings.set("openpos_online_holder", str(comptoir.pk))
    bought_online(event, (ticket, 10), (ticket, 10))

    (transfer,) = statement(event)["transfers"]

    assert (transfer["payer"], transfer["payee"], transfer["amount"]) == (comptoir, portiers, D("20.00"))
    assert transfer["details"][0]["why"] == "online"


@pytest.mark.django_db
def test_an_association_of_another_organizer_is_nobody(event, ticket, portiers):
    from pretix.base.models import Organizer

    elsewhere = PosAssociation.objects.create(
        organizer=Organizer.objects.create(name="Ailleurs", slug="ailleurs"), name="Voisins"
    )
    event.settings.set("openpos_share_online", str(elsewhere.pk))
    event.settings.set("openpos_share_door", "not a number")
    event.settings.set("openpos_online_holder", "not a number")
    bought_online(event, (ticket, 10))

    report = statement(event)

    assert [share["label"] for share in report["shares"]] == ["Online sales"]
    assert report["transfers"] == []


# -- a series -----------------------------------------------------------------


@pytest.fixture
def two_dates(organizer, channel):
    from pretix.base.models import Item

    event = series_event(organizer)
    first = a_date(event, "Vendredi", now() + timedelta(days=1))
    second = a_date(event, "Samedi", now() + timedelta(days=2))
    ticket = Item.objects.create(event=event, name="Entrée", default_price=10, admission=True)
    return event, first, second, ticket


@pytest.mark.django_db
def test_in_a_series_each_date_has_its_own_statement(two_dates, organizer, portiers, comptoir):
    event, first, second, ticket = two_dates
    shared(event, online=portiers, door=portiers, bar=comptoir)
    door = a_device(organizer, "Porte", PosDevice.ROLE_DOOR)
    rung(event, door, [line(ticket, 1, "10.00", subevent=first.pk)])
    rung(event, door, [line(ticket, 2, "10.00", subevent=second.pk)])
    bought_online(event, (ticket, 10, first))
    # A pass for both evenings, paid as one: 12 € for the first, 18 € for the second.
    bought_online(event, (ticket, 12, first), (ticket, 18, second), fees=[D("2.00")])

    friday = statement(event, first)
    saturday = statement(event, second)
    whole = statement(event)

    assert share_of(friday, "Les Portiers")["cash"] == D("10.00")
    # The fee goes with the order's first date, and its money in proportion.
    assert share_of(friday, "Les Portiers")["online"] == D("24.00")
    assert share_of(friday, "Les Portiers")["fees"] == [{"name": "Service fee", "count": 1, "total": D("2.00")}]
    assert products_of(share_of(friday, "Les Portiers")) == {("Entrée", None): (3, D("32.00"))}
    assert share_of(saturday, "Les Portiers")["cash"] == D("20.00")
    assert share_of(saturday, "Les Portiers")["online"] == D("18.00")
    assert share_of(saturday, "Les Portiers")["fees"] == []
    assert share_of(whole, "Les Portiers")["total"] == D("72.00")


@pytest.mark.django_db
def test_in_a_series_an_order_that_holds_nothing_any_more_stays_with_its_first_date(two_dates, portiers):
    """Cancelled with a fee kept: the money left is the first date's."""
    event, first, second, ticket = two_dates
    shared(event, online=portiers)
    order = bought_online(event, (ticket, 10, second), refunded=8)
    OrderPosition.all.filter(order=order).update(canceled=True)

    assert share_of(statement(event, second), "Les Portiers")["online"] == D("2.00")
    assert statement(event, first)["shares"] == []


# -- the page -----------------------------------------------------------------


@pytest.mark.django_db
def test_whoever_reads_the_orders_reads_the_statements(
    reader, event, counters, ticket, beer, door, bar_till, portiers, comptoir
):
    shared(event, online=portiers, door=portiers, bar=comptoir)
    bought_online(event, (ticket, 10))
    rung(event, bar_till, [line(beer, 2, "3.00")])

    response = reader.get(statements_url(event))

    assert response.status_code == 200
    page = response.content.decode()
    assert "Les Portiers" in page
    assert "Le Comptoir" in page
    # Read, not set: the form is for whoever may change the event's settings.
    assert 'name="share_online"' not in page


@pytest.mark.django_db
def test_somebody_who_may_not_read_the_orders_is_turned_away(outsider, event):
    assert outsider.get(statements_url(event)).status_code == 403


@pytest.mark.django_db
def test_reading_the_statements_is_not_enough_to_change_them(reader, event, portiers):
    response = reader.post(statements_url(event), {"share_online": portiers.pk})

    assert response.status_code == 403
    assert event.settings.get("openpos_share_online") is None


@pytest.mark.django_db
def test_who_counts_what_is_saved_and_written_to_the_history(backoffice, event, portiers, comptoir):
    response = backoffice.post(statements_url(event), {
        "share_online": portiers.pk, "share_door": portiers.pk, "share_pos": comptoir.pk,
        "online_holder": comptoir.pk,
    })

    assert response.status_code == 302
    event.settings.flush()
    assert event.settings.get("openpos_share_online") == str(portiers.pk)
    assert event.settings.get("openpos_share_door") == str(portiers.pk)
    assert event.settings.get("openpos_share_bar") == str(comptoir.pk)
    assert event.settings.get("openpos_online_holder") == str(comptoir.pk)
    entry = event.all_logentries().get(action_type="pretix_openpos.shares.changed")
    text = str(entry.display())
    assert "Who counts what was changed:" in text
    assert "Bar: nobody → Le Comptoir" in text
    assert "online payments held by: nobody → Le Comptoir" in text

    # Put back to nobody, which forgets the setting rather than storing a blank.
    backoffice.post(statements_url(event), {"share_online": "", "share_door": portiers.pk,
                                            "share_pos": comptoir.pk, "online_holder": ""})
    event.settings.flush()
    assert event.settings.get("openpos_share_online") is None
    assert event.settings.get("openpos_online_holder") is None


@pytest.mark.django_db
def test_saving_what_did_not_change_writes_no_history(backoffice, event, portiers):
    shared(event, online=portiers)

    backoffice.post(statements_url(event), {"share_online": portiers.pk})

    assert not event.all_logentries().filter(action_type="pretix_openpos.shares.changed").exists()


@pytest.mark.django_db
@pytest.mark.parametrize("field", ["share_door", "online_holder"])
def test_an_association_that_is_not_there_is_refused(backoffice, event, portiers, field):
    response = backoffice.post(statements_url(event), {"share_online": portiers.pk, field: "999999"}, follow=True)

    assert "One of the associations chosen no longer exists." in response.content.decode()
    event.settings.flush()
    assert event.settings.get("openpos_share_online") is None


@pytest.mark.django_db
def test_the_page_says_what_is_left_to_set_up(backoffice, event, counters, beer, bar_till, comptoir, portiers):
    shared(event, bar=comptoir)
    on_the_reader(event, rung(event, bar_till, [line(beer, 2, "3.00")], payment_type="card"))
    rung(event, bar_till, [line(beer, 1, "3.00")], testmode=True)

    page = backoffice.get(statements_url(event)).content.decode()

    assert "Nobody counts these parts yet: Online sales, Door." in page
    assert "of card payments went into the SumUp account" in page
    assert "One sale made in test mode is left out." in page
    assert f'/control/organizer/{event.organizer.slug}/openpos/associations/' in page
    assert 'name="share_online"' in page


@pytest.mark.django_db
def test_the_page_with_no_association_at_all_says_where_to_add_them(backoffice, event):
    page = backoffice.get(statements_url(event)).content.decode()

    assert "No association yet, so the evening is shown part by part." in page
    assert "Nothing has been sold for this evening yet." in page


@pytest.mark.django_db
def test_the_page_lists_the_transfers_and_why(
    backoffice, event, organizer, counters, ticket, beer, bar_till, portiers, comptoir
):
    shared(event, online=portiers, door=portiers, bar=comptoir)
    organizer.settings.set("openpos_sumup_holder", str(portiers.pk))
    opening = a_drawer(organizer, "Caisse du bar", held_by=comptoir)
    rung(event, bar_till, [line(ticket, 2, "10.00")], drawer_session=opening)
    on_the_reader(event, rung(event, bar_till, [line(beer, 5, "3.00")], payment_type="card"))
    bought_online(event, (ticket, 10), refunded=4)

    page = backoffice.get(statements_url(event)).content.decode()

    assert "<strong>Le Comptoir</strong> pays <strong>€5.00</strong> to <strong>Les Portiers</strong>" in page
    assert "Le Comptoir holds €20.00 of Les Portiers's: cash in the drawer “Caisse du bar”." in page
    assert "Les Portiers holds €15.00 of Le Comptoir's: card payments on the SumUp account." in page
    assert "of the money is not in what was sold" in page


@pytest.mark.django_db
def test_nobody_owing_anybody_is_said(backoffice, event, counters, beer, bar_till, comptoir):
    shared(event, bar=comptoir)
    rung(event, bar_till, [line(beer, 1, "3.00")])

    page = backoffice.get(statements_url(event)).content.decode()

    assert "Nobody owes anybody: each association holds its own money." in page


@pytest.mark.django_db
def test_a_reader_is_shown_who_counts_what_without_a_form(reader, event, portiers):
    shared(event, online=portiers)
    event.settings.set("openpos_online_holder", str(portiers.pk))

    page = reader.get(statements_url(event)).content.decode()

    assert "<strong>Online sales</strong> Les Portiers" in page
    assert "<strong>Online payments land with</strong> Les Portiers" in page
    # Nor the way to a page it could not open.
    assert "/openpos/associations/" not in page


@pytest.mark.django_db
def test_in_a_series_the_page_shows_tonight_one_date_or_all_of_them(backoffice, two_dates, organizer, portiers):
    from pretix.base.models import Team

    event, first, second, ticket = two_dates
    Team.objects.filter(organizer=organizer).update(all_events=True)
    shared(event, online=portiers)
    bought_online(event, (ticket, 10, first))
    bought_online(event, (ticket, 30, second))

    one = backoffice.get(statements_url(event, f"?date={second.pk}")).content.decode()
    every = backoffice.get(statements_url(event, "?date=all")).content.decode()
    default = backoffice.get(statements_url(event, "?date=nonsense"))

    assert "€30.00" in one and "€10.00" not in one
    assert "€40.00" in every
    assert default.status_code == 200
    assert f"?export=csv&amp;date={second.pk}" in one
    assert "?export=csv&amp;date=all" in every


# -- the spreadsheet ----------------------------------------------------------


def csv_rows(response):
    import csv
    import io

    content = b"".join(response.streaming_content).decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(content), delimiter=";"))


@pytest.mark.django_db
def test_the_statement_downloads_as_one_line_per_figure(
    reader, event, organizer, counters, ticket, beer, deposit, bar_till, portiers, comptoir
):
    shared(event, online=portiers, door=portiers, bar=comptoir)
    organizer.settings.set("openpos_sumup_holder", str(portiers.pk))
    on_the_reader(event, rung(event, bar_till, [line(beer, 2, "3.00"), line(deposit, 2, "1.00")], payment_type="card"))
    rung(event, bar_till, [line(deposit, -1, "1.00")], kind=PosSale.KIND_DEPOSIT_REFUND)
    rung(event, bar_till, [], total=D("1.50"))
    bought_online(event, (ticket, 10), fees=[D("1.00")])

    response = reader.get(statements_url(event, "?export=csv"))

    assert response.status_code == 200
    assert response["Content-Type"].startswith("text/csv")
    assert 'filename="openpos-statements-soiree.csv"' in response["Content-Disposition"]
    rows = csv_rows(response)
    by_kind = {(row["association"], row["kind"], row["product"]): row for row in rows}
    assert by_kind[("Le Comptoir", "product", "Bière")]["amount"] == "6.00"
    assert by_kind[("Le Comptoir", "product", "Bière")]["category"] == "Boissons"
    assert by_kind[("Le Comptoir", "deposit_taken", "")]["amount"] == "2.00"
    assert by_kind[("Le Comptoir", "deposit_returned", "")]["amount"] == "-1.00"
    assert by_kind[("Le Comptoir", "unallocated", "")]["amount"] == "1.50"
    assert by_kind[("Le Comptoir", "card", "")]["amount"] == "8.00"
    assert by_kind[("Le Comptoir", "cash", "")]["amount"] == "0.50"
    assert by_kind[("Les Portiers", "fee", "Service fee")]["amount"] == "1.00"
    assert by_kind[("Les Portiers", "online", "")]["amount"] == "11.00"
    assert by_kind[("Les Portiers", "transfer", "")]["counterpart"] == "Le Comptoir"
    assert by_kind[("Les Portiers", "transfer", "")]["amount"] == "8.00"
    # The parts that took something tonight: the door sold nothing.
    assert by_kind[("Les Portiers", "product", "Entrée")]["parts"] == "Online sales"


@pytest.mark.django_db
def test_a_date_of_a_series_downloads_under_its_own_name(backoffice, two_dates, organizer, portiers):
    from pretix.base.models import Team

    event, first, second, ticket = two_dates
    Team.objects.filter(organizer=organizer).update(all_events=True)
    shared(event, online=portiers)
    bought_online(event, (ticket, 10, first))

    one = backoffice.get(statements_url(event, f"?export=csv&date={first.pk}"))
    every = backoffice.get(statements_url(event, "?export=csv&date=all"))

    day = first.date_from.astimezone(event.timezone).date().isoformat()
    assert f'filename="openpos-statements-soirees-{day}.csv"' in one["Content-Disposition"]
    assert 'filename="openpos-statements-soirees-all.csv"' in every["Content-Disposition"]
    assert [row["kind"] for row in csv_rows(one)] == ["product", "online"]


@pytest.mark.django_db
def test_a_name_that_could_start_a_formula_goes_out_as_text(reader, event, ticket, organizer):
    evil = PosAssociation.objects.create(organizer=organizer, name="=HYPERLINK(1)")
    shared(event, online=evil)
    bought_online(event, (ticket, 10))

    rows = csv_rows(reader.get(statements_url(event, "?export=csv")))

    assert {row["association"] for row in rows} == {"'=HYPERLINK(1)"}


@pytest.mark.django_db
def test_the_statements_are_behind_their_own_permission_in_a_team(organizer, event):
    """With exactly the permission the page asks for, and with nothing."""
    allowed = staff(organizer, event, "compta@example.org", ["event.orders:read"])
    refused = staff(organizer, event, "rien@example.org", ["event.items:write"])

    assert allowed.get(statements_url(event)).status_code == 200
    assert refused.get(statements_url(event)).status_code == 403
