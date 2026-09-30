# BPC Clothes System — Desktop-to-Web Migration Plan

## Decision and guardrails

- Target: browser-based management app; internet is always available.
- Tenant model: multiple independent companies/brands in one hosted application, with strict data isolation.
- Rollout: keep the Java Swing desktop app available until the web app passes parity, tenant-isolation, backup/restore, and user-acceptance checks.
- Data safety: no production schema changes, bulk data moves, demo-data deletion, or desktop shutdown as part of Phase 1.
- Deployment: implement behind a separate route and/or branch first; do not replace the existing storefront or production desktop-sync endpoints blindly.

## Repositories inspected

1. `Mohameee018/cutdown-system-desktop`
   - Java 21 Swing application using SQLite JDBC.
   - Persistent database file: `clothes_system.db`.
   - Persistence boundary: `Clothes_system.db.PersistenceRepository`; schema in `DatabaseSchema.java`.
   - Existing domain includes products, variants, price/inventory history, per-warehouse stock, warehouses, customers, orders/items, returns, expenses, settings, dashboard and reports.
   - Product and order operations have application-side rules; the web implementation must preserve these rather than only copy screens.
2. `Mohameee018/Cutdown-clothes-store`
   - Existing Node.js/Express app serves a customer-facing storefront and uses Supabase.
   - `admin.html` is currently an order-status admin page, not a full inventory/ERP management app.
   - Existing server routes include authenticated desktop product sync and order operations; the public storefront has a separate purpose and must remain working.
   - Existing dependencies are Express and `@supabase/supabase-js`; the current front end is plain HTML/CSS/JavaScript.
3. `Mohameee018/BPC-Business-platform-core`
   - Company showcase site only; not the place to implement inventory/business logic. Update its system link only after the web app is ready.

## Important findings / risks

- Desktop is SQLite-first; the hosted web system is Supabase/Postgres. These are not interchangeable schemas and cannot be migrated by simply pointing the UI at Supabase.
- Desktop has richer workflows than the current storefront admin page (warehouse stock, variants, price/inventory history, returns, expenses, reports, and order editing).
- The existing Supabase model already has a `brands` table and `brand_id` columns across key tables, plus migration scripts for multi-brand foundations/hardening. This is a useful starting point, not proof that isolation is correct end-to-end.
- The current Express desktop-sync guard compares a user's `brand_id` to one configured `CUTDOWN_BRAND_ID`. That is a single-brand gate and must be redesigned before onboarding multiple companies. Tenant identity must come from the authenticated user's trusted server-side profile, never from a client-supplied brand ID.
- Product and variant sync already writes product/variant and inventory data, but the inventory model differs from desktop's per-warehouse and history model. Reconcile those semantics before treating cloud inventory as canonical.
- Existing website data includes storefront-specific orders/reviews and product presentation fields. Preserve those; don't truncate tables or repurpose existing columns without a migration.
- Supabase management API/database inspection was attempted during this audit, but the linked account returned a permissions error. Therefore live row counts, active policies, grants, storage policies, and current production constraints still require a successful read-only database audit before schema changes.

## Live database audit completed (read-only)

- The linked Supabase project is active and reachable through the `Mohamed Ahmed` linked account.
- Current table counts observed: `brands=1`, `profiles=3`, `customers=1`, and `products=0`, `product_variants=0`, `product_images=0`, `warehouses=0`, `inventory=0`, `orders=0`, `order_items=0`, `returns=0`. These are a point-in-time snapshot, not a claim about desktop-local SQLite contents.
- The queried schema has no `public.expenses` table. Expenses therefore need a deliberate web schema and import mapping; they must not be silently dropped from parity scope.
- The applied migration history currently lists `complete_cutdown_shared_backend` and `lock_down_backend_functions_and_admin_tables`. The multi-brand SQL scripts in the repository are not evidence that all of those scripts have been applied to production.
- Read-only policy inspection found public SELECT policies for active products, variants, and images, and customer/order policies that call shared admin helpers. These existing policies were written for the storefront and require a separate tenant-isolation review before multi-company data is considered secure.
- Supabase security advisors currently report: one RLS-enabled table (`desktop_update_manifests`) without a policy; three SECURITY DEFINER functions callable by authenticated users (`claim_customer_for_auth`, `current_brand_id`, `is_brand_admin`); and leaked-password protection disabled. These are findings to review, not changes applied by this migration branch.

