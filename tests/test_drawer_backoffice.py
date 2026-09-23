"""
Cash drawers in the back office.

Three screens and one column: the list where drawers are created, one drawer's
evenings, one evening's closing report, and the drawer each device feeds on the
till devices screen. Checked through the real pages, with teams holding exactly
the permissions they would hold in production — a report readable only by an
admin, or a form a treasurer could submit, are both bugs this suite exists to
catch.
"""
from datetime import timedelta
from decimal import Decimal
from io import StringIO

import pytest
from django.core.management import CommandError, call_command
from django.utils.timezone import now
from pretix.base.models import Event

from pretix_openpos.models import PosDevice, PosDrawer, PosDrawerEntry, PosDrawerSession, PosSale

from .conftest import sell, staff
from .test_drawers import count_it, give_drawer, open_it


def drawers_url(organizer):
    return f"/control/organizer/{organizer.slug}/openpos/drawers/"


def drawer_url(drawer):
    return f"{drawers_url(drawer.organizer)}{drawer.pk}/"


def session_url(session):
    return f"{drawer_url(session.drawer)}{session.pk}/"


def devices_url(organizer):
    return f"/control/organizer/{organizer.slug}/openpos/devices/"


def latest(organizer, action_type):
    return organizer.all_logentries().filter(action_type=action_type).latest("datetime")


@pytest.fixture
def evening(till, device, beer):
    """An evening at the bar: opened on 100, two beers, 20 taken out, counted, closed."""
    drawer = give_drawer(device)
    open_it(till, cashier="Léa")
    sell(till, [{"item": beer.pk, "count": 2}], idempotency_key="sale-00001", cashier="Léa")
    sell(till, [{"item": beer.pk, "count": 1}], idempotency_key="sale-00002",
         payment_type="card", cashier="Léa")
    till.post("drawer/movement", {
        "idempotency_key": "move-00001", "kind": "out", "amount": "20.00", "reason": "Glaçons",
    })
    count = count_it(till, "85.00").json()["entry"]
    till.post("drawer/close", {"idempotency_key": "close-00001", "count_seq": count["seq"],
                               "cashier": "Léa", "reason": "Manque un euro"})
    return drawer.sessions.get()


# -- the list ----------------------------------------------------------------


@pytest.mark.django_db
def test_an_admin_creates_a_drawer_for_each_drawer_behind_the_counter(backoffice, organizer):
    response = backoffice.post(drawers_url(organizer), {
        "action": "create", "new-name": " Bar ", "new-opening_float": "150.00",
    })

    assert response.status_code == 302
    drawer = PosDrawer.objects.get()
    assert drawer.name == "Bar"
    assert drawer.opening_float == Decimal("150.00")
    entry = latest(organizer, "pretix_openpos.drawer.created")
    assert entry.parsed_data["name"] == "Bar"
    assert "150.00" in entry.display()


@pytest.mark.django_db
def test_two_drawers_with_one_name_are_refused(backoffice, organizer):
    PosDrawer.objects.create(organizer=organizer, name="Bar")

    response = backoffice.post(drawers_url(organizer), {"action": "create", "new-name": "bar"})

    assert response.status_code == 200
    assert "already a drawer" in response.content.decode()
    assert PosDrawer.objects.count() == 1


@pytest.mark.django_db
def test_the_list_says_where_each_drawer_stands(backoffice, organizer, evening, another_till):
    give_drawer(another_till.device, name="Porte")
    open_it(another_till)

    page = backoffice.get(drawers_url(organizer)).content.decode()

    assert "Bar" in page and "Porte" in page
    assert "Caisse bar" in page  # the till feeding the bar drawer
    assert "Difference -€1.00" in page
    assert "since" in page  # the door's drawer, open


@pytest.mark.django_db
def test_a_drawer_is_renamed_and_its_float_changed_with_both_sides_logged(backoffice, organizer):
    drawer = PosDrawer.objects.create(organizer=organizer, name="Bar", opening_float=Decimal("100"))

    backoffice.post(drawers_url(organizer), {
        "action": "save", "drawer": drawer.pk,
        f"d{drawer.pk}-name": "Bar du haut", f"d{drawer.pk}-opening_float": "",
    })

    drawer.refresh_from_db()
    assert drawer.name == "Bar du haut"
    assert drawer.opening_float is None
    entry = latest(organizer, "pretix_openpos.drawer.changed")
    assert entry.parsed_data["name_before"] == "Bar"
    text = str(entry.display())
    assert "renamed from Bar" in text and "100.00" in text


