-- Cutdown shared Supabase schema
-- Phase 1: canonical shared data model for Website + Java Swing Desktop.
-- Safe to run after supabase.sql and supabase_payment_events.sql.
-- Existing columns are preserved for compatibility; desktop_* columns are
-- stable mapping keys while the migration is in progress.

create extension if not exists pgcrypto;

-- =========================================================
-- PRODUCTS
-- =========================================================
alter table products add column if not exists desktop_id text;
alter table products add column if not exists sku text;
alter table products add column if not exists cost_price numeric(10,2) not null default 0;
alter table products add column if not exists minimum_stock integer not null default 0;
alter table products add column if not exists is_active boolean not null default true;
alter table products add column if not exists updated_at timestamptz not null default now();

create unique index if not exists ux_products_desktop_id
    on products(desktop_id) where desktop_id is not null;

create index if not exists ix_products_active_created
    on products(active, created_at desc);

-- =========================================================
-- PRODUCT VARIANTS
-- =========================================================
create table if not exists product_variants (
    id uuid primary key default gen_random_uuid(),
    desktop_variant_id text unique,
    product_id uuid not null references products(id) on delete cascade,
    sku text,
    size text,
    color text,
    stock integer not null default 0 check (stock >= 0),
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(product_id, size, color)
);

create index if not exists ix_product_variants_product
    on product_variants(product_id);

-- =========================================================
-- PRODUCT IMAGES / SUPABASE STORAGE
-- =========================================================
create table if not exists product_images (
    id uuid primary key default gen_random_uuid(),
    product_id uuid not null references products(id) on delete cascade,
    storage_path text not null,
    public_url text,
    alt_text text default '',
    sort_order integer not null default 0,
    is_primary boolean not null default false,
    color text,
    created_at timestamptz not null default now()
);
alter table product_images add column if not exists color text;
create index if not exists ix_product_images_product_color on product_images(product_id,color,sort_order);

