create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  desktop_id text,
  amount numeric(12,2) not null default 0 check (amount >= 0),
  category text not null default 'General',
  description text not null default '',
  payment_method text not null default 'cash',
  status text not null default 'paid',
  expense_date date not null default current_date,
  brand_id uuid not null references public.brands(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists expenses_brand_date_idx
  on public.expenses (brand_id, expense_date desc);

create index if not exists expenses_brand_created_idx
  on public.expenses (brand_id, created_at desc);

alter table public.expenses enable row level security;

revoke all on table public.expenses from anon, authenticated;
grant all on table public.expenses to service_role;

drop policy if exists expenses_deny_client_access on public.expenses;
create policy expenses_deny_client_access
  on public.expenses
  for all
  to anon, authenticated
  using (false)
  with check (false);
