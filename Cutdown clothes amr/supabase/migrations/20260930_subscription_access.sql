-- BPC Clothes System subscription access
-- Additive migration: preserves all existing business data.
create table if not exists public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  duration_days integer not null check (duration_days in (30,90,365)),
  price numeric(12,2) not null default 0 check (price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.brands(id) on delete restrict,
  auth_user_id uuid references auth.users(id) on delete set null,
  plan_id uuid not null references public.subscription_plans(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','active','expired','cancelled')),
  starts_at timestamptz,
  expires_at timestamptz,
  activation_code_hash text unique,
  activation_expires_at timestamptz,
  customer_name text,
  customer_email text,
  payment_method text not null default 'manual' check (payment_method in ('manual','online')),
  payment_reference text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_renewed_at timestamptz
);

create table if not exists public.subscription_payments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  amount numeric(12,2) not null default 0 check (amount >= 0),
  payment_method text not null check (payment_method in ('manual','online')),
  reference text,
  notes text,
  paid_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists ix_subscriptions_brand on public.subscriptions(brand_id);
create index if not exists ix_subscriptions_user on public.subscriptions(auth_user_id);
create index if not exists ix_subscriptions_expiry on public.subscriptions(expires_at);
create index if not exists ix_subscription_payments_subscription on public.subscription_payments(subscription_id);

insert into public.subscription_plans(code,name,duration_days,price,active)
values
  ('monthly','Monthly',30,0,true),
  ('quarterly','3 Months',90,0,true),
  ('yearly','1 Year',365,0,true)
on conflict(code) do update set name=excluded.name,duration_days=excluded.duration_days;

alter table public.subscription_plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.subscription_payments enable row level security;

revoke all on table public.subscription_plans from anon, authenticated;
revoke all on table public.subscriptions from anon, authenticated;
revoke all on table public.subscription_payments from anon, authenticated;

-- Only the trusted application server uses these tables.
-- No client-side role gets direct access to subscription records or activation codes.
