create or replace function public.sync_desktop_product_atomic(
  p_product jsonb, p_variants jsonb, p_images jsonb, p_warehouse_id uuid
)
returns jsonb language plpgsql security definer set search_path = public
as $function$
declare
  v_brand_id uuid; v_desktop_id text; v_product_id uuid; v_variant_id uuid; v_inventory_id uuid;
  v_stock integer; v_has_variants boolean; v_old_paths text[] := array[]::text[]; v_image jsonb; v_variant record; v_slug text;
begin
  if p_product is null or jsonb_typeof(p_product) <> 'object' then raise exception 'INVALID_PRODUCT_PAYLOAD'; end if;
  v_brand_id := nullif(p_product->>'brand_id','')::uuid;
  v_desktop_id := nullif(trim(p_product->>'desktop_id'),'');
  if v_brand_id is null or v_desktop_id is null then raise exception 'INVALID_PRODUCT_IDENTITY'; end if;
  if p_variants is null or jsonb_typeof(p_variants) <> 'array' then raise exception 'INVALID_VARIANTS_PAYLOAD'; end if;
  if p_images is not null and jsonb_typeof(p_images) <> 'array' then raise exception 'INVALID_IMAGES_PAYLOAD'; end if;
  if not exists(select 1 from public.warehouses where id=p_warehouse_id and brand_id=v_brand_id and active=true) then raise exception 'INVALID_SYNC_WAREHOUSE'; end if;
  select id into v_product_id from public.products where brand_id=v_brand_id and desktop_id=v_desktop_id;
  if p_images is not null and v_product_id is not null then
    select coalesce(array_agg(storage_path),array[]::text[]) into v_old_paths from public.product_images where brand_id=v_brand_id and product_id=v_product_id and storage_path is not null;
  end if;
  v_slug := trim(both '-' from regexp_replace(lower(coalesce(p_product->>'name','product')||'-'||v_desktop_id||'-'||v_brand_id::text),'[^a-z0-9]+','-','g'));
  insert into public.products (brand_id,desktop_id,slug,sku,name,category,description,image_url,price,cost_price,stock,minimum_stock,active,is_active)
  values (v_brand_id,v_desktop_id,v_slug,coalesce(p_product->>'sku',''),coalesce(p_product->>'name',''),coalesce(p_product->>'category',''),coalesce(p_product->>'description',''),coalesce(p_product->>'image_url',''),coalesce((p_product->>'price')::numeric,0),coalesce((p_product->>'cost_price')::numeric,0),coalesce((p_product->>'stock')::integer,0),coalesce((p_product->>'minimum_stock')::integer,0),coalesce((p_product->>'active')::boolean,true),coalesce((p_product->>'is_active')::boolean,true))
  on conflict (brand_id,desktop_id) do update set slug=excluded.slug,sku=excluded.sku,name=excluded.name,category=excluded.category,description=excluded.description,image_url=case when excluded.image_url<>'' then excluded.image_url else products.image_url end,price=excluded.price,cost_price=excluded.cost_price,stock=excluded.stock,minimum_stock=excluded.minimum_stock,active=excluded.active,is_active=excluded.is_active,updated_at=now()
  returning id into v_product_id;
  v_has_variants := jsonb_array_length(p_variants)>0;
  if v_has_variants then
    insert into public.product_variants (brand_id,desktop_variant_id,product_id,sku,size,color,stock,active)
    select v_brand_id,v.desktop_variant_id,v_product_id,coalesce(v.sku,''),coalesce(v.size,''),coalesce(v.color,''),coalesce(v.stock,0),coalesce(v.active,true)
    from jsonb_to_recordset(p_variants) as v(desktop_variant_id text,sku text,size text,color text,stock integer,active boolean)
    where nullif(trim(v.desktop_variant_id),'') is not null
    on conflict (brand_id,desktop_variant_id) do update set product_id=excluded.product_id,sku=excluded.sku,size=excluded.size,color=excluded.color,stock=excluded.stock,active=excluded.active,updated_at=now();
    delete from public.inventory i using public.product_variants v where i.variant_id=v.id and i.brand_id=v_brand_id and v.brand_id=v_brand_id and v.product_id=v_product_id and v.desktop_variant_id is not null and not exists (select 1 from jsonb_to_recordset(p_variants) as incoming(desktop_variant_id text) where incoming.desktop_variant_id=v.desktop_variant_id);
    delete from public.product_variants v where v.brand_id=v_brand_id and v.product_id=v_product_id and v.desktop_variant_id is not null and not exists (select 1 from jsonb_to_recordset(p_variants) as incoming(desktop_variant_id text) where incoming.desktop_variant_id=v.desktop_variant_id);
  else
    delete from public.inventory where brand_id=v_brand_id and product_id=v_product_id and variant_id is not null;
    delete from public.product_variants where brand_id=v_brand_id and product_id=v_product_id;
  end if;
  v_stock := case when v_has_variants then 0 else coalesce((p_product->>'stock')::integer,0) end;
  select id into v_inventory_id from public.inventory where brand_id=v_brand_id and product_id=v_product_id and warehouse_id=p_warehouse_id and variant_id is null order by updated_at desc nulls last limit 1;
  if v_inventory_id is null then insert into public.inventory (brand_id,product_id,warehouse_id,variant_id,quantity) values (v_brand_id,v_product_id,p_warehouse_id,null,v_stock);
  else update public.inventory set quantity=v_stock,updated_at=now() where id=v_inventory_id; end if;
  if v_has_variants then
    for v_variant in select desktop_variant_id,stock from jsonb_to_recordset(p_variants) as x(desktop_variant_id text,stock integer) loop
      select id into v_variant_id from public.product_variants where brand_id=v_brand_id and desktop_variant_id=v_variant.desktop_variant_id;
      select id into v_inventory_id from public.inventory where brand_id=v_brand_id and product_id=v_product_id and warehouse_id=p_warehouse_id and variant_id=v_variant_id order by updated_at desc nulls last limit 1;
      if v_inventory_id is null then insert into public.inventory (brand_id,product_id,warehouse_id,variant_id,quantity) values (v_brand_id,v_product_id,p_warehouse_id,v_variant_id,coalesce(v_variant.stock,0));
      else update public.inventory set quantity=coalesce(v_variant.stock,0),updated_at=now() where id=v_inventory_id; end if;
      v_inventory_id := null; v_variant_id := null;
    end loop;
  end if;
  if p_images is not null then
    delete from public.product_images where brand_id=v_brand_id and product_id=v_product_id;
    for v_image in select value from jsonb_array_elements(p_images) loop
      insert into public.product_images (brand_id,product_id,storage_path,public_url,alt_text,sort_order,is_primary,color)
      values (v_brand_id,v_product_id,v_image->>'storage_path',v_image->>'public_url',coalesce(v_image->>'alt_text',p_product->>'name'),coalesce((v_image->>'sort_order')::integer,0),coalesce((v_image->>'is_primary')::boolean,false),coalesce(v_image->>'color',''));
    end loop;
    update public.products set image_url=coalesce((select public_url from public.product_images where brand_id=v_brand_id and product_id=v_product_id order by is_primary desc,sort_order asc limit 1),nullif(p_product->>'image_url',''),''),updated_at=now() where id=v_product_id and brand_id=v_brand_id;
  end if;
  return jsonb_build_object('product_id',v_product_id,'old_storage_paths',to_jsonb(v_old_paths));
end;
$function$;
revoke execute on function public.sync_desktop_product_atomic(jsonb,jsonb,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.sync_desktop_product_atomic(jsonb,jsonb,jsonb,uuid) to service_role;