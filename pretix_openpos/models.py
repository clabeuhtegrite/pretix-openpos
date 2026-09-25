import hashlib
import json
from datetime import timezone as dt_timezone
from decimal import Decimal

from django.core.cache import cache
from django.db import IntegrityError, models, transaction
from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _, pgettext_lazy
from pretix.base.models import Device, Event, ItemCategory, Order, Organizer, User

#: previous_hash of the very first sale of an event.
GENESIS_HASH = "0" * 64

CENT = Decimal("0.01")


def refund_key(idempotency_key: str) -> str:
    """
    The key of the payout row that goes with a sale.

    One customer can produce two journal rows — the sale, and the deposit
    handed back with it — and the journal's idempotency is per row. Derived
    rather than sent, so a retry of the whole transaction still recognises both
    halves of what it already committed.
    """
    return f"{idempotency_key}:refund"


def reversed_positions(positions):
    """The sold lines, negated, so the journal reads as a credit note."""
    reversed_lines = []
    for line in positions:
        entry = dict(line)
        for field in ("count", "line_total"):
            value = entry.get(field)
            if value is None:
                continue
            entry[field] = -value if isinstance(value, int) else str(-Decimal(str(value)))
        reversed_lines.append(entry)
    return reversed_lines


class PosSale(models.Model):
    """
    Append-only journal of every sale made at a till.

    Rows are never updated and never deleted; ``save()`` and ``delete()`` refuse
    to do either. Each row stores the hash of its predecessor, so altering an
    earlier sale invalidates the hash of every sale after it and
    :meth:`verify_chain` will point at the first row that no longer adds up.

    This is deliberately more than the deployment strictly needs — a non-VAT-liable
    association is out of scope of the French cash-register rules — but it costs
    almost nothing to maintain and it is the one thing that is genuinely painful
    to retrofit onto a POS that already has history.
    """

    PAYMENT_CASH = "cash"
    PAYMENT_CARD = "card"
    PAYMENT_CHOICES = (
        (PAYMENT_CASH, _("Cash")),
        (PAYMENT_CARD, _("Card terminal")),
    )

    KIND_SALE = "sale"
    KIND_CANCELLATION = "cancellation"
    #: Money handed back over the counter for a returned cup, and nothing else.
    #:
    #: It is not a sale and it is not the reversal of one: no order stands
    #: behind it, because pretix has no way to represent one — an order's total
    #: cannot go below zero, and the queue at the end of the night is people
    #: returning cups and buying nothing. So the deposit is sold as an ordinary
    #: product and its return is written here, in the one ledger that reconciles
    #: against the drawer. The amount is negative, like a cancellation's, which
    #: is what keeps the takings the plain sum of the column.
    KIND_DEPOSIT_REFUND = "deposit_refund"
    #: A cancellation undone: pretix' back office reactivated the order.
    #:
    #: Written only when the money never left — the order comes back paid —
    #: and pointing at the cancellation it undoes rather than at the sale, so
    #: every reversal in this journal names the one row it reverses. Its amount
    #: is the cancellation's, negated, which puts the sale back in the takings.
    #: A till never writes one: it cannot reactivate anything.
    KIND_REACTIVATION = "reactivation"
    KIND_CHOICES = (
        (KIND_SALE, _("Sale")),
        (KIND_CANCELLATION, _("Cancellation")),
        (KIND_DEPOSIT_REFUND, _("Deposit refund")),
        (KIND_REACTIVATION, _("Reactivation")),
    )

    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="openpos_sales")
    #: Gapless per-event counter, starting at 1.
    seq = models.PositiveIntegerField()
    datetime = models.DateTimeField(db_index=True)

    device = models.ForeignKey(
        Device, null=True, blank=True, on_delete=models.SET_NULL, related_name="openpos_sales"
    )
    #: Denormalised so the journal still names the till after the device is deleted.
    device_serial = models.CharField(max_length=190, blank=True)
    #: The till's human name ("Caisse bar"), captured at the same time and for the
    #: same reason. Not part of the hash: the serial is what identifies a till,
    #: this is only what an operator reads in a report.
    device_name = models.CharField(max_length=190, blank=True, default="")
    #: Free-text label the app sends so two volunteers sharing one tablet can be
    #: told apart in the takings report.
    cashier = models.CharField(max_length=190, blank=True)

    order = models.ForeignKey(
        Order, null=True, blank=True, on_delete=models.SET_NULL, related_name="openpos_sales"
    )
    #: Denormalised for the same reason: test-mode orders can be purged.
    order_code = models.CharField(max_length=16)

    #: Whether the event was in test mode when the sale was made.
    #:
    #: Recorded at write time rather than read from the order, because the order
    #: is exactly what goes away: disabling test mode offers to delete every
    #: test order, which leaves this journal row orphaned. Inferring "orphan =
    #: test" afterwards would mean a real order deleted by hand silently drops
    #: out of the takings — the one thing an append-only journal exists to stop.
    testmode = models.BooleanField(default=False)

    #: Sale, or the reversal of one.
    #:
    #: A cancellation is a new row, never an edit of the one it reverses: that is
    #: the whole point of an append-only journal, and it is what lets the takings
    #: be recomputed from the journal alone at any later date.
    kind = models.CharField(max_length=16, choices=KIND_CHOICES, default=KIND_SALE)

    #: For a cancellation, the ``seq`` of the sale it reverses.
    #:
    #: The journal's own identity, not a foreign key: the row it points at can
    #: never move or disappear, and (event, seq) is what a printed report cites.
    cancels_seq = models.PositiveIntegerField(null=True, blank=True)

    #: Why the sale was cancelled, as typed by the operator.
    #:
    #: Optional, but asked for: a reversal with no stated ground is the first
    #: thing anyone auditing a till asks about.
    reason = models.CharField(max_length=190, blank=True, default="")

    #: Recorded on a till that had no network, and replayed afterwards.
    #:
    #: Worth a column of its own because it changes what the row means: the
    #: price was decided by the app from a cached tariff rather than by the
    #: server, and ``datetime`` is when the customer paid, not when the order
    #: was created. Anyone reconciling a night that had a dropout needs to be
    #: able to find exactly these rows.
    offline = models.BooleanField(default=False)

    payment_type = models.CharField(max_length=16, choices=PAYMENT_CHOICES)
    #: Negative on a cancellation, so the takings are the plain sum of the column.
    total = models.DecimalField(max_digits=13, decimal_places=2)
    cash_given = models.DecimalField(max_digits=13, decimal_places=2, null=True, blank=True)
    cash_change = models.DecimalField(max_digits=13, decimal_places=2, null=True, blank=True)

    #: Snapshot of what was sold, so the journal stays readable even if the
    #: product is renamed or deleted afterwards.
    positions = models.JSONField(default=list)

    #: The opening of a cash drawer this sale's money went into, or came out of.
    #:
    #: Set when the till that rang it up is assigned a drawer and that drawer
    #: was open at the time, and never otherwise: a till with no drawer keeps
    #: selling exactly as it always has. Card sales carry it too, for the
    #: closing report to name them, although no card money ever reaches the
    #: drawer. Part of the hash from version 5, so a sale cannot be quietly
    #: moved from one evening's drawer to another's — and ``RESTRICT`` rather
    #: than ``SET_NULL`` for the same reason: nulling it would rewrite a row
    #: of an append-only journal behind its hash.
    drawer_session = models.ForeignKey(
        "PosDrawerSession", null=True, blank=True, on_delete=models.RESTRICT,
        related_name="sales",
    )

    idempotency_key = models.CharField(max_length=190)

    previous_hash = models.CharField(max_length=64)
    hash = models.CharField(max_length=64)

    #: Which set of fields the hash covers.
    #:
    #: A hash chain cannot be extended in place: adding a field to the hashed
    #: payload would invalidate every row written before it, and verify_chain()
    #: would report tampering on an untouched journal. So the payload is
    #: versioned, each row records the version it was written under, and
    #: verification replays the shape that row was actually hashed with.
    #: 1 = original fields. 2 = adds `testmode`. 3 = adds `kind`, `cancels_seq`
    #: and `reason`, i.e. everything that distinguishes a reversal from a sale.
    #: 4 = adds `offline`.
    hash_version = models.PositiveSmallIntegerField(default=1)

    class Meta:
        verbose_name = _("Till sale")
        verbose_name_plural = _("Till sales")
        ordering = ("event", "seq")
        constraints = [
            models.UniqueConstraint(fields=["event", "seq"], name="openpos_sale_unique_seq"),
            models.UniqueConstraint(
                fields=["event", "idempotency_key"], name="openpos_sale_unique_idempotency"
            ),
        ]
        indexes = [
            # Reversals are a small minority of the journal, and the question
            # asked of them — "has this sale been cancelled?" — is asked every
            # time the history is opened.
            models.Index(
                fields=["event", "cancels_seq"],
                name="openpos_sale_cancels_idx",
                condition=models.Q(cancels_seq__isnull=False),
            ),
        ]

    def __str__(self):
        return f"#{self.seq} {self.order_code} {self.total}"

    @classmethod
    def cancelled_seqs(cls, event, seqs):
        """
        Which of these rows stand reversed.

        Asked of the journal rather than of the order, because the journal is
        what survives: a test-mode purge takes the orders away and the takings
        still have to add up afterwards.

        A reversal can itself be undone. pretix' back office can reactivate a
        cancelled order, and the journal answers with a reactivation pointing
        at the cancellation — so a sale is reversed by any cancellation of it
        that no reactivation has undone, and a cancellation is reversed when a
        reactivation has. Two queries, whatever the number of rows asked about.
        """
        reversals = dict(
            cls.objects.filter(
                event=event,
                kind__in=(cls.KIND_CANCELLATION, cls.KIND_REACTIVATION),
                cancels_seq__in=list(seqs),
            ).values_list("seq", "cancels_seq")
        )
        if not reversals:
            return set()
        undone = set(
            cls.objects.filter(
                event=event, kind=cls.KIND_REACTIVATION, cancels_seq__in=list(reversals)
            ).values_list("cancels_seq", flat=True)
        )
        return {target for seq, target in reversals.items() if seq not in undone}

    @classmethod
    def is_back_office(cls, device_serial, kind):
        """
        Whether a row with this serial and kind was written by pretix' back
        office rather than by a till.

        Told apart by shape rather than by a column of its own, because the
        shape cannot lie: a till's cancellation always carries that till's
        serial — the endpoint refuses any caller that is not a paired device —
        and a reactivation is never written by a till at all. A reversal with
        no till behind it can only have come from the back office.

        A classmethod as well as the property below, because the Sales page
        asks it of aggregated rows that are dictionaries, not models.
        """
        return not device_serial and kind in (cls.KIND_CANCELLATION, cls.KIND_REACTIVATION)

    @property
    def from_back_office(self) -> bool:
        return self.is_back_office(self.device_serial, self.kind)

    # -- integrity ---------------------------------------------------------

    #: Version used for rows written from now on.
    CURRENT_HASH_VERSION = 5

    def _hash_payload(self) -> str:
        """Canonical representation the hash is taken over, for this row's version."""
        payload = {
            "seq": self.seq,
            "event": self.event_id,
            "datetime": self.datetime.isoformat(),
            "device": self.device_serial,
            "cashier": self.cashier,
            "order": self.order_code,
            "payment_type": self.payment_type,
            "total": str(self.total),
            "cash_given": None if self.cash_given is None else str(self.cash_given),
            "cash_change": None if self.cash_change is None else str(self.cash_change),
            "positions": self.positions,
            "previous_hash": self.previous_hash,
        }
        if self.hash_version >= 2:
            payload["testmode"] = self.testmode
        if self.hash_version >= 3:
            payload["kind"] = self.kind
            payload["cancels_seq"] = self.cancels_seq
            payload["reason"] = self.reason
        if self.hash_version >= 4:
            payload["offline"] = self.offline
        if self.hash_version >= 5:
            payload["drawer_session"] = self.drawer_session_id
        return json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        )

    def compute_hash(self) -> str:
        return hashlib.sha256(self._hash_payload().encode("utf-8")).hexdigest()

    @classmethod
    def _walk_chain(cls, rows, previous, expected_seq):
        """
        Walk ``rows`` (ascending ``seq``) checking every link.

        Returns ``(first bad row or None, last good (seq, hash) or None)``.
        """
        last = None
        for sale in rows:
            if (
                sale.seq != expected_seq
                or sale.previous_hash != previous
                or sale.hash != sale.compute_hash()
            ):
                return sale, last
            previous = sale.hash
            expected_seq += 1
            last = (sale.seq, sale.hash)
        return None, last

    @classmethod
    def verify_chain(cls, event):
        """
        Walk the whole journal of an event and return the first row that does
        not add up, or ``None`` when the chain is intact.
        """
        bad, _last = cls._walk_chain(
            cls.objects.filter(event=event).order_by("seq").iterator(), GENESIS_HASH, 1
        )
        return bad

    #: Cache key of the last verified ``(seq, hash)`` of an event's journal.
    CHAIN_CHECKPOINT_KEY = "pretix_openpos:chain:{}"

    @classmethod
    def verify_chain_cached(cls, event):
        """
        Like :meth:`verify_chain`, but resuming from the last row a previous
        call verified — so the back-office page does not re-hash a whole
        festival's journal on every load.

        What this is, exactly: a way to skip work, not a second witness. Rows up
        to the anchor are not re-hashed, so nothing at or behind it is examined
        — an amount edited straight in the database with its hash left alone is
        invisible here, and so is a rewrite that recomputed the hashes as it
        went. Everything after the anchor is checked in full, which is what the
        page is asking about: whether the journal has held since it was last
        looked at.

        A mismatched checkpoint is deliberately *not* treated as tampering
        either. It is stored in the cache, and a cache is evicted for a hundred
        ordinary reasons — a restart, memory pressure, a deploy. Reporting a
        broken journal every time Redis came back would be an alarm nobody
        would keep listening to. So a checkpoint that no longer matches simply
        buys one full walk and is written again.

        The audit that misses none of this is the full walk from row one, which
        ``manage.py openpos_verify_journal`` runs — from a cron job, or on the
        day somebody doubts the journal.
        """
        key = cls.CHAIN_CHECKPOINT_KEY.format(event.pk)
        checkpoint = cache.get(key)
        if checkpoint and cls.objects.filter(
            event=event, seq=checkpoint["seq"], hash=checkpoint["hash"]
        ).exists():
            rows = (
                cls.objects.filter(event=event, seq__gt=checkpoint["seq"])
                .order_by("seq")
                .iterator()
            )
            bad, last = cls._walk_chain(rows, checkpoint["hash"], checkpoint["seq"] + 1)
            if bad is None:
                if last:
                    cache.set(key, {"seq": last[0], "hash": last[1]}, None)
                return None
            # The tail is broken. Re-walk from the start so the row reported is
            # the first that no longer adds up, not merely the first after the
            # checkpoint.
            return cls.verify_chain(event)

        bad, last = cls._walk_chain(
            cls.objects.filter(event=event).order_by("seq").iterator(), GENESIS_HASH, 1
        )
        if bad is None and last:
            cache.set(key, {"seq": last[0], "hash": last[1]}, None)
        return bad

    # -- append-only enforcement -------------------------------------------

    def save(self, *args, **kwargs):
        if self.pk is not None:
            raise ValueError("PosSale rows are append-only and cannot be modified.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValueError("PosSale rows are append-only and cannot be deleted.")

    # -- writing -----------------------------------------------------------

    @classmethod
    def record(cls, *, event, order, device, cashier, payment_type, total, positions,
               idempotency_key, cash_given=None, cash_change=None, testmode=False,
               kind=KIND_SALE, cancels_seq=None, reason="", offline=False,
               recorded_at=None, drawer_session=None, attempts=5):
        """
        Append a row to the journal, chaining it onto the current tail.

        Two tills can commit concurrently, so the sequence number is claimed
        optimistically and the unique constraint on ``(event, seq)`` arbitrates.
        Each attempt runs in its own savepoint so that a collision does not
        poison the surrounding transaction, which is also creating the order.

        ``order`` may be ``None``: a deposit refund is money out of the drawer
        with no order to hang it on.

        ``drawer_session`` is the drawer opening the money belongs to, when the
        till has a drawer — see :attr:`drawer_session`.
        """
        for _attempt in range(attempts):
            last = cls.objects.filter(event=event).order_by("-seq").first()
            sale = cls(
                event=event,
                seq=(last.seq + 1) if last else 1,
                # When the customer paid, which for a sale replayed from a till
                # that was offline is not when this row is being written. The
                # sequence still follows the order rows arrive in — the chain
                # is over `seq`, and a report reads by `datetime`.
                datetime=recorded_at or now(),
                device=device,
                device_serial=device.unique_serial if device else "",
                device_name=(device.name or "") if device else "",
                cashier=cashier or "",
                order=order,
                # Blank for a row with no order behind it — a deposit refund.
                order_code=order.code if order else "",
                payment_type=payment_type,
                total=total,
                cash_given=cash_given,
                cash_change=cash_change,
                positions=positions,
                idempotency_key=idempotency_key,
                testmode=testmode,
                kind=kind,
                cancels_seq=cancels_seq,
                reason=reason or "",
                offline=offline,
                drawer_session=drawer_session,
                hash_version=cls.CURRENT_HASH_VERSION,
                previous_hash=last.hash if last else GENESIS_HASH,
            )
            sale.hash = sale.compute_hash()
            try:
                with transaction.atomic():
                    sale.save()
                return sale
            except IntegrityError:
                # Either another till claimed our sequence number, or this exact
                # sale was already recorded. The latter is the idempotency case
                # and is a success, not a retry.
                existing = cls.objects.filter(
                    event=event, idempotency_key=idempotency_key
                ).first()
                if existing:
                    return existing
                continue

        raise RuntimeError(
            f"Could not append to the Open POS journal of {event.slug} after {attempts} attempts."
        )


class PosDevice(models.Model):
    """
    What a paired device is for, and which card terminal belongs to it.

    A till at the bar and a tablet at the door run the same app and pair the
    same way, but they are not doing the same job: one rings up rounds with a
    terminal of its own, the other scans tickets and sells the occasional one on
    the spot. Which of the two a device is could have been a switch inside the
    app; it is stored here instead, and the reason is the rule this row exists
    to carry — *a till with a terminal may not take a card payment that terminal
    did not validate*. A browser app can be stale, or simply edited, so a switch
    it holds is a promise it cannot keep. The server can, and the app only
    renders the role it is told.

    Hung off the pretix ``Device`` rather than off an (event, device) pair: which
    corner of the room a tablet stands in is a fact about the tablet, not about
    the event it happens to be selling for tonight.

    A device with no row here — which is every device paired before this
    existed — keeps behaving exactly as it did: the till, with the door one tap
    away. That is what :attr:`ROLE_UNSET` means, and it is why the role is a
    blank string rather than a default of "till": "nobody has said yet" and "it
    is the bar till" want different answers at the door.
    """

    #: Nobody has assigned this device. Both jobs stay available, as before.
    ROLE_UNSET = ""
    #: The bar till: the product grid, and a terminal of its own if one is set.
    ROLE_TILL = "pos"
    #: The door: scanning, with the grid reachable for selling a ticket on site.
    ROLE_DOOR = "door"
    ROLE_CHOICES = (
        (ROLE_UNSET, _("Not assigned")),
        (ROLE_TILL, _("Till")),
        (ROLE_DOOR, _("Door")),
    )

    device = models.OneToOneField(
        Device, on_delete=models.CASCADE, related_name="openpos_device"
    )
    role = models.CharField(
        max_length=8, choices=ROLE_CHOICES, blank=True, default=ROLE_UNSET,
        verbose_name=_("Role"),
    )

    #: The SumUp reader this till drives, e.g. ``rdr_3MSAFM23CK82VSTT4BN6RWSQ65``.
    #:
    #: Its presence is what makes card payments on this device go through the
    #: terminal, and what makes the server refuse a card payment that arrives
    #: without a transaction the terminal validated. Empty is the ordinary case
    #: and means the cashier takes the card on their own phone, in the vendor's
    #: app, and tells the till it happened — which is all the till has ever
    #: done, and all the door will ever do.
    #:
    #: Chosen on the till device screen, from the readers paired to the
    #: organizer's SumUp account, and only for a device whose role is
    #: :attr:`ROLE_TILL`: one reader, one till. It is stored as SumUp's own id
    #: rather than as a foreign key to a reader of ours, because the paired
    #: readers live on SumUp's side and a copy here would be one more thing
    #: that can go stale.
    sumup_reader_id = models.CharField(
        max_length=190, blank=True, default="",
        verbose_name=_("SumUp reader"),
    )

    #: The cash drawer this device's cash goes into, if it has one.
    #:
    #: Several devices may share a drawer — two tablets at one bar, one box of
    #: change between them — and a device with none keeps selling exactly as
    #: it did before drawers existed. Once it has one, a cash sale waits for
    #: that drawer to be opened: see :class:`PosDrawerSession`.
    drawer = models.ForeignKey(
        "PosDrawer", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="devices", verbose_name=_("Cash drawer"),
    )

    # -- what the device was last heard saying ------------------------------
    #
    # pretix keeps a device's creation and pairing dates and nothing after
    # that, so the back office could not tell a tablet that has been quiet
    # since 21:14 from one that sold a round a minute ago — nor that a quiet
    # one is sitting on fifteen cash sales it has not managed to send. That
    # second fact is the one that matters before counting a drawer: the
    # amount the server expects in it is computed from the sales it has, and
    # a sale still on the tablet is not one of them.
    #
    # Two sources, kept apart on purpose. ``last_seen_at`` is the server's
    # own observation and cannot be wrong about when; the rest is what the
    # app said about itself, on its own clock, at ``status_reported_at``, and
    # is shown as such. A device that never reported keeps these at their
    # defaults, which read as "nothing known", not as "nothing pending".
    #
    # Every one of them is nullable or has its default in the database as well
    # as in Python, and that is for going back: Django drops a Python-only
    # default from the column once it has added it, so a 0.24 put back after
    # this migration — which writes a row without these columns when a
    # device is first given a role — would hit a NOT NULL on PostgreSQL.

    #: Server time of this device's last authenticated call to an Open POS
    #: endpoint. Written at most once a minute: see ``note_contact`` in
    #: ``api/views.py``.
    last_seen_at = models.DateTimeField(null=True, blank=True)
    #: Server time at which the app last sent its status report.
    status_reported_at = models.DateTimeField(null=True, blank=True)
    #: How many sales the app said it was still holding, not yet sent.
    pending_sales = models.PositiveIntegerField(default=0, db_default=0)
    #: When the oldest of those was recorded, on the tablet's clock.
    oldest_pending_at = models.DateTimeField(null=True, blank=True)
    #: When the app last got its queue through to the server, on its clock.
    last_sync_at = models.DateTimeField(null=True, blank=True)
    #: The build the app said it was running.
    app_version = models.CharField(max_length=64, blank=True, default="", db_default="")

    class Meta:
        verbose_name = _("Till device")
        verbose_name_plural = _("Till devices")

    def __str__(self):
        return f"{self.device}: {self.role or 'unset'}"

    @property
    def drives_terminal(self) -> bool:
        """Whether a card payment on this device has to come from its terminal."""
        return bool(self.sumup_reader_id)

    @property
    def serves_door(self) -> bool:
        """
        Whether this device works at the door, alone or with the till.

        An unassigned device does both, as it always has; only a device the
        organizer made the bar till has no door.
        """
        return self.role != self.ROLE_TILL

    @property
    def holds_sales(self) -> bool:
        """Whether the app last said it had sales it had not sent yet."""
        return self.status_reported_at is not None and self.pending_sales > 0

    @classmethod
    def for_device(cls, device):
        """
        The role row of a device, or an unsaved blank one.

        Never ``None``: every caller wants to ask the same questions of a device
        nobody has assigned as of one somebody has, and the answers for the
        unassigned one are exactly this object's defaults.
        """
        if device is None:
            return cls()
        return getattr(device, "openpos_device", None) or cls(device=device)


class PosTerminalPayment(models.Model):
    """
    A card payment put on a reader, and what became of it.

    This row exists so that "the reader validated it" is something the server
    knows rather than something the till claims. It is written before the
    amount reaches the reader, settled from SumUp's own Transactions API, and
    then spent — exactly once — by the sale that books it.

    It also pins the basket. The amount is priced here, at the moment the
    cardholder is asked for it, and the sale that follows is booked from
    :attr:`positions` rather than from whatever the app sends afterwards. That
    closes the one gap that would otherwise cost real money: a tariff edited
    between the tap and the receipt would leave a card charged for one figure
    and an order written for another, and no amount of comparing totals
    afterwards can put that right once the money has moved.

    Not part of the journal, and deliberately mutable: the journal is the
    append-only record of what the drawer did, and a payment that is still
    being waited on has no place in it. What reaches the journal is the sale,
    once this row says the money moved.
    """

    STATUS_PENDING = "pending"
    STATUS_SUCCESSFUL = "successful"
    STATUS_FAILED = "failed"
    STATUS_CHOICES = (
        (STATUS_PENDING, _("Waiting for the cardholder")),
        (STATUS_SUCCESSFUL, _("Paid")),
        (STATUS_FAILED, _("Not paid")),
    )

    event = models.ForeignKey(
        Event, on_delete=models.CASCADE, related_name="openpos_terminal_payments"
    )
    device = models.ForeignKey(
        Device, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="openpos_terminal_payments",
    )
    #: Denormalised so the row still names its till after the device is deleted,
    #: and so the check that a payment belongs to *this* till survives that too.
    device_serial = models.CharField(max_length=190, blank=True, default="")

    #: The key the sale will carry. One basket, one payment, one sale.
    #:
    #: SumUp's reader checkout has no idempotency key of its own — retrying it
    #: starts a second payment — so this is what stands in for one: a second
    #: attempt on the same basket finds this row rather than charging again.
    idempotency_key = models.CharField(max_length=190)

    #: SumUp's own handle on the payment, generated by the checkout call.
    client_transaction_id = models.CharField(max_length=190, blank=True, default="")
    #: SumUp's handle on the request put on the reader, from the same answer.
    #: The one thing that can say "cancelled" before any card has been
    #: presented — see :meth:`SumUpAccount.reader_checkout`.
    checkout_id = models.CharField(max_length=190, blank=True, default="")
    #: SumUp's transaction id, known only once the transaction exists. This is
    #: what a refund needs, which is why it is kept rather than looked up again.
    transaction_id = models.CharField(max_length=190, blank=True, default="")

    reader_id = models.CharField(max_length=190)
    amount = models.DecimalField(max_digits=13, decimal_places=2)
    currency = models.CharField(max_length=8)
    #: The basket as the server priced it, in the shape the checkout takes.
    positions = models.JSONField(default=list)

    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_PENDING)
    #: Why it did not go through, in SumUp's words, for the operator.
    failure = models.CharField(max_length=190, blank=True, default="")

    #: When the money was sent back to the card, if it was.
    #:
    #: Written only after SumUp has accepted the refund, and checked before one
    #: is asked for. A cancellation cannot normally run twice — the journal
    #: refuses a second reversal of the same sale — but this is the money path,
    #: and "we already gave it back" is worth knowing from the row itself
    #: rather than by reasoning about another table.
    refunded = models.DateTimeField(null=True, blank=True)

    created = models.DateTimeField(auto_now_add=True)
    updated = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("Terminal payment")
        verbose_name_plural = _("Terminal payments")
        constraints = [
            models.UniqueConstraint(
                fields=["event", "idempotency_key"], name="openpos_terminal_unique_key"
            ),
        ]
        indexes = [
            models.Index(
                fields=["client_transaction_id"], name="openpos_terminal_ctid_idx"
            ),
        ]

    def __str__(self):
        return f"{self.idempotency_key} {self.amount} {self.status}"

    @classmethod
    def settling(cls, sale):
        """
        The reader payment a journal sale was settled by, if a reader settled it.

        One lookup for every question that must never get two answers: whether
        a cancellation at the till asks SumUp for the money back, whether
        pretix' refund dialog offers to, and which transaction either of them
        names. A cash sale, or a card taken on somebody's phone, has none —
        there is nothing here for this server to refund.
        """
        if sale is None or sale.payment_type != PosSale.PAYMENT_CARD:
            return None
        payment = cls.objects.filter(
            event_id=sale.event_id,
            idempotency_key=sale.idempotency_key,
            status=cls.STATUS_SUCCESSFUL,
        ).first()
        if payment is None or not payment.transaction_id:
            return None
        return payment

    @property
    def settled(self) -> bool:
        return self.status != self.STATUS_PENDING

    def belongs_to(self, device) -> bool:
        """
        Whether this payment was taken on the till now trying to spend it.

        Checked by serial rather than by row, so a device deleted and re-paired
        under the same serial still owns its own payments, and — the point —
        one till can never book a sale against another till's card payment.
        """
        serial = device.unique_serial if device else ""
        # A payment with no till named belongs to no till, rather than to
        # every caller who also has none: this is the check that stops one
        # device booking a sale against another's card payment, and a rule
        # where two blanks match would be the wrong way for it to fail.
        return bool(serial) and self.device_serial == serial


