-- Cutdown: atomic stock reservation for both variant and product-level items.
-- Run this in Supabase SQL Editor before switching the application to these RPCs.

create or replace function public.reserve_stock_items(p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row jsonb;
  v_id uuid;
  p_id uuid;
  qty integer;
  current_stock integer;
begin
  for item_row in
    select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_id := nullif(item_row->>'variant_id', '')::uuid;
    p_id := nullif(item_row->>'product_id', '')::uuid;
    qty := greatest(1, (item_row->>'quantity')::integer);

    if v_id is not null then
      select stock
        into current_stock
        from product_variants
       where id = v_id
         and product_id = p_id
         and active = true
       for update;

      if not found or current_stock < qty then
        raise exception 'INSUFFICIENT_VARIANT_STOCK:%', v_id using errcode = 'P0001';
      end if;

      update product_variants
         set stock = stock - qty, updated_at = now()
       where id = v_id;

    elsif p_id is not null then
      select stock
        into current_stock
        from products
       where id = p_id
         and active = true
       for update;

      if not found or current_stock < qty then
        raise exception 'INSUFFICIENT_PRODUCT_STOCK:%', p_id using errcode = 'P0001';
      end if;

      update products
         set stock = stock - qty
       where id = p_id;

    else
      raise exception 'INVALID_STOCK_ITEM' using errcode = 'P0001';
    end if;
  end loop;
end;
$$;

create or replace function public.release_stock_items(p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item_row jsonb;
  v_id uuid;
  p_id uuid;
  qty integer;
begin
  for item_row in
    select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_id := nullif(item_row->>'variant_id', '')::uuid;
    p_id := nullif(item_row->>'product_id', '')::uuid;
    qty := greatest(1, (item_row->>'quantity')::integer);

    if v_id is not null then
      update product_variants
         set stock = stock + qty, updated_at = now()
       where id = v_id;
    elsif p_id is not null then
      update products
         set stock = stock + qty
       where id = p_id;
    end if;
  end loop;
end;
$$;

revoke all on function public.reserve_stock_items(jsonb) from public, anon, authenticated;
revoke all on function public.release_stock_items(jsonb) from public, anon, authenticated;
