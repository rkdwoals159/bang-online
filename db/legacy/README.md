# Preserved application migration

`0000_long_iron_man.sql` is the exact SQL recorded in the production application's
`schema_migrations` version 1 on 2026-09-28. Its SHA-256 is
`fc1959a1d064d492efb9d501100b132b8342fd001536d34c90c13f9b32d80cce`.
Keep this file immutable. The production ledger row is preserved and is no longer
written or interpreted by request-time initialization.

The 2026-10-04 Sites version 2 publish failed at the first statement in the platform
baseline (`command_receipts already exists`). The schema predated platform migration
tracking because version 1 created it at request time. The specifically failed
platform `drizzle/0000_long_iron_man.sql` now uses `IF NOT EXISTS` only on its 25
CREATE TABLE/INDEX statements; its schema definitions and Drizzle metadata are
unchanged. This allows the normal Sites deployment runner to establish its own
baseline record without dropping or rewriting tables/data or the legacy ledger.
The new aggregate/cursor index remains a separate generated 0001 migration.

Subsequent successfully deployed SQL/metadata is immutable. Append future generated
Drizzle migrations. Runtime performs a read-only schema readiness check only.
