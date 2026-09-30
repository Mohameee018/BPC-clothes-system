# Desktop SQLite → Supabase/Postgres mapping (draft)

Status: schema-level mapping only. This is not an import script and must not be run against production.

## Source of truth inspected
- Desktop source schema: `src/Clothes_system/db/DatabaseSchema.java`.
- Desktop persistence: `src/Clothes_system/db/PersistenceRepository.java`.
- Web shared schema: `Cutdown clothes amr/supabase_shared_schema.sql`.
- The actual local `clothes_system.db` file was not available in this repository audit, so row counts, actual legacy columns, local image files, and real-world data quality remain unverified.

## Proposed table mapping

| Desktop SQLite table | Web/Postgres target | Mapping and cautions |
|---|---|---|
| `products` | `products` | Map SQLite `id` to `desktop_id`; map SKU, name, category, description, cost/sale price, minimum stock, active flag and timestamps. Confirm exact existing web columns (`name`, `category`, `description`, `price`, `stock`, `active`, etc.) against the live schema before coding. Assign a trusted company `brand_id`; never accept it from import payload. |
| `product_variants` | `product_variants` | Map `variant_id` to `desktop_variant_id`; resolve `product_id` through a per-company ID map; preserve color/size/stock. Check uniqueness of size/color and stock consistency. |
| `warehouses` | `warehouses` | Map `id` to `desktop_id`, name/location/active. Every warehouse must belong to the same company as its inventory and products. |
| `product_warehouse_stock` | `inventory` | Resolve product and warehouse IDs; preserve quantity and updated time. Desktop rows are product+warehouse keyed, while web inventory can also reference variants. Do not aggregate variant and product quantities until the business rule is confirmed. |
| `product_color_images` | `product_images` + Storage | Upload local files to a dedicated bucket path and map color/sort order. A local filesystem path is not a valid hosted image URL. Keep original files and a manifest until checksums and URLs reconcile. |
| `product_price_history` | No confirmed equivalent in shared schema | Add a deliberate tenant-scoped history table or preserve the rows in a staging/archive table. Do not discard audit history. |
| `product_inventory_history` | No confirmed equivalent in shared schema | Add a deliberate tenant-scoped inventory ledger with product/variant/warehouse links, signed quantity change, resulting balance, reason/reference and original timestamp. Do not recreate historical events as new stock adjustments. |
| `customers` | `customers` | Map source ID to `desktop_id`; preserve name/phone/status/totals/last order. Desktop phone is required and globally unique locally; web phone is nullable with a partial unique index. Detect duplicate/blank phones before import; do not silently merge customers. |
| `orders` | `orders` | Map source ID to `desktop_id`; preserve customer/phone/address snapshots, dates, payment/status, shipping, discount, notes, total and delivery time. Resolve company-scoped customer ID only where semantics are safe. Desktop `total` is TEXT while web monetary fields are numeric: parse/validate without rounding silently. |
| `order_items` | `order_items` | Preserve desktop row identity via `desktop_id` where supported; resolve order/product/variant IDs. Preserve product-name/SKU/category/size/color snapshots, quantity, unit price, cost price and line total. Do not require a live product match for historical snapshots. |
| `returns` | `returns` | Desktop supports product-level/partial return records; the shared web schema currently constrains returns to `return_type='whole_order'`. This is a blocker for faithful migration. Design a compatible return model before importing any returns or enabling write workflows. |
| `expenses` | No confirmed `public.expenses` table | Create a tenant-scoped expenses schema and policies first, with stable desktop ID and typed date/amount. Preserve category, description, payment and status. |
| `settings` | No direct shared business-table equivalent | Classify each setting: global app preference, user preference, or company setting. Do not import blindly; keep secrets out of ordinary settings rows. |

## ID and tenancy rules
1. Keep UUID primary keys for hosted rows and store desktop IDs in unique external-ID columns; never convert `PRD-*`, `ORD-*`, or `RET-*` IDs into guessed UUIDs.
2. Every imported row must be assigned to the target company selected by a trusted operator/server-side context. For parent-child records, verify that all referenced parents have the same `brand_id`.
3. Use an explicit source-to-target ID map for products, variants, warehouses, customers, orders and order items. Avoid relying on names, SKUs, phone numbers, or array order as identity.
4. Make import idempotent using stable source IDs plus company scope. A second dry run must not duplicate rows.
5. Preserve timestamps with an explicit unit conversion: desktop schema stores several times as integer epoch milliseconds, while Postgres uses `timestamptz`. Validate date-only strings separately.
6. Monetary fields use SQLite `REAL` in several tables. Import via decimal-safe parsing and report values that exceed the chosen currency precision; never silently adjust historical totals.
7. Enforce tenant isolation at the API and database layers. Every child query/write must verify both the child's company and the company of its referenced parent.

## Required importer phases
1. Read-only inventory: table counts, schema fingerprint, integrity check, foreign-key check, image-path inventory; emit no writes.
2. Export to a protected local snapshot; keep the source DB unchanged and record a checksum.
3. Dry run against a disposable test project: validate required fields, ID collisions, missing parents, duplicate phones, status mappings, image availability and numeric/date conversion.
4. Import into staging/test tables or a disposable project using transactions and an import manifest; generate per-table source/accepted/rejected counts.
5. Reconcile products, variants, warehouse stock, orders, order items, returns, expenses, histories, monetary totals and image checksums. Every mismatch must be explained.
6. Run tenant-isolation tests with two test companies, including cross-tenant parent IDs and storage paths.
7. Only after signed-off backup/restore and reconciliation should a separately approved production migration be considered.

## Current blockers before implementation
- Actual SQLite database file and image assets are not present in the repo snapshot.
- Live production columns/constraints must be rechecked before generating SQL.
- No matching web tables are confirmed for expenses, price history, or inventory history.
- Web returns currently model whole-order returns only, unlike the desktop table.
- Existing web storefront and desktop-sync behavior must remain unchanged throughout test imports.
