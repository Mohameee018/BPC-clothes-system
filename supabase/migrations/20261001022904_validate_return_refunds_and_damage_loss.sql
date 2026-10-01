create or replace function public.process_whole_order_return(p_order_id uuid,p_reason text,p_disposition text,p_refund_amount numeric,p_loss numeric)
returns boolean language plpgsql security definer set search_path = public as $function$
declare
  order_row record;
  stock_items jsonb;
  max_loss numeric;
  normalized_reason text := lower(trim(coalesce(p_reason,'')));
begin
  select id,customer_id,source,order_status,payment_status,stock_reserved,total_amount into order_row
    from orders where id=p_order_id and source='website' for update;
  if not found then raise exception 'WEBSITE_ORDER_NOT_FOUND'; end if;
  if not (coalesce(order_row.order_status,'') in ('confirmed','Completed') or coalesce(order_row.payment_status,'')='paid') then raise exception 'ORDER_NOT_CONFIRMED'; end if;
  if not coalesce(order_row.stock_reserved,false) then raise exception 'ORDER_STOCK_NOT_RESERVED'; end if;
  if exists(select 1 from returns where order_id=p_order_id) then return false; end if;
  if p_disposition not in ('Return to Stock','Scrap / Damaged') then raise exception 'INVALID_RETURN_DISPOSITION'; end if;
  if coalesce(p_refund_amount,0)<0 or coalesce(p_refund_amount,0)>coalesce(order_row.total_amount,0) then raise exception 'INVALID_RETURN_REFUND_AMOUNT'; end if;
  if coalesce(p_loss,0)<0 then raise exception 'INVALID_LOSS_AMOUNT'; end if;
  if normalized_reason in ('product defective / damaged','other — damaged') and p_disposition <> 'Scrap / Damaged' then raise exception 'RETURN_REASON_DISPOSITION_MISMATCH'; end if;
  if normalized_reason in ('wrong size / product intact','customer changed mind','wrong product sent','other — intact') and p_disposition <> 'Return to Stock' then raise exception 'RETURN_REASON_DISPOSITION_MISMATCH'; end if;
  select coalesce(sum(greatest(0,coalesce(quantity,0))*greatest(0,coalesce(cost_price,0))),0) into max_loss from order_items where order_id=p_order_id;
  if coalesce(p_loss,0)>max_loss then raise exception 'INVALID_LOSS_AMOUNT'; end if;
  if p_disposition='Return to Stock' then
    if coalesce(p_loss,0)<>0 then raise exception 'INVALID_LOSS_AMOUNT'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('product_id',product_id,'variant_id',variant_id,'quantity',quantity)),'[]'::jsonb) into stock_items from order_items where order_id=p_order_id;
    perform public.release_stock_items(stock_items);
  end if;
  insert into returns (desktop_id,order_id,customer_id,return_type,reason,disposition,refund_amount,loss,processed_at,brand_id)
  values ('website-return:'||p_order_id::text,p_order_id,order_row.customer_id,'whole_order',coalesce(p_reason,''),p_disposition,greatest(0,coalesce(p_refund_amount,0)),greatest(0,coalesce(p_loss,0)),now(),(select brand_id from orders where id=p_order_id));
  update orders set delivery_status='Returned',order_status='Not Prepared',stock_reserved=false,updated_at=now() where id=p_order_id;
  return true;
end;
$function$;