"""
The associations that share the evenings, and whose account holds what.

The organizer's page: the list of associations, and who keeps the money that
does not stay with its owner — the SumUp account's, each drawer's. Behind the
organizer's settings, like the card readers page, since saying whose account a
card payment is owed from is a decision about the associations' money.
"""
import re
from datetime import timedelta

import pytest
from django.utils.timezone import now
from pretix.base.models import Event, Organizer, Team

from pretix_openpos.associations import sumup_holder, uses
from pretix_openpos.models import PosAssociation, PosDrawer

from .conftest import staff


def associations_url(organizer):
    return f"/control/organizer/{organizer.slug}/openpos/associations/"


@pytest.fixture
def portiers(organizer):
    return PosAssociation.objects.create(organizer=organizer, name="Les Portiers")


@pytest.fixture
def comptoir(organizer):
    return PosAssociation.objects.create(organizer=organizer, name="Le Comptoir")


def history(organizer, action_type):
    return [
        str(entry.display())
        for entry in organizer.all_logentries().filter(action_type=action_type).order_by("pk")
    ]


def keeper(organizer, event, email, permissions):
    """A member with exactly these organizer permissions, and the event's orders to read."""
    client = staff(organizer, event, email, ["event.orders:read"])
    Team.objects.filter(members__email=email).update(
        all_organizer_permissions=False,
        limit_organizer_permissions=dict.fromkeys(permissions, True),
    )
    return client


def links_to(page, url):
    """The attributes of every link on the page that points at ``url``."""
    return re.findall(rf'<a href="{re.escape(url)}"([^>]*)>', page)


# -- who may -------------------------------------------------------------------


@pytest.mark.django_db
def test_the_page_asks_for_the_organizer_settings(organizer, event):
    allowed = keeper(organizer, event, "tresorier@example.org", ["organizer.settings.general:write"])
    devices_only = keeper(organizer, event, "technique@example.org", ["organizer.devices:write"])

    assert allowed.get(associations_url(organizer)).status_code == 200
    assert devices_only.get(associations_url(organizer)).status_code == 403
    assert devices_only.post(associations_url(organizer), {"action": "create", "new-name": "X"}).status_code == 403
    assert not PosAssociation.objects.exists()


@pytest.mark.django_db
def test_the_sidebar_offers_the_page_to_whoever_may_open_it(organizer, event):
    allowed = keeper(organizer, event, "tresorier@example.org", ["organizer.settings.general:write"])
    devices_only = keeper(organizer, event, "technique@example.org", ["organizer.devices:write"])
    arrivals = f"/control/organizer/{organizer.slug}/openpos/arrivals/"

    elsewhere = links_to(allowed.get(arrivals).content.decode(), associations_url(organizer))
    assert elsewhere and not any('class="active"' in attrs for attrs in elsewhere)
    assert not links_to(devices_only.get(arrivals).content.decode(), associations_url(organizer))
    here = links_to(allowed.get(associations_url(organizer)).content.decode(), associations_url(organizer))
    assert any('class="active"' in attrs for attrs in here)


@pytest.mark.django_db
def test_an_empty_page_says_what_it_is_for(backoffice, organizer):
    page = backoffice.get(associations_url(organizer)).content.decode()

    assert "No association yet. Add the ones that share your evenings." in page
    # Nothing to give the money to yet.
    assert 'name="sumup_holder"' not in page


# -- the list and each association's page -----------------------------------


def association_url(organizer, association=None):
    return associations_url(organizer) + (f"{association.pk}/" if association else "new/")


def profile(**changes):
    """What the form posts for a complete association, with ``changes`` on top."""
    data = {
        "action": "save",
        "name": "Les Portiers",
        "address": "12 rue des Lilas",
        "zipcode": "75011",
        "city": "Paris",
        "country": "FR",
        "siret": "123 456 789 00012",
        "vat_id": "",
        "invoice_prefix": "PORT-",
        "invoice_footer": "Association loi 1901",
    }
    data.update(changes)
    return data


@pytest.mark.django_db
def test_an_association_is_added_changed_and_deleted(backoffice, organizer):
    response = backoffice.post(association_url(organizer), profile())
    assert response.status_code == 302
    association = PosAssociation.objects.get()
    assert (association.organizer, association.invoice_prefix, association.can_issue) == (organizer, "PORT-", True)

    listed = backoffice.get(associations_url(organizer)).content.decode()
    assert "Numbered PORT-…" in listed
    assert association_url(organizer, association) in listed

    backoffice.post(association_url(organizer, association), profile(name="Portiers", city="Lyon"))
    association.refresh_from_db()
    assert (association.name, association.city) == ("Portiers", "Lyon")

    backoffice.post(association_url(organizer, association), {"action": "delete"})
    assert not PosAssociation.objects.exists()

    assert str(association) == "Portiers"
    assert history(organizer, "pretix_openpos.association.created") == ["An association was added: Les Portiers."]
    assert history(organizer, "pretix_openpos.association.changed") == [
        "The association Les Portiers, now Portiers, was changed: name, city."
    ]
    assert history(organizer, "pretix_openpos.association.deleted") == ["The association Portiers was deleted."]


