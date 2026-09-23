from django.core.management.base import BaseCommand, CommandError
from django_scopes import scopes_disabled
from pretix.base.models import Event

from pretix_openpos.models import PosDrawer, PosDrawerEntry, PosSale


class Command(BaseCommand):
    """
    Re-verify the journal hash chain of every event, from the very first row —
    and the ledger of every cash drawer, which is chained the same way.

    The back-office sales page only walks the journal from an anchored
    checkpoint, which is cheap but cannot see a sloppy edit behind the anchor.
    This is the full audit — the thing to run from a cron job, or on the day
    somebody doubts the journal.
    """

    help = "Fully re-verify the Open POS journal hash chain of every event, and every drawer ledger."

    def add_arguments(self, parser):
        parser.add_argument(
            "--event",
            help="Limit the audit to one event, given as organizer/slug.",
        )

    def handle(self, *args, **options):
        broken = []
        with scopes_disabled():
            events = Event.objects.filter(
                pk__in=PosSale.objects.values_list("event", flat=True).distinct()
            ).select_related("organizer")
            if options["event"]:
                organizer, _sep, slug = options["event"].partition("/")
                events = events.filter(organizer__slug=organizer, slug=slug)
                if not events:
                    raise CommandError(
                        f"No Open POS journal found for {options['event']}."
                    )

            for event in events:
                label = f"{event.organizer.slug}/{event.slug}"
                bad = PosSale.verify_chain(event)
                if bad is None:
                    count = PosSale.objects.filter(event=event).count()
                    self.stdout.write(self.style.SUCCESS(f"  ok   {label} ({count} rows)"))
                else:
                    broken.append(label)
                    self.stdout.write(
                        self.style.ERROR(
                            f" FAIL  {label}: first bad row is seq {bad.seq} "
                            f"(order {bad.order_code})"
                        )
                    )

            # Drawers belong to organizers, not events, so an audit of one
            # event leaves them to the full run.
            if not options["event"]:
                drawers = PosDrawer.objects.filter(
                    pk__in=PosDrawerEntry.objects.values_list("drawer", flat=True).distinct()
                ).select_related("organizer").order_by("organizer__slug", "pk")
                for drawer in drawers:
                    label = f"{drawer.organizer.slug} drawer {drawer.pk} ({drawer.name})"
                    bad = PosDrawerEntry.verify_chain(drawer)
                    if bad is None:
                        count = PosDrawerEntry.objects.filter(drawer=drawer).count()
                        self.stdout.write(self.style.SUCCESS(f"  ok   {label} ({count} rows)"))
                    else:
                        broken.append(label)
                        self.stdout.write(
                            self.style.ERROR(f" FAIL  {label}: first bad row is seq {bad.seq}")
                        )

        if broken:
            raise CommandError("Journal verification failed for: " + ", ".join(broken))