class PosCategory(models.Model):
    """
    Which till role a category of products is sold by, if it is reserved at all.

    The door and the bar run the same app on purpose — see :class:`PosDevice` —
    and until now that meant the same catalogue too. A volunteer who comes out
    of the scanner to sell somebody a ticket lands on the whole grid, beer
    included, and the beer is one row below the ticket.

    So a category may be reserved for one role. Stored against the category
    rather than against the device, and that is the substance of the choice:
    a device is paired once and sells for whichever event is running tonight,
    while a category belongs to one event. A list of categories held on the
    device would name rows that the next event does not have, and the honest
    reading of "none of these categories exist here" is "nothing is reserved" —
    which is to say the restriction would quietly lapse at the next event,
    without a screen anywhere saying so. Hung off the category, it lapses only
    where an organiser has actually said nothing.

    It also means one answer per category instead of one per device: a tablet
    borrowed for the door at nine o'clock is given a role, and the catalogue
    follows.

    A category with no row here, which is every category until somebody says
    otherwise, is sold by every till. That is :attr:`ROLE_ALL`, and it is the
    same shape of default as :attr:`PosDevice.ROLE_UNSET`: turning this on
    changes nothing until an organiser reserves something.
    """

    #: Nobody has reserved this category: every till sells it, as before.
    ROLE_ALL = ""
    ROLE_CHOICES = (
        (ROLE_ALL, _("Every till")),
        (PosDevice.ROLE_TILL, _("The bar till only")),
        (PosDevice.ROLE_DOOR, _("The door only")),
    )

    category = models.OneToOneField(
        ItemCategory, on_delete=models.CASCADE, related_name="openpos_category"
    )
    role = models.CharField(
        max_length=8, choices=ROLE_CHOICES, blank=True, default=ROLE_ALL,
        verbose_name=_("Sold by"),
    )

    class Meta:
        verbose_name = _("Category at the till")
        verbose_name_plural = _("Categories at the till")

    def __str__(self):
        return f"{self.category}: {self.role or 'all'}"

    @classmethod
    def reserved(cls, event) -> dict:
        """
        ``{category_id: role}`` for the categories of an event that are reserved.

        One query, and the categories nobody has reserved are simply absent:
        every caller asks the same question of them as of a category with no
        row at all, and that question is answered by their absence here.
        """
        return dict(
            cls.objects.filter(category__event=event)
            .exclude(role=cls.ROLE_ALL)
            .values_list("category_id", "role")
        )

    @classmethod
    def off_limits(cls, event, pos_device) -> set:
        """
        The categories this device may not sell.

        Empty for a device nobody has assigned, whatever is reserved: the
        unassigned device is the one that still does both jobs, and narrowing
        its catalogue on the strength of a role it has not been given would
        take the grid away from every till paired before this existed.

        Empty, too, when nothing is reserved — which is the state every event
        starts in and the reason this feature is invisible until it is set up.
        """
        if not pos_device.role:
            return set()
        return {
            category_id
            for category_id, role in cls.reserved(event).items()
            if role != pos_device.role
        }


