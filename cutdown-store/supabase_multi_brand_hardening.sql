-- Cutdown multi-brand hardening
-- Run after supabase_multi_brand.sql.

-- Tenant-local desktop IDs: the same local ID may exist in different brands.
drop index if exists public.ux_products_desktop_id;
create unique index if not exists ux_products_brand_desktop_id
  on public.products(brand_id, desktop_id)
  where desktop_id is not null;

alter table public.product_variants
  drop constraint if exists product_variants_desktop_variant_id_key;
create unique index if not exists ux_variants_brand_desktop_id
  on public.product_variants(brand_id, desktop_variant_id)
  where desktop_variant_id is not null;

alter table public.warehouses
  drop constraint if exists warehouses_desktop_id_key;
create unique index if not exists ux_warehouses_brand_desktop_id
  on public.warehouses(brand_id, desktop_id)
  where desktop_id is not null;

drop index if exists public.ux_customers_phone;
create unique index if not exists ux_customers_brand_phone
  on public.customers(brand_id, phone)
  where phone is not null and phone <> '';

alter table public.customers
  drop constraint if exists customers_desktop_id_key;
create unique index if not exists ux_customers_brand_desktop_id
  on public.customers(brand_id, desktop_id)
  where desktop_id is not null;

drop index if exists public.ux_orders_desktop_id;
create unique index if not exists ux_orders_brand_desktop_id
  on public.orders(brand_id, desktop_id)
  where desktop_id is not null;

drop index if exists public.ux_order_items_desktop_id;
create unique index if not exists ux_order_items_brand_desktop_id
  on public.order_items(brand_id, desktop_id)
  where desktop_id is not null;

-- Order items inherit the tenant from their parent order if a caller omits it.
create or replace function public.set_order_item_brand_default()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.brand_id is null and new.order_id is not null then
    select brand_id into new.brand_id from public.orders where id = new.order_id;
  end if;
  if new.brand_id is null then
    new.brand_id := '00000000-0000-4000-8000-000000000001';
  end if;
  return new;
end;
$$;
revoke all on function public.set_order_item_brand_default() from public, anon, authenticated;

drop trigger if exists trg_order_items_brand_default on public.order_items;
create trigger trg_order_items_brand_default
before insert on public.order_items
for each row execute function public.set_order_item_brand_default();

-- User-editable raw_user_meta_data must never decide tenant authorization.
-- The server assigns the brand after Auth user creation.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles(id,name,phone,brand_id)
  values(new.id,new.raw_user_meta_data->>'name',new.raw_user_meta_data->>'phone',null)
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_link_customer on auth.users;

-- Never link a customer to a brand using user-editable metadata.
create or replace function public.link_customer_to_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Customer linking is performed by the trusted application server,
  -- which knows the current website's configured brand.
  return new;
end;
$$;
revoke all on function public.link_customer_to_auth_user() from public, anon, authenticated;
