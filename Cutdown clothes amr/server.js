import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createClient} from "@supabase/supabase-js";
dotenv.config();
const __dirname=path.dirname(fileURLToPath(import.meta.url)),app=express();
app.use(cors());app.use(express.json({limit:"1mb"}));app.use(express.static(__dirname));
const supabase=process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY?createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY):null;
const base=process.env.PUBLIC_BASE_URL||"",paymobBase=process.env.PAYMOB_BASE_URL||"https://accept.paymob.com";
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
 const {data:order,error:oe}=await supabase.from("orders").insert({customer_name:customer.name.trim(),customer_phone:customer.phone.trim(),customer_email:customer.email?.trim()||null,city:customer.city?.trim()||null,address:customer.address.trim(),notes:customer.notes?.trim()||null,payment_method,payment_status:"pending",order_status:"pending",total_amount:total}).select().single();if(oe)return r.status(500).json({error:oe.message});
 const {error:ie}=await supabase.from("order_items").insert(clean.map(i=>({...i,order_id:order.id})));if(ie){await supabase.from("orders").delete().eq("id",order.id);return r.status(500).json({error:ie.message})}
 if(payment_method==="cod"){await supabase.from("orders").update({order_status:"confirmed"}).eq("id",order.id);return r.status(201).json({order_id:order.id,payment_required:false,message:"Order confirmed for cash on delivery."})}
 if(!(process.env.PAYMOB_SECRET_KEY&&process.env.PAYMOB_PUBLIC_KEY&&process.env.PAYMOB_INTEGRATION_ID&&process.env.PAYMOB_HMAC_SECRET&&base))return r.status(503).json({error:"Online payment is not configured yet. Add Supabase + Paymob variables in Railway."});
 const amountCents=Math.round(total*100),parts=customer.name.trim().split(/\\s+/),first=parts[0]||"Customer",last=parts.slice(1).join(" ")||"Customer";
 const pay=await fetch(paymobBase+"/v1/intention/",{method:"POST",headers:{"Authorization":"Token "+process.env.PAYMOB_SECRET_KEY,"Content-Type":"application/json"},body:JSON.stringify({amount:amountCents,currency:"EGP",payment_methods:[Number(process.env.PAYMOB_INTEGRATION_ID)],items:clean.map(i=>({name:i.product_name,amount:Math.round(Number(i.unit_price)*100),description:"Cutdown product",quantity:i.quantity})),billing_data:{first_name:first,last_name:last,email:customer.email||"no-email@cutdown.store",phone_number:customer.phone,apartment:"NA",building:"NA",street:customer.address,floor:"NA",city:customer.city||"Cairo",state:customer.city||"Cairo",country:"EGY"},special_reference:order.id,expiration:3600,notification_url:base+"/api/paymob/webhook",redirection_url:base+"/payment-result?order_id="+encodeURIComponent(order.id)})});
 const pd=await pay.json();if(!pay.ok)return r.status(502).json({error:"Payment provider rejected the request.",details:pd});const checkoutUrl=paymobBase+"/unifiedcheckout/?publicKey="+encodeURIComponent(process.env.PAYMOB_PUBLIC_KEY)+"&clientSecret="+encodeURIComponent(pd.client_secret);r.status(201).json({order_id:order.id,payment_required:true,checkout_url:checkoutUrl});
});
function verifyHmac(o,h){if(!o||!h||!process.env.PAYMOB_HMAC_SECRET)return false;const f=[o.amount_cents,o.created_at,o.currency,o.error_occured,o.has_parent_transaction,o.id,o.integration_id,o.is_3d_secure,o.is_auth,o.is_capture,o.is_refunded,o.is_standalone_payment,o.is_voided,o.order?.id,o.owner,o.pending,o.source_data?.pan,o.source_data?.sub_type,o.source_data?.type,o.success],c=crypto.createHmac("sha512",process.env.PAYMOB_HMAC_SECRET).update(f.map(String).join("")).digest("hex");return c.length===h.length&&crypto.timingSafeEqual(Buffer.from(c),Buffer.from(h))}
app.post("/api/paymob/webhook",async(q,r)=>{const o=q.body?.obj,h=String(q.query.hmac||"");if(!verifyHmac(o,h))return r.status(401).json({error:"Invalid HMAC"});if(!supabase)return r.sendStatus(503);const orderId=o.order?.merchant_order_id||o.merchant_order_id;if(!orderId)return r.json({received:true});const {error}=await supabase.from("payment_events").insert({provider_event_id:String(o.id),order_id:orderId,success:o.success===true,payload:o});if(error&&!String(error.message).toLowerCase().includes("duplicate"))return r.sendStatus(503);if(!error)await supabase.from("orders").update({payment_status:o.success===true&&!o.pending?"paid":"failed",order_status:o.success===true&&!o.pending?"confirmed":"pending"}).eq("id",orderId);r.json({received:true})});
app.get("/payment-result",(_q,r)=>r.sendFile(path.join(__dirname,"payment-result.html")));app.use((_q,r)=>r.sendFile(path.join(__dirname,"index.html")));const port=process.env.PORT||3000;app.listen(port,()=>console.log("Cutdown Store listening on "+port));