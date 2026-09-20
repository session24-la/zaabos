"""ZaabOS production acceptance static audit.
Does not touch production data. Exits non-zero if a critical invariant disappears.
"""
from pathlib import Path
import re, sys

ROOT=Path(__file__).resolve().parent
app=(ROOT/"app.py").read_text(encoding="utf-8")
fail=[]

def require(label, pattern, flags=0):
    if not re.search(pattern, app, flags):
        fail.append(label)

# Multi-tenant / data isolation invariants
require("tenant-scoped order uniqueness", r"uq_orders_tenant_order_no")
require("tenant-scoped payment uniqueness", r"uq_payments_tenant_order")
require("tenant-scoped refund uniqueness", r"uq_refunds_tenant_order")
require("tenant-scoped daily closing", r"uq_daily_closing_tenant_branch_date")
require("atomic unpaid payment claim", r"payment_status='unpaid'")
require("ambiguous public tracking guard", r"พบเลขออเดอร์ซ้ำในหลายร้าน")

# Authentication / request security
require("CSRF token validation", r"csrf", re.I)
require("secure password hashing", r"(generate_password_hash|check_password_hash)")
require("HTTPOnly session cookie", r"SESSION_COOKIE_HTTPONLY=True")
require("SameSite cookie", r"SESSION_COOKIE_SAMESITE='Lax'")
require("anti-clickjacking", r"X-Frame-Options")
require("nosniff", r"X-Content-Type-Options")
require("HSTS", r"Strict-Transport-Security")

# Operational readiness
require("liveness endpoint", r"@app\.get\('/healthz'\)")
require("readiness endpoint", r"@app\.get\('/readyz'\)")
require("migration v12", r"record_migration\(conn, 12")
require("migration v13", r"record_migration\(conn, 13")
require("production readiness endpoint", r"production-readiness")

if fail:
    print("FAIL")
    for x in fail: print(" -",x)
    sys.exit(1)
print("PASS — critical Round 12 invariants present")
