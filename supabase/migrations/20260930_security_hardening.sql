-- BPC / Cutdown Clothes
-- Security hardening for the web migration branch.
-- IMPORTANT: this file is intentionally NOT executed against production by CI.
-- Apply only after the isolated tenant test environment passes.

begin;

-- claim_customer_for_auth() is called by the server with the service role.
-- It performs a write, so normal signed-in users should not be able to invoke it
-- through /rest/v1/rpc.
revoke execute on function public.claim_customer_for_auth() from public, anon, authenticated;
grant execute on function public.claim_customer_for_auth() to service_role;

-- Prevent cross-brand references at the database layer.
-- NOT VALID keeps the migration non-blocking for legacy rows; new writes are
-- still checked immediately. Existing legacy violations can be audited and
-- validated after reconciliation.
create unique index if not exists products_brand_id_id_uq
  on public.products (brand_id, id);
create unique index if not exists product_variants_brand_id_id_uq
  on public.product_variants (brand_id, id);
create unique index if not exists warehouses_brand_id_id_uq
  on public.warehouses (brand_id, id);
create unique index if not exists customers_brand_id_id_uq
  on public.customers (brand_id, id);
create unique index if not exists orders_brand_id_id_uq
  on public.orders (brand_id, id);

alter table public.product_variants
  drop constraint if exists product_variants_brand_product_fkey;
alter table public.product_variants
  add constraint product_variants_brand_product_fkey
  foreign key (brand_id, product_id)
  references public.products (brand_id, id)
  not valid;

alter table public.product_images
  drop constraint if exists product_images_brand_product_fkey;
alter table public.product_images
  add constraint product_images_brand_product_fkey
  foreign key (brand_id, product_id)
  references public.products (brand_id, id)
  not valid;

alter table public.inventory
  drop constraint if exists inventory_brand_product_fkey;
alter table public.inventory
  add constraint inventory_brand_product_fkey
  foreign key (brand_id, product_id)
  references public.products (brand_id, id)
  not valid;

alter table public.inventory
  drop constraint if exists inventory_brand_warehouse_fkey;
alter table public.inventory
  add constraint inventory_brand_warehouse_fkey
  foreign key (brand_id, warehouse_id)
  references public.warehouses (brand_id, id)
  not valid;

alter table public.inventory
  drop constraint if exists inventory_brand_variant_fkey;
alter table public.inventory
  add constraint inventory_brand_variant_fkey
  foreign key (brand_id, variant_id)
  references public.product_variants (brand_id, id)
  not valid;

alter table public.order_items
  drop constraint if exists order_items_brand_product_fkey;
alter table public.order_items
  add constraint order_items_brand_product_fkey
  foreign key (brand_id, product_id)
  references public.products (brand_id, id)
  not valid;

alter table public.order_items
  drop constraint if exists order_items_brand_variant_fkey;
alter table public.order_items
  add constraint order_items_brand_variant_fkey
  foreign key (brand_id, variant_id)
  references public.product_variants (brand_id, id)
  not valid;

alter table public.orders
  drop constraint if exists orders_brand_customer_fkey;
alter table public.orders
  add constraint orders_brand_customer_fkey
  foreign key (brand_id, customer_id)
  references public.customers (brand_id, id)
  not valid;

alter table public.returns
  drop constraint if exists returns_brand_order_fkey;
alter table public.returns
  add constraint returns_brand_order_fkey
  foreign key (brand_id, order_id)
  references public.orders (brand_id, id)
  not valid;

alter table public.returns
  drop constraint if exists returns_brand_customer_fkey;
alter table public.returns
  add constraint returns_brand_customer_fkey
  foreign key (brand_id, customer_id)
  references public.customers (brand_id, id)
  not valid;

commit;

-- After the isolated migration test and legacy-data audit, validate each
-- NOT VALID constraint. Validation is intentionally a separate step so any
-- existing cross-brand legacy rows are surfaced before production enforcement.