@pytest.mark.django_db
def test_a_drawer_entry_written_by_hand_still_reads(organizer):
    """A log entry is not worth a 500, whatever somebody wrote into it."""
    organizer.log_action("pretix_openpos.drawer.changed", data={
        "name": "Bar", "name_before": "Bar", "opening_float": "cent", "opening_float_before": None,
    })

    text = str(latest(organizer, "pretix_openpos.drawer.changed").display())

    assert "usual float none → cent" in text


@pytest.mark.django_db
def test_saving_a_drawer_unchanged_writes_nothing_down(backoffice, organizer):
    drawer = PosDrawer.objects.create(organizer=organizer, name="Bar")

    backoffice.post(drawers_url(organizer), {
        "action": "save", "drawer": drawer.pk, f"d{drawer.pk}-name": "Bar",
    })

    assert not organizer.all_logentries().filter(
        action_type="pretix_openpos.drawer.changed"
    ).exists()


@pytest.mark.django_db
def test_a_rename_onto_another_drawer_s_name_is_refused(backoffice, organizer):
    PosDrawer.objects.create(organizer=organizer, name="Porte")
    drawer = PosDrawer.objects.create(organizer=organizer, name="Bar")

    response = backoffice.post(drawers_url(organizer), {
        "action": "save", "drawer": drawer.pk, f"d{drawer.pk}-name": "Porte",
    })

    assert response.status_code == 200
    drawer.refresh_from_db()
    assert drawer.name == "Bar"


@pytest.mark.django_db
def test_a_drawer_never_opened_can_be_deleted_and_its_tills_let_go(backoffice, organizer, device):
    drawer = give_drawer(device)

    backoffice.post(drawers_url(organizer), {"action": "delete", "drawer": drawer.pk})

    assert not PosDrawer.objects.exists()
    assert PosDevice.objects.get(device=device).drawer is None
    entry = latest(organizer, "pretix_openpos.drawer.deleted")
    assert "Caisse bar" in str(entry.display())


@pytest.mark.django_db
def test_a_drawer_with_a_history_keeps_it(backoffice, organizer, evening):
    response = backoffice.post(
        drawers_url(organizer), {"action": "delete", "drawer": evening.drawer_id}, follow=True
    )

    assert PosDrawer.objects.filter(pk=evening.drawer_id).exists()
    assert "history stays" in response.content.decode()


@pytest.mark.django_db
@pytest.mark.parametrize("body", [
    {"action": "save", "drawer": "abc"},
    {"action": "save", "drawer": "999999"},
    {"action": "sideways", "drawer": "{pk}"},
])
def test_a_post_naming_nothing_this_screen_knows_is_not_found(backoffice, organizer, body):
    drawer = PosDrawer.objects.create(organizer=organizer, name="Bar")
    body = {key: value.format(pk=drawer.pk) for key, value in body.items()}

    assert backoffice.post(drawers_url(organizer), body).status_code == 404


@pytest.mark.django_db
def test_another_organizer_s_drawer_is_out_of_reach(backoffice, organizer):
    from pretix.base.models import Organizer

    elsewhere = Organizer.objects.create(name="Ailleurs", slug="ailleurs")
    theirs = PosDrawer.objects.create(organizer=elsewhere, name="Bar")

    assert backoffice.get(f"{drawers_url(organizer)}{theirs.pk}/").status_code == 404
    response = backoffice.post(drawers_url(organizer), {"action": "delete", "drawer": theirs.pk})
    assert response.status_code == 404
    assert PosDrawer.objects.filter(pk=theirs.pk).exists()


# -- who may do what ---------------------------------------------------------


@pytest.mark.django_db
def test_whoever_reads_every_order_reads_the_drawers_and_changes_nothing(reader, organizer, evening):
    assert reader.get(drawers_url(organizer)).status_code == 200
    assert reader.get(drawer_url(evening.drawer)).status_code == 200
    assert reader.get(session_url(evening)).status_code == 200

    assert reader.post(drawers_url(organizer), {"action": "create", "new-name": "X"}).status_code == 403
    assert reader.post(session_url(evening), {"amount": "1"}).status_code == 403
    assert "Close from here" not in reader.get(session_url(evening)).content.decode()


