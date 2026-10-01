begin;
alter table public.orders add column if not exists client_request_id text;
create unique index if not exists orders_brand_client_request_id_unique on public.orders (brand_id, client_request_id) where client_request_id is not null;
commit;