class PosDrawer(models.Model):
    """
    A cash drawer: the box of notes and coins behind a counter.

    Created in the back office, one per physical drawer, and given to the
    devices whose cash goes into it — often one, sometimes two tablets at the
    same bar. Organizer-level, like the devices themselves: the bar's drawer is
    the bar's drawer whichever event is on tonight.

    The drawer itself holds no money figure. What it held at any moment is the
    business of its openings, :class:`PosDrawerSession`, and of their ledger,
    :class:`PosDrawerEntry`, which is where every euro that went in or out
    without a sale is written down.
    """

    organizer = models.ForeignKey(
        Organizer, on_delete=models.CASCADE, related_name="openpos_drawers"
    )
    name = models.CharField(max_length=190, verbose_name=_("Name"))
    #: What the drawer usually starts the evening with.
    #:
    #: Only ever a suggestion: the till offers it when the drawer is opened,
    #: and what is actually counted then is what the evening starts from.
    opening_float = models.DecimalField(
        max_digits=13, decimal_places=2, null=True, blank=True,
        verbose_name=_("Usual opening float"),
    )
    created = models.DateTimeField(auto_now_add=True)
    #: When the drawer was put away. A drawer that has been opened cannot be
    #: deleted — its ledger, and the sales filed under its openings, would go
    #: with it — so this is how one stops being offered: out of the list and
    #: out of the tills' choice, its evenings still there to read.
    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("Cash drawer")
        verbose_name_plural = _("Cash drawers")
        ordering = ("name", "pk")
        constraints = [
            # Two drawers called "Bar" is a report nobody can read.
            models.UniqueConstraint(
                fields=["organizer", "name"], name="openpos_drawer_unique_name"
            ),
        ]

    def __str__(self):
        return self.name

    def open_session(self):
        """The opening that is still running, or ``None``."""
        return self.sessions.filter(closed_at__isnull=True).first()


