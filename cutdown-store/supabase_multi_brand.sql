-- Cutdown Multi-Brand + Auth foundation
-- Apply this migration to production Supabase before enabling multi-brand enforcement.

create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  active boolean not null default true,
  website_url text,
  desktop_update_channel text not null default 'stable',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.brands(id,name,slug,active)
values('00000000-0000-4000-8000-000000000001','Cutdown Default','cutdown-default',true)
on conflict (id) do nothing;

alter table public.profiles add column if not exists brand_id uuid references public.brands(id) on delete restrict;
update public.profiles set brand_id='00000000-0000-4000-8000-000000000001' where brand_id is null;
create index if not exists ix_profiles_brand on public.profiles(brand_id);

alter table public.products add column if not exists brand_id uuid references public.brands(id) on delete restrict;
alter table public.product_variants add column if not exists brand_id uuid references public.brands(id) on delete restrict;
alter table public.product_images add column if not exists brand_id uuid references public.brands(id) on delete restrict;
alter table public.warehouses add column if not exists brand_id uuid references public.brands(id) on delete restrict;
alter table public.inventory add column if not exists brand_id uuid references public.brands(id) on delete restrict;
alter table public.customers add column if not exists brand_id uuid references public.brands(id) on delete restrict;
alter table public.orders add column if not exists brand_id uuid references public.brands(id) on delete restrict;
alter table public.order_items add column if not exists brand_id uuid references public.brands(id) on delete restrict;
alter table public.returns add column if not exists brand_id uuid references public.brands(id) on delete restrict;
alter table public.reviews add column if not exists brand_id uuid references public.brands(id) on delete restrict;

update public.products set brand_id='00000000-0000-4000-8000-000000000001' where brand_id is null;
update public.product_variants set brand_id='00000000-0000-4000-8000-000000000001' where brand_id is null;
update public.product_images set brand_id='00000000-0000-4000-8000-000000000001' where brand_id is null;
update public.warehouses set brand_id='00000000-0000-4000-8000-000000000001' where brand_id is null;
update public.inventory set brand_id='00000000-0000-4000-8000-000000000001' where brand_id is null;
update public.customers set brand_id='00000000-0000-4000-8000-000000000001' where brand_id is null;
update public.orders set brand_id='00000000-0000-4000-8000-000000000001' where brand_id is null;
update public.order_items set brand_id='00000000-0000-4000-8000-000000000001' where brand_id is null;
update public.returns set brand_id='00000000-0000-4000-8000-000000000001' where brand_id is null;
update public.reviews set brand_id='00000000-0000-4000-8000-000000000001' where brand_id is null;

create index if not exists ix_products_brand on public.products(brand_id);
create index if not exists ix_variants_brand on public.product_variants(brand_id);
create index if not exists ix_images_brand on public.product_images(brand_id);
create index if not exists ix_warehouses_brand on public.warehouses(brand_id);
create index if not exists ix_inventory_brand on public.inventory(brand_id);
create index if not exists ix_customers_brand on public.customers(brand_id);
create index if not exists ix_orders_brand on public.orders(brand_id);
create index if not exists ix_order_items_brand on public.order_items(brand_id);
create index if not exists ix_returns_brand on public.returns(brand_id);
create index if not exists ix_reviews_brand on public.reviews(brand_id);

alter table public.brands enable row level security;
drop policy if exists "authenticated can read own brand" on public.brands;
create policy "authenticated can read own brand" on public.brands
for select to authenticated
using (id=(select brand_id from public.profiles where id=(select auth.uid())));

drop policy if exists "profiles own brand" on public.profiles;
create policy "profiles own brand" on public.profiles
for select to authenticated
using ((select auth.uid())=id);

create or replace function public.current_brand_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select brand_id from public.profiles where id=(select auth.uid()) limit 1
$$;
revoke all on function public.current_brand_id() from public, anon;
grant execute on function public.current_brand_id() to authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id,name,phone,brand_id)
  values(
    new.id,
    new.raw_user_meta_data->>'name',
    new.raw_user_meta_data->>'phone',
    nullif(new.raw_user_meta_data->>'brand_id','')::uuid
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Existing server-side inserts that omit brand_id remain on the default brand.
create or replace function public.set_brand_defaults()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.brand_id is null then
    new.brand_id := '00000000-0000-4000-8000-000000000001';
  end if;
  return new;
end;
$$;
revoke all on function public.set_brand_defaults() from public, anon, authenticated;

drop trigger if exists trg_products_brand_default on public.products;
create trigger trg_products_brand_default before insert on public.products for each row execute function public.set_brand_defaults();
drop trigger if exists trg_variants_brand_default on public.product_variants;
create trigger trg_variants_brand_default before insert on public.product_variants for each row execute function public.set_brand_defaults();
drop trigger if exists trg_images_brand_default on public.product_images;
create trigger trg_images_brand_default before insert on public.product_images for each row execute function public.set_brand_defaults();
drop trigger if exists trg_warehouses_brand_default on public.warehouses;
create trigger trg_warehouses_brand_default before insert on public.warehouses for each row execute function public.set_brand_defaults();
drop trigger if exists trg_inventory_brand_default on public.inventory;
create trigger trg_inventory_brand_default before insert on public.inventory for each row execute function public.set_brand_defaults();
drop trigger if exists trg_customers_brand_default on public.customers;
create trigger trg_customers_brand_default before insert on public.customers for each row execute function public.set_brand_defaults();
drop trigger if exists trg_orders_brand_default on public.orders;
create trigger trg_orders_brand_default before insert on public.orders for each row execute function public.set_brand_defaults();
drop trigger if exists trg_order_items_brand_default on public.order_items;
create trigger trg_order_items_brand_default before insert on public.order_items for each row execute function public.set_brand_defaults();
drop trigger if exists trg_returns_brand_default on public.returns;
create trigger trg_returns_brand_default before insert on public.returns for each row execute function public.set_brand_defaults();
drop trigger if exists trg_reviews_brand_default on public.reviews;
create trigger trg_reviews_brand_default before insert on public.reviews for each row execute function public.set_brand_defaults();

create or replace function public.is_brand_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists(
    select 1 from public.profiles
    where id=(select auth.uid()) and role='admin' and brand_id is not null
  )
$$;
revoke all on function public.is_brand_admin() from public, anon;
grant execute on function public.is_brand_admin() to authenticated;

-- The application server is the only data API for tenant data.
-- Public browser clients use Supabase Auth only; they do not query tenant tables directly.
revoke all on table public.products from anon, authenticated;
revoke all on table public.product_variants from anon, authenticated;
revoke all on table public.product_images from anon, authenticated;
revoke all on table public.warehouses from anon, authenticated;
revoke all on table public.inventory from anon, authenticated;
revoke all on table public.customers from anon, authenticated;
revoke all on table public.orders from anon, authenticated;
revoke all on table public.order_items from anon, authenticated;
revoke all on table public.returns from anon, authenticated;
revoke all on table public.reviews from anon, authenticated;

-- Keep legacy customer auto-linking inside the user's brand.
create or replace function public.link_customer_to_auth_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare v_brand uuid;
begin
  v_brand := nullif(new.raw_user_meta_data->>'brand_id','')::uuid;
  if new.email is not null then
    update public.customers
    set auth_user_id=new.id, updated_at=now()
    where auth_user_id is null
      and (v_brand is null or brand_id=v_brand)
      and lower(email)=lower(new.email);
  end if;
  return new;
end;
$$;
revoke all on function public.link_customer_to_auth_user() from public, anon, authenticated;