## Phase 1 implementation on the migration branch

- Added `/app` as a separate management entry point. It does not replace the storefront or `/admin`.
- Added `/api/app/session`, `/api/app/products`, and `/api/app/inventory`. Each verifies the authenticated user's administrator role and active assigned brand, then filters records by that profile-derived `brand_id`; no client-supplied brand ID is trusted.
- Added a read-only responsive `app.html` preview for products and inventory. It is a pilot shell, not yet a full ERP and not yet linked from the public BPC showcase.
- Added a GitHub Actions validation workflow to check Node syntax, endpoint presence, tenant filters, and the management page.
- This branch has not been deployed to production. No production database changes or data migrations were run.

## Incremental implementation plan

### Phase 0 — Baseline and safeguards (this branch)
- Record repository boundaries and feature inventory.
- Obtain a read-only schema/policy/row-count snapshot and backup/restore evidence before any production DDL.
- Export a verified copy of each existing SQLite database and record counts for every table.
- Identify images stored as local file paths and map them to cloud storage objects; keep the original files until reconciliation is signed off.
- Define parity tests for business rules, not just UI appearance.

### Phase 1 — Multi-tenant foundation (no production rollout yet)
- Confirm `brands`, `profiles`, all business tables, unique indexes, triggers, RLS policies, Storage policies, and grants.
- Replace single configured-brand authorization with profile-derived tenant context on authenticated server routes.
- Ensure every query and mutation is tenant-scoped; add database RLS as defense in depth. Verify tenant A cannot read/write tenant B's products, images, stock, customers, orders, returns, expenses, or reports.
- Decide company-owner, manager, inventory, sales, and read-only roles. Do not rely on user-editable Auth metadata for permissions.
- Add automated isolation tests before enabling company signup or invitations.

### Phase 2 — Canonical data contract and migration tooling
- Write an explicit mapping from SQLite tables/columns to Postgres tables/columns, including IDs, decimal/currency precision, timestamps, returns, status values, stock per warehouse, and history.
- Use stable external IDs and idempotent upserts; preserve source IDs in mapping columns or a dedicated migration map.
- Build a dry-run importer with counts, validation errors, checksums for images, and a rollback/retry strategy.
- Keep production writes disabled during dry runs. Never overwrite cloud records just because a desktop export omits a field.

### Phase 3 — Web app shell and read-only parity
- Build a separate authenticated management area (e.g. `/app`) without replacing the customer storefront.
- Start with dashboard, products, variants, warehouses, and inventory read-only screens against tenant-scoped APIs.
- Add pagination, search, loading/error states, responsive layouts, and audit logging.
- Compare values with the desktop app for a known test dataset.

### Phase 4 — Controlled writes by module
Implement and test one workflow at a time:
1. Products and images
2. Warehouses and inventory adjustments/history
3. Customers
4. Orders and order status
5. Returns and stock restoration
6. Expenses
7. Dashboard/reports
Each mutation must be transactional where multiple rows are involved and must enforce tenant ownership on both parent and child rows.

### Phase 5 — Parallel pilot and cutover
- Run a test company and then one real company in parallel with desktop.
- Compare record counts, stock balances, order totals, return quantities, and reports daily.
- Train users and collect sign-off.
- Only then make web the default. Keep desktop read-only/exportable as a rollback path for an agreed period; do not delete SQLite files or stop publishing desktop releases until explicitly approved.

## Exit criteria before replacing desktop

- No unexplained row/count/value differences in migration reconciliation.
- Tenant isolation tests pass for all CRUD and Storage paths.
- Backup restore is tested, not merely configured.
- Products/images, warehouse inventory, order edit/status, partial/full returns, expenses, and reports pass parity tests.
- No critical/high security findings remain in RLS, API authorization, or secret exposure.
- Pilot users approve the workflow and a rollback procedure has been rehearsed.

## Immediate next actions

1. Restore Supabase management-tool permission and perform the live read-only schema/RLS/Storage audit.
2. Inspect the remaining Express endpoints and the SQLite repository methods for exact data mappings.
3. Produce the migration mapping and test fixtures before any database DDL or data import.
4. Implement tenant-context middleware and isolation tests on a non-production branch before adding web write screens.
