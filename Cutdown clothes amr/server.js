import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createClient} from "@supabase/supabase-js";
dotenv.config();
const __dirname=path.dirname(fileURLToPath(import.meta.url)),app=express();
app.use(cors());app.use(express.json({limit:"12mb"}));app.use(express.static(__dirname));
const supabase=process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY?createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY):null;
const base=process.env.PUBLIC_BASE_URL||"",paymobBase=process.env.PAYMOB_BASE_URL||"https://accept.paymob.com";

function requireDesktopSync(q,r,next){
  const expected=process.env.CUTDOWN_DESKTOP_SYNC_TOKEN;
  if(!expected)return r.status(503).json({error:"Desktop sync is not configured."});
  const got=String(q.headers.authorization||"").replace(/^Bearer\\s+/i,"");
  if(!got||got!==expected)return r.status(401).json({error:"Unauthorized desktop sync request."});
  next();
}
function safeFileName(name){return String(name||"image").toLowerCase().replace(/[^a-z0-9._-]+/g,"-").slice(-120)||"image";}
function extFromMime(mime){const m=String(mime||"").toLowerCase();return m.includes("png")?"png":m.includes("webp")?"webp":m.includes("gif")?"gif":"jpg";}
app.post("/api/desktop/products/sync",requireDesktopSync,async(q,r)=>{
  if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
  const p=q.body?.product;
  if(!p?.desktop_id||!p?.name)return r.status(400).json({error:"product.desktop_id and product.name are required."});
  const productRow={desktop_id:String(p.desktop_id),sku:String(p.sku||""),name:String(p.name),category:String(p.category||""),description:String(p.description||""),image_path:String(p.image_path||""),price:Number(p.price||0),cost_price:Number(p.cost_price||0),stock:Math.max(0,Number(p.stock||0)),minimum_stock:Math.max(0,Number(p.minimum_stock||0)),active:p.active!==false,is_active:p.active!==false};
  const up=await supabase.from("products").upsert(productRow,{onConflict:"desktop_id"}).select().single();
  if(up.error)return r.status(500).json({error:up.error.message});
  const productId=up.data.id;
  const variants=Array.isArray(p.variants)?p.variants:[];
  if(variants.length){const rows=variants.map(v=>({desktop_variant_id:String(v.desktop_variant_id||v.id),product_id:productId,sku:String(v.sku||""),size:String(v.size||""),color:String(v.color||""),stock:Math.max(0,Number(v.stock||0)),active:v.active!==false}));const vu=await supabase.from("product_variants").upsert(rows,{onConflict:"desktop_variant_id"});if(vu.error)return r.status(500).json({error:vu.error.message});}
  const images=Array.isArray(p.images)?p.images.slice(0,50):[];
  if(images.length){
    const old=await supabase.from("product_images").select("storage_path").eq("product_id",productId);
    if(old.data?.length)await supabase.storage.from("product-images").remove(old.data.map(x=>x.storage_path).filter(Boolean));
    await supabase.from("product_images").delete().eq("product_id",productId);
    const imageRows=[];
    for(const img of images.slice(0,30)){
      if(!img.data_base64)continue;
      const ext=extFromMime(img.mime_type),color=String(img.color||"").trim().slice(0,80),sort=Number(img.sort_order||0);
      const path="desktop/"+safeFileName(p.desktop_id)+"/"+safeFileName(color||"default")+"-"+sort+"."+ext;
      const bytes=Buffer.from(String(img.data_base64),"base64");
      const upImg=await supabase.storage.from("product-images").upload(path,bytes,{contentType:img.mime_type||"image/"+ext,upsert:true});
      if(upImg.error)return r.status(500).json({error:upImg.error.message});
      const pub=supabase.storage.from("product-images").getPublicUrl(path).data.publicUrl;
      imageRows.push({product_id:productId,storage_path:path,public_url:pub,alt_text:String(img.alt_text||p.name),sort_order:sort,is_primary:sort===0,color});
    }
    if(imageRows.length){const ii=await supabase.from("product_images").insert(imageRows);if(ii.error)return r.status(500).json({error:ii.error.message});}
  }
  r.json({ok:true,product_id:productId,desktop_id:p.desktop_id,variant_count:variants.length,image_count:images.length});
});
app.get("/api/desktop/orders",requireDesktopSync,async(_q,r)=>{
  if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
  const o=await supabase.from("orders").select("*,order_items(*)").order("created_at",{ascending:false}).limit(100);
  if(o.error)return r.status(500).json({error:o.error.message});
  r.json(o.data||[]);
});
app.get("/api/health",(_q,r)=>r.json({ok:true,supabase:!!supabase,paymentConfigured:!!(process.env.PAYMOB_SECRET_KEY&&process.env.PAYMOB_PUBLIC_KEY&&process.env.PAYMOB_INTEGRATION_ID&&process.env.PAYMOB_HMAC_SECRET)}));
app.get("/api/products",async(_q,r)=>{
 if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
 const {data,error}=await supabase.from("products").select("*").eq("active",true).order("created_at",{ascending:false});
 if(error)return r.status(500).json({error:error.message});
 const products=data||[];
 const ids=products.map(p=>p.id);
 if(!ids.length)return r.json([]);
 const {data:variants}=await supabase.from("product_variants").select("id,product_id,desktop_variant_id,sku,size,color,stock,active").in("product_id",ids).eq("active",true);
 const {data:images}=await supabase.from("product_images").select("id,product_id,storage_path,public_url,alt_text,sort_order,color").in("product_id",ids).order("sort_order",{ascending:true});
 const vm=new Map(),im=new Map();
 (variants||[]).forEach(v=>{if(!vm.has(v.product_id))vm.set(v.product_id,[]);vm.get(v.product_id).push(v)});
 (images||[]).forEach(v=>{if(!im.has(v.product_id))im.set(v.product_id,[]);im.get(v.product_id).push(v)});
 r.json(products.map(p=>({...p,variants:vm.get(p.id)||[],images:im.get(p.id)||[]})));
});
app.get("/api/reviews",async(_q,r)=>{if(!supabase)return r.status(503).json({error:"Supabase is not configured."});const {data,error}=await supabase.from("reviews").select("*").eq("approved",true).order("created_at",{ascending:false});if(error)return r.status(500).json({error:error.message});r.json(data||[])});
app.post("/api/reviews",async(q,r)=>{if(!supabase)return r.status(503).json({error:"Supabase is not configured."});const {name,rating,body}=q.body||{};if(!name?.trim()||!body?.trim()||!Number.isInteger(Number(rating))||Number(rating)<1||Number(rating)>5)return r.status(400).json({error:"Invalid review."});const {data,error}=await supabase.from("reviews").insert({name:name.trim().slice(0,80),rating:Number(rating),body:body.trim().slice(0,1000),approved:true}).select().single();if(error)return r.status(500).json({error:error.message});r.status(201).json(data)});
async function findOrCreateCustomer(customer){
 if(!supabase||!customer?.phone)return null;
 const phone=String(customer.phone).trim();
 const found=await supabase.from("customers").select("id").eq("phone",phone).maybeSingle();
 if(found.data?.id)return found.data.id;
 const payload={name:String(customer.name||"").trim(),phone,email:customer.email?.trim()||null,city:customer.city?.trim()||null,address:customer.address?.trim()||null};
 const created=await supabase.from("customers").insert(payload).select("id").single();
 return created.data?.id||null;
}
app.post("/api/orders",async(q,r)=>{
 if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
 const {customer,items,payment_method}=q.body||{};if(!customer?.name||!customer?.phone||!customer?.address||!Array.isArray(items)||!items.length)return r.status(400).json({error:"Missing order details."});if(!["cod","online"].includes(payment_method))return r.status(400).json({error:"Invalid payment method."});
 const {data:products,error:pe}=await supabase.from("products").select("id,name,price,stock,active").in("id",items.map(i=>i.product_id));if(pe)return r.status(500).json({error:pe.message});
 const variantIds=items.map(i=>i.variant_id).filter(Boolean);let variants=[];
 if(variantIds.length){const vr=await supabase.from("product_variants").select("id,product_id,size,color,stock,active").in("id",variantIds);if(vr.error)return r.status(500).json({error:vr.error.message});variants=vr.data||[]}
 const map=new Map((products||[]).map(p=>[p.id,p])),vmap=new Map(variants.map(v=>[v.id,v]));let total=0;const clean=[];
 for(const item of items){
   const p=map.get(item.product_id),n=Math.max(1,Math.floor(Number(item.quantity))),v=item.variant_id?vmap.get(item.variant_id):null;
   if(!p||!p.active||(!v&&n>p.stock)|| (v&&(!v.active||v.product_id!==p.id||n>v.stock)))return r.status(409).json({error:"The selected color or size is unavailable."});
   total+=Number(p.price)*n;clean.push({product_id:p.id,variant_id:v?.id||null,product_name:p.name,quantity:n,unit_price:p.price,size:v?.size||item.size||null,color:v?.color||item.color||null})
 }
 const variantReservation=clean.filter(i=>i.variant_id).map(i=>({variant_id:i.variant_id,quantity:i.quantity}));
 const customerId=await findOrCreateCustomer(customer);
 if(variantReservation.length){const reserve=await supabase.rpc("reserve_variant_stock",{p_items:variantReservation});if(reserve.error)return r.status(409).json({error:"One or more selected sizes are no longer available."});}
 const {data:order,error:oe}=await supabase.from("orders").insert({customer_name:customer.name.trim(),customer_phone:customer.phone.trim(),customer_email:customer.email?.trim()||null,city:customer.city?.trim()||null,address:customer.address.trim(),notes:customer.notes?.trim()||null,payment_method,payment_status:"pending",order_status:"pending",total_amount:total,customer_id:customerId,source:"website",stock_reserved:variantReservation.length>0}).select().single();if(oe)return r.status(500).json({error:oe.message});
 const {error:ie}=await supabase.from("order_items").insert(clean.map(i=>({...i,order_id:order.id})));if(ie){if(variantReservation.length)await supabase.rpc("release_variant_stock",{p_items:variantReservation});await supabase.from("orders").delete().eq("id",order.id);return r.status(500).json({error:ie.message})}
 if(payment_method==="cod"){await supabase.from("orders").update({order_status:"confirmed"}).eq("id",order.id);return r.status(201).json({order_id:order.id,payment_required:false,message:"Order confirmed for cash on delivery."})}
 if(!(process.env.PAYMOB_SECRET_KEY&&process.env.PAYMOB_PUBLIC_KEY&&process.env.PAYMOB_INTEGRATION_ID&&process.env.PAYMOB_HMAC_SECRET&&base))return r.status(503).json({error:"Online payment is not configured yet. Add Supabase + Paymob variables in Railway."});
 const amountCents=Math.round(total*100),parts=customer.name.trim().split(/\\s+/),first=parts[0]||"Customer",last=parts.slice(1).join(" ")||"Customer";
 const pay=await fetch(paymobBase+"/v1/intention/",{method:"POST",headers:{"Authorization":"Token "+process.env.PAYMOB_SECRET_KEY,"Content-Type":"application/json"},body:JSON.stringify({amount:amountCents,currency:"EGP",payment_methods:[Number(process.env.PAYMOB_INTEGRATION_ID)],items:clean.map(i=>({name:i.product_name,amount:Math.round(Number(i.unit_price)*100),description:"Cutdown product",quantity:i.quantity})),billing_data:{first_name:first,last_name:last,email:customer.email||"no-email@cutdown.store",phone_number:customer.phone,apartment:"NA",building:"NA",street:customer.address,floor:"NA",city:customer.city||"Cairo",state:customer.city||"Cairo",country:"EGY"},special_reference:order.id,expiration:3600,notification_url:base+"/api/paymob/webhook",redirection_url:base+"/payment-result?order_id="+encodeURIComponent(order.id)})});
 const pd=await pay.json();if(!pay.ok)return r.status(502).json({error:"Payment provider rejected the request.",details:pd});const checkoutUrl=paymobBase+"/unifiedcheckout/?publicKey="+encodeURIComponent(process.env.PAYMOB_PUBLIC_KEY)+"&clientSecret="+encodeURIComponent(pd.client_secret);r.status(201).json({order_id:order.id,payment_required:true,checkout_url:checkoutUrl});
});
function verifyHmac(o,h){if(!o||!h||!process.env.PAYMOB_HMAC_SECRET)return false;const f=[o.amount_cents,o.created_at,o.currency,o.error_occured,o.has_parent_transaction,o.id,o.integration_id,o.is_3d_secure,o.is_auth,o.is_capture,o.is_refunded,o.is_standalone_payment,o.is_voided,o.order?.id,o.owner,o.pending,o.source_data?.pan,o.source_data?.sub_type,o.source_data?.type,o.success],c=crypto.createHmac("sha512",process.env.PAYMOB_HMAC_SECRET).update(f.map(String).join("")).digest("hex");return c.length===h.length&&crypto.timingSafeEqual(Buffer.from(c),Buffer.from(h))}
app.post("/api/paymob/webhook",async(q,r)=>{const o=q.body?.obj,h=String(q.query.hmac||"");if(!verifyHmac(o,h))return r.status(401).json({error:"Invalid HMAC"});if(!supabase)return r.sendStatus(503);const orderId=o.order?.merchant_order_id||o.merchant_order_id;if(!orderId)return r.json({received:true});const {error}=await supabase.from("payment_events").insert({provider_event_id:String(o.id),order_id:orderId,success:o.success===true,payload:o});if(error&&!String(error.message).toLowerCase().includes("duplicate"))return r.sendStatus(503);if(!error){const success=o.success===true&&!o.pending;await supabase.from("orders").update({payment_status:success?"paid":"failed",order_status:success?"confirmed":"pending"}).eq("id",orderId);if(!success){const ord=await supabase.from("orders").select("stock_reserved").eq("id",orderId).single();if(ord.data?.stock_reserved){const it=await supabase.from("order_items").select("variant_id,quantity").eq("order_id",orderId);const items=(it.data||[]).filter(x=>x.variant_id).map(x=>({variant_id:x.variant_id,quantity:x.quantity}));if(items.length)await supabase.rpc("release_variant_stock",{p_items:items});await supabase.from("orders").update({stock_reserved:false}).eq("id",orderId);}}}r.json({received:true})});
app.get("/payment-result",(_q,r)=>r.sendFile(path.join(__dirname,"payment-result.html")));app.use((_q,r)=>r.sendFile(path.join(__dirname,"index.html")));const port=process.env.PORT||3000;app.listen(port,()=>console.log("Cutdown Store listening on "+port));