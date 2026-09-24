"""
A SumUp merchant account, in memory.

The plugin's one rule about SumUp is that nothing it says is believed until it
has been asked over an authenticated connection, and the whole terminal flow is
built on the difference between "it failed", "it has not happened yet" and "we
could not ask". None of those three can be told apart against a live API, and
two of them cannot be provoked there at all — so the tests drive this instead,
and it is written to behave the way the real one is documented to: a reader
checkout that answers before the cardholder has touched anything, a transaction
that does not exist until they have, and a refund that only ever points at one.

It records every call, so a test can say what the server asked as well as what
it did with the answer.

The shapes are SumUp's published ones (``openapi.yaml`` in
github.com/sumup/sumup-openapi), not remembered ones. This stub was first
written from memory, and three of its answers were wrong in ways that made the
suite pass against an API that does not exist: a refund answered 204 where
SumUp answers 201, a reader's status at the top level where SumUp puts it
under ``data``, and a busy reader as a 409 where SumUp sends a 422 naming it.

A 409 is what SumUp does answer a refund asked for moments after the payment —
the first real refunds, on 24 September 2026 — and ``not_refundable_yet`` is
how a test has it say so.
"""
import json
import re


class FakeResponse:
    def __init__(self, status_code, payload=None, text=None):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload) if payload is not None else (text or "")
        self.content = self.text.encode()

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


def reader_offline():
    """What SumUp answers a checkout for a reader that is off or out of range."""
    return FakeResponse(
        422, {"errors": {"type": "READER_OFFLINE", "detail": "The device is offline."}}
    )


#: SumUp's answer to a refund of a transaction whose state does not allow one
#: yet, word for word from its API reference — and from the order page of the
#: first refund it refused.
NOT_REFUNDABLE = {
    "type": "https://developer.sumup.com/problem/conflict",
    "title": "Conflict",
    "status": 409,
    "detail": "The transaction is not refundable in its current state",
}

#: SumUp's answer to a refund its payment processor rejects, from the same
#: reference: a refusal for good, where the 409 is one for now.
REFUND_FAILED = {
    "type": "https://developer.sumup.com/problem/unprocessable-entity",
    "title": "Unprocessable Entity",
    "status": 422,
    "detail": "Refund failed.",
    "errors": [{
        "code": "INVALID_AMOUNT",
        "detail": "Amount exceeds the refundable amount",
        "reason": "amount_too_high",
        "max_refundable_amount": 1000,
    }],
}


def reader_busy():
    """What SumUp answers within a minute of the last request it accepted."""
    return FakeResponse(
        422,
        {"errors": {"type": "READER_BUSY",
                    "detail": "There is a pending checkout for the device."}},
    )