@pytest.mark.django_db
def test_the_page_of_an_association_shows_what_it_says(backoffice, organizer, portiers):
    page = backoffice.get(association_url(organizer, portiers)).content.decode()

    assert 'value="Les Portiers"' in page
    assert "does not invoice yet" in page
    assert "Nothing names this association yet, so it can be deleted." in page


@pytest.mark.django_db
def test_changing_one_field_says_which(backoffice, organizer):
    backoffice.post(association_url(organizer), profile())
    association = PosAssociation.objects.get()

    backoffice.post(association_url(organizer, association), profile(invoice_prefix="LP-"))
    backoffice.post(association_url(organizer, association), profile(invoice_prefix="LP-"))

    assert history(organizer, "pretix_openpos.association.changed") == [
        "The association Les Portiers was changed: invoice number prefix."
    ]


@pytest.mark.django_db
def test_an_invoice_needs_an_address_and_a_prefix(backoffice, organizer):
    response = backoffice.post(association_url(organizer), profile(address="", invoice_prefix=""))

    assert response.status_code == 200
    assert response.content.decode().count("This field is required.") == 2
    assert not PosAssociation.objects.exists()


@pytest.mark.django_db
def test_two_associations_cannot_share_a_name(backoffice, organizer, portiers, comptoir):
    """Whatever the case: two sellers called the same are two nobody can tell apart."""
    created = backoffice.post(association_url(organizer), profile(name="les portiers"))
    renamed = backoffice.post(
        association_url(organizer, comptoir), profile(name="LES PORTIERS", invoice_prefix="COMPT-")
    )

    assert "There is already an association called “les portiers”." in created.content.decode()
    assert "There is already an association called “LES PORTIERS”." in renamed.content.decode()
    assert sorted(PosAssociation.objects.values_list("name", flat=True)) == ["Le Comptoir", "Les Portiers"]


@pytest.mark.django_db
def test_two_associations_cannot_share_a_prefix(backoffice, organizer, portiers):
    portiers.invoice_prefix = "PORT-"
    portiers.save()

    response = backoffice.post(association_url(organizer), profile(name="Le Comptoir", invoice_prefix="port-"))

    assert "“Les Portiers” already numbers its invoices with this prefix." in response.content.decode()


@pytest.mark.django_db
def test_a_prefix_only_takes_what_an_invoice_number_can_hold(backoffice, organizer):
    response = backoffice.post(association_url(organizer), profile(invoice_prefix="PORT!"))

    assert "Use only the characters A-Z, a-z, 0-9, -./:# here." in response.content.decode()


@pytest.mark.django_db
def test_a_prefix_the_event_s_invoices_use_would_not_start_from_1(backoffice, organizer, event, ticket):
    from .test_invoice_issuers import bought_online, invoiced

    invoiced(bought_online(event))

    response = backoffice.post(association_url(organizer), profile(invoice_prefix="SOIREE-"))

    assert "Invoices numbered with this prefix already exist in another name." in response.content.decode()


@pytest.mark.django_db
def test_an_association_keeps_its_own_prefix_once_it_has_invoiced(backoffice, organizer, event, ticket):
    from .test_invoice_issuers import bought_online, invoiced

    backoffice.post(association_url(organizer), profile(invoice_prefix="PORT-%Y-"))
    association = PosAssociation.objects.get()
    event.settings.set("openpos_online_holder", str(association.pk))
    invoice = invoiced(bought_online(event))
    assert invoice.number.endswith("-00001")

    response = backoffice.post(
        association_url(organizer, association), profile(invoice_prefix="PORT-%Y-", city="Lyon")
    )

    assert response.status_code == 302
    listed = backoffice.get(associations_url(organizer)).content.decode()
    assert invoice.number in listed
    assert "It has issued 1 invoice, which names it." in listed


@pytest.mark.django_db
def test_the_same_name_is_fine_in_another_organizer(backoffice, organizer, portiers):
    other = Organizer.objects.create(name="Voisins", slug="voisins")
    PosAssociation.objects.create(organizer=other, name="Le Comptoir", invoice_prefix="COMPT-")

    backoffice.post(association_url(organizer), profile(name="Le Comptoir", invoice_prefix="COMPT-"))

    assert PosAssociation.objects.filter(organizer=organizer, name="Le Comptoir").exists()


