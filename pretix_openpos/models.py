import hashlib
import json

from django.core.cache import cache
from django.db import IntegrityError, models, transaction
from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _
from pretix.base.models import Device, Event, ItemCategory, Order

#: previous_hash of the very first sale of an event.
GENESIS_HASH = "0" * 64


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
    KIND_CHOICES = (
        (KIND_SALE, _("Sale")),
        (KIND_CANCELLATION, _("Cancellation")),
        (KIND_DEPOSIT_REFUND, _("Deposit refund")),
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
        Append a row to the journal, chaining it onto the current tail.

        Two tills can commit concurrently, so the sequence number is claimed
        optimistically and the unique constraint on ``(event, seq)`` arbitrates.
        Each attempt runs in its own savepoint so that a collision does not
        poison the surrounding transaction, which is also creating the order.

        ``order`` may be ``None``: a deposit refund is money out of the drawer
        with no order to hang it on.
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

    class Meta:
        verbose_name = _("Till device")
        verbose_name_plural = _("Till devices")

    def __str__(self):
        return f"{self.device}: {self.role or 'unset'}"

    @property
    def drives_terminal(self) -> bool:
        """Whether a card payment on this device has to come from its terminal."""
        return bool(self.sumup_reader_id)

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