@pytest.mark.django_db
def test_reading_one_event_s_orders_is_not_reading_the_drawers(organizer, event):
    Event.objects.create(
        organizer=organizer, name="Autre", slug="autre", date_from=now(), plugins="pretix_openpos"
    )
    one_event = staff(organizer, event, "tresorier@example.org", ["event.orders:read"])

    assert one_event.get(drawers_url(organizer)).status_code == 403


@pytest.mark.django_db
def test_a_member_with_no_permission_is_kept_out(outsider, organizer):
    assert outsider.get(drawers_url(organizer)).status_code == 403


@pytest.mark.django_db
def test_the_drawers_are_in_the_organizer_menu_for_whoever_may_read_them(
    backoffice, reader, outsider, organizer
):
    link = f'href="{drawers_url(organizer)}"'

    assert link in backoffice.get(drawers_url(organizer)).content.decode()
    assert link in reader.get(drawers_url(organizer)).content.decode()
    page = outsider.get(f"/control/organizer/{organizer.slug}/")
    assert link not in page.content.decode()


# -- one drawer --------------------------------------------------------------


@pytest.mark.django_db
def test_a_drawer_s_evenings_are_listed_with_their_difference(backoffice, evening, till):
    open_it(till, key="open-00002")

    response = backoffice.get(drawer_url(evening.drawer))

    assert response.status_code == 200
    rows = response.context["rows"]
    assert len(rows) == 2
    assert rows[0]["closing"] is None  # tonight, still open
    assert rows[1]["difference"] == Decimal("-1.00")
    assert response.context["tampered_with"] is None
    assert "Caisse bar" in response.content.decode()


@pytest.mark.django_db
def test_a_drawer_s_evenings_page_back_through_a_season(backoffice, organizer, monkeypatch):
    from pretix_openpos import drawer_views

    monkeypatch.setattr(drawer_views, "SESSIONS_PER_PAGE", 2)
    drawer = PosDrawer.objects.create(organizer=organizer, name="Bar")
    for days in range(3):
        PosDrawerSession.objects.create(
            drawer=drawer, opened_at=now() - timedelta(days=days + 1), closed_at=now()
        )

    first = backoffice.get(drawer_url(drawer))
    second = backoffice.get(drawer_url(drawer) + "?page=2")
    nonsense = backoffice.get(drawer_url(drawer) + "?page=deux")

    assert first.context["next_page"] == 2 and first.context["previous_page"] is None
    assert len(second.context["rows"]) == 1 and second.context["previous_page"] == 1
    assert nonsense.context["page"] == 1


@pytest.mark.django_db
def test_a_doctored_ledger_is_said_in_red(backoffice, evening):
    PosDrawerEntry.objects.filter(session=evening, kind=PosDrawerEntry.KIND_OUT).update(
        amount=Decimal("2.00")
    )

    response = backoffice.get(drawer_url(evening.drawer))

    assert response.context["tampered_with"].kind == PosDrawerEntry.KIND_OUT
    assert "does not add up" in response.content.decode()


@pytest.mark.django_db
def test_a_drawer_s_evenings_export_as_one_file(backoffice, evening):
    response = backoffice.get(drawer_url(evening.drawer) + "?export=csv")

    body = b"".join(response.streaming_content).decode("utf-8")
    header, row = body.lstrip("﻿").strip().splitlines()
    assert header.startswith("opening;opened_at;opened_by;closed_at")
    fields = dict(zip(header.split(";"), row.split(";")))
    assert fields["float"] == "100.00"
    assert fields["cash_sales"] == "6.00"
    assert fields["cash_out"] == "20.00"
    assert fields["expected"] == "86.00"
    assert fields["counted"] == "85.00"
    assert fields["difference"] == "-1.00"
    assert fields["card"] == "3.00"
    assert fields["note"] == "Manque un euro"


@pytest.mark.django_db
def test_an_opening_still_running_exports_with_blanks(backoffice, till, device):
    drawer = give_drawer(device)
    open_it(till)

    body = b"".join(
        backoffice.get(drawer_url(drawer) + "?export=csv").streaming_content
    ).decode("utf-8")

    row = body.strip().splitlines()[1].split(";")
    assert row[3] == ""  # closed_at


# -- one evening ---------------------------------------------------------------