@pytest.mark.django_db
def test_an_association_still_named_somewhere_stays(backoffice, organizer, event, ticket, portiers):
    from .test_invoice_issuers import bought_online, invoiced

    for field, value in profile().items():
        if field not in ("action", "name"):
            setattr(portiers, field, value)
    portiers.save()
    organizer.settings.set("openpos_sumup_holder", str(portiers.pk))
    PosDrawer.objects.create(organizer=organizer, name="Caisse du bar", held_by=portiers)
    event.settings.set("openpos_online_holder", str(portiers.pk))
    invoiced(bought_online(event))
    invoiced(bought_online(event))

    response = backoffice.post(association_url(organizer, portiers), {"action": "delete"}, follow=True)

    assert PosAssociation.objects.filter(pk=portiers.pk).exists()
    page = response.content.decode()
    assert "“Les Portiers” is still in use, so it stays." in page
    assert "It has issued 2 invoices, which name it." in page
    assert "It invoices the cards taken on the SumUp account." in page
    assert "It invoices the cash of: Caisse du bar." in page
    assert "It invoices the online ticketing of: Soirée." in page
    # Said on its page too, where the delete button is not.
    own = backoffice.get(association_url(organizer, portiers)).content.decode()
    assert 'value="delete"' not in own
    assert "This association cannot be deleted:" in own


@pytest.mark.django_db
def test_what_names_an_association_is_read_in_its_own_organizer_only(organizer, event, portiers):
    """An event of another organizer carrying the same number is not this one's."""
    other = Organizer.objects.create(name="Voisins", slug="voisins")
    elsewhere = Event.objects.create(
        organizer=other, name="Ailleurs", slug="ailleurs", date_from=now() + timedelta(days=1),
    )
    elsewhere.settings.set("openpos_online_holder", str(portiers.pk))

    assert uses(portiers) == []


@pytest.mark.django_db
@pytest.mark.parametrize("post", [{"action": "nonsense"}, {}])
def test_a_post_that_says_nothing_is_not_found(backoffice, organizer, portiers, post):
    assert backoffice.post(association_url(organizer, portiers), post).status_code == 404
    assert backoffice.post(association_url(organizer), {"action": "delete"}).status_code == 404
    assert backoffice.post(associations_url(organizer), post).status_code == 404


@pytest.mark.django_db
def test_another_organizer_s_association_is_not_found(backoffice, organizer):
    other = Organizer.objects.create(name="Voisins", slug="voisins")
    theirs = PosAssociation.objects.create(organizer=other, name="Voisins")

    assert backoffice.get(association_url(organizer, theirs)).status_code == 404
    response = backoffice.post(association_url(organizer, theirs), {"action": "delete"})

    assert response.status_code == 404
    assert PosAssociation.objects.filter(pk=theirs.pk).exists()


# -- who holds the money -------------------------------------------------------


@pytest.mark.django_db
def test_whose_account_holds_the_money_is_saved_and_written_down(backoffice, organizer, portiers, comptoir):
    bar = PosDrawer.objects.create(organizer=organizer, name="Caisse du bar")
    old = PosDrawer.objects.create(organizer=organizer, name="Ancienne caisse", archived_at=now())

    page = backoffice.get(associations_url(organizer)).content.decode()
    assert f'name="drawer_{bar.pk}"' in page
    # Put away, and can be brought back: its cash is still somebody's to invoice.
    assert f'name="drawer_{old.pk}"' in page

    backoffice.post(associations_url(organizer), {
        "action": "holders", "sumup_holder": portiers.pk,
        f"drawer_{bar.pk}": comptoir.pk, f"drawer_{old.pk}": "",
    })

    assert sumup_holder(organizer) == portiers
    bar.refresh_from_db()
    old.refresh_from_db()
    assert (bar.held_by, old.held_by) == (comptoir, None)
    (entry,) = history(organizer, "pretix_openpos.holders.changed")
    assert "Who invoices what is taken on site was changed:" in entry
    assert "SumUp account: nobody → Les Portiers" in entry
    assert "cash drawer Caisse du bar: nobody → Le Comptoir" in entry
    assert "Ancienne caisse" not in entry

    # Back to nobody: the setting goes, rather than holding a blank.
    backoffice.post(associations_url(organizer), {
        "action": "holders", "sumup_holder": "", f"drawer_{bar.pk}": comptoir.pk,
    })
    organizer.settings.flush()
    assert organizer.settings.get("openpos_sumup_holder") is None
    assert "SumUp account: Les Portiers → nobody" in history(organizer, "pretix_openpos.holders.changed")[-1]


@pytest.mark.django_db
def test_saving_the_holders_unchanged_writes_no_history(backoffice, organizer, portiers):
    backoffice.post(associations_url(organizer), {"action": "holders", "sumup_holder": ""})

    assert history(organizer, "pretix_openpos.holders.changed") == []


