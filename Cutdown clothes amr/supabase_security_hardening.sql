-- Cutdown security hardening: privileged RPC execution and tenant-safe customer claiming
-- Apply after supabase_multi_brand_hardening.sql.

-- These functions mutate tenant data and must never be callable directly by anon/authenticated clients.
revoke execute on function public.process_whole_order_return(uuid,text,text,numeric,numeric) from public, anon, authenticated;
revoke execute on function public.reserve_variant_stock(jsonb) from public, anon, authenticated;
revoke execute on function public.release_variant_stock(jsonb) from public, anon, authenticated;

-- Customer claiming must stay inside the authenticated user's configured brand.
create or replace function public.claim_customer_for_auth()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  cid uuid;
  v_brand uuid;
  v_email text;
begin
  select brand_id into v_brand
  from public.profiles
  where id=(select auth.uid())
  limit 1;

  if v_brand is null then
    return null;
  end if;

  select email into v_email
  from auth.users
  where id=(select auth.uid());

  select id into cid
  from public.customers
  where auth_user_id=(select auth.uid())
    and brand_id=v_brand
  limit 1;

  if cid is not null then
    return cid;
  end if;

  update public.customers
  set auth_user_id=(select auth.uid()), updated_at=now()
  where id=(
    select id
    from public.customers
    where auth_user_id is null
      and brand_id=v_brand
      and email is not null
      and v_email is not null
      and lower(email)=lower(v_email)
    order by created_at
    limit 1
  )
  returning id into cid;

  return cid;
end;
$$;

revoke all on function public.claim_customer_for_auth() from public, anon;
grant execute on function public.claim_customer_for_auth() to authenticated;
