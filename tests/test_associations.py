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


# -- the list --------------------------------------------------------------------


@pytest.mark.django_db
def test_an_association_is_added_renamed_and_deleted(backoffice, organizer):
    response = backoffice.post(associations_url(organizer), {"action": "create", "new-name": "Les Portiers"})
    assert response.status_code == 302
    association = PosAssociation.objects.get()
    assert association.organizer == organizer

    backoffice.post(associations_url(organizer), {
        "action": "save", "association": association.pk, f"a{association.pk}-name": "Portiers",
    })
    association.refresh_from_db()
    assert association.name == "Portiers"

    backoffice.post(associations_url(organizer), {"action": "delete", "association": association.pk})
    assert not PosAssociation.objects.exists()

    assert str(association) == "Portiers"
    assert history(organizer, "pretix_openpos.association.created") == ["An association was added: Les Portiers."]
    assert history(organizer, "pretix_openpos.association.changed") == [
        "The association Les Portiers was renamed Portiers."
    ]
    assert history(organizer, "pretix_openpos.association.deleted") == ["The association Portiers was deleted."]


@pytest.mark.django_db
def test_saving_a_name_unchanged_writes_no_history(backoffice, organizer, portiers):
    backoffice.post(associations_url(organizer), {
        "action": "save", "association": portiers.pk, f"a{portiers.pk}-name": "Les Portiers",
    })

    assert history(organizer, "pretix_openpos.association.changed") == []


@pytest.mark.django_db
def test_two_associations_cannot_share_a_name(backoffice, organizer, portiers, comptoir):
    """Whatever the case: two lines called the same are a statement nobody can read."""
    created = backoffice.post(associations_url(organizer), {"action": "create", "new-name": "les portiers"})
    renamed = backoffice.post(associations_url(organizer), {
        "action": "save", "association": comptoir.pk, f"a{comptoir.pk}-name": "LES PORTIERS",
    })

    assert created.status_code == 200
    assert "There is already an association called “les portiers”." in created.content.decode()
    assert renamed.status_code == 200
    assert "There is already an association called “LES PORTIERS”." in renamed.content.decode()
    assert sorted(PosAssociation.objects.values_list("name", flat=True)) == ["Le Comptoir", "Les Portiers"]


@pytest.mark.django_db
def test_the_same_name_is_fine_in_another_organizer(backoffice, organizer, portiers):
    other = Organizer.objects.create(name="Voisins", slug="voisins")
    PosAssociation.objects.create(organizer=other, name="Le Comptoir")

    backoffice.post(associations_url(organizer), {"action": "create", "new-name": "Le Comptoir"})

    assert PosAssociation.objects.filter(organizer=organizer, name="Le Comptoir").exists()


@pytest.mark.django_db
def test_an_association_still_named_somewhere_stays(backoffice, organizer, event, portiers):
    organizer.settings.set("openpos_sumup_holder", str(portiers.pk))
    PosDrawer.objects.create(organizer=organizer, name="Caisse du bar", held_by=portiers)
    event.settings.set("openpos_share_door", str(portiers.pk))

    response = backoffice.post(
        associations_url(organizer), {"action": "delete", "association": portiers.pk}, follow=True
    )

    assert PosAssociation.objects.filter(pk=portiers.pk).exists()
    page = response.content.decode()
    assert "“Les Portiers” is still in use, so it stays." in page
    assert "It holds the SumUp account&#x27;s money." in page
    assert "It holds the cash of: Caisse du bar." in page
    assert "It counts a part of: Soirée." in page
    # Said on the list too, where the delete button is not.
    listed = backoffice.get(associations_url(organizer)).content.decode()
    assert 'value="delete"' not in listed


@pytest.mark.django_db
def test_what_names_an_association_is_read_in_its_own_organizer_only(organizer, event, portiers):
    """An event of another organizer carrying the same number is not this one's."""
    other = Organizer.objects.create(name="Voisins", slug="voisins")
    elsewhere = Event.objects.create(
        organizer=other, name="Ailleurs", slug="ailleurs", date_from=now() + timedelta(days=1),
    )
    elsewhere.settings.set("openpos_share_bar", str(portiers.pk))

    assert uses(portiers) == []


@pytest.mark.django_db
@pytest.mark.parametrize("post", [
    {"action": "save", "association": "999999"},
    {"action": "delete", "association": "nope"},
    {"action": "delete"},
    {"action": "nonsense", "association": "{pk}"},
])
def test_what_names_no_association_of_this_organizer_is_not_found(backoffice, organizer, portiers, post):
    post = {key: value.format(pk=portiers.pk) for key, value in post.items()}

    assert backoffice.post(associations_url(organizer), post).status_code == 404


@pytest.mark.django_db
def test_another_organizer_s_association_is_not_found(backoffice, organizer):
    other = Organizer.objects.create(name="Voisins", slug="voisins")
    theirs = PosAssociation.objects.create(organizer=other, name="Voisins")

    response = backoffice.post(associations_url(organizer), {"action": "delete", "association": theirs.pk})

    assert response.status_code == 404
    assert PosAssociation.objects.filter(pk=theirs.pk).exists()


# -- who holds the money -------------------------------------------------------


@pytest.mark.django_db
def test_whose_account_holds_the_money_is_saved_and_written_down(backoffice, organizer, portiers, comptoir):
    bar = PosDrawer.objects.create(organizer=organizer, name="Caisse du bar")
    old = PosDrawer.objects.create(organizer=organizer, name="Ancienne caisse", archived_at=now())

    page = backoffice.get(associations_url(organizer)).content.decode()
    assert f'name="drawer_{bar.pk}"' in page
    # Put away, and still read by the statements of the evenings it was used on.
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
    assert "Who holds the money was changed:" in entry
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
        "Who holds the money was saved with nothing changed."
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

    assert "the cash of every sale counts as" in page
    assert f"/control/organizer/{organizer.slug}/openpos/drawers/" in page


@pytest.mark.django_db
def test_a_drawer_kept_by_an_association_keeps_it(organizer, portiers):
    """Deleting the association under a drawer is refused by the database too."""
    from django.db.models import ProtectedError

    PosDrawer.objects.create(organizer=organizer, name="Caisse du bar", held_by=portiers)

    with pytest.raises(ProtectedError):
        portiers.delete()


# -- a copied event ------------------------------------------------------------


@pytest.mark.django_db
def test_a_copy_in_the_same_organizer_keeps_who_counts_what(event, portiers, comptoir):
    event.settings.set("openpos_share_door", str(portiers.pk))
    event.settings.set("openpos_share_bar", str(comptoir.pk))
    copy = Event.objects.create(
        organizer=event.organizer, name="Soirée suivante", slug="soiree-2",
        date_from=now() + timedelta(days=8),
    )

    copy.copy_data_from(event)

    assert copy.settings.get("openpos_share_door") == str(portiers.pk)
    assert copy.settings.get("openpos_share_bar") == str(comptoir.pk)


@pytest.mark.django_db
def test_a_copy_into_another_organizer_forgets_it(event, portiers):
    event.settings.set("openpos_share_door", str(portiers.pk))
    other = Organizer.objects.create(name="Voisins", slug="voisins")
    copy = Event.objects.create(
        organizer=other, name="Soirée", slug="soiree", date_from=now() + timedelta(days=8),
    )

    copy.copy_data_from(event)

    assert copy.settings.get("openpos_share_door") is None
