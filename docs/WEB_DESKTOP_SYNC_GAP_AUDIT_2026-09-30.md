# Desktop ↔ Web Sync Gap Audit — 2026-09-30

Status: static source review only. No production schema, data, or deployment was changed.

## Verified status
- The four GitHub Actions workflows associated with commit `bd19f1664ea47a93d43b8640fdd736e0620ed485` completed successfully: Web migration validation, Web syntax check, Desktop database inventory tool, and Website checks.
- Pull request #1 remains the review path for the migration branch. These passing checks do not mean the migration is production-ready or that live tenant isolation has been runtime-tested.

## Desktop persistence behavior
The desktop SQLite schema defines these tables:
`products`, `product_variants`, `warehouses`, `product_warehouse_stock`, `product_color_images`, `product_price_history`, `product_inventory_history`, `customers`, `orders`, `order_items`, `returns`, `expenses`, and `settings`.

`PersistenceRepository.saveAll()` saves warehouses, products, customers, orders, returns, expenses, and settings inside one SQLite transaction, committing all or rolling back on failure. It also persists product price history, inventory history, variants, warehouse stock, and color images as part of product persistence.

## Confirmed web-schema gaps
1. **Expenses:** desktop has an `expenses` table, but the reviewed shared Supabase schema has no equivalent table.
2. **History ledgers:** desktop has `product_price_history` and `product_inventory_history`; no equivalent tenant-scoped web tables were confirmed in the reviewed shared schema.
3. **Returns:** desktop `returns` stores product-level rows, quantity, product/size/color snapshots, refund, disposition and loss. Web schema restricts `return_type` to `whole_order`; this cannot faithfully represent existing partial/product returns.
4. **Settings:** desktop stores store identity, invoice, printer, return-policy and UI settings. These need classification as company, user, or application settings before migration.
5. **Stock shape:** desktop has product-level stock plus product/warehouse stock and variant stock. Web has products, variants and inventory with optional variant and required warehouse references. Reconciliation rules must be explicit to avoid double-counting or losing stock.
6. **Legacy identifiers and timestamps:** desktop IDs are text and several timestamps are epoch milliseconds; hosted records use UUIDs and timestamps. A stable per-company ID map and explicit timestamp conversion are required.

## Sync endpoint risk found by static inspection
The current `POST /api/desktop/products/sync` handler in `Cutdown clothes amr/server.js` performs multiple separate Supabase operations: product upsert, warehouse lookup/creation, variant upsert and stale-variant deletion, inventory update/insert, then image removal/deletion/uploads/inserts. These are not wrapped in one database transaction by the handler. A failure after an earlier operation succeeds can leave a partially synchronized product. Some image cleanup/delete results are not checked before the handler proceeds.

This differs from the desktop `saveAll()` atomic transaction behavior. Before treating sync as reliable for production, move the related mutations into a server-validated transactional database function or another design with explicit idempotency, rollback/compensation, and reconciliation. Preserve existing storefront behavior while testing this.

## Required next validation
- Run tests against a disposable Supabase project or isolated test database, not production.
- Test failure injection after each sync stage and verify that retries converge without duplicate or missing rows.
- Test two brands with colliding desktop IDs, cross-brand product/variant/warehouse references, and storage access boundaries.
- Verify storage bucket visibility and per-brand object access; path prefixes alone are not an authorization boundary.
- Reconcile source/target counts and quantities, including partial returns, expenses, price history, inventory history, settings, and image checksums.
- Obtain the real local `clothes_system.db` and referenced image assets before making claims about actual source rows or importing data. The database file was not found in the tracked GitHub repository.

## Safety boundary
This document is an audit artifact, not an import script. Do not apply schema changes, import data, merge the PR, or deploy a new release on the basis of this report alone.
