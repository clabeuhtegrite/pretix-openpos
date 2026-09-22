"""
Where the plugin's screens are found in pretix' own sidebar.

The two event screens, *Who sells what* and *Sales*, were declared only as the
plugin's ``navigation_links``. pretix 2026.7 shows those in one place: the "Go
to" menu on the plugin's card, under Settings → Plugins. So the journal an
organiser opens at the end of every evening, drawer counted, had no entry in
the event's sidebar at all.

These tests read the sidebar the way it is actually drawn, off a rendered event
page, rather than calling the receiver: what matters is what an organiser sees,
and a receiver pretix never calls would pass every test that called it by hand.
"""
import re

import pytest

from .conftest import staff


def event_url(event, page=""):
    return f"/control/event/{event.organizer.slug}/{event.slug}/{page}"


def categories_url(event):
    return event_url(event, "openpos/categories/")


def sales_url(event):
    return event_url(event, "openpos/sales/")


def links_to(page, url):
    """The attributes of every link on the page that points at ``url``."""
    return re.findall(rf'<a href="{re.escape(url)}"([^>]*)>', page)


def sidebar(client, event, page=""):
    response = client.get(event_url(event, page))
    assert response.status_code == 200
    return response.content.decode()


@pytest.mark.django_db
def test_an_admin_finds_both_screens_in_the_event_sidebar(backoffice, event):
    page = sidebar(backoffice, event)

    assert "Open POS" in page
    assert links_to(page, categories_url(event))
    assert links_to(page, sales_url(event))


@pytest.mark.django_db
def test_someone_who_may_only_read_orders_is_offered_the_journal_alone(reader, event):
    # The journal is guarded by event.orders:read, the categories by
    # event.items:write. A link to a page that answers 403 is worse than none.
    page = sidebar(reader, event)

    assert links_to(page, sales_url(event))
    assert not links_to(page, categories_url(event))


@pytest.mark.django_db
def test_someone_who_may_only_change_products_is_offered_the_categories_alone(
    organizer, event
):
    client = staff(organizer, event, "catalogue@example.org", ["event.items:write"])

    page = sidebar(client, event)

    assert links_to(page, categories_url(event))
    assert not links_to(page, sales_url(event))


@pytest.mark.django_db
def test_someone_who_may_open_neither_gets_no_entry_at_all(organizer, event):
    client = staff(organizer, event, "vouchers@example.org", ["event.vouchers:read"])

    page = sidebar(client, event)

    assert not links_to(page, categories_url(event))
    assert not links_to(page, sales_url(event))
    # Not even an empty heading with nothing under it.
    assert "fa-calculator" not in page


@pytest.mark.django_db
def test_every_link_it_offers_opens(reader, backoffice, event):
    """The permission the link is shown under is the one the page enforces."""
    for client in (reader, backoffice):
        page = sidebar(client, event)
        for url in (categories_url(event), sales_url(event)):
            if links_to(page, url):
                assert client.get(url).status_code == 200, url


@pytest.mark.django_db
@pytest.mark.parametrize("here, elsewhere", [
    ("openpos/categories/", "openpos/sales/"),
    ("openpos/sales/", "openpos/categories/"),
])
def test_the_page_open_is_the_one_marked(backoffice, event, here, elsewhere):
    page = sidebar(backoffice, event, here)

    # pretix unfolds the menu around the child link marked active, and draws
    # that one highlighted.
    assert any('class="active"' in attrs for attrs in links_to(page, event_url(event, here)))
    assert not any(
        'class="active"' in attrs for attrs in links_to(page, event_url(event, elsewhere))
    )


@pytest.mark.django_db
def test_nothing_is_marked_on_a_page_of_pretix_own(backoffice, event):
    page = sidebar(backoffice, event)

    for url in (categories_url(event), sales_url(event)):
        assert not any('class="active"' in attrs for attrs in links_to(page, url))


@pytest.mark.django_db
def test_an_event_that_does_not_run_the_till_has_no_entry(backoffice, event):
    # The receiver is an event plugin signal: pretix only asks it on events
    # that have the plugin switched on, which is what keeps a festival that
    # sells nothing at the door from growing a menu for a till it has not got.
    event.disable_plugin("pretix_openpos")
    event.save()

    page = sidebar(backoffice, event)

    assert not links_to(page, categories_url(event))
    assert not links_to(page, sales_url(event))
    assert "fa-calculator" not in page
