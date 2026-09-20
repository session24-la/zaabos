# ZaabOS Round 14G — Time & Flexible Shift Correctness

- Database/application timestamps now use explicit UTC ISO timestamps.
- Restaurant business date defaults to Asia/Vientiane (configurable with ZAABOS_TIMEZONE).
- Daily order number date uses restaurant-local date.
- Report and daily-closing date filters convert restaurant-local dates to UTC boundaries.
- Receipt, kitchen ticket, KDS and tracking time formatting is pinned to Asia/Vientiane so a device timezone cannot silently change printed restaurant time.
- Shifts remain event-based: open whenever responsibility begins; close whenever handover happens. No fixed 08:00/20:00 schedule.
- Cash refunds after an older shift has closed are attributed to the currently open operator shift.
- Cash refund requires the refunding operator to have an open shift.
- Closing expected cash subtracts cash refunds attributed to that shift.
- Migration 20 is additive only. No reset and no production data deletion.

Operational setting:
ZAABOS_TIMEZONE=Asia/Vientiane