@pytest.mark.django_db
def test_an_entry_that_changed_nothing_still_reads(organizer, event):
    """None is written today; the history is read long after whatever wrote it."""
    organizer.log_action("pretix_openpos.holders.changed", data={"changed": []})
    event.log_action("pretix_openpos.shares.changed", data={})

    assert history(organizer, "pretix_openpos.holders.changed") == [
        "Who invoices what is taken on site was saved with nothing changed."
    ]
    (entry,) = event.all_logentries().filter(action_type="pretix_openpos.shares.changed")
    assert str(entry.display()) == "Who counts what was saved with nothing changed."


@pytest.mark.django_db
@pytest.mark.parametrize("field", ["sumup_holder", "drawer"])
def test_a_holder_that_is_not_there_changes_nothing(backoffice, organizer, portiers, field):
    bar = PosDrawer.objects.create(organizer=organizer, name="Caisse du bar")
    name = f"drawer_{bar.pk}" if field == "drawer" else field

    response = backoffice.post(
        associations_url(organizer),
        {"action": "holders", "sumup_holder": portiers.pk, name: "999999"},
        follow=True,
    )

    assert "One of the associations chosen no longer exists." in response.content.decode()
    organizer.settings.flush()
    assert organizer.settings.get("openpos_sumup_holder") is None
    bar.refresh_from_db()
    assert bar.held_by is None


@pytest.mark.django_db
def test_without_a_drawer_the_page_says_where_the_cash_goes(backoffice, organizer, portiers):
    page = backoffice.get(associations_url(organizer)).content.decode()

    assert "cash sales are invoiced in the" in page
    assert f"/control/organizer/{organizer.slug}/openpos/drawers/" in page


@pytest.mark.django_db
def test_a_drawer_kept_by_an_association_keeps_it(organizer, portiers):
    """Deleting the association under a drawer is refused by the database too."""
    from django.db.models import ProtectedError

    PosDrawer.objects.create(organizer=organizer, name="Caisse du bar", held_by=portiers)

    with pytest.raises(ProtectedError):
        portiers.delete()


# -- a copied event ------------------------------------------------------------


def a_copy(event, organizer=None):
    copy = Event.objects.create(
        organizer=organizer or event.organizer, name="Soirée suivante", slug="soiree-2",
        date_from=now() + timedelta(days=8),
    )
    copy.copy_data_from(event)
    return copy


@pytest.mark.django_db
def test_a_copy_in_the_same_organizer_keeps_who_invoices_online_but_not_its_numbering(event, portiers):
    event.settings.set("openpos_online_holder", str(portiers.pk))
    event.settings.set("openpos_invoice_series", "FEST-")

    copy = a_copy(event)

    assert copy.settings.get("openpos_online_holder") == str(portiers.pk)
    # Kept, it would number on from the event it was copied from.
    assert copy.settings.get("openpos_invoice_series") is None


@pytest.mark.django_db
def test_a_copy_into_another_organizer_forgets_it(event, portiers):
    event.settings.set("openpos_online_holder", str(portiers.pk))
    other = Organizer.objects.create(name="Voisins", slug="voisins")

    copy = a_copy(event, organizer=other)

    assert copy.settings.get("openpos_online_holder") is None


# -- the history ----------------------------------------------------------------


@pytest.mark.django_db
def test_a_renaming_written_by_0_26_still_reads(organizer):
    organizer.log_action(
        "pretix_openpos.association.changed",
        data={"association": 1, "name": "Portiers", "name_before": "Les Portiers"},
    )

    assert history(organizer, "pretix_openpos.association.changed") == [
        "The association Les Portiers was renamed Portiers."
    ]


@pytest.mark.django_db
def test_a_field_the_history_no_longer_knows_is_named_as_written(organizer):
    organizer.log_action(
        "pretix_openpos.association.changed",
        data={"association": 1, "name": "Portiers", "name_before": "Portiers", "fields": ["logo"]},
    )

    assert history(organizer, "pretix_openpos.association.changed") == [
        "The association Portiers was changed: logo."
    ]


@pytest.mark.django_db
def test_who_counted_what_in_0_26_still_reads(event):
    event.log_action("pretix_openpos.shares.changed", data={"changed": [
        {"part": "door", "name": "Les Portiers", "name_before": None},
        {"part": "online_holder", "name": None, "name_before": "Le Comptoir"},
    ]})

    (entry,) = event.all_logentries().filter(action_type="pretix_openpos.shares.changed")
    text = str(entry.display())
    assert "Who counts what was changed:" in text
    assert "Door: nobody → Les Portiers" in text
    assert "online payments held by: Le Comptoir → nobody" in text