@pytest.mark.django_db
def test_the_closing_report_adds_the_evening_up(backoffice, evening):
    response = backoffice.get(session_url(evening))

    assert response.status_code == 200
    figures = response.context["figures"]
    assert figures["float"] == Decimal("100.00")
    assert figures["cash_sales"] == Decimal("6.00")
    assert figures["cash_out"] == Decimal("20.00")
    assert figures["expected"] == Decimal("86.00")
    assert response.context["closing"].amount == Decimal("85.00")
    assert response.context["late"] is False
    (till_row,) = response.context["tills"]
    assert till_row["label"] == "Caisse bar · Léa"
    assert till_row["cash"] == Decimal("6.00") and till_row["card"] == Decimal("3.00")
    page = response.content.decode()
    assert "Glaçons" in page and "Manque un euro" in page
    assert "Soirée" in page  # the event its sales belong to


@pytest.mark.django_db
def test_a_sale_replayed_after_the_closing_is_said_rather_than_folded_in(backoffice, evening, till, beer):
    # The evening ran for hours, which the fixture rang up in a second.
    PosDrawerSession.objects.filter(pk=evening.pk).update(
        opened_at=evening.closed_at - timedelta(hours=4)
    )
    sell(
        till, [{"item": beer.pk, "count": 1, "price": "3.00"}],
        idempotency_key="offline-00001",
        offline={"recorded_at": (evening.closed_at - timedelta(minutes=5)).isoformat(),
                 "charged_total": "3.00"},
    )

    response = backoffice.get(session_url(evening))

    assert response.context["late"] is True
    assert response.context["difference_now"] == Decimal("-4.00")
    assert "after it was closed" in response.content.decode()


@pytest.mark.django_db
def test_a_drawer_a_till_forgot_is_closed_from_the_back_office(backoffice, organizer, till, device):
    drawer = give_drawer(device)
    open_it(till)
    session = drawer.sessions.get()

    response = backoffice.post(session_url(session), {"amount": "99.50", "reason": "Compté lundi"})

    assert response.status_code == 302
    session.refresh_from_db()
    assert session.closed_at is not None
    closing = session.entries.get(kind=PosDrawerEntry.KIND_CLOSE)
    assert closing.source == PosDrawerEntry.SOURCE_BACKOFFICE
    assert closing.amount == Decimal("99.50")
    assert closing.cashier == "boss@example.org"
    assert closing.user is not None
    entry = latest(organizer, "pretix_openpos.drawer.closed")
    assert "Compté lundi" in str(entry.display())
    assert "from the back office" in backoffice.get(session_url(session)).content.decode()


@pytest.mark.django_db
def test_nobody_counted_it_is_a_closing_too(backoffice, organizer, till, device):
    drawer = give_drawer(device)
    open_it(till)
    session = drawer.sessions.get()

    backoffice.post(session_url(session), {"amount": ""})

    closing = session.entries.get(kind=PosDrawerEntry.KIND_CLOSE)
    assert closing.amount is None
    assert "without a count" in str(latest(organizer, "pretix_openpos.drawer.closed").display())
    assert "Not counted" in backoffice.get(session_url(session)).content.decode()


@pytest.mark.django_db
def test_closing_an_evening_twice_is_said(backoffice, evening):
    response = backoffice.post(session_url(evening), {"amount": "1"}, follow=True)

    assert "already been closed" in response.content.decode()
    assert evening.entries.filter(kind=PosDrawerEntry.KIND_CLOSE).count() == 1


@pytest.mark.django_db
def test_a_back_office_closing_that_loses_the_race_is_said(backoffice, till, device, monkeypatch):
    from pretix_openpos import drawer_views
    from pretix_openpos.drawers import DrawerError

    drawer = give_drawer(device)
    open_it(till)

    def refuse(*args, **kwargs):
        raise DrawerError("drawer_closed", "Closed on the till a moment ago.")

    monkeypatch.setattr(drawer_views, "close_drawer", refuse)
    response = backoffice.post(session_url(drawer.sessions.get()), {"amount": "1"}, follow=True)

    assert "Closed on the till a moment ago." in response.content.decode()


@pytest.mark.django_db
def test_a_negative_count_is_refused_on_the_form(backoffice, till, device):
    drawer = give_drawer(device)
    open_it(till)

    response = backoffice.post(session_url(drawer.sessions.get()), {"amount": "-5"})

    assert response.status_code == 200
    assert response.context["close_form"].errors
    assert drawer.sessions.get().closed_at is None


