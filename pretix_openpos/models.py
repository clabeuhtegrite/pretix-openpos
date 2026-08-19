import hashlib
import json

from django.core.cache import cache
from django.db import IntegrityError, models, transaction
from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _
from pretix.base.models import Device, Event, Item, ItemVariation, Order

#: previous_hash of the very first sale of an event.
GENESIS_HASH = "0" * 64


class PosPrice(models.Model):
    """
    On-site price of a product, overriding the webshop price.

    pretix resolves prices through Item.default_price -> ItemVariation.default_price
    -> SubEventItem and has no notion of a per-sales-channel price, so the till
    tariff has to live here. The POS API is the only thing that reads it, and it
    is the sole authority on what a position costs at the door: the PWA never
    sends a price, it only sends product identifiers and quantities.
    """

    event = models.ForeignKey(Event, on_delete=models.CASCADE, related_name="openpos_prices")
    item = models.ForeignKey(Item, on_delete=models.CASCADE, related_name="openpos_prices")
    variation = models.ForeignKey(
        ItemVariation, null=True, blank=True, on_delete=models.CASCADE, related_name="openpos_prices"
    )
    price = models.DecimalField(
        max_digits=13, decimal_places=2, verbose_name=_("On-site price"),
        help_text=_("Price charged at the till, replacing the online price."),
    )

    class Meta:
        verbose_name = _("On-site price")
        verbose_name_plural = _("On-site prices")
        constraints = [
            # A partial constraint per nullability, because most databases treat
            # NULLs as distinct and would happily accept duplicate item-level rows
            # under a plain unique_together.
            models.UniqueConstraint(
                fields=["item", "variation"],
                condition=models.Q(variation__isnull=False),
                name="openpos_price_unique_variation",
            ),
            models.UniqueConstraint(
                fields=["item"],
                condition=models.Q(variation__isnull=True),
                name="openpos_price_unique_item",
            ),
        ]

    def __str__(self):
        if self.variation_id:
            return f"{self.item} – {self.variation}: {self.price}"
        return f"{self.item}: {self.price}"


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
    KIND_CHOICES = (
        (KIND_SALE, _("Sale")),
        (KIND_CANCELLATION, _("Cancellation")),
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
        Which of these sales already have a cancellation against them.

        Asked of the journal rather than of the order, because the journal is
        what survives: a test-mode purge takes the orders away and the takings
        still have to add up afterwards.
        """
        return set(
            cls.objects.filter(
                event=event, kind=cls.KIND_CANCELLATION, cancels_seq__in=list(seqs)
            ).values_list("cancels_seq", flat=True)
        )

    # -- integrity ---------------------------------------------------------

    #: Version used for rows written from now on.
    CURRENT_HASH_VERSION = 4

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
               recorded_at=None, attempts=5):
        """
        Append a sale to the journal, chaining it onto the current tail.

        Two tills can commit concurrently, so the sequence number is claimed
        optimistically and the unique constraint on ``(event, seq)`` arbitrates.
        Each attempt runs in its own savepoint so that a collision does not
        poison the surrounding transaction, which is also creating the order.
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
                order_code=order.code,
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