create index if not exists ix_product_images_product
    on product_images(product_id, sort_order);

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- =========================================================
-- WAREHOUSES + INVENTORY
-- =========================================================
create table if not exists warehouses (
    id uuid primary key default gen_random_uuid(),
    desktop_id text unique,
    name text not null,
    location text default '',
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists inventory (
    id uuid primary key default gen_random_uuid(),
    product_id uuid not null references products(id) on delete cascade,
    variant_id uuid references product_variants(id) on delete cascade,
    warehouse_id uuid not null references warehouses(id) on delete cascade,
    quantity integer not null default 0 check (quantity >= 0),
    updated_at timestamptz not null default now(),
    unique(product_id, variant_id, warehouse_id)
);

create index if not exists ix_inventory_product
    on inventory(product_id);

create index if not exists ix_inventory_variant
    on inventory(variant_id);

create index if not exists ix_inventory_warehouse
    on inventory(warehouse_id);

-- =========================================================
-- CUSTOMERS / WEBSITE ACCOUNTS
-- =========================================================
create table if not exists customers (
    id uuid primary key default gen_random_uuid(),
    auth_user_id uuid unique references auth.users(id) on delete set null,
    desktop_id text unique,
    name text not null,
    email text,
    phone text,
    additional_phone text,
    city text,
    address text,
    total_orders integer not null default 0,
    total_spent numeric(12,2) not null default 0,
    last_order_at timestamptz,
    status text not null default 'Active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists ux_customers_phone
    on customers(phone) where phone is not null and phone <> '';

create index if not exists ix_customers_auth_user
    on customers(auth_user_id);

-- =========================================================
-- ORDERS
-- =========================================================
alter table orders add column if not exists desktop_id text;
alter table orders add column if not exists customer_id uuid references customers(id) on delete set null;
alter table orders add column if not exists source text not null default 'website';
alter table orders add column if not exists shipping_amount numeric(10,2) not null default 0;
alter table orders add column if not exists updated_at timestamptz not null default now();

create unique index if not exists ux_orders_desktop_id
    on orders(desktop_id) where desktop_id is not null;

create index if not exists ix_orders_customer
    on orders(customer_id);

create index if not exists ix_orders_created
    on orders(created_at desc);

-- =========================================================
-- ORDER ITEMS
-- =========================================================
alter table order_items add column if not exists variant_id uuid references product_variants(id) on delete set null;
alter table order_items add column if not exists desktop_id text;

create unique index if not exists ux_order_items_desktop_id
    on order_items(desktop_id) where desktop_id is not null;

create index if not exists ix_order_items_variant
    on order_items(variant_id);

-- =========================================================
-- RETURNS — WHOLE ORDER ONLY
-- =========================================================
create table if not exists returns (
    id uuid primary key default gen_random_uuid(),
    desktop_id text unique,
    order_id uuid references orders(id) on delete set null,
    customer_id uuid references customers(id) on delete set null,
    return_type text not null default 'whole_order'
        check (return_type = 'whole_order'),
    reason text,
    disposition text not null
        check (disposition in ('Return to Stock', 'Scrap / Damaged')),
    refund_amount numeric(12,2) not null default 0,
    loss numeric(12,2) not null default 0,
    created_at timestamptz not null default now(),
    processed_at timestamptz,
    notes text
);

create index if not exists ix_returns_order
    on returns(order_id);

-- =========================================================
-- UPDATED_AT HELPER
-- =========================================================
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_products_updated_at on products;
create trigger trg_products_updated_at
before update on products
for each row execute function set_updated_at();

drop trigger if exists trg_product_variants_updated_at on product_variants;
create trigger trg_product_variants_updated_at
before update on product_variants
for each row execute function set_updated_at();

drop trigger if exists trg_warehouses_updated_at on warehouses;
create trigger trg_warehouses_updated_at
before update on warehouses
for each row execute function set_updated_at();

drop trigger if exists trg_inventory_updated_at on inventory;
create trigger trg_inventory_updated_at
before update on inventory
for each row execute function set_updated_at();

drop trigger if exists trg_customers_updated_at on customers;
create trigger trg_customers_updated_at
before update on customers
for each row execute function set_updated_at();

drop trigger if exists trg_orders_updated_at on orders;
create trigger trg_orders_updated_at
before update on orders
for each row execute function set_updated_at();

-- =========================================================
-- STOCK-SAFE WHOLE-ORDER RETURN
-- =========================================================
-- This function is intentionally narrow: it is for the new whole-order
-- return workflow only. Detailed integration code will call it after the
-- desktop/API layer is connected.
create or replace function restore_whole_order_stock(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    item_row record;
begin
    for item_row in
        select oi.product_id, oi.variant_id, oi.quantity
        from order_items oi
        where oi.order_id = p_order_id
    loop
        if item_row.variant_id is not null then
            update product_variants
            set stock = stock + item_row.quantity,
                updated_at = now()
            where id = item_row.variant_id;

            update inventory
            set quantity = quantity + item_row.quantity,
                updated_at = now()
            where variant_id = item_row.variant_id;
        else
            update products
            set stock = stock + item_row.quantity,
                updated_at = now()
            where id = item_row.product_id;
        end if;
    end loop;
end;
$$;

-- =========================================================
-- RLS
-- =========================================================
alter table product_variants enable row level security;
alter table product_images enable row level security;
alter table warehouses enable row level security;
alter table inventory enable row level security;
alter table customers enable row level security;
alter table returns enable row level security;

-- Public storefront reads only active catalog data.
drop policy if exists "public read active product variants" on product_variants;
create policy "public read active product variants"
on product_variants for select
using (
    active = true
    and exists (
        select 1 from products p
        where p.id = product_variants.product_id
          and p.active = true
          and p.is_active = true
    )
);

drop policy if exists "public read product images" on product_images;
create policy "public read product images"
on product_images for select
using (
    exists (
        select 1 from products p
        where p.id = product_images.product_id
          and p.active = true
          and p.is_active = true
    )
);

-- Customers can only read/update their own website profile.
drop policy if exists "customer read own profile" on customers;
create policy "customer read own profile"
on customers for select
to authenticated
using (auth_user_id = auth.uid());

drop policy if exists "customer update own profile" on customers;
create policy "customer update own profile"
on customers for update
to authenticated
using (auth_user_id = auth.uid())
with check (auth_user_id = auth.uid());

-- Customer order visibility will be added with the authenticated website
-- account flow. Desktop/admin access is intentionally not granted through
-- the public anon key; it will go through the protected server/API layer.

-- =========================================================
-- MIGRATION SAFETY NOTES
-- =========================================================
-- 1. Do not delete the existing products.stock/active columns yet.
-- 2. Do not drop SQLite or old website columns until the migration tests pass.
-- 3. desktop_id is the stable bridge for existing Java Swing records.
-- 4. Website IDs remain UUIDs; desktop IDs remain PRD-/ORD-/RET- style.
-- 5. Service-role credentials stay server-side only.


-- =========================================================
-- WEBSITE ACCOUNT / ORDER LINKING (next integration step)
-- =========================================================
-- A customer account is represented by Supabase Auth + one profile row.
-- Orders may be created by a signed-in customer or by guest checkout.
create index if not exists ix_orders_customer_created
    on orders(customer_id, created_at desc)
    where customer_id is not null;

-- A product is considered sold out from inventory, while active=false is
-- reserved for deliberately hidden products. This keeps "SOLD OUT" visible
-- on the storefront instead of silently hiding an exhausted product.
create or replace function product_is_sold_out(p_product_id uuid)
returns boolean
language sql
stable
as $$
    select coalesce((
        select stock <= 0 from products where id = p_product_id
    ), true);
$$;