@pytest.mark.django_db
def test_an_opening_of_another_drawer_is_not_found(backoffice, organizer, evening):
    other = PosDrawer.objects.create(organizer=organizer, name="Porte")

    assert backoffice.get(f"{drawer_url(other)}{evening.pk}/").status_code == 404


@pytest.mark.django_db
def test_an_empty_opening_says_nothing_was_sold(backoffice, till, device, event):
    drawer = give_drawer(device)
    open_it(till)
    event.testmode = True
    event.save()

    page = backoffice.get(session_url(drawer.sessions.get())).content.decode()

    assert "Nothing was sold into this opening." in page


# -- the devices screen --------------------------------------------------------


@pytest.mark.django_db
def test_a_device_is_given_its_drawer_next_to_its_role(backoffice, organizer, device):
    drawer = PosDrawer.objects.create(organizer=organizer, name="Bar")

    page = backoffice.get(devices_url(organizer)).content.decode()
    backoffice.post(devices_url(organizer), {f"drawer_{device.pk}": str(drawer.pk)})

    assert "Cash drawer" in page and "Bar" in page
    assert PosDevice.objects.get(device=device).drawer == drawer
    entry = latest(organizer, "pretix_openpos.devices.changed")
    assert entry.parsed_data["changed"][0]["drawer"] == "Bar"
    assert "cash drawer Bar" in str(entry.display())


@pytest.mark.django_db
def test_moving_a_device_between_drawers_is_readable(backoffice, organizer, device):
    bar = give_drawer(device, name="Bar")
    PosDrawer.objects.create(organizer=organizer, name="Porte")
    porte = PosDrawer.objects.get(name="Porte")

    backoffice.post(devices_url(organizer), {f"drawer_{device.pk}": str(porte.pk)})
    assert "cash drawer Bar → Porte" in str(
        latest(organizer, "pretix_openpos.devices.changed").display()
    )
    backoffice.post(devices_url(organizer), {f"drawer_{device.pk}": ""})
    assert "cash drawer Porte taken away" in str(
        latest(organizer, "pretix_openpos.devices.changed").display()
    )
    assert bar.devices.count() == 0


@pytest.mark.django_db
def test_a_drawer_that_is_not_the_organizer_s_is_refused(backoffice, organizer, device):
    from pretix.base.models import Organizer

    elsewhere = Organizer.objects.create(name="Ailleurs", slug="ailleurs")
    theirs = PosDrawer.objects.create(organizer=elsewhere, name="Bar")

    response = backoffice.post(devices_url(organizer), {f"drawer_{device.pk}": str(theirs.pk)})

    assert response.status_code == 200
    assert "no cash drawer" in response.content.decode()
    assert not PosDevice.objects.filter(device=device).exists()


# -- the journal ---------------------------------------------------------------


@pytest.mark.django_db
def test_the_journal_names_the_drawer_each_sale_went_into(backoffice, event, evening):
    sales_url = f"/control/event/{event.organizer.slug}/{event.slug}/openpos/sales/"

    page = backoffice.get(sales_url).content.decode()
    body = b"".join(backoffice.get(sales_url + "?export=csv").streaming_content).decode()

    assert session_url(evening) in page
    header, *rows = body.lstrip("﻿").strip().splitlines()
    assert header.endswith(";drawer;drawer_opening")
    assert rows[0].endswith(f";Bar;{evening.pk}")


# -- the audit -----------------------------------------------------------------


@pytest.mark.django_db
def test_the_audit_walks_every_drawer_s_ledger(evening):
    out = StringIO()
    call_command("openpos_verify_journal", stdout=out)
    # Open, the ice money, the count, the closing: the sales are the journal's.
    assert f"drawer {evening.drawer_id} (Bar) (4 rows)" in out.getvalue()

    PosDrawerEntry.objects.filter(session=evening, kind=PosDrawerEntry.KIND_OPEN).update(
        amount=Decimal("50.00")
    )
    with pytest.raises(CommandError) as failure:
        call_command("openpos_verify_journal", stdout=StringIO())
    assert "drawer" in str(failure.value)


@pytest.mark.django_db
def test_the_audit_of_one_event_leaves_the_drawers_to_the_full_run(evening, event):
    out = StringIO()

    call_command("openpos_verify_journal", event=f"{event.organizer.slug}/{event.slug}", stdout=out)

    assert "drawer" not in out.getvalue()
    assert PosSale.objects.filter(drawer_session=evening).count() == 2
