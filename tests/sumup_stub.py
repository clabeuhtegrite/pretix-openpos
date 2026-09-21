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


class FakeSumUp:
    """One merchant's readers, transactions and refunds."""

    def __init__(self, merchant="MERCH1"):
        self.merchant = merchant
        #: reader id -> the reader object SumUp would return.
        self.readers = {}
        #: client_transaction_id -> the transaction, or None while there is none.
        self.transactions = {}
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

    def pay(self, client_transaction_id=None, *, transaction_id="tx_1", status="SUCCESSFUL"):
        """Have the cardholder answer the reader."""
        if client_transaction_id is None:
            client_transaction_id = next(iter(self.transactions))
        self.transactions[client_transaction_id] = {
            "id": transaction_id,
            "client_transaction_id": client_transaction_id,
            "status": status,
            "amount": "10.00",
        }
        return client_transaction_id

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
        terminate = re.fullmatch(rf"{re.escape(prefix)}/([^/]+)/terminate", path)
        if method == "POST" and terminate:
            return self._terminate
        if method == "GET" and path == f"/v2.1/merchants/{self.merchant}/transactions":
            return self._transaction
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
            # Nothing exists yet: the cardholder has not been asked. That is
            # what makes the till's first poll a 404 rather than a failure.
            self.transactions[client_transaction_id] = None
            return FakeResponse(
                201, {"data": {"client_transaction_id": client_transaction_id}}
            )

        return handler

    def _terminate(self, body, params):
        # SumUp confirms nothing here, by design.
        return FakeResponse(204)

    def _transaction(self, body, params):
        key = params.get("client_transaction_id") or params.get("id")
        transaction = self.transactions.get(key)
        if transaction is None:
            # Either no such transaction, or one the cardholder has not
            # answered yet. SumUp cannot tell those apart either.
            return FakeResponse(404, {"message": "not found"})
        return FakeResponse(200, transaction)

    def _refund(self, transaction_id):
        def handler(body, params):
            known = [
                t for t in self.transactions.values()
                if t and t.get("id") == transaction_id
            ]
            if not known:
                return FakeResponse(404, {"message": "no such transaction"})
            self.refunds.append((transaction_id, (body or {}).get("amount")))
            return FakeResponse(204)

        return handler