class PosDrawerSession(models.Model):
    """
    One opening of a drawer, from the float counted in to the cash counted out.

    Opened on a till by whoever sets up the counter, with the float they
    counted into it; closed at the end of the evening on a count of the cash,
    and the difference between what was counted and what the drawer should
    hold is the one figure the evening is judged by.

    A cash sale on a device that has a drawer is refused while its drawer is
    not open: the sale has to land in an opening, or the count at the end of
    the night cannot account for it. Card sales are never refused, and are
    attached for the report's sake only.

    The row is mutable — it gains its closing time — but everything that
    happened to the money is in :class:`PosDrawerEntry`, which is not.
    """

    drawer = models.ForeignKey(PosDrawer, on_delete=models.CASCADE, related_name="sessions")
    opened_at = models.DateTimeField()
    closed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = _("Cash drawer opening")
        verbose_name_plural = _("Cash drawer openings")
        ordering = ("-opened_at", "-pk")
        constraints = [
            # One drawer, one opening at a time. The ledger code checks this
            # first; this is what holds when two tills press "open" at once.
            models.UniqueConstraint(
                fields=["drawer"],
                condition=models.Q(closed_at__isnull=True),
                name="openpos_drawer_one_open_session",
            ),
        ]

    def __str__(self):
        return f"{self.drawer} {self.opened_at:%Y-%m-%d %H:%M}"

    @property
    def is_open(self) -> bool:
        return self.closed_at is None