class FakeSumUp:
    """One merchant's readers, transactions and refunds."""

    def __init__(self, merchant="MERCH1"):
        self.merchant = merchant
        #: reader id -> the reader object SumUp would return.
        self.readers = {}
        #: client_transaction_id -> the transaction, or None while there is none.
        self.transactions = {}
        #: checkout_id -> the request put on a reader, as SumUp keeps it:
        #: ``pending`` until the cardholder answers it or it ends unpaid.
        self.checkouts = {}
        self.refunds = []
        #: Every call made, as (method, path, json body).
        self.calls = []
        #: Answer the next call with this ``FakeResponse`` instead of acting.
        self.next_response = None
        #: Raise this instead of answering — a timeout, a DNS failure.
        self.next_exception = None
        #: What a freshly paired reader comes back as. SumUp says ``processing``
        #: until the device itself acknowledges, which takes a few seconds.
        self.pairing_status = "paired"
        #: reader id -> what ``/status`` says about it. A reader with no entry
        #: here answers 404, which is what a Solo on firmware older than
        #: 3.3.39.0 does: old enough to take a payment, too old to be asked
        #: about one.
        self.reader_states = {}
        #: Transaction ids a refund is answered 409 for, as SumUp answers one
        #: asked for moments after the payment. Taken out, the refund goes.
        self.not_refundable_yet = set()
        #: Answer every refund with this ``FakeResponse`` while it is set,
        #: whatever else is asked in between: a refusal that stays.
        self.refuse_refunds_with = None
        #: The query of every history read, for a test to say what was asked.
        self.history_reads = []
        #: Added to the history's next link. SumUp's example of one carries
        #: the cursor and the order only; a test may make it repeat more.
        self.history_link_extra = ""
        self._counter = 0

    # -- setting a scene ---------------------------------------------------

    def add_reader(self, reader_id="rdr_ONE", name="Bar", model="solo", status="paired"):
        self.readers[reader_id] = {
            "id": reader_id,
            "name": name,
            "status": status,
            "device": {"identifier": f"dev-{reader_id}", "model": model},
        }
        return reader_id

    def set_state(self, reader_id, state="IDLE", *, status="ONLINE", **extra):
        """What ``/status`` will say about this reader."""
        self.reader_states[reader_id] = {
            "status": status,
            "state": state,
            "battery_level": 72,
            "connection_type": "Wi-Fi",
            "firmware_version": "3.3.39.0",
            **extra,
        }
        return reader_id

    def pay(
        self, client_transaction_id=None, *, transaction_id="tx_1", status="SUCCESSFUL",
        amount="10.00",
    ):
        """Have the cardholder answer the reader."""
        if client_transaction_id is None:
            client_transaction_id = next(iter(self.transactions))
        self.transactions[client_transaction_id] = {
            "id": transaction_id,
            "client_transaction_id": client_transaction_id,
            "status": status,
            "amount": amount,
        }
        for checkout in self._checkouts_for(client_transaction_id):
            checkout["status"] = (
                "successful" if status in ("SUCCESSFUL", "PAID_OUT")
                else "pending" if status == "PENDING"
                else "failed"
            )
        return client_transaction_id

    def give_back(self, transaction_id="tx_1", *, amount=None, status="REFUNDED", stated=True):
        """
        Give a payment back from SumUp's side: its dashboard, or its app.

        ``status`` is what SumUp then says of the payment: ``REFUNDED``, or
        ``CANCELLED`` for one reversed before it settled. ``amount`` is how much
        went back, the whole of it by default. ``stated=False`` leaves the
        figure off the history's line, where SumUp documents one, so that only
        the transaction's own events say how much — twice, as SumUp lists them.
        """
        transaction = self.find(transaction_id)
        refunded = amount if amount is not None else transaction["amount"]
        transaction["status"] = status
        if status == "REFUNDED":
            event = {"type": "REFUND", "status": "SUCCESSFUL", "amount": float(refunded)}
            detailed = {"event_type": "REFUND", "status": "SUCCESSFUL", "amount": float(refunded)}
            transaction["events"] = [event]
            transaction["transaction_events"] = [detailed]
            if stated:
                transaction["refunded_amount"] = float(refunded)
            else:
                transaction.pop("refunded_amount", None)
        return transaction

    def find(self, transaction_id):
        """The transaction with this id, as SumUp keeps it."""
        return next(
            t for t in self.transactions.values() if t and t.get("id") == transaction_id
        )

    def walk_away(self, client_transaction_id=None, *, status="cancelled"):
        """
        End the request on the reader with no card ever presented.

        What SumUp does once the request expires with nobody in front of it
        (``cancelled``), or once the cashier's stop has reached the device
        (``failed``, what the spec says a terminated request reports). No
        transaction is created: the Transactions API goes on answering 404,
        and only the request itself says it is over.
        """
        if client_transaction_id is None:
            client_transaction_id = next(iter(self.transactions))
        for checkout in self._checkouts_for(client_transaction_id):
            checkout["status"] = status
        return client_transaction_id

    def _checkouts_for(self, client_transaction_id):
        return [
            c for c in self.checkouts.values()
            if c["client_transaction_id"] == client_transaction_id
        ]

    @property
    def started(self):
        """The client transaction ids of every checkout put on a reader."""
        return list(self.transactions)

    def call_paths(self, method=None):
        return [path for verb, path, _body in self.calls if method in (None, verb)]

    # -- answering ---------------------------------------------------------

    def request(self, method, url, *, json=None, params=None, headers=None, timeout=None):
        path = url.replace("https://api.sumup.com", "")
        self.calls.append((method, path, json))

        if self.next_exception is not None:
            exception, self.next_exception = self.next_exception, None
            raise exception
        if self.next_response is not None:
            response, self.next_response = self.next_response, None
            return response

        handler = self._route(method, path)
        if handler is None:
            return FakeResponse(404, {"message": "no such route"})
        return handler(json or {}, params or {})

    def _route(self, method, path):
        prefix = f"/v0.1/merchants/{self.merchant}/readers"
        if method == "GET" and path == prefix:
            return self._list_readers
        if method == "POST" and path == prefix:
            return self._pair_reader
        if method == "DELETE" and path.startswith(f"{prefix}/"):
            return self._forget(path[len(prefix) + 1:])
        checkout = re.fullmatch(rf"{re.escape(prefix)}/([^/]+)/checkout", path)
        if method == "POST" and checkout:
            return self._checkout(checkout.group(1))
        request = re.fullmatch(rf"{re.escape(prefix)}/([^/]+)/checkout/([^/]+)", path)
        if method == "GET" and request:
            return self._reader_checkout(request.group(1), request.group(2))
        terminate = re.fullmatch(rf"{re.escape(prefix)}/([^/]+)/terminate", path)
        if method == "POST" and terminate:
            return self._terminate
        state = re.fullmatch(rf"{re.escape(prefix)}/([^/]+)/status", path)
        if method == "GET" and state:
            return self._reader_status(state.group(1))
        if method == "GET" and path == f"/v2.1/merchants/{self.merchant}/transactions":
            return self._transaction
        if method == "GET" and path == f"/v2.1/merchants/{self.merchant}/transactions/history":
            return self._history
        refund = re.fullmatch(
            rf"/v1\.0/merchants/{re.escape(self.merchant)}/payments/([^/]+)/refunds", path
        )
        if method == "POST" and refund:
            return self._refund(refund.group(1))
        return None

    def _list_readers(self, body, params):
        return FakeResponse(200, {"items": list(self.readers.values())})

    def _pair_reader(self, body, params):
        if not body.get("pairing_code"):
            return FakeResponse(400, {"message": "pairing_code is required"})
        self._counter += 1
        reader_id = f"rdr_{self._counter}"
        reader = {
            "id": reader_id,
            "name": body.get("name") or "",
            "status": self.pairing_status,
            "device": {"identifier": f"dev-{reader_id}", "model": "solo"},
        }
        self.readers[reader_id] = reader
        return FakeResponse(201, reader)

    def _forget(self, reader_id):
        def handler(body, params):
            if reader_id not in self.readers:
                return FakeResponse(404, {"message": "no such reader"})
            del self.readers[reader_id]
            return FakeResponse(204)

        return handler

    def _checkout(self, reader_id):
        def handler(body, params):
            if reader_id not in self.readers:
                return FakeResponse(404, {"message": "no such reader"})
            self._counter += 1
            client_transaction_id = f"ctx_{self._counter}"
            checkout_id = f"chk_{self._counter}"
            # Nothing exists yet: the cardholder has not been asked. That is
            # what makes the till's first poll a 404 rather than a failure.
            self.transactions[client_transaction_id] = None
            self.checkouts[checkout_id] = {
                "checkout_id": checkout_id,
                "client_transaction_id": client_transaction_id,
                "reader": reader_id,
                "status": "pending",
            }
            return FakeResponse(
                201,
                {"data": {
                    "checkout_id": checkout_id,
                    "client_transaction_id": client_transaction_id,
                }},
            )

        return handler

    def _reader_checkout(self, reader_id, checkout_id):
        def handler(body, params):
            checkout = self.checkouts.get(checkout_id)
            if checkout is None or checkout["reader"] != reader_id:
                return FakeResponse(404, {"detail": "not found"})
            return FakeResponse(200, {"data": {
                "checkout_id": checkout_id,
                "client_transaction_id": checkout["client_transaction_id"],
                "status": checkout["status"],
                "payment_failure_reason": None,
            }})

        return handler

    def _reader_status(self, reader_id):
        def handler(body, params):
            state = self.reader_states.get(reader_id)
            if state is None:
                return FakeResponse(404, {"message": "not supported"})
            return FakeResponse(200, {"data": state})

        return handler

    def _terminate(self, body, params):
        # SumUp confirms nothing here, by design, and the device obeys in its
        # own time: the request stays pending until ``walk_away`` says the
        # stop has reached it.
        return FakeResponse(202, {})

    def _transaction(self, body, params):
        if "id" in params:
            transaction = next(
                (t for t in self.transactions.values() if t and t.get("id") == params["id"]),
                None,
            )
        else:
            transaction = self.transactions.get(params.get("client_transaction_id"))
        if transaction is None:
            # Either no such transaction, or one the cardholder has not
            # answered yet. SumUp cannot tell those apart either.
            return FakeResponse(404, {"message": "not found"})
        # The full resource carries its refunds as events only: the total
        # refunded is a field of the history's lines, not of this.
        return FakeResponse(
            200, {k: v for k, v in transaction.items() if k != "refunded_amount"}
        )

    def _history(self, body, params):
        """
        The history, filtered as SumUp filters it, one page at a time.

        Newest first when asked, and paged by the id of the last line given,
        through a ``next`` link that is a bare query string, as SumUp's is.
        """
        self.history_reads.append(dict(params))
        statuses = set(params.get("statuses[]") or ())
        lines = [
            {
                "id": t["id"],
                "transaction_id": t["id"],
                "client_transaction_id": t["client_transaction_id"],
                "type": "PAYMENT",
                "status": t["status"],
                "amount": float(t["amount"]),
                **({"refunded_amount": t["refunded_amount"]} if "refunded_amount" in t else {}),
            }
            for t in self.transactions.values()
            if t and (not statuses or t["status"] in statuses)
        ]
        if params.get("order") == "descending":
            lines.reverse()
        after = params.get("newest_ref")
        if after:
            lines = lines[[line["id"] for line in lines].index(after) + 1:]
        limit = int(params.get("limit") or 10)
        page, rest = lines[:limit], lines[limit:]
        links = (
            [{
                "rel": "next",
                "href": f"limit={limit}&newest_ref={page[-1]['id']}&order=descending"
                        f"{self.history_link_extra}",
            }]
            if rest else []
        )
        return FakeResponse(200, {"items": page, "links": links})

    def _refund(self, transaction_id):
        def handler(body, params):
            known = [
                t for t in self.transactions.values()
                if t and t.get("id") == transaction_id
            ]
            if not known:
                return FakeResponse(404, {"message": "no such transaction"})
            if self.refuse_refunds_with is not None:
                return self.refuse_refunds_with
            if transaction_id in self.not_refundable_yet:
                return FakeResponse(409, NOT_REFUNDABLE)
            amount = (body or {}).get("amount")
            self.refunds.append((transaction_id, amount))
            # What the payment then says of itself, in the history and on the
            # transaction alike.
            self.give_back(transaction_id, amount=amount)
            return FakeResponse(201, {})

        return handler
