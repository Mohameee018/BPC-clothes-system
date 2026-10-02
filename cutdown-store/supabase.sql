create extension if not exists pgcrypto;
create table if not exists products (id uuid primary key default gen_random_uuid(),name text not null,slug text unique not null,description text default '',price numeric(10,2) not null default 0,image_url text,category text default 'unisex',stock integer not null default 0,active boolean not null default true,created_at timestamptz not null default now());
create table if not exists orders (id uuid primary key default gen_random_uuid(),customer_name text not null,customer_phone text not null,customer_email text,city text,address text not null,notes text,payment_method text not null check(payment_method in ('cod','online')),payment_status text not null default 'pending',order_status text not null default 'pending',total_amount numeric(10,2) not null,created_at timestamptz not null default now());
create table if not exists order_items (id uuid primary key default gen_random_uuid(),order_id uuid not null references orders(id) on delete cascade,product_id uuid references products(id),product_name text not null,quantity integer not null check(quantity>0),unit_price numeric(10,2) not null,size text,color text);
create table if not exists reviews (id uuid primary key default gen_random_uuid(),name text not null,rating integer not null check(rating between 1 and 5),body text not null,approved boolean not null default true,created_at timestamptz not null default now());
alter table products enable row level security;
alter table reviews enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
create policy "public read active products" on products for select using (active=true);
create policy "public read approved reviews" on reviews for select using (approved=true);
insert into products(name,slug,description,price,image_url,stock) values
('CUTDOWN TEE 01','cutdown-tee-01','Placeholder product — replace with real product data.',0,'assets/t shirt cutdown.jpeg',0),
('CUTDOWN TEE 02','cutdown-tee-02','Placeholder product — replace with real product data.',0,'assets/t shirt cutdown.jpeg',0),
('CUTDOWN TEE 03','cutdown-tee-03','Placeholder product — replace with real product data.',0,'assets/t shirt cutdown.jpeg',0),
('CUTDOWN TEE 04','cutdown-tee-04','Placeholder product — replace with real product data.',0,'assets/t shirt cutdown.jpeg',0),
('CUTDOWN TEE 05','cutdown-tee-05','Placeholder product — replace with real product data.',0,'assets/t shirt cutdown.jpeg',0)
on conflict(slug) do nothing;