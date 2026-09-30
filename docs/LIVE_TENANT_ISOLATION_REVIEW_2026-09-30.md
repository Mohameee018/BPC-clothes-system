# Live tenant-isolation review — 2026-09-30

Scope: read-only inspection of the linked production Supabase project's table definitions, migration history and pg_policies. No database writes, policy edits, or deployments were performed.

## Confirmed facts

- Applied migrations reported by Supabase:
  - 20260929042235 complete_cutdown_shared_backend
  - 20260929042357 lock_down_backend_functions_and_admin_tables
- Tenant-bearing business tables include brands, profiles, products, product_variants, product_images, warehouses, inventory, customers, orders, order_items, returns, and reviews.
- Most business tables have a nullable brand_id; foreign keys connect each row to a brand, but ordinary single-column foreign keys do not by themselves prove that child and parent rows belong to the same brand.
- Current public policies include:
  - products: public SELECT where active = true.
  - product_variants: public SELECT for active variants whose parent product has both active and is_active true.
  - product_images: public SELECT when the parent product is active.
  - reviews: public SELECT where approved = true.
- Admin policies on inventory, warehouses and returns call private.is_admin(); customer/order policies also allow private.is_admin(). Those policy expressions do not visibly compare the row's brand_id with the authenticated user's profiles.brand_id.
- The new /api/app/* preview endpoints use server-side tenant resolution from the authenticated profile and explicitly filter data by that brand. This is useful defense in depth, but the current static checks do not prove runtime cross-tenant isolation.
- desktop_update_manifests is RLS-enabled and has no policy in the captured advisor output; this needs a deliberate decision for whether reads occur through a privileged server endpoint or an authenticated policy.
- The targeted read-only query returned no policies for storage.objects. This does not by itself prove the bucket is private/public; bucket visibility and service-role upload behavior still need explicit verification.
- The targeted function-grant query confirmed SECURITY DEFINER functions in scope. private.is_admin() grants EXECUTE to authenticated; public.claim_customer_for_auth(), public.current_brand_id(), and public.is_brand_admin() also grant EXECUTE to authenticated (and service_role). Each function has search_path=public. Review the bodies and whether that search_path is sufficient for all referenced objects before making any changes.

## Risks to resolve before multi-company production use

1. **Public storefront visibility:** public SELECT policies may permit direct Supabase queries to list active products, variants, images and approved reviews across every brand, unless another enforced filter or separate project boundary limits them. Verify expected public storefront behavior before tightening anything.
2. **Admin row isolation:** confirm whether private.is_admin() is intentionally global-admin-only or brand-aware. As currently visible in policy expressions, it is not row-brand scoped. Tenant isolation cannot be assumed from an admin role check alone.
3. **Cross-brand relationships:** add database-enforced consistency for references such as order items → orders/products/variants, inventory → products/variants/warehouses, and images/variants → products, so mismatched brand IDs cannot be written even by a future server bug.
4. **Nullable tenant keys:** decide which tables must require non-null brand_id; backfill/validate before constraints, not in an unreviewed production change.
5. **Storage:** review the product-images bucket policies and object naming/ownership. Namespaced upload paths alone are not authorization controls.
6. **Role functions:** review execute grants and SECURITY DEFINER search paths for claim_customer_for_auth, current_brand_id, and is_brand_admin; verify least-privilege grants before modifying.
7. **Real tenant tests:** use a disposable database/project with two test companies, test direct anon/authenticated API access and server endpoints, attempt cross-brand parent IDs, and test Storage object access. A code grep or syntax check is not an isolation test.

## Recommended order

1. Preserve current storefront behavior with baseline tests.
2. Create a disposable test environment and seed two synthetic brands and admin users.
3. Write explicit expected-access tests for anonymous storefront access, brand A admin, brand B admin and customer users.
4. Design a reviewed migration with constraints/policies and a rollback plan.
5. Run tests on the disposable environment, then separately request approval before any production schema/policy change.

## Status

Audit only. Production database unchanged. This document is not a statement that production multi-tenant isolation has passed.