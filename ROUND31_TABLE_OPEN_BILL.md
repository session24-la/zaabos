# Round 31 — Table Open Bill

Default dine-in behaviour: one open payable bill per occupied table. Repeated QR submits from the same or different phones append new items to that bill. Explicit staff split bills remain separate. Paying/completing the normal bill ends that seating session; the next QR order starts a fresh bill.

Acceptance is covered by `round31_table_open_bill_test.py` and must be run only on isolated SQLite with no `DATABASE_URL`.