class PosDrawerEntry(models.Model):
    """
    Append-only ledger of a drawer: everything that moved its money but a sale.

    Opening float, cash put in, cash taken out, every count, the closing. Sales
    are not repeated here — they are in :class:`PosSale`, and each one names
    the opening it belongs to — so a drawer's expected cash is its entries plus
    its sales, and neither ledger has to be kept in step with the other.

    Hash-chained per drawer the way the sales journal is per event, and for
    the same reason: a float lowered after the fact, or a withdrawal that
    disappears, is exactly what a cash audit looks for, and the chain makes
    either one visible. ``save()`` and ``delete()`` refuse to modify a row.

    Written under a lock on the drawer's row, which serialises everything that
    happens to one drawer. The traffic is a handful of rows an evening, so the
    optimistic retry the sales journal needs would be all cost and no benefit.
    """

    KIND_OPEN = "open"
    KIND_IN = "in"
    KIND_OUT = "out"
    KIND_COUNT = "count"
    KIND_CLOSE = "close"
    KIND_CHOICES = (
        (KIND_OPEN, _("Opening float")),
        (KIND_IN, _("Cash in")),
        (KIND_OUT, _("Cash out")),
        # In context: pretix' own catalogue has "Count" as the verb, and it
        # is consulted before this one.
        (KIND_COUNT, pgettext_lazy("cash drawer entry", "Count")),
        (KIND_CLOSE, _("Closing")),
    )

    #: Done on a till, by whoever held it.
    SOURCE_TILL = "till"
    #: Done in the back office, by a pretix user.
    SOURCE_BACKOFFICE = "backoffice"
    SOURCE_CHOICES = (
        (SOURCE_TILL, _("Till")),
        (SOURCE_BACKOFFICE, _("Back office")),
    )

    drawer = models.ForeignKey(PosDrawer, on_delete=models.CASCADE, related_name="entries")
    session = models.ForeignKey(
        PosDrawerSession, on_delete=models.CASCADE, related_name="entries"
    )
    #: Gapless per-drawer counter, starting at 1.
    seq = models.PositiveIntegerField()
    datetime = models.DateTimeField(db_index=True)
    kind = models.CharField(max_length=16, choices=KIND_CHOICES)

    #: The float, the sum put in or taken out, or the cash counted. Positive.
    #:
    #: Empty on one row only: a closing nobody counted, which is how a drawer
    #: left open since an earlier evening gets closed by somebody who never
    #: saw the money it held.
    amount = models.DecimalField(max_digits=13, decimal_places=2, null=True, blank=True)
    #: On a count and on a closing, what the drawer should have held then.
    expected = models.DecimalField(max_digits=13, decimal_places=2, null=True, blank=True)
    #: How the amount was counted, ``{"20.00": 3, "0.50": 4}``, when it was
    #: counted note by note. Empty when a total was typed in.
    denominations = models.JSONField(default=dict, blank=True)
    #: Why money went in or out, or a word about the closing.
    reason = models.CharField(max_length=190, blank=True, default="")
    #: Who did it: the name the till was given, or the back-office user.
    cashier = models.CharField(max_length=190, blank=True, default="")
    source = models.CharField(max_length=16, choices=SOURCE_CHOICES, default=SOURCE_TILL)

    device = models.ForeignKey(
        Device, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="openpos_drawer_entries",
    )
    #: Denormalised, like the sales journal's, so the ledger still names the
    #: till after the device is gone. The serial is what the hash covers.
    device_serial = models.CharField(max_length=190, blank=True, default="")
    device_name = models.CharField(max_length=190, blank=True, default="")
    #: The back-office user, when there was one. A convenience link only:
    #: :attr:`cashier` is what the hash covers, so a deleted account leaves
    #: the chain intact.
    user = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="openpos_drawer_entries",
    )

    idempotency_key = models.CharField(max_length=190)

    previous_hash = models.CharField(max_length=64)
    hash = models.CharField(max_length=64)
    #: Which fields the hash covers; see :attr:`PosSale.hash_version`.
    hash_version = models.PositiveSmallIntegerField(default=1)

    CURRENT_HASH_VERSION = 1

    class Meta:
        verbose_name = _("Cash drawer entry")
        verbose_name_plural = _("Cash drawer entries")
        ordering = ("drawer", "seq")
        constraints = [
            models.UniqueConstraint(fields=["drawer", "seq"], name="openpos_drawer_unique_seq"),
            models.UniqueConstraint(
                fields=["drawer", "idempotency_key"], name="openpos_drawer_unique_idempotency"
            ),
        ]

    def __str__(self):
        return f"{self.drawer} #{self.seq} {self.kind} {self.amount}"

    @property
    def difference(self):
        """Counted minus expected: negative when cash is missing."""
        if self.amount is None or self.expected is None:
            return None
        return self.amount - self.expected

    # -- integrity ---------------------------------------------------------

    def _hash_payload(self) -> str:
        def money(value):
            return None if value is None else str(Decimal(value).quantize(CENT))

        payload = {
            "seq": self.seq,
            "drawer": self.drawer_id,
            "session": self.session_id,
            # In UTC whatever it was handed in, so that a row reads back from
            # the database exactly as it was hashed.
            "datetime": self.datetime.astimezone(dt_timezone.utc).isoformat(),
            "kind": self.kind,
            "amount": money(self.amount),
            "expected": money(self.expected),
            "denominations": self.denominations or {},
            "reason": self.reason,
            "cashier": self.cashier,
            "source": self.source,
            "device": self.device_serial,
            "previous_hash": self.previous_hash,
        }
        return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    def compute_hash(self) -> str:
        return hashlib.sha256(self._hash_payload().encode("utf-8")).hexdigest()

    @classmethod
    def verify_chain(cls, drawer):
        """The first entry of this drawer that does not add up, or ``None``."""
        previous = GENESIS_HASH
        expected_seq = 1
        for entry in cls.objects.filter(drawer=drawer).order_by("seq").iterator():
            if (
                entry.seq != expected_seq
                or entry.previous_hash != previous
                or entry.hash != entry.compute_hash()
            ):
                return entry
            previous = entry.hash
            expected_seq += 1
        return None

    # -- append-only enforcement -------------------------------------------

    def save(self, *args, **kwargs):
        if self.pk is not None:
            raise ValueError("PosDrawerEntry rows are append-only and cannot be modified.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ValueError("PosDrawerEntry rows are append-only and cannot be deleted.")

    # -- writing -----------------------------------------------------------

    @classmethod
    def append(cls, *, drawer, session, kind, idempotency_key, amount=None, expected=None,
               denominations=None, reason="", cashier="", device=None, user=None,
               source=SOURCE_TILL, at=None):
        """
        Chain one entry onto the drawer's ledger.

        The caller holds the drawer's row lock — see :mod:`pretix_openpos.drawers`
        — which is what makes reading the tail and writing after it safe.
        """
        last = cls.objects.filter(drawer=drawer).order_by("-seq").first()
        entry = cls(
            drawer=drawer,
            session=session,
            seq=(last.seq + 1) if last else 1,
            datetime=at or now(),
            kind=kind,
            amount=None if amount is None else Decimal(amount).quantize(CENT),
            expected=None if expected is None else Decimal(expected).quantize(CENT),
            denominations=denominations or {},
            reason=reason or "",
            cashier=cashier or "",
            source=source,
            device=device,
            device_serial=device.unique_serial if device else "",
            device_name=(device.name or "") if device else "",
            user=user,
            idempotency_key=idempotency_key,
            hash_version=cls.CURRENT_HASH_VERSION,
            previous_hash=last.hash if last else GENESIS_HASH,
        )
        entry.hash = entry.compute_hash()
        entry.save()
        return entry
