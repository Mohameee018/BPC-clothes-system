create table if not exists payment_events (
 id uuid primary key default gen_random_uuid(),
 provider_event_id text unique not null,
 order_id uuid not null references orders(id) on delete cascade,
 success boolean not null default false,
 payload jsonb not null,
 created_at timestamptz not null default now()
);
alter table payment_events enable row level security;