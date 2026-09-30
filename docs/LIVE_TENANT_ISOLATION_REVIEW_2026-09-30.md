# Live tenant-isolation review — 2026-09-30

Scope: read-only inspection of the linked production Supabase project's migration history, RLS policies, function definitions and grants. No database writes, policy edits, or deployments were performed.

## Confirmed facts

- Applied migrations reported by Supabase:
  - `20260929042235 complete_cutdown_shared_backend`
  - `20260929042357 lock_down_backend_functions_and_admin_tables`
- Tenant-bearing business tables include brands, profiles, products, product_variants, product_images, warehouses, inventory, customers, orders, order_items, returns, and reviews.
- Most business tables have a nullable `brand_id`; ordinary single-column foreign keys do not by themselves prove that child and parent rows belong to the same brand.
- Current public policies include:
  - products: public SELECT where `active = true`, with no visible `brand_id` condition in that policy.
  - product_variants: public SELECT for active variants whose parent product has both `active` and `is_active` true.
  - product_images: public SELECT when the parent product is active.
  - reviews: public SELECT where approved = true.
- Admin policies on inventory, warehouses and returns call `private.is_admin()`; customer/order policies also allow `private.is_admin()`. These expressions do not visibly compare the row's `brand_id` with the authenticated user's `profiles.brand_id`.
- The `private.is_admin()` definition is `exists(select 1 from public.profiles where id = auth.uid() and role = 'admin')`. It checks the caller's role, but does not check the row's brand. This confirms the helper itself is global-role based; whether this creates cross-tenant data exposure depends on the intended role model and all surrounding grants/policies, and must be tested with separate users and brands.
- `public.current_brand_id()` returns `brand_id` from the caller's own profile.
- `public.is_brand_admin()` checks that the caller's profile has role `admin` and a non-null `brand_id`.
- `public.claim_customer_for_auth()` obtains the caller's profile brand, looks for a customer already linked to the caller in that brand, and otherwise claims an unlinked customer with a matching email within that brand. The function body explicitly scopes the customer lookup/update to the profile's brand.
- The reviewed functions are SECURITY DEFINER and use `search_path = public`. Referenced objects in the captured bodies are schema-qualified except built-ins; still review least-privilege EXECUTE grants and all call paths before changing anything.
- EXECUTE grants were observed for `private.is_admin()` to authenticated and for `public.claim_customer_for_auth()`, `public.current_brand_id()`, and `public.is_brand_admin()` to authenticated (and service_role).
- The new `/api/app/*` preview endpoints use server-side tenant resolution from the authenticated profile and explicitly filter data by that brand. Static checks do not prove runtime cross-tenant isolation.
- `desktop_update_manifests` is RLS-enabled and had no policy in the captured advisor output; determine whether reads should occur only through a privileged server endpoint or an authenticated policy.
- A targeted query returned no policies for `storage.objects`. This alone does not prove bucket visibility; bucket configuration and actual object access still need explicit verification.

## Risks to resolve before multi-company production use

1. **Public storefront visibility:** the products public SELECT policy only checks `active = true`; it has no visible brand restriction. Active products across brands may therefore be exposed to direct public Supabase queries unless a separate enforced boundary applies. Verify expected storefront behavior before tightening the policy.
2. **Admin row isolation:** `private.is_admin()` is role-based and not brand-aware. Confirm whether this role is intentionally a platform-wide administrator. Brand admins should not rely on a global role check for tenant isolation.
3. **Cross-brand relationships:** add database-enforced consistency for references such as order items → orders/products/variants, inventory → products/variants/warehouses, and images/variants → products, so mismatched brand IDs cannot be written even if a server bug occurs.
4. **Nullable tenant keys:** decide which tables require non-null `brand_id`; backfill and validate before adding constraints.
5. **Storage:** review product-image bucket policies and object ownership. Namespaced upload paths alone are not authorization controls.
6. **Role functions:** keep SECURITY DEFINER only where needed, review EXECUTE grants and search paths, and verify intended behavior with tests before changes.
7. **Real tenant tests:** use a disposable database/project with two synthetic brands and separate admin/customer users. Test direct anonymous/authenticated API access, server endpoints, cross-brand parent IDs, and Storage object access. Code grep and syntax checks are not isolation tests.

## Recommended order

1. Preserve current storefront behavior with baseline tests.
2. Create a disposable test environment and seed two synthetic brands and admin users.
3. Write explicit expected-access tests for anonymous storefront access, brand A admin, brand B admin and customer users.
4. Design a reviewed migration with constraints/policies and a rollback plan.
5. Run tests on the disposable environment, then separately request approval before any production schema/policy change.

## Status

Audit only. Production database unchanged. This document is not a statement that production multi-tenant isolation has passed.