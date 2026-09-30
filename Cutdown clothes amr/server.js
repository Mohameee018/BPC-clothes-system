import express from "express";
import cors from "cors";
import compression from "compression";
import dotenv from "dotenv";
import crypto from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createClient} from "@supabase/supabase-js";
dotenv.config();
const __dirname=path.dirname(fileURLToPath(import.meta.url)),app=express();
app.set("trust proxy",1);app.disable("x-powered-by");
const base=process.env.PUBLIC_BASE_URL||"";
const allowedOrigins=String(process.env.CORS_ORIGINS||base||"").split(",").map(x=>x.trim().replace(/\/$/,"")).filter(Boolean);
app.use(cors({origin:(origin,cb)=>{if(!origin||allowedOrigins.includes(origin))return cb(null,true);return cb(null,false);},methods:["GET","POST","OPTIONS"],allowedHeaders:["Authorization","Content-Type"]}));
app.use((q,r,next)=>{if(q.headers.authorization)r.setHeader("Cache-Control","no-store");r.setHeader("X-Content-Type-Options","nosniff");r.setHeader("X-Frame-Options","DENY");r.setHeader("Referrer-Policy","strict-origin-when-cross-origin");r.setHeader("Permissions-Policy","camera=(),microphone=(),geolocation=()");if(q.secure)r.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");next()});
app.use(compression({threshold:"1kb"}));
app.use(express.json({limit:"12mb"}));
const blockedStatic=/^\/(?:server\.js|package(?:-lock)?\.json|\.env(?:\..*)?|supabase[^/]*\.sql)(?:$|\/)/i;
app.use((q,r,next)=>blockedStatic.test(q.path)?r.status(404).end():next());
app.use(express.static(__dirname,{index:false,etag:true,maxAge:"1h",setHeaders:(res,file)=>{if(path.extname(file).toLowerCase()===".html")res.setHeader("Cache-Control","public, max-age=0, must-revalidate")}}));
const SUPABASE_SERVER_KEY=process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY||"";
const supabase=process.env.SUPABASE_URL&&SUPABASE_SERVER_KEY?createClient(process.env.SUPABASE_URL,SUPABASE_SERVER_KEY,{auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false}}):null;
const rateBuckets=new Map();
function rateLimit({windowMs=60000,max=60,keyPrefix="api"}={}){return (q,r,next)=>{const now=Date.now(),key=keyPrefix+":"+q.ip+":"+q.path,old=rateBuckets.get(key)||{start:now,count:0};if(now-old.start>=windowMs){old.start=now;old.count=0}old.count++;rateBuckets.set(key,old);if(old.count>max)return r.status(429).json({error:"Too many requests. Please try again later."});next()}}
setInterval(()=>{const cutoff=Date.now()-10*60*1000;for(const [k,v] of rateBuckets)if(v.start<cutoff)rateBuckets.delete(k)},5*60*1000).unref();
const DEFAULT_BRAND_ID="00000000-0000-4000-8000-000000000001";
const configuredBrandId=()=>String((process.env.BPC_BRAND_ID||process.env.CUTDOWN_BRAND_ID)||DEFAULT_BRAND_ID).trim();
async function resolvePublicBrand(req){
 if(!supabase)return null;
 const requested=String(req.query?.brand||req.body?.brand_slug||"").trim().toLowerCase();
 if(requested){
  const found=await supabase.from("brands").select("id,name,slug,active,website_url,settings").eq("slug",requested).eq("active",true).maybeSingle();
  if(found.error)throw found.error;
  return found.data||null;
 }
 const host=String(req.headers?.host||"").split(":")[0].toLowerCase();
 const baseHost=(()=>{try{return new URL(process.env.PUBLIC_BASE_URL||"").hostname.toLowerCase()}catch{return ""}})();
 if(host&&(!baseHost||host!==baseHost)){
  const brands=await supabase.from("brands").select("id,name,slug,active,website_url,settings").eq("active",true).not("website_url","is",null).limit(500);
  if(brands.error)throw brands.error;
  const match=(brands.data||[]).find(b=>{try{return new URL(String(b.website_url||"")).hostname.toLowerCase()===host}catch{return false}});
  if(match)return match;
 }
 const fallback=await supabase.from("brands").select("id,name,slug,active,website_url,settings").eq("id",configuredBrandId()).eq("active",true).maybeSingle();
 if(fallback.error)throw fallback.error;
 return fallback.data||null;
}
const paymobBase=process.env.PAYMOB_BASE_URL||"https://accept.paymob.com";

async function requireDesktopSync(q,r,next){
  if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
  const got=String(q.headers.authorization||"").replace(/^Bearer\s+/i,"").trim();
  if(!got)return r.status(401).json({error:"Desktop login required."});
  const user=await getAuthUser(q);
  if(!user)return r.status(401).json({error:"Desktop session expired. Please sign in again."});
  const profile=await getAuthProfile(user.id);
  if(profile?.role!=="admin"||!profile?.brand_id)return r.status(403).json({error:"Brand administrator access required."});
  const brandId=String(profile.brand_id);
  if(brandId!==configuredBrandId())return r.status(403).json({error:"This desktop installation is not assigned to this brand."});
  q.brandId=brandId;
  q.desktopUser=user;
  next();
}
function safeFileName(name){return String(name||"image").toLowerCase().replace(/[^a-z0-9._-]+/g,"-").slice(-120)||"image";}
function detectImage(bytes){if(bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {ext:"png",mime:"image/png"};if(bytes.length>=3&&bytes.subarray(0,3).equals(Buffer.from([255,216,255])))return {ext:"jpg",mime:"image/jpeg"};if(bytes.length>=6&&["GIF87a","GIF89a"].includes(bytes.subarray(0,6).toString("ascii")))return {ext:"gif",mime:"image/gif"};if(bytes.length>=12&&bytes.subarray(0,4).toString("ascii")==="RIFF"&&bytes.subarray(8,12).toString("ascii")==="WEBP")return {ext:"webp",mime:"image/webp"};return null;}
app.post("/api/desktop/products/sync",rateLimit({windowMs:60*1000,max:30,keyPrefix:"desktop-sync"}),requireDesktopSync,async(q,r)=>{
  if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
  const p=q.body?.product;
  if(!p?.desktop_id||!p?.name)return r.status(400).json({error:"product.desktop_id and product.name are required."});

  // Validate every nested payload before the first database/storage mutation.
  // This prevents malformed variants/images from leaving an avoidable partial sync.
  const variants=Array.isArray(p.variants)?p.variants:[];
  const variantIds=new Set();
  for(const v of variants){
    const variantId=String(v?.desktop_variant_id||v?.id||"").trim();
    const variantStock=Number(v?.stock??0);
    if(!variantId||variantIds.has(variantId)||!Number.isSafeInteger(variantStock)||variantStock<0)
      return r.status(400).json({error:"Invalid or duplicate variant ID/stock."});
    variantIds.add(variantId);
  }
  const images=Array.isArray(p.images)?p.images.slice(0,50):[];
  const preparedImages=[];
  for(const img of images){
    if(!img?.data_base64)continue;
    const bytes=Buffer.from(String(img.data_base64),"base64");
    if(bytes.length>1572864)return r.status(413).json({error:"Product image is too large. Maximum is 1.5 MB per image."});
    const detected=detectImage(bytes);
    if(!detected)return r.status(415).json({error:"Unsupported product image type."});
    preparedImages.push({img,bytes,detected});
  }
  const price=Number(p.price||0),costPrice=Number(p.cost_price||0),stock=Number(p.stock||0),minimumStock=Number(p.minimum_stock||0);
  if(!Number.isFinite(price)||price<0||!Number.isFinite(costPrice)||costPrice<0||!Number.isSafeInteger(stock)||stock<0||!Number.isSafeInteger(minimumStock)||minimumStock<0)return r.status(400).json({error:"Invalid product pricing or stock."});
  const productRow={brand_id:q.brandId,desktop_id:String(p.desktop_id),sku:String(p.sku||""),name:String(p.name),category:String(p.category||""),description:String(p.description||""),image_path:String(p.image_path||""),price,cost_price:costPrice,stock,minimum_stock:minimumStock,active:p.active!==false,is_active:p.active!==false};
  const up=await supabase.from("products").upsert(productRow,{onConflict:"brand_id,desktop_id"}).select().single();
  if(up.error)return r.status(500).json({error:"Internal server error."});
  const productId=up.data.id;
  let warehouse=await supabase.from("warehouses").select("id").eq("brand_id",q.brandId).eq("active",true).order("created_at",{ascending:true}).limit(1).maybeSingle();
  if(warehouse.error)return r.status(500).json({error:"Internal server error."});
  if(!warehouse.data){const createdWarehouse=await supabase.from("warehouses").insert({brand_id:q.brandId,name:"Main Warehouse",location:"",active:true}).select("id").single();if(createdWarehouse.error)return r.status(500).json({error:"Internal server error."});warehouse={data:createdWarehouse.data};}
  const warehouseId=warehouse.data.id;
  if(variants.length){const rows=variants.map(v=>({brand_id:q.brandId,desktop_variant_id:String(v.desktop_variant_id||v.id).trim(),product_id:productId,sku:String(v.sku||""),size:String(v.size||""),color:String(v.color||""),stock:Number(v.stock??0),active:v.active!==false}));const vu=await supabase.from("product_variants").upsert(rows,{onConflict:"brand_id,desktop_variant_id"});if(vu.error)return r.status(500).json({error:"Internal server error."});const ids=rows.map(v=>v.desktop_variant_id);const stale=await supabase.from("product_variants").delete().eq("brand_id",q.brandId).eq("product_id",productId).not("desktop_variant_id","in","("+ids.join(",")+")");if(stale.error)return r.status(500).json({error:"Internal server error."});}else{const clear=await supabase.from("product_variants").delete().eq("brand_id",q.brandId).eq("product_id",productId);if(clear.error)return r.status(500).json({error:"Internal server error."});}
  const inv=await supabase.from("inventory").select("id").eq("brand_id",q.brandId).eq("product_id",productId).eq("warehouse_id",warehouseId).is("variant_id",null).maybeSingle();
  if(inv.error)return r.status(500).json({error:"Internal server error."});
  if(inv.data){const iu=await supabase.from("inventory").update({quantity:stock,updated_at:new Date().toISOString()}).eq("id",inv.data.id);if(iu.error)return r.status(500).json({error:"Internal server error."});}
  else{const ii=await supabase.from("inventory").insert({brand_id:q.brandId,product_id:productId,warehouse_id:warehouseId,quantity:stock});if(ii.error)return r.status(500).json({error:"Internal server error."});}
  if(images.length || p.images){
    const old=await supabase.from("product_images").select("storage_path").eq("brand_id",q.brandId).eq("product_id",productId);
    if(old.error)return r.status(500).json({error:"Could not prepare product images."});
    if(old.data?.length){const removed=await supabase.storage.from("product-images").remove(old.data.map(x=>x.storage_path).filter(Boolean));if(removed.error)return r.status(500).json({error:"Could not prepare product images."});}
    const deleted=await supabase.from("product_images").delete().eq("brand_id",q.brandId).eq("product_id",productId);
    if(deleted.error)return r.status(500).json({error:"Could not prepare product images."});
    const imageRows=[];
    for(const {img,bytes,detected} of preparedImages){
      const ext=detected.ext,color=String(img.color||"").trim().slice(0,80),sort=Number(img.sort_order||0);
      const path="brands/"+safeFileName(q.brandId)+"/desktop/"+safeFileName(p.desktop_id)+"/"+safeFileName(color||"default")+"-"+sort+"."+ext;
      const upImg=await supabase.storage.from("product-images").upload(path,bytes,{contentType:detected.mime,upsert:true});
      if(upImg.error)return r.status(500).json({error:"Internal server error."});
      const pub=supabase.storage.from("product-images").getPublicUrl(path).data.publicUrl;
      imageRows.push({brand_id:q.brandId,product_id:productId,storage_path:path,public_url:pub,alt_text:String(img.alt_text||p.name),sort_order:sort,is_primary:sort===0,color});
    }
    if(imageRows.length){const ii=await supabase.from("product_images").insert(imageRows);if(ii.error)return r.status(500).json({error:"Internal server error."});}
  }
  r.json({ok:true,product_id:productId,desktop_id:p.desktop_id,variant_count:variants.length,image_count:images.length});
});
app.get("/api/desktop/orders",requireDesktopSync,async(q,r)=>{
 if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
 const o=await supabase.from("orders").select("*,order_items(*)").eq("brand_id",q.brandId).eq("source","website").order("created_at",{ascending:false}).limit(100);
 if(o.error)return r.status(500).json({error:"Internal server error."});
 r.json((o.data||[]).map(x=>({...x,customer_name:x.customer_name||"",customer_phone:x.customer_phone||"",order_items:(x.order_items||[]).map(i=>({...i,product_name:i.product_name||"",sku:i.sku||"",category:i.category||"",size:i.size||"",color:i.color||"",cost_price:i.cost_price||0}))})));
});
app.post("/api/desktop/orders/return",requireDesktopSync,async(q,r)=>{
 if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
 const {order_id,reason,disposition,amount,loss}=q.body||{};
 if(!order_id)return r.status(400).json({error:"Missing order_id."});
 const owned=await supabase.from("orders").select("id").eq("id",order_id).eq("brand_id",q.brandId).eq("source","website").maybeSingle();
 if(owned.error)return r.status(500).json({error:"Internal server error."}); if(!owned.data)return r.status(404).json({error:"Website order not found."});
 const result=await supabase.rpc("process_whole_order_return",{p_order_id:order_id,p_reason:String(reason||"Customer Return"),p_disposition:String(disposition||"Return to Stock"),p_refund_amount:Number(amount||0),p_loss:Number(loss||0)});
 if(result.error){
   const msg=String(result.error.message||"");
   if(msg.includes("WEBSITE_ORDER_NOT_FOUND"))return r.status(404).json({error:"Website order not found."});
   if(msg.includes("INVALID_RETURN_DISPOSITION"))return r.status(400).json({error:"Invalid return disposition."}); if(msg.includes("INVALID_REFUND_AMOUNT"))return r.status(400).json({error:"Invalid refund amount."}); if(msg.includes("INVALID_LOSS_AMOUNT"))return r.status(400).json({error:"Invalid loss amount."});
   if(msg.includes("ORDER_NOT_CONFIRMED"))return r.status(409).json({error:"Order is not confirmed for return."});
   if(msg.includes("ORDER_STOCK_NOT_RESERVED"))return r.status(409).json({error:"Order stock is no longer reserved."});
   return r.status(500).json({error:"Could not process return."});
 }
 r.json({ok:true,processed:result.data===true});
});
app.post("/api/desktop/orders/status",requireDesktopSync,async(q,r)=>{
 if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
 const {order_id,order_status,delivery_status}=q.body||{};
 if(!order_id||(!order_status&&!delivery_status))return r.status(400).json({error:"Missing order status."});
 const orderStatuses=["Not Prepared","Preparing","Prepared","Completed"];
 const deliveryStatuses=["Pending","With Shipping Company","Out for Delivery","Delivered","Returned"];
 if(order_status&&!orderStatuses.includes(String(order_status)))return r.status(400).json({error:"Invalid order status."});
 if(delivery_status&&!deliveryStatuses.includes(String(delivery_status)))return r.status(400).json({error:"Invalid delivery status."});
 const patch={}; if(order_status)patch.order_status=String(order_status); if(delivery_status)patch.delivery_status=String(delivery_status);
 const u=await supabase.from("orders").update(patch).eq("id",order_id).eq("brand_id",q.brandId).eq("source","website").select("id").maybeSingle();
 if(u.error)return r.status(500).json({error:"Internal server error."}); if(!u.data)return r.status(404).json({error:"Website order not found."}); r.json({ok:true});
});
async function getAuthUser(req){const auth=String(req.headers.authorization||"");const token=auth.replace(/^Bearer\s+/i,"").trim();if(!token||!supabase)return null;const {data,error}=await supabase.auth.getUser(token);return error?null:data?.user||null}
async function getAuthProfile(userId){if(!supabase||!userId)return null;const {data}=await supabase.from("profiles").select("id,role,name,phone,brand_id").eq("id",userId).maybeSingle();return data||null}
async function ensureCustomerForUser(user){
  if(!supabase||!user?.id)return null;
  const profile=await getAuthProfile(user.id);
  if(!profile?.brand_id)throw new Error("This account is not assigned to a brand.");
  const brandId=String(profile.brand_id);
  const existing=await supabase.from("customers").select("id,name,email,phone,city,address").eq("brand_id",brandId).eq("auth_user_id",user.id).maybeSingle();
  if(existing.error)throw existing.error;
  if(existing.data)return existing.data;
  const claimed=await supabase.rpc("claim_customer_for_auth");
  if(claimed.error)throw claimed.error;
  if(!claimed.data)return null;
  const linked=await supabase.from("customers").select("id,name,email,phone,city,address").eq("id",claimed.data).eq("brand_id",brandId).eq("auth_user_id",user.id).maybeSingle();
  if(linked.error)throw linked.error;
  return linked.data||null;
}const SUPABASE_PUBLISHABLE_KEY=process.env.SUPABASE_PUBLISHABLE_KEY||"sb_publishable_FG00mgx9-nGbIxCPfSiCHw_CFRHCcc_";
const authClient=process.env.SUPABASE_URL&&SUPABASE_PUBLISHABLE_KEY?createClient(process.env.SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{autoRefreshToken:false,persistSession:false,detectSessionInUrl:false}}):null;
function hashActivationCode(code){
  return crypto.createHash("sha256").update(String(code||"").trim().toUpperCase()).digest("hex");
}
function makeActivationCode(){
  return crypto.randomBytes(5).toString("hex").toUpperCase().match(/.{1,4}/g).join("-");
}
function addDays(date,days){return new Date(date.getTime()+Number(days)*86400000)}
async function getSubscriptionForUser(userId){
  if(!supabase||!userId)return null;
  const now=new Date();
  const q=await supabase.from("subscriptions")
    .select("id,brand_id,auth_user_id,status,starts_at,expires_at,customer_name,customer_email,payment_method,plan_id,subscription_plans(code,name,duration_days,price)")
    .eq("auth_user_id",userId)
    .order("expires_at",{ascending:false})
    .limit(1)
    .maybeSingle();
  if(q.error)return null;
  const sub=q.data;
  if(!sub)return null;
  if(sub.expires_at && new Date(sub.expires_at)<=now && sub.status==="active"){
    await supabase.from("subscriptions").update({status:"expired",updated_at:now.toISOString()}).eq("id",sub.id).eq("status","active");
    sub.status="expired";
  }
  return sub;
}
function subscriptionView(sub){
  if(!sub)return {status:"none",active:false,warning:false};
  const expires=sub.expires_at?new Date(sub.expires_at):null;
  const isLifetime=sub.subscription_plans?.code==="lifetime";
  const ms=expires?expires.getTime()-Date.now():null;
  const daysLeft=expires?Math.ceil(ms/86400000):null;
  const warning=!isLifetime&&sub.status==="active"&&daysLeft!==null&&daysLeft<=7;
  return {
    id:sub.id,status:sub.status,active:sub.status==="active"&&(isLifetime||!!expires&&expires.getTime()>Date.now()),
    warning,days_left:daysLeft,starts_at:sub.starts_at||null,expires_at:sub.expires_at||null,
    plan:sub.subscription_plans||null
  };
}
async function requireActiveSubscription(userId,res){
  const sub=await getSubscriptionForUser(userId);
  const view=subscriptionView(sub);
  if(!view.active){
    const message=view.status==="expired"?"Your subscription has expired. Renew to continue.":"A paid BPC subscription is required to access the system.";
    return {ok:false,response:res.status(403).json({error:message,code:view.status==="expired"?"SUBSCRIPTION_EXPIRED":"SUBSCRIPTION_REQUIRED",subscription:view})};
  }
  return {ok:true,subscription:sub,view};
}

app.get("/api/subscription/plans",async(_q,r)=>{
 if(!supabase)return r.status(503).json({error:"Subscription service is not configured."});
 const p=await supabase.from("subscription_plans").select("id,code,name,duration_days,price").eq("active",true).order("duration_days");
 if(p.error)return r.status(500).json({error:"Could not load subscription plans."});
 r.json({plans:p.data||[]});
});
async function createPaymobIntention({amountCents,email,name,phone,planName,paymentRef}){
 const secret=String(process.env.PAYMOB_SECRET_KEY||"").trim();
 const publicKey=String(process.env.PAYMOB_PUBLIC_KEY||"").trim();
 const methods=String(process.env.PAYMOB_PAYMENT_METHODS||"").split(",").map(x=>x.trim()).filter(Boolean).map(x=>/^\\d+$/.test(x)?Number(x):x);
 if(!secret||!publicKey||!methods.length)throw new Error("PAYMOB_NOT_CONFIGURED");
 const baseUrl=String(process.env.PUBLIC_BASE_URL||"").replace(/\/$/,"");
 if(!baseUrl)throw new Error("PUBLIC_BASE_URL_NOT_CONFIGURED");
 const response=await fetch(paymobBase+"/v1/intention/",{
  method:"POST",
  headers:{"Authorization":"Token "+secret,"Content-Type":"application/json"},
  body:JSON.stringify({
   amount:Number(amountCents),currency:"EGP",payment_methods:methods,
   items:[{name:planName,amount:Number(amountCents),description:"BPC Clothes System subscription",quantity:1}],
   billing_data:{first_name:String(name||"Customer").split(/\\s+/)[0]||"Customer",last_name:String(name||"Customer").split(/\\s+/).slice(1).join(" ")||"Customer",phone_number:String(phone||"0000000000"),email,apartment:"NA",floor:"NA",street:"NA",building:"NA",city:"Cairo",state:"Cairo",country:"EG"},
   special_reference:paymentRef,expiration:3600,
   notification_url:baseUrl+"/api/payments/paymob/webhook",
   redirection_url:baseUrl+"/payment-result.html"
  })
 });
 const data=await response.json().catch(()=>({}));
 if(!response.ok||!data?.client_secret)throw new Error("PAYMOB_INTENTION_FAILED");
 return {clientSecret:String(data.client_secret),intentionId:String(data.id||""),orderId:String(data.intention_order_id||"")};
}
function paymobCheckoutUrl(clientSecret){
 const publicKey=String(process.env.PAYMOB_PUBLIC_KEY||"").trim();
 return paymobBase+"/unifiedcheckout/?publicKey="+encodeURIComponent(publicKey)+"&clientSecret="+encodeURIComponent(clientSecret);
}
function paymobTxnHmacValid(obj,received){
 const secret=String(process.env.PAYMOB_HMAC_SECRET||"").trim();
 if(!secret||!received||!obj)return false;
 const source=obj.source_data||{},order=obj.order||{};
 const values=[obj.amount_cents,obj.created_at,obj.currency,obj.error_occured,obj.has_parent_transaction,obj.id,obj.integration_id,obj.is_3d_secure,obj.is_auth,obj.is_capture,obj.is_refunded,obj.is_standalone_payment,obj.is_voided,order.id,obj.owner,obj.pending,source.pan,source.sub_type,source.type,obj.success].map(v=>v===true?"true":v===false?"false":String(v??""));
 const expected=crypto.createHmac("sha512",secret).update(values.join("")).digest("hex");
 const actual=Buffer.from(String(received));const expectedBuf=Buffer.from(expected);return actual.length===expectedBuf.length&&crypto.timingSafeEqual(expectedBuf,actual);
}
app.post("/api/subscription/signup",rateLimit({windowMs:10*60*1000,max:5,keyPrefix:"subscription-signup"}),async(q,r)=>{
 if(!authClient||!supabase)return r.status(503).json({error:"Supabase Auth is not configured."});
 const email=String(q.body?.email||"").trim().toLowerCase(),password=String(q.body?.password||""),name=String(q.body?.name||"").trim(),phone=String(q.body?.phone||"").trim(),planCode=String(q.body?.plan||"").trim().toLowerCase();
 if(!email||password.length<8||!name||!planCode)return r.status(400).json({error:"Name, email, password (8+ characters), and a subscription plan are required."});
 const plan=await supabase.from("subscription_plans").select("id,code,name,duration_days,price").eq("code",planCode).eq("active",true).maybeSingle();
 if(plan.error)return r.status(500).json({error:"Could not load the selected plan."});
 if(!plan.data)return r.status(400).json({error:"The selected subscription plan is unavailable."});
 const price=Number(plan.data.price||0);
 if(!Number.isFinite(price)||price<=0)return r.status(400).json({error:"The selected plan has an invalid price."});
 const signed=await authClient.auth.signUp({email,password,options:{data:{name,phone}}});
 if(signed.error)return r.status(400).json({error:signed.error.message});
 const user=signed.data.user;
 if(!user)return r.status(400).json({error:"Account could not be created."});
 const brandId=crypto.randomUUID();
 const baseSlug=name.toLowerCase().normalize("NFKD").replace(/[\\u0300-\\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,48)||"store";
 const brandSlug=baseSlug+"-"+crypto.randomBytes(4).toString("hex");
 const brand=await supabase.from("brands").insert({id:brandId,name:name+" Store",slug:brandSlug,active:true,website_url:null,settings:{}}).select("id").single();
 if(brand.error){await supabase.auth.admin.deleteUser(user.id);return r.status(500).json({error:"Store workspace could not be created."});}
 const profile=await supabase.from("profiles").update({brand_id:brandId,role:"admin",name,phone}).eq("id",user.id);
 if(profile.error){await supabase.from("brands").delete().eq("id",brandId);await supabase.auth.admin.deleteUser(user.id);return r.status(500).json({error:"Account could not be assigned to its store workspace."});}
 const paymentRef="BPC-"+crypto.randomBytes(12).toString("hex");
 const now=new Date(),activationExpires=addDays(now,1/24);
 const pending=await supabase.from("subscriptions").insert({
   brand_id:brandId,auth_user_id:user.id,plan_id:plan.data.id,status:"pending",
   starts_at:null,expires_at:null,activation_code_hash:hashActivationCode(paymentRef),
   activation_expires_at:activationExpires.toISOString(),customer_name:name,customer_email:email,
   payment_method:"paymob",updated_at:now.toISOString()
 }).select("id").single();
 if(pending.error){await supabase.auth.admin.deleteUser(user.id);return r.status(500).json({error:"Could not create the pending subscription."});}
  const requestedMethod=String(q.body?.payment_method||"paymob").trim().toLowerCase();
 if(requestedMethod==="instapay"||requestedMethod==="vodafone_cash"){
  const manual=await getPlatformPaymentSettings();
  await supabase.from("subscriptions").update({payment_method:requestedMethod,activation_code_hash:null,activation_expires_at:null,updated_at:new Date().toISOString()}).eq("id",pending.data.id);
  return r.status(201).json({
   user:{id:user.id,email:user.email||email},session:signed.data.session||null,requires_email_confirmation:!signed.data.session,
   subscription:{id:pending.data.id,plan:plan.data,status:"pending"},
   payment:{method:requestedMethod,status:"pending",reference:paymentRef,instructions:requestedMethod==="instapay"?{
    address:manual.instapayAddress,name:manual.instapayName,bank:manual.instapayBank,account:manual.instapayAccount,amount:price,currency:"EGP"
   }:{number:manual.vodafoneCashNumber,name:manual.vodafoneCashName,amount:price,currency:"EGP"}}
  });
 }
 let payment;
 try{payment=await createPaymobIntention({amountCents:Math.round(price*100),email,name,phone,planName:plan.data.name,paymentRef});}
 catch(error){
  await supabase.from("subscriptions").delete().eq("id",pending.data.id);
  await supabase.auth.admin.deleteUser(user.id);
  const msg=String(error?.message||"");
  if(msg==="PAYMOB_NOT_CONFIGURED"||msg==="PUBLIC_BASE_URL_NOT_CONFIGURED")return r.status(503).json({error:"Online payment is not configured yet. Please contact support for manual payment."});
  return r.status(502).json({error:"Could not start the secure payment checkout. Please try again."});
 }
 r.status(201).json({user:{id:user.id,email:user.email||email},session:signed.data.session||null,requires_email_confirmation:!signed.data.session,subscription:{id:pending.data.id,plan:plan.data},payment:{checkout_url:paymobCheckoutUrl(payment.clientSecret),reference:paymentRef}});
});
app.post("/api/payments/paymob/webhook",async(q,r)=>{
 const received=String(q.query?.hmac||"").trim(),obj=q.body?.obj;
 if(!paymobTxnHmacValid(obj,received))return r.status(200).json({ok:false});
 const order=obj?.order||{},reference=String(order?.merchant_order_id||"").trim();
 if(!reference)return r.status(200).json({ok:true});
 const sub=await supabase.from("subscriptions").select("id,auth_user_id,plan_id,status,activation_code_hash,subscription_plans(code,duration_days,price)").eq("activation_code_hash",hashActivationCode(reference)).eq("status","pending").maybeSingle();
 if(sub.error||!sub.data)return r.status(200).json({ok:true});
 const expectedCents=Math.round(Number(sub.data.subscription_plans?.price||0)*100);
 const paidCents=Number(obj.amount_cents||0);
 if(!obj.success||obj.error_occured||obj.is_refunded||paidCents!==expectedCents){
  await supabase.from("subscriptions").update({status:"failed",updated_at:new Date().toISOString()}).eq("id",sub.data.id).eq("status","pending");
  return r.status(200).json({ok:true});
 }
 const now=new Date(),days=Number(sub.data.subscription_plans?.duration_days||30),expires=addDays(now,days);
 await supabase.from("subscriptions").update({
  status:"active",starts_at:now.toISOString(),expires_at:expires.toISOString(),
  activation_code_hash:null,activation_expires_at:null,payment_method:"paymob",updated_at:now.toISOString()
 }).eq("id",sub.data.id).eq("status","pending");
 r.status(200).json({ok:true});
});
app.post("/api/subscription/instapay-reference",rateLimit({windowMs:10*60*1000,max:5,keyPrefix:"instapay-reference"}),async(q,r)=>{
 const user=await getAuthUser(q);if(!user)return r.status(401).json({error:"Not authenticated."});
 const reference=String(q.body?.reference||"").trim(),notes=String(q.body?.notes||"").trim();
 if(reference.length<3||reference.length>120)return r.status(400).json({error:"Enter a valid InstaPay transaction reference."});
 const sub=await supabase.from("subscriptions").select("id,status,payment_method,plan_id").eq("auth_user_id",user.id).eq("status","pending").order("created_at",{ascending:false}).limit(1).maybeSingle();
 if(sub.error)return r.status(500).json({error:"Could not load your pending subscription."});
 if(!sub.data)return r.status(404).json({error:"No pending subscription was found."});
 if(sub.data.payment_method!=="instapay")return r.status(409).json({error:"This subscription is not using InstaPay."});
 const up=await supabase.from("subscriptions").update({payment_reference:reference,notes:notes||null,updated_at:new Date().toISOString()}).eq("id",sub.data.id).eq("status","pending").select("id,payment_reference,notes,status").single();
 if(up.error)return r.status(500).json({error:"Could not save the transfer reference."});
 r.json({ok:true,subscription:up.data,status:"pending"});
});
app.post("/api/subscription/manual-transfer-reference",rateLimit({windowMs:10*60*1000,max:5,keyPrefix:"manual-transfer-reference"}),async(q,r)=>{
 const user=await getAuthUser(q);if(!user)return r.status(401).json({error:"Not authenticated."});
 const method=String(q.body?.payment_method||"").trim().toLowerCase(),reference=String(q.body?.reference||"").trim(),notes=String(q.body?.notes||"").trim();
 if(!["instapay","vodafone_cash"].includes(method))return r.status(400).json({error:"Unsupported manual payment method."});
 if(reference.length<3||reference.length>120)return r.status(400).json({error:"Enter a valid transaction reference."});
 const sub=await supabase.from("subscriptions").select("id,status,payment_method").eq("auth_user_id",user.id).eq("status","pending").order("created_at",{ascending:false}).limit(1).maybeSingle();
 if(sub.error)return r.status(500).json({error:"Could not load your pending subscription."});
 if(!sub.data)return r.status(404).json({error:"No pending subscription was found."});
 if(sub.data.payment_method!==method)return r.status(409).json({error:"This subscription is using a different payment method."});
 const up=await supabase.from("subscriptions").update({payment_reference:reference,notes:notes||null,updated_at:new Date().toISOString()}).eq("id",sub.data.id).eq("status","pending").select("id,payment_reference,notes,status").single();
 if(up.error)return r.status(500).json({error:"Could not save the transfer reference."});
 r.json({ok:true,subscription:up.data,status:"pending"});
});
app.get("/api/subscription/status",async(q,r)=>{
 const user=await getAuthUser(q);if(!user)return r.status(401).json({error:"Not authenticated."});
 const sub=await getSubscriptionForUser(user.id);r.json({subscription:subscriptionView(sub)});
});
app.post("/api/desktop/auth/login",rateLimit({windowMs:10*60*1000,max:10,keyPrefix:"desktop-login"}),async(q,r)=>{
 if(!authClient||!supabase)return r.status(503).json({error:"Supabase Auth is not configured."});
 const email=String(q.body?.email||"").trim(),password=String(q.body?.password||"");
 if(!email||!password)return r.status(400).json({error:"Email and password are required."});
 const signed=await authClient.auth.signInWithPassword({email,password});
 if(signed.error||!signed.data?.session)return r.status(401).json({error:"Invalid email or password."});
 const user=signed.data.user;let profile=await getAuthProfile(user.id);
 if(profile?.role!=="admin"||!profile?.brand_id){await authClient.auth.signOut();return r.status(403).json({error:"This account is not assigned to a BPC company administrator."});}
 profile=await ensureSubscriberWorkspace(user,profile);
 const brand=await supabase.from("brands").select("id,name,slug,active,website_url").eq("id",profile.brand_id).maybeSingle();
 if(brand.error||!brand.data?.active){await authClient.auth.signOut();return r.status(403).json({error:"This company is inactive or unavailable."});}
 const gate=isSuperAdminUser(user)?{ok:true,view:{status:"super_admin",active:true,warning:false}}:await requireActiveSubscription(user.id,r);
 if(!gate.ok){await authClient.auth.signOut();return gate.response;}
 r.json({access_token:signed.data.session.access_token,refresh_token:signed.data.session.refresh_token,expires_at:signed.data.session.expires_at,user:{id:user.id,email:user.email||null},profile,brand:brand.data,subscription:gate.view});
});
async function ensureSubscriberWorkspace(user,profile){
 if(!supabase||!user?.id||!profile?.brand_id||isSuperAdminUser(user))return profile;
 const configured=String(configuredBrandId());
 const sub=await getSubscriptionForUser(user.id);
 if(!sub||String(sub.brand_id)!==configured||String(profile.brand_id)!==configured)return profile;
 const name=String(profile.name||user.user_metadata?.name||"Store").trim()||"Store";
 const baseSlug=name.toLowerCase().normalize("NFKD").replace(/[\\u0300-\\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,48)||"store";
 const brandId=crypto.randomUUID(),slug=baseSlug+"-"+crypto.randomBytes(4).toString("hex");
 const created=await supabase.from("brands").insert({id:brandId,name:name+" Store",slug,active:true,website_url:null,settings:{}}).select("id").single();
 if(created.error)return profile;
 const pu=await supabase.from("profiles").update({brand_id:brandId}).eq("id",user.id).eq("brand_id",configured);
 if(pu.error){await supabase.from("brands").delete().eq("id",brandId);return profile;}
 const su=await supabase.from("subscriptions").update({brand_id:brandId,updated_at:new Date().toISOString()}).eq("id",sub.id).eq("auth_user_id",user.id).eq("brand_id",configured);
 if(su.error){await supabase.from("profiles").update({brand_id:configured}).eq("id",user.id).eq("brand_id",brandId);await supabase.from("brands").delete().eq("id",brandId);return profile;}
 return {...profile,brand_id:brandId};
}
function isSuperAdminUser(user){
 const expected=String((process.env.BPC_SUPER_ADMIN_EMAIL||process.env.CUTDOWN_SUPER_ADMIN_EMAIL)||"").trim().toLowerCase();
 return !!expected&&String(user?.email||"").toLowerCase()===expected;
}
async function getPlatformPaymentSettings(){
 const fallback={
  instapayAddress:String(process.env.BPC_INSTAPAY_ADDRESS||"").trim(),instapayName:String(process.env.BPC_INSTAPAY_NAME||"").trim(),instapayBank:String(process.env.BPC_INSTAPAY_BANK||"").trim(),instapayAccount:String(process.env.BPC_INSTAPAY_ACCOUNT||"").trim(),
  vodafoneCashNumber:String(process.env.BPC_VODAFONE_CASH_NUMBER||"").trim(),vodafoneCashName:String(process.env.BPC_VODAFONE_CASH_NAME||"").trim()
 };
 if(!supabase)return fallback;
 const row=await supabase.from("brands").select("settings").eq("id",configuredBrandId()).maybeSingle();
 if(row.error||!row.data?.settings?.payment)return fallback;
 const p=row.data.settings.payment||{};
 return {...fallback,instapayAddress:String(p.instapayAddress??fallback.instapayAddress).trim(),instapayName:String(p.instapayName??fallback.instapayName).trim(),instapayBank:String(p.instapayBank??fallback.instapayBank).trim(),instapayAccount:String(p.instapayAccount??fallback.instapayAccount).trim(),vodafoneCashNumber:String(p.vodafoneCashNumber??fallback.vodafoneCashNumber).trim(),vodafoneCashName:String(p.vodafoneCashName??fallback.vodafoneCashName).trim()};
}
async function requireSuperAdmin(req,res){
 const user=await getAuthUser(req); if(!user)return {ok:false,response:res.status(401).json({error:"Not authenticated."})};
 if(!isSuperAdminUser(user))return {ok:false,response:res.status(403).json({error:"Super administrator access required."})};
 return {ok:true,user};
}
app.get("/api/admin/payment-settings",async(q,r)=>{
 const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;
 r.json(await getPlatformPaymentSettings());
});
app.patch("/api/admin/payment-settings",async(q,r)=>{
 const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;
 const current=await getPlatformPaymentSettings();
 const clean={...current};
 for(const key of ["instapayAddress","instapayName","instapayBank","instapayAccount","vodafoneCashNumber","vodafoneCashName"]){if(Object.prototype.hasOwnProperty.call(q.body||{},key))clean[key]=String(q.body[key]||"").trim().slice(0,160)}
 if(clean.vodafoneCashNumber&&!/^[0-9+\\s-]{8,25}$/.test(clean.vodafoneCashNumber))return r.status(400).json({error:"Invalid Vodafone Cash number."});
 const row=await supabase.from("brands").select("settings").eq("id",configuredBrandId()).maybeSingle();
 if(row.error||!row.data)return r.status(404).json({error:"BPC owner brand was not found."});
 const settings={...(row.data.settings||{}),payment:clean};
 const up=await supabase.from("brands").update({settings,updated_at:new Date().toISOString()}).eq("id",configuredBrandId()).select("settings").single();
 if(up.error)return r.status(500).json({error:"Could not save payment settings."});
 r.json(clean);
});
app.get("/api/admin/brands",async(q,r)=>{const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;const brands=await supabase.from("brands").select("id,name,slug,active,website_url").order("name");if(brands.error)return r.status(500).json({error:"Could not load brands."});r.json(brands.data||[])});
app.post("/api/admin/brands",async(q,r)=>{
 const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;
 const name=String(q.body?.name||"").trim(),slug=String(q.body?.slug||"").trim().toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/^-+|-+$/g,"");
 if(!name||!slug)return r.status(400).json({error:"Brand name and slug are required."});if(name.length>120||slug.length>80)return r.status(400).json({error:"Brand name or slug is too long."});
 const created=await supabase.from("brands").insert({name,slug,website_url:q.body?.website_url||null}).select("id,name,slug,active,website_url").single();
 if(created.error)return r.status(409).json({error:created.error.message}); r.status(201).json(created.data);
});
app.post("/api/admin/brands/account",async(q,r)=>{
 const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;
 const brandId=String(q.body?.brand_id||"").trim(),email=String(q.body?.email||"").trim().toLowerCase(),name=String(q.body?.name||"").trim();
 if(!brandId||!email||!name)return r.status(400).json({error:"brand_id, email and name are required."});if(name.length>120||email.length>254)return r.status(400).json({error:"Invalid account fields."});
 const brand=await supabase.from("brands").select("id,name,active").eq("id",brandId).maybeSingle();
 if(brand.error||!brand.data?.active)return r.status(404).json({error:"Brand not found or inactive."});
 const password=crypto.randomBytes(12).toString("base64url");
 const created=await supabase.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name}});
 if(created.error)return r.status(409).json({error:created.error.message});
 const profile=await supabase.from("profiles").update({brand_id:brandId,role:"admin",name}).eq("id",created.data.user.id);
 if(profile.error)return r.status(500).json({error:"Internal server error."});
 r.status(201).json({user_id:created.data.user.id,email,brand:brand.data});
});
app.get("/api/admin/plans",async(q,r)=>{
 const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;
 const p=await supabase.from("subscription_plans").select("id,code,name,duration_days,price,active").order("duration_days");
 if(p.error)return r.status(500).json({error:"Could not load plans."});r.json(p.data||[]);
});
app.patch("/api/admin/plans/:id",async(q,r)=>{
 const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;
 const price=Number(q.body?.price),active=q.body?.active!==false;
 if(!Number.isFinite(price)||price<0)return r.status(400).json({error:"Invalid plan price."});
 const up=await supabase.from("subscription_plans").update({price,active,updated_at:new Date().toISOString()}).eq("id",q.params.id).select("id,code,name,duration_days,price,active").maybeSingle();
 if(up.error)return r.status(400).json({error:"Could not update plan."});if(!up.data)return r.status(404).json({error:"Plan not found."});r.json(up.data);
});
app.get("/api/admin/subscriptions",async(q,r)=>{
 const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;
 const subs=await supabase.from("subscriptions").select("id,brand_id,auth_user_id,status,starts_at,expires_at,customer_name,customer_email,payment_method,payment_reference,notes,created_at,last_renewed_at,subscription_plans(code,name,duration_days,price)").order("expires_at",{ascending:false}).limit(500);
 if(subs.error)return r.status(500).json({error:"Could not load subscriptions."});
 r.json(subs.data||[]);
});
app.post("/api/admin/subscriptions/create",async(q,r)=>{
 const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;
 const brandId=String(q.body?.brand_id||configuredBrandId()).trim(),email=String(q.body?.email||"").trim().toLowerCase(),name=String(q.body?.name||"").trim(),planCode=String(q.body?.plan_code||"monthly").trim(),paymentMethod=String(q.body?.payment_method||"manual"),amount=Number(q.body?.amount||0);
 if(!email||!name)return r.status(400).json({error:"Customer name and email are required."});
 const plan=await supabase.from("subscription_plans").select("id,code,name,duration_days,price").eq("code",planCode).eq("active",true).maybeSingle();
 if(plan.error||!plan.data)return r.status(400).json({error:"Invalid subscription plan."});
 const brand=await supabase.from("brands").select("id,name,active").eq("id",brandId).maybeSingle();
 if(brand.error||!brand.data?.active)return r.status(404).json({error:"Brand not found or inactive."});
 const password=crypto.randomBytes(9).toString("base64url");
 const created=await supabase.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{name}});
 if(created.error)return r.status(409).json({error:created.error.message});
 const profile=await supabase.from("profiles").update({brand_id:brandId,role:"admin",name}).eq("id",created.data.user.id);
 if(profile.error){await supabase.auth.admin.deleteUser(created.data.user.id);return r.status(500).json({error:"Could not assign the account to the company."});}
 const now=new Date(),expires=addDays(now,Number(plan.data.duration_days));
 const sub=await supabase.from("subscriptions").insert({brand_id:brandId,auth_user_id:created.data.user.id,plan_id:plan.data.id,status:"active",starts_at:now.toISOString(),expires_at:expires.toISOString(),customer_name:name,customer_email:email,payment_method:paymentMethod,payment_reference:String(q.body?.payment_reference||"").trim()||null,notes:String(q.body?.notes||"").trim()||null}).select("id").single();
 if(sub.error){await supabase.auth.admin.deleteUser(created.data.user.id);return r.status(500).json({error:"Could not create the subscription."});}
 await supabase.from("subscription_payments").insert({subscription_id:sub.data.id,amount:Number.isFinite(amount)&&amount>=0?amount:Number(plan.data.price||0),payment_method:paymentMethod,reference:String(q.body?.payment_reference||"").trim()||null,notes:String(q.body?.notes||"").trim()||null});
 r.status(201).json({account:{email,password,name},subscription:{id:sub.data.id,plan:plan.data,starts_at:now.toISOString(),expires_at:expires.toISOString()}});
});
app.post("/api/admin/subscriptions/activation",async(q,r)=>{
 const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;
 const brandId=String(q.body?.brand_id||configuredBrandId()).trim(),email=String(q.body?.email||"").trim().toLowerCase(),name=String(q.body?.name||"").trim(),planCode=String(q.body?.plan_code||"monthly").trim(),amount=Number(q.body?.amount||0);
 const plan=await supabase.from("subscription_plans").select("id,code,name,duration_days,price").eq("code",planCode).eq("active",true).maybeSingle();
 if(plan.error||!plan.data||!email||!name)return r.status(400).json({error:"Valid name, email and plan are required."});
 const code=makeActivationCode(),now=new Date(),activationExpires=addDays(now,7);
 const ins=await supabase.from("subscriptions").insert({brand_id:brandId,plan_id:plan.data.id,status:"pending",activation_code_hash:hashActivationCode(code),activation_expires_at:activationExpires.toISOString(),customer_name:name,customer_email:email,payment_method:"manual",payment_reference:String(q.body?.payment_reference||"").trim()||null,notes:String(q.body?.notes||"").trim()||null}).select("id").single();
 if(ins.error)return r.status(500).json({error:"Could not create activation."});
 await supabase.from("subscription_payments").insert({subscription_id:ins.data.id,amount:Number.isFinite(amount)&&amount>=0?amount:Number(plan.data.price||0),payment_method:"manual",reference:String(q.body?.payment_reference||"").trim()||null,notes:String(q.body?.notes||"").trim()||null});
 r.status(201).json({activation_code:code,expires_at:activationExpires.toISOString(),plan:plan.data,customer:{name,email}});
});
app.post("/api/admin/subscriptions/approve-instapay",async(q,r)=>{
 const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;
 const id=String(q.body?.subscription_id||"").trim(),reference=String(q.body?.payment_reference||"").trim(),notes=String(q.body?.notes||"").trim();
 if(!id)return r.status(400).json({error:"subscription_id is required."});
 const sub=await supabase.from("subscriptions").select("id,brand_id,auth_user_id,status,payment_method,payment_reference,notes,plan_id,customer_name,customer_email,subscription_plans(code,name,duration_days,price)").eq("id",id).maybeSingle();
 if(sub.error||!sub.data)return r.status(404).json({error:"Subscription not found."});
 if(sub.data.status!=="pending"||sub.data.payment_method!=="instapay")return r.status(409).json({error:"This subscription is not a pending InstaPay payment."});
 const finalReference=reference||String(sub.data.payment_reference||"").trim();
 if(!finalReference)return r.status(400).json({error:"A transaction reference is required before approval."});
 const now=new Date(),days=Number(sub.data.subscription_plans?.duration_days||30),expires=addDays(now,days);
 const up=await supabase.from("subscriptions").update({status:"active",starts_at:now.toISOString(),expires_at:expires.toISOString(),payment_reference:finalReference,notes:notes||sub.data.notes||null,updated_at:now.toISOString()}).eq("id",id).eq("status","pending").select("id,status,starts_at,expires_at").single();
 if(up.error)return r.status(500).json({error:"Could not activate the subscription."});
 const pay=await supabase.from("subscription_payments").insert({subscription_id:id,amount:Number(sub.data.subscription_plans?.price||0),payment_method:"instapay",reference:finalReference,notes:notes||null});
 if(pay.error)return r.status(500).json({error:"Subscription activated, but the payment record could not be saved."});
 r.json({ok:true,subscription:up.data});
});
app.post("/api/admin/subscriptions/approve-manual-transfer",async(q,r)=>{
 const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;
 const id=String(q.body?.subscription_id||"").trim(),reference=String(q.body?.payment_reference||"").trim(),notes=String(q.body?.notes||"").trim();
 if(!id)return r.status(400).json({error:"subscription_id is required."});
 const sub=await supabase.from("subscriptions").select("id,brand_id,auth_user_id,status,payment_method,payment_reference,notes,plan_id,customer_name,customer_email,subscription_plans(code,name,duration_days,price)").eq("id",id).maybeSingle();
 if(sub.error||!sub.data)return r.status(404).json({error:"Subscription not found."});
 if(sub.data.status!=="pending"||!["instapay","vodafone_cash"].includes(sub.data.payment_method))return r.status(409).json({error:"This subscription is not a pending manual payment."});
 const finalReference=reference||String(sub.data.payment_reference||"").trim();if(!finalReference)return r.status(400).json({error:"A transaction reference is required before approval."});
 const now=new Date(),days=Number(sub.data.subscription_plans?.duration_days||30),expires=addDays(now,days);
 const up=await supabase.from("subscriptions").update({status:"active",starts_at:now.toISOString(),expires_at:expires.toISOString(),payment_reference:finalReference,notes:notes||sub.data.notes||null,updated_at:now.toISOString()}).eq("id",id).eq("status","pending").select("id,status,starts_at,expires_at").single();
 if(up.error)return r.status(500).json({error:"Could not activate the subscription."});
 const pay=await supabase.from("subscription_payments").insert({subscription_id:id,amount:Number(sub.data.subscription_plans?.price||0),payment_method:sub.data.payment_method,reference:finalReference,notes:notes||null});
 if(pay.error)return r.status(500).json({error:"Subscription activated, but the payment record could not be saved."});
 r.json({ok:true,subscription:up.data});
});
app.post("/api/admin/subscriptions/renew",async(q,r)=>{
 const gate=await requireSuperAdmin(q,r);if(!gate.ok)return gate.response;
 const id=String(q.body?.subscription_id||"").trim(),planCode=String(q.body?.plan_code||"").trim(),amount=Number(q.body?.amount||0);
 if(!id)return r.status(400).json({error:"subscription_id is required."});
 const sub=await supabase.from("subscriptions").select("id,status,expires_at,plan_id,brand_id").eq("id",id).maybeSingle();
 if(sub.error||!sub.data)return r.status(404).json({error:"Subscription not found."});
 const planQuery=planCode?await supabase.from("subscription_plans").select("id,code,name,duration_days,price").eq("code",planCode).eq("active",true).maybeSingle():await supabase.from("subscription_plans").select("id,code,name,duration_days,price").eq("id",sub.data.plan_id).maybeSingle();
 if(planQuery.error||!planQuery.data)return r.status(400).json({error:"Invalid renewal plan."});
 const now=new Date(),base=sub.data.expires_at&&new Date(sub.data.expires_at)>now?new Date(sub.data.expires_at):now,expires=addDays(base,Number(planQuery.data.duration_days));
 const up=await supabase.from("subscriptions").update({plan_id:planQuery.data.id,status:"active",starts_at:sub.data.status==="expired"?now.toISOString():sub.data.starts_at,expires_at:expires.toISOString(),updated_at:now.toISOString(),last_renewed_at:now.toISOString()}).eq("id",id).select("id,expires_at,status").single();
 if(up.error)return r.status(500).json({error:"Could not renew subscription."});
 await supabase.from("subscription_payments").insert({subscription_id:id,amount:Number.isFinite(amount)&&amount>=0?amount:Number(planQuery.data.price||0),payment_method:String(q.body?.payment_method||"manual"),reference:String(q.body?.payment_reference||"").trim()||null,notes:String(q.body?.notes||"").trim()||null});
 r.json({ok:true,subscription:up.data,plan:planQuery.data});
});
app.get("/api/desktop/update",async(q,r)=>{
 const user=await getAuthUser(q);if(!user)return r.status(401).json({error:"Desktop login required."});
 const profile=await getAuthProfile(user.id);if(profile?.role!=="admin"||!profile?.brand_id)return r.status(403).json({error:"Brand administrator access required."});
 const brand=await supabase.from("brands").select("id,name,desktop_update_channel,active").eq("id",profile.brand_id).maybeSingle();
 if(brand.error||!brand.data?.active)return r.status(403).json({error:"Brand is inactive."});
 const channel=String(brand.data.desktop_update_channel||"stable").trim()||"stable";
 const manifest=await supabase.from("desktop_update_manifests")
   .select("version,download_url,sha256,mandatory,updated_at")
   .eq("brand_id",profile.brand_id)
   .eq("channel",channel)
   .maybeSingle();
 if(manifest.error)return r.status(500).json({error:"Could not load desktop update manifest."});
 if(manifest.data){
   const url=String(manifest.data.download_url||"").trim();
   const sha=String(manifest.data.sha256||"").trim().toLowerCase();
   if(!/^https:\/\//i.test(url)||!/^[a-f0-9]{64}$/.test(sha))return r.status(500).json({error:"Desktop update manifest is invalid."});
   return r.json({brand:brand.data,version:String(manifest.data.version),download_url:url,sha256:sha,mandatory:manifest.data.mandatory===true,updated_at:manifest.data.updated_at});
 }
 const url=String((process.env.BPC_DESKTOP_DOWNLOAD_URL||process.env.CUTDOWN_DESKTOP_DOWNLOAD_URL)||"").trim();
 const sha=String(process.env.BPC_DESKTOP_SHA256||process.env.CUTDOWN_DESKTOP_SHA256||process.env.BPC_DESKTOP_SHA||process.env.CUTDOWN_DESKTOP_SHA||"").trim().toLowerCase();
 if(url&&/^https:\/\//i.test(url)&&/^[a-f0-9]{64}$/.test(sha)){
   return r.json({brand:brand.data,version:String((process.env.BPC_DESKTOP_VERSION||process.env.CUTDOWN_DESKTOP_VERSION)||"1.0.0"),download_url:url,sha256:sha,mandatory:String((process.env.BPC_DESKTOP_UPDATE_MANDATORY||process.env.CUTDOWN_DESKTOP_UPDATE_MANDATORY)||"false")==="true"});
 }
 return r.status(404).json({error:"No desktop update is configured for this brand/channel."});
});
app.get("/api/public-config",async(q,r)=>{if(!process.env.SUPABASE_URL)return r.status(503).json({error:"Supabase URL is not configured."});try{const brand=await resolvePublicBrand(q);if(!brand)return r.status(404).json({error:"Store brand not found or inactive."});const settings=brand.settings&&typeof brand.settings==="object"?brand.settings:{};r.json({supabaseUrl:process.env.SUPABASE_URL,supabaseKey:SUPABASE_PUBLISHABLE_KEY,brandId:brand.id,brandSlug:brand.slug,brandName:brand.name,settings,supportWhatsApp:String(process.env.BPC_SUPPORT_WHATSAPP||"").trim(),instapay:{address:String(process.env.BPC_INSTAPAY_ADDRESS||"").trim(),name:String(process.env.BPC_INSTAPAY_NAME||"").trim(),bank:String(process.env.BPC_INSTAPAY_BANK||"").trim(),account:String(process.env.BPC_INSTAPAY_ACCOUNT||"").trim()}})}catch{return r.status(503).json({error:"Could not resolve store brand."})}});
app.post("/api/auth/signup",rateLimit({windowMs:10*60*1000,max:5,keyPrefix:"customer-signup"}),async(q,r)=>{
 if(!authClient||!supabase)return r.status(503).json({error:"Supabase Auth is not configured."});
 const email=String(q.body?.email||"").trim().toLowerCase(),password=String(q.body?.password||""),name=String(q.body?.name||"").trim(),phone=String(q.body?.phone||"").trim(),slug=String(q.body?.brand_slug||"").trim().toLowerCase();
 if(!email||password.length<8||!name)return r.status(400).json({error:"Name, valid email, and password (8+ characters) are required."});
 if(name.length>120||email.length>254||phone.length>40)return r.status(400).json({error:"One or more account fields are too long."});
 const brand=slug?await supabase.from("brands").select("id,slug,active").eq("slug",slug).eq("active",true).maybeSingle():{data:null,error:null};
 if(brand.error)return r.status(503).json({error:"Could not verify store brand."});
 if(!brand.data)return r.status(404).json({error:"Store brand not found or inactive. Refresh the store and try again."});
 const signed=await authClient.auth.signUp({email,password,options:{data:{name,phone,brand_slug:brand.data.slug}}});
 if(signed.error)return r.status(400).json({error:signed.error.message});
 if(!signed.data?.user)return r.status(400).json({error:"Account could not be created."});
 r.status(201).json({user:{id:signed.data.user.id,email:signed.data.user.email||email},session:signed.data.session||null,requires_email_confirmation:!signed.data.session});
});
app.get("/api/auth/me",async(q,r)=>{
 const user=await getAuthUser(q);if(!user)return r.status(401).json({error:"Not authenticated."});
 const profile=await getAuthProfile(user.id);
 if(profile?.role==="admin"){
   const gate=isSuperAdminUser(user)?{ok:true,view:{status:"super_admin",active:true,warning:false}}:await requireActiveSubscription(user.id,r);if(!gate.ok)return gate.response;
   return r.json({user:{id:user.id,email:user.email||null},profile,subscription:gate.view});
 }
 r.json({user:{id:user.id,email:user.email||null},profile,subscription:null});
});

async function requireBrandAdmin(req,res){const user=await getAuthUser(req);if(!user)return null;const profile=await getAuthProfile(user.id);if(!profile||profile.role!=="admin"||String(profile.brand_id)!==configuredBrandId())return null;return {user,profile};}
async function requireTenantAdmin(req,res){const user=await getAuthUser(req);if(!user)return res.status(401).json({error:"Sign in to continue."});const profile=await getAuthProfile(user.id);if(!profile||profile.role!=="admin"||!profile.brand_id)return res.status(403).json({error:"Company administrator access required."});const brand=await supabase.from("brands").select("id,name,slug,active,website_url").eq("id",profile.brand_id).maybeSingle();if(brand.error)return res.status(503).json({error:"Could not verify company access."});if(!brand.data?.active)return res.status(403).json({error:"This company is inactive."});const gate=isSuperAdminUser(user)?{ok:true,view:{status:"super_admin",active:true,warning:false}}:await requireActiveSubscription(user.id,res);if(!gate.ok)return gate.response;req.tenant={user,profile,brand:brand.data,brandId:String(profile.brand_id),subscription:gate.view};return null;}
app.get("/api/app/session",async(q,r)=>{const denied=await requireTenantAdmin(q,r);if(denied)return denied;const profile=await ensureSubscriberWorkspace(q.tenant.user,q.tenant.profile);if(String(profile.brand_id)!==String(q.tenant.brandId)){const brand=await supabase.from("brands").select("id,name,slug,active,website_url").eq("id",profile.brand_id).maybeSingle();if(brand.data){q.tenant.profile=profile;q.tenant.brand=brand.data;q.tenant.brandId=String(profile.brand_id);}}r.json({user:{id:q.tenant.user.id,email:q.tenant.user.email||null},profile:q.tenant.profile,brand:q.tenant.brand});});
app.get("/api/app/settings",async(q,r)=>{const denied=await requireTenantAdmin(q,r);if(denied)return denied;const b=await supabase.from("brands").select("settings").eq("id",q.tenant.brandId).maybeSingle();if(b.error)return r.status(500).json({error:"Could not load settings."});r.json({settings:b.data?.settings||{}});});
app.patch("/api/app/settings",async(q,r)=>{const denied=await requireTenantAdmin(q,r);if(denied)return denied;const settings=q.body?.settings;if(!settings||typeof settings!=="object"||Array.isArray(settings))return r.status(400).json({error:"Invalid settings."});const allowed=["storeName","storeType","storePhone","storeAddress","logoUrl","invoiceFooter","returnPolicy","printer","paperSize","autoPrint","primaryColor","sidebarColor","storeMode","heroImageUrl","heroTitle","heroSubtitle","heroEyebrow","storyTitle","storyText","aboutText","instagramUrl","facebookUrl","whatsappUrl","tiktokUrl","contactEmail","customDomain","templateId"];const clean={};for(const key of allowed)if(Object.prototype.hasOwnProperty.call(settings,key))clean[key]=settings[key];const u=await supabase.from("brands").update({settings:clean,updated_at:new Date().toISOString()}).eq("id",q.tenant.brandId).select("settings").single();if(u.error)return r.status(500).json({error:"Could not save settings."});r.json({settings:u.data.settings||{}});});
app.post("/api/app/store-asset",rateLimit({windowMs:60*1000,max:10,keyPrefix:"store-asset"}),async(q,r)=>{
 const denied=await requireTenantAdmin(q,r);if(denied)return denied;
 const kind=String(q.body?.kind||"").trim(),encoded=String(q.body?.data_base64||"").trim();
 if(!["logo","hero"].includes(kind)||!encoded)return r.status(400).json({error:"Store asset kind and image are required."});
 const bytes=Buffer.from(encoded,"base64");if(!bytes.length||bytes.length>3145728)return r.status(413).json({error:"Store image must be smaller than 3 MB."});
 const detected=detectImage(bytes);if(!detected)return r.status(415).json({error:"Use a valid JPG, PNG, GIF or WebP image."});
 const storagePath="brands/"+safeFileName(q.tenant.brandId)+"/store/"+kind;
 const uploaded=await supabase.storage.from("product-images").upload(storagePath,bytes,{contentType:detected.mime,upsert:true});
 if(uploaded.error)return r.status(500).json({error:"Could not upload store image."});
 const url=supabase.storage.from("product-images").getPublicUrl(storagePath).data.publicUrl;
 const key=kind==="logo"?"logoUrl":"heroImageUrl";
 const current=await supabase.from("brands").select("settings").eq("id",q.tenant.brandId).single();
 if(current.error)return r.status(500).json({error:"Could not load store settings."});
 const settings={...(current.data?.settings||{}),[key]:url};
 const saved=await supabase.from("brands").update({settings,updated_at:new Date().toISOString()}).eq("id",q.tenant.brandId).select("settings").single();
 if(saved.error)return r.status(500).json({error:"Image uploaded but could not save store settings."});
 r.status(201).json({url,settings:saved.data.settings||{}});
});
app.post("/api/app/product-image",rateLimit({windowMs:60*1000,max:20,keyPrefix:"product-image"}),async(q,r)=>{
 const denied=await requireTenantAdmin(q,r);if(denied)return denied;
 const productId=String(q.body?.product_id||"").trim(),encoded=String(q.body?.data_base64||"").trim();
 if(!productId||!encoded)return r.status(400).json({error:"Product and image data are required."});
 const owned=await supabase.from("products").select("id").eq("id",productId).eq("brand_id",q.tenant.brandId).maybeSingle();
 if(owned.error)return r.status(500).json({error:"Could not verify product."});if(!owned.data)return r.status(404).json({error:"Product not found for this brand."});
 const bytes=Buffer.from(encoded,"base64");if(!bytes.length||bytes.length>1572864)return r.status(413).json({error:"Image must be smaller than 1.5 MB."});
 const detected=detectImage(bytes);if(!detected)return r.status(415).json({error:"Use a valid JPG, PNG, GIF or WebP image."});
 const storagePath="brands/"+safeFileName(q.tenant.brandId)+"/web/"+safeFileName(productId)+"/primary";
 const uploaded=await supabase.storage.from("product-images").upload(storagePath,bytes,{contentType:detected.mime,upsert:true});
 if(uploaded.error)return r.status(500).json({error:"Could not upload product image."});
 const imageUrl=supabase.storage.from("product-images").getPublicUrl(storagePath).data.publicUrl;
 const saved=await supabase.from("products").update({image_url:imageUrl,updated_at:new Date().toISOString()}).eq("id",productId).eq("brand_id",q.tenant.brandId).select("id,image_url").single();
 if(saved.error)return r.status(500).json({error:"Image uploaded but could not be assigned to product."});
 r.status(201).json(saved.data);
});
app.get("/api/app/products",rateLimit({windowMs:60*1000,max:90,keyPrefix:"app-products"}),async(q,r)=>{const denied=await requireTenantAdmin(q,r);if(denied)return denied;const brandId=q.tenant.brandId;const p=await supabase.from("products").select("id,desktop_id,sku,name,category,description,price,cost_price,stock,minimum_stock,active,is_active,image_url,created_at,updated_at").eq("brand_id",brandId).order("created_at",{ascending:false}).limit(500);if(p.error)return r.status(503).json({error:"Could not load company products."});const ids=(p.data||[]).map(x=>x.id);if(!ids.length)return r.json({products:[]});const [v,i]=await Promise.all([supabase.from("product_variants").select("id,product_id,sku,size,color,stock,active").eq("brand_id",brandId).in("product_id",ids),supabase.from("product_images").select("id,product_id,public_url,storage_path,alt_text,sort_order,color,is_primary").eq("brand_id",brandId).in("product_id",ids).order("sort_order")]);if(v.error||i.error)return r.status(503).json({error:"Could not load product details."});const vm=new Map(),im=new Map();for(const x of v.data||[]){if(!vm.has(x.product_id))vm.set(x.product_id,[]);vm.get(x.product_id).push(x);}for(const x of i.data||[]){if(!im.has(x.product_id))im.set(x.product_id,[]);im.get(x.product_id).push(x);}r.json({products:(p.data||[]).map(x=>({...x,variants:vm.get(x.id)||[],images:im.get(x.id)||[]}))});});
app.post("/api/app/inventory/adjust",rateLimit({windowMs:60*1000,max:60,keyPrefix:"inventory-adjust"}),async(q,r)=>{
 const denied=await requireTenantAdmin(q,r);if(denied)return denied;
 const inventoryId=String(q.body?.inventory_id||"").trim(),quantity=Number(q.body?.quantity);
 if(!inventoryId||!Number.isSafeInteger(quantity)||quantity<0)return r.status(400).json({error:"Inventory row and a non-negative whole quantity are required."});
 const result=await supabase.rpc("adjust_inventory_stock",{p_inventory_id:inventoryId,p_quantity:quantity,p_brand_id:q.tenant.brandId});
 if(result.error){const msg=String(result.error.message||"");if(msg.includes("INVENTORY_NOT_FOUND"))return r.status(404).json({error:"Inventory row not found for this brand."});if(msg.includes("PRODUCT_USES_VARIANTS"))return r.status(409).json({error:"This product uses sizes/colors. Adjust stock on each variant instead."});if(msg.includes("INVALID_VARIANT_STOCK")||msg.includes("INVALID_PRODUCT_STOCK"))return r.status(409).json({error:"The adjustment would make stock negative."});if(msg.includes("INVALID_INVENTORY_QUANTITY"))return r.status(400).json({error:"Invalid stock quantity."});return r.status(500).json({error:"Could not adjust inventory."});}
 r.json({ok:true,inventory:result.data});
});
app.get("/api/app/inventory",rateLimit({windowMs:60*1000,max:90,keyPrefix:"app-inventory"}),async(q,r)=>{const denied=await requireTenantAdmin(q,r);if(denied)return denied;const brandId=q.tenant.brandId;const [s,w]=await Promise.all([supabase.from("inventory").select("id,product_id,variant_id,warehouse_id,quantity,updated_at").eq("brand_id",brandId).order("updated_at",{ascending:false}).limit(2000),supabase.from("warehouses").select("id,desktop_id,name,location,active").eq("brand_id",brandId).order("name")]);if(s.error||w.error)return r.status(503).json({error:"Could not load company inventory."});const pids=[...new Set((s.data||[]).map(x=>x.product_id))],vids=[...new Set((s.data||[]).map(x=>x.variant_id).filter(Boolean))];const [p,v]=await Promise.all([pids.length?supabase.from("products").select("id,name,sku,minimum_stock").eq("brand_id",brandId).in("id",pids):Promise.resolve({data:[],error:null}),vids.length?supabase.from("product_variants").select("id,size,color,sku").eq("brand_id",brandId).in("id",vids):Promise.resolve({data:[],error:null})]);if(p.error||v.error)return r.status(503).json({error:"Could not resolve inventory items."});const pm=new Map((p.data||[]).map(x=>[x.id,x])),vm=new Map((v.data||[]).map(x=>[x.id,x])),wm=new Map((w.data||[]).map(x=>[x.id,x]));r.json({warehouses:w.data||[],items:(s.data||[]).map(x=>({...x,product:pm.get(x.product_id)||null,variant:x.variant_id?vm.get(x.variant_id)||null:null,warehouse:wm.get(x.warehouse_id)||null}))});});

app.get("/api/admin/ping",async(q,r)=>{const admin=await requireBrandAdmin(q,r);if(!admin)return r.status(403).json({error:"Admin access required."});r.json({ok:true,admin:true,brand_id:admin.profile.brand_id})});
app.post("/api/account/profile",async(q,r)=>{
 const user=await getAuthUser(q); if(!user)return r.status(401).json({error:"Not authenticated."});
 const accountProfile=await getAuthProfile(user.id); if(!accountProfile?.brand_id)return r.status(403).json({error:"This account is not assigned to a brand."});
 let customer;try{customer=await ensureCustomerForUser(user)}catch(e){return r.status(500).json({error:"Could not load customer profile."})}
 const {name,phone,city,address}=q.body||{};const patch={};
 if(name!==undefined)patch.name=String(name).trim();if(phone!==undefined)patch.phone=String(phone).trim();if(city!==undefined)patch.city=String(city).trim();if(address!==undefined)patch.address=String(address).trim();
 if(!Object.keys(patch).length)return r.status(400).json({error:"No profile changes."});
 const profile=await getAuthProfile(user.id); const updated=await supabase.from("customers").update(patch).eq("id",customer.id).eq("brand_id",String(profile?.brand_id||"")).select("id,name,email,phone,city,address").maybeSingle();
 if(updated.error)return r.status(500).json({error:"Internal server error."});if(!updated.data)return r.status(404).json({error:"Customer profile not found."});r.json({customer:updated.data});
});
app.get("/api/account/orders",async(q,r)=>{
 const user=await getAuthUser(q); if(!user)return r.status(401).json({error:"Not authenticated."});
 let customer;try{customer=await ensureCustomerForUser(user)}catch(e){return r.status(500).json({error:"Could not load customer profile."})}
 const profile=await getAuthProfile(user.id); if(!profile?.brand_id)return r.status(403).json({error:"This account is not assigned to a brand."});
 const orders=await supabase.from("orders").select("*,order_items(*)").eq("brand_id",String(profile.brand_id)).eq("customer_id",customer.id).order("created_at",{ascending:false}).limit(50);
 if(orders.error)return r.status(500).json({error:"Internal server error."});r.json({customer,orders:orders.data||[]});
});
app.get("/api/admin/orders",async(q,r)=>{
 const user=await getAuthUser(q); if(!user)return r.status(401).json({error:"Not authenticated."});
 const profile=await getAuthProfile(user.id); if(profile?.role!=="admin"||!profile?.brand_id)return r.status(403).json({error:"Company administrator access required."});
 const gate=isSuperAdminUser(user)?{ok:true}:await requireActiveSubscription(user.id,r); if(!gate.ok)return gate.response;
 const brandId=String(profile.brand_id);
 const orders=await supabase.from("orders").select("*,order_items(*),customers(name,email,phone,city,address)").eq("brand_id",brandId).eq("source","website").order("created_at",{ascending:false}).limit(500);
 if(orders.error)return r.status(500).json({error:"Internal server error."});r.json((orders.data||[]).map(o=>({...o,customer:o.customers||null})));
});
app.post("/api/app/orders",rateLimit({windowMs:5*60*1000,max:30,keyPrefix:"tenant-admin-orders"}),async(q,r)=>{
 const denied=await requireTenantAdmin(q,r);if(denied)return denied;
 const brandId=q.tenant.brandId,{customer,items}=q.body||{};
 if(!customer?.name||!customer?.phone||!customer?.address||!Array.isArray(items)||!items.length)return r.status(400).json({error:"Customer name, phone, address and at least one product are required."});
 if(items.length>50||items.some(i=>!i?.product_id||!Number.isSafeInteger(Number(i.quantity))||Number(i.quantity)<1||Number(i.quantity)>100))return r.status(400).json({error:"Invalid order items."});
 const productIds=[...new Set(items.map(i=>String(i.product_id)))],variantIds=[...new Set(items.map(i=>String(i.variant_id||"")).filter(Boolean))];
 const products=await supabase.from("products").select("id,name,price,cost_price,stock,active").eq("brand_id",brandId).in("id",productIds);
 if(products.error)return r.status(500).json({error:"Could not load products."});
 const variants=variantIds.length?await supabase.from("product_variants").select("id,product_id,size,color,stock,active").eq("brand_id",brandId).in("id",variantIds):{data:[],error:null};
 if(variants.error)return r.status(500).json({error:"Could not load product variants."});
 const pm=new Map((products.data||[]).map(p=>[p.id,p])),vm=new Map((variants.data||[]).map(v=>[v.id,v]));
 let subtotal=0;const clean=[];
 for(const item of items){
  const p=pm.get(String(item.product_id)),qty=Number(item.quantity),v=item.variant_id?vm.get(String(item.variant_id)):null;
  if(!p||!p.active||!Number.isSafeInteger(qty)||qty<1||qty>100||item.variant_id&&(!v||v.product_id!==p.id||!v.active))return r.status(409).json({error:"A selected product or variant is unavailable."});
  subtotal+=Number(p.price||0)*qty;
  clean.push({product_id:p.id,variant_id:v?.id||null,product_name:p.name,quantity:qty,unit_price:Number(p.price||0),cost_price:Number(p.cost_price||0),size:v?.size||item.size||null,color:v?.color||item.color||null});
 }
 const shipping=Number(q.body?.shipping_amount||0),discount=Number(q.body?.discount||0);
 if(!Number.isFinite(shipping)||shipping<0||!Number.isFinite(discount)||discount<0||discount>subtotal+shipping)return r.status(400).json({error:"Invalid shipping or discount amount."});
 const total=subtotal+shipping-discount;
 const phone=String(customer.phone).trim();
 let customerId=null;
 const existing=await supabase.from("customers").select("id").eq("brand_id",brandId).eq("phone",phone).maybeSingle();
 if(existing.error)return r.status(500).json({error:"Could not look up customer."});
 const customerPatch={name:String(customer.name).trim(),phone,email:String(customer.email||"").trim()||null,city:String(customer.city||"").trim()||null,address:String(customer.address).trim(),updated_at:new Date().toISOString()};
 if(existing.data?.id){
  const cu=await supabase.from("customers").update(customerPatch).eq("id",existing.data.id).eq("brand_id",brandId).select("id").single();
  if(cu.error)return r.status(500).json({error:"Could not update customer."});customerId=cu.data.id;
 }else{
  const cu=await supabase.from("customers").insert({...customerPatch,brand_id:brandId}).select("id").single();
  if(cu.error)return r.status(500).json({error:"Could not create customer."});customerId=cu.data.id;
 }
 const reservation=clean.map(i=>({product_id:i.product_id,variant_id:i.variant_id,quantity:i.quantity}));
 const reserved=await supabase.rpc("reserve_stock_items",{p_items:reservation});
 if(reserved.error)return r.status(409).json({error:"Not enough stock for this order."});
 const order=await supabase.from("orders").insert({brand_id:brandId,customer_id:customerId,customer_name:customerPatch.name,customer_phone:phone,customer_email:customerPatch.email,city:customerPatch.city,address:customerPatch.address,notes:String(customer.notes||"").trim()||null,payment_method:"cod",payment_status:"pending",order_status:"Not Prepared",delivery_status:"Pending",total_amount:total,discount,shipping_amount:shipping,source:"website",stock_reserved:true}).select("id").single();
 if(order.error){await supabase.rpc("release_stock_items",{p_items:reservation});return r.status(500).json({error:"Could not create order."});}
 const inserted=await supabase.from("order_items").insert(clean.map(i=>({...i,order_id:order.data.id,brand_id:brandId})));
 if(inserted.error){await supabase.rpc("release_stock_items",{p_items:reservation});await supabase.from("orders").delete().eq("id",order.data.id).eq("brand_id",brandId);return r.status(500).json({error:"Could not save order items."});}
 r.status(201).json({ok:true,order_id:order.data.id,total_amount:total});
});
app.post("/api/app/orders/return",async(q,r)=>{
 const denied=await requireTenantAdmin(q,r);if(denied)return denied;
 const {order_id,reason,disposition,amount,loss}=q.body||{};
 if(!order_id)return r.status(400).json({error:"Missing order_id."});
 const owned=await supabase.from("orders").select("id").eq("id",order_id).eq("brand_id",q.tenant.brandId).eq("source","website").maybeSingle();
 if(owned.error)return r.status(500).json({error:"Could not verify order ownership."});
 if(!owned.data)return r.status(404).json({error:"Website order not found."});
 const result=await supabase.rpc("process_whole_order_return",{p_order_id:order_id,p_reason:String(reason||"Customer Return"),p_disposition:String(disposition||"Return to Stock"),p_refund_amount:Number(amount||0),p_loss:Number(loss||0)});
 if(result.error){
  const msg=String(result.error.message||"");
  if(msg.includes("WEBSITE_ORDER_NOT_FOUND"))return r.status(404).json({error:"Website order not found."});
  if(msg.includes("INVALID_RETURN_DISPOSITION"))return r.status(400).json({error:"Invalid return disposition."});
  if(msg.includes("INVALID_REFUND_AMOUNT"))return r.status(400).json({error:"Invalid refund amount."});
  if(msg.includes("INVALID_LOSS_AMOUNT"))return r.status(400).json({error:"Invalid loss amount."});
  if(msg.includes("ORDER_NOT_CONFIRMED"))return r.status(409).json({error:"Order is not confirmed for return."});
  if(msg.includes("ORDER_STOCK_NOT_RESERVED"))return r.status(409).json({error:"Order stock is no longer reserved."});
  return r.status(500).json({error:"Could not process return."});
 }
 r.json({ok:true,processed:result.data===true});
});
app.post("/api/admin/orders/status",async(q,r)=>{
 const user=await getAuthUser(q); if(!user)return r.status(401).json({error:"Not authenticated."});
 const profile=await getAuthProfile(user.id); if(profile?.role!=="admin"||!profile?.brand_id)return r.status(403).json({error:"Company administrator access required."});
 const gate=isSuperAdminUser(user)?{ok:true}:await requireActiveSubscription(user.id,r); if(!gate.ok)return gate.response;
 const brandId=String(profile.brand_id);
 const {order_id,order_status,delivery_status}=q.body||{};if(!order_id||(!order_status&&!delivery_status))return r.status(400).json({error:"Missing order status."});
 const orderStatuses=["Not Prepared","Preparing","Prepared","Completed"];
 const deliveryStatuses=["Pending","With Shipping Company","Out for Delivery","Delivered","Returned"];
 if(order_status&&!orderStatuses.includes(String(order_status)))return r.status(400).json({error:"Invalid order status."});
 if(delivery_status&&!deliveryStatuses.includes(String(delivery_status)))return r.status(400).json({error:"Invalid delivery status."});
 const patch={}; if(order_status)patch.order_status=String(order_status);if(delivery_status)patch.delivery_status=String(delivery_status);
 const updated=await supabase.from("orders").update(patch).eq("id",order_id).eq("brand_id",brandId).eq("source","website").select("id,order_status,delivery_status").maybeSingle();
 if(updated.error)return r.status(500).json({error:"Internal server error."});if(!updated.data)return r.status(404).json({error:"Website order not found."});r.json({ok:true,order:updated.data});
});

/* BPC system API — tenant-scoped management surface. */
app.use("/api/system",rateLimit({windowMs:60*1000,max:120,keyPrefix:"system-api"}));
const SYSTEM_TABLES={
  products:["id","desktop_id","sku","name","slug","category","description","image_url","price","cost_price","stock","minimum_stock","active","is_active","created_at","updated_at"],
  product_variants:["id","product_id","desktop_variant_id","sku","size","color","stock","active","created_at","updated_at"],
  warehouses:["id","desktop_id","name","location","active","created_at","updated_at"],
  inventory:["id","product_id","variant_id","warehouse_id","quantity","updated_at"],
  customers:["id","auth_user_id","desktop_id","name","email","phone","additional_phone","city","address","status","total_orders","total_spent","last_order_at","created_at","updated_at"],
  orders:["id","desktop_id","customer_id","customer_name","customer_phone","customer_email","city","address","notes","payment_method","payment_status","order_status","delivery_status","total_amount","discount","source","shipping_amount","stock_reserved","created_at","updated_at"],
  order_items:["id","order_id","product_id","product_name","quantity","unit_price","cost_price","size","color","variant_id","desktop_id","brand_id"],
  returns:["id","desktop_id","order_id","customer_id","return_type","reason","disposition","refund_amount","loss","created_at","processed_at","notes"],
  expenses:["id","desktop_id","amount","category","description","payment_method","status","expense_date","created_at","updated_at"]
};
const SYSTEM_WRITE_TABLES=new Set(["products","product_variants","warehouses","inventory","customers","expenses"]);
async function requireSystemAdmin(q,r){
  if(!supabase)return {ok:false,response:r.status(503).json({error:"Supabase is not configured."})};
  const user=await getAuthUser(q); if(!user)return {ok:false,response:r.status(401).json({error:"Not authenticated."})};
  const profile=await getAuthProfile(user.id);
  if(profile?.role!=="admin"||!profile?.brand_id)return {ok:false,response:r.status(403).json({error:"Company administrator access required."})};
  const sub=isSuperAdminUser(user)?{ok:true,view:{status:"super_admin",active:true,warning:false}}:await requireActiveSubscription(user.id,r);if(!sub.ok)return sub;
  q.systemUser=user;q.brandId=String(profile.brand_id);q.subscription=sub.view;return {ok:true,user,profile,subscription:sub.view};
}
function systemColumns(table,obj){const allowed=new Set(SYSTEM_TABLES[table]||[]);const out={};for(const [k,v] of Object.entries(obj||{}))if(allowed.has(k)&&k!=="id"&&k!=="brand_id"&&k!=="created_at"&&k!=="updated_at")out[k]=v;return out}
app.get("/api/system/summary",async(q,r)=>{
  const gate=await requireSystemAdmin(q,r);if(!gate.ok)return gate.response;
  const tables=["products","product_variants","warehouses","inventory","customers","orders","returns","expenses"];
  const results=await Promise.all(tables.map(table=>supabase.from(table).select("id",{count:"exact",head:true}).eq("brand_id",q.brandId)));
  const bad=results.find(x=>x.error);if(bad)return r.status(500).json({error:"Could not load system summary."});
  const counts={};tables.forEach((table,i)=>{counts[table]=results[i].count||0});
  const revenue=await supabase.from("orders").select("total_amount").eq("brand_id",q.brandId).neq("order_status","cancelled");
  if(revenue.error)return r.status(500).json({error:"Could not load system summary."});
  r.json({counts,revenue:(revenue.data||[]).reduce((n,x)=>n+Number(x.total_amount||0),0)});
});
app.get("/api/system/:table",async(q,r)=>{
  const table=String(q.params.table||"");if(!SYSTEM_TABLES[table])return r.status(404).json({error:"Unknown system resource."});
  const gate=await requireSystemAdmin(q,r);if(!gate.ok)return gate.response;
  const limit=Math.min(500,Math.max(1,Number(q.query.limit||200)));let query=supabase.from(table).select(SYSTEM_TABLES[table].join(",")).eq("brand_id",q.brandId).limit(limit);
  const search=String(q.query.search||"").trim();if(search&&["products","customers","warehouses","expenses"].includes(table)){const field=table==="products"?"name":table==="customers"?"name":table==="warehouses"?"name":"description";query=query.ilike(field,"%"+search.replace(/[%_]/g,"") +"%")}
  query=query.order(table==="inventory"?"updated_at":"created_at",{ascending:false});
  const result=await query;if(result.error)return r.status(500).json({error:"Could not load "+table+"."});r.json(result.data||[]);
});
app.post("/api/system/:table",async(q,r)=>{
  const table=String(q.params.table||"");if(!SYSTEM_WRITE_TABLES.has(table))return r.status(405).json({error:"This resource is not writable here."});
  const gate=await requireSystemAdmin(q,r);if(!gate.ok)return gate.response;
  const row=systemColumns(table,q.body);row.brand_id=q.brandId;
  if(table==="products"){
    if(!String(row.name||"").trim())return r.status(400).json({error:"Product name is required."});
    row.name=String(row.name).trim();
    row.slug=String(row.slug||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,90)||("product-"+Date.now());
    row.price=Number(row.price??0);row.cost_price=Number(row.cost_price??0);if(!Number.isFinite(row.price)||row.price<0||!Number.isFinite(row.cost_price)||row.cost_price<0)return r.status(400).json({error:"Prices must be valid non-negative numbers."});
    row.stock=Number(row.stock??0);row.minimum_stock=Number(row.minimum_stock??0);if(!Number.isSafeInteger(row.stock)||row.stock<0||!Number.isSafeInteger(row.minimum_stock)||row.minimum_stock<0)return r.status(400).json({error:"Stock and minimum stock must be whole non-negative numbers."});
    row.active=row.active!==false;row.is_active=row.active;
  }
  if(table==="warehouses"&&!String(row.name||"").trim())return r.status(400).json({error:"Warehouse name is required."});
  if(table==="customers"&&!String(row.name||"").trim())return r.status(400).json({error:"Customer name is required."});
  if(table==="product_variants"){row.stock=Number(row.stock??0);if(!row.product_id)return r.status(400).json({error:"Select a product for this variant."});if(!String(row.size||"").trim()&&!String(row.color||"").trim())return r.status(400).json({error:"A variant needs a size or color."});if(!Number.isSafeInteger(row.stock)||row.stock<0)return r.status(400).json({error:"Variant stock must be a whole non-negative number."});const owner=await supabase.from("products").select("id").eq("id",row.product_id).eq("brand_id",q.brandId).maybeSingle();if(owner.error||!owner.data)return r.status(400).json({error:"Product does not belong to this brand."});}
  const ins=await supabase.from(table).insert(row).select(SYSTEM_TABLES[table].join(",")).single();if(ins.error)return r.status(400).json({error:"Could not create "+table+" record.",detail:ins.error.message});if(table==="products"){let wh=await supabase.from("warehouses").select("id").eq("brand_id",q.brandId).eq("active",true).order("created_at",{ascending:true}).limit(1).maybeSingle();if(wh.error)return r.status(500).json({error:"Product created but warehouse lookup failed."});if(!wh.data){const nw=await supabase.from("warehouses").insert({brand_id:q.brandId,name:"Main Warehouse",location:"",active:true}).select("id").single();if(nw.error)return r.status(500).json({error:"Product created but main warehouse could not be created."});wh={data:nw.data}}const inv=await supabase.from("inventory").insert({brand_id:q.brandId,product_id:ins.data.id,warehouse_id:wh.data.id,quantity:Number(ins.data.stock||0)});if(inv.error)return r.status(500).json({error:"Product created but inventory could not be initialized."});}
  if(table==="product_variants"){
    const product=await supabase.from("products").select("id").eq("id",row.product_id).eq("brand_id",q.brandId).maybeSingle();
    if(product.error||!product.data){await supabase.from("product_variants").delete().eq("id",ins.data.id).eq("brand_id",q.brandId);return r.status(400).json({error:"Product does not belong to this brand."});}
    let wh=await supabase.from("warehouses").select("id").eq("brand_id",q.brandId).eq("active",true).order("created_at",{ascending:true}).limit(1).maybeSingle();
    if(wh.error)return r.status(500).json({error:"Variant created but warehouse lookup failed."});
    if(!wh.data){const nw=await supabase.from("warehouses").insert({brand_id:q.brandId,name:"Main Warehouse",location:"",active:true}).select("id").single();if(nw.error)return r.status(500).json({error:"Variant created but warehouse could not be created."});wh={data:nw.data};}
    const inv=await supabase.from("inventory").insert({brand_id:q.brandId,product_id:row.product_id,variant_id:ins.data.id,warehouse_id:wh.data.id,quantity:Number(ins.data.stock||0)});
    if(inv.error){await supabase.from("product_variants").delete().eq("id",ins.data.id).eq("brand_id",q.brandId);return r.status(500).json({error:"Could not initialize variant inventory."});}
    const base=await supabase.from("inventory").update({quantity:0,updated_at:new Date().toISOString()}).eq("brand_id",q.brandId).eq("product_id",row.product_id).is("variant_id",null);
    if(base.error)return r.status(500).json({error:"Variant inventory created but base stock could not be reconciled."});
    const all=await supabase.from("product_variants").select("stock").eq("brand_id",q.brandId).eq("product_id",row.product_id).eq("active",true);
    if(all.error)return r.status(500).json({error:"Could not calculate product stock."});
    const total=(all.data||[]).reduce((n,x)=>n+Number(x.stock||0),0);
    const synced=await supabase.from("products").update({stock:total,updated_at:new Date().toISOString()}).eq("id",row.product_id).eq("brand_id",q.brandId);
    if(synced.error)return r.status(500).json({error:"Could not sync product stock."});
  }
  r.status(201).json(ins.data);
});
app.patch("/api/system/:table/:id",async(q,r)=>{
  const table=String(q.params.table||"");if(!SYSTEM_WRITE_TABLES.has(table))return r.status(405).json({error:"This resource is not writable here."});
  const gate=await requireSystemAdmin(q,r);if(!gate.ok)return gate.response;
  const patch=systemColumns(table,q.body);patch.updated_at=new Date().toISOString();if(table==="products"){if("name" in patch&&!String(patch.name||"").trim())return r.status(400).json({error:"Product name is required."});for(const key of ["price","cost_price"])if(key in patch&&(!Number.isFinite(Number(patch[key]))||Number(patch[key])<0))return r.status(400).json({error:"Prices must be valid non-negative numbers."});for(const key of ["stock","minimum_stock"])if(key in patch&&(!Number.isSafeInteger(Number(patch[key]))||Number(patch[key])<0))return r.status(400).json({error:"Stock and minimum stock must be whole non-negative numbers."});}if(table==="product_variants"){if("stock" in patch&&(!Number.isSafeInteger(Number(patch.stock))||Number(patch.stock)<0))return r.status(400).json({error:"Variant stock must be a whole non-negative number."});if(("size" in patch||"color" in patch)&&!String(patch.size??"").trim()&&!String(patch.color??"").trim())return r.status(400).json({error:"A variant needs a size or color."});}
  const up=await supabase.from(table).update(patch).eq("id",q.params.id).eq("brand_id",q.brandId).select(SYSTEM_TABLES[table].join(",")).maybeSingle();if(up.error)return r.status(400).json({error:"Could not update record.",detail:up.error.message});if(!up.data)return r.status(404).json({error:"Record not found."});if(table==="product_variants"){const variants=await supabase.from("product_variants").select("stock").eq("brand_id",q.brandId).eq("product_id",up.data.product_id).eq("active",true);if(variants.error)return r.status(500).json({error:"Variant saved, but product stock could not be recalculated."});const total=(variants.data||[]).reduce((n,v)=>n+Number(v.stock||0),0);const synced=await supabase.from("products").update({stock:total,updated_at:new Date().toISOString()}).eq("id",up.data.product_id).eq("brand_id",q.brandId);if(synced.error)return r.status(500).json({error:"Variant saved, but product stock could not be synchronized."});}r.json(up.data);
});
app.delete("/api/system/:table/:id",async(q,r)=>{
  const table=String(q.params.table||"");if(!SYSTEM_WRITE_TABLES.has(table))return r.status(405).json({error:"This resource is not writable here."});
  const gate=await requireSystemAdmin(q,r);if(!gate.ok)return gate.response;
  const del=await supabase.from(table).delete().eq("id",q.params.id).eq("brand_id",q.brandId);if(del.error)return r.status(400).json({error:"Could not delete record.",detail:del.error.message});r.json({ok:true});
});

/* Railway healthcheck: keep this endpoint lightweight and independent of external services.
   The application can still report Supabase failures through its normal API endpoints. */
app.get("/api/health",(_q,r)=>r.status(200).json({ok:true,service:"bpc-clothes-system"}));

app.get("/api/products",async(q,r)=>{
 if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
 let brand;try{brand=await resolvePublicBrand(q)}catch{return r.status(503).json({error:"Could not resolve store brand."})}
 if(!brand)return r.status(404).json({error:"Store brand not found or inactive."});
 const brandId=String(brand.id); const {data,error}=await supabase.from("products").select("*").eq("brand_id",brandId).eq("active",true).order("created_at",{ascending:false});
 if(error)return r.status(500).json({error:"Could not load products."});const products=data||[],ids=products.map(p=>p.id);if(!ids.length)return r.json([]);
 const {data:variants}=await supabase.from("product_variants").select("id,product_id,desktop_variant_id,sku,size,color,stock,active").eq("brand_id",brandId).in("product_id",ids).eq("active",true);
 const {data:images}=await supabase.from("product_images").select("id,product_id,storage_path,public_url,alt_text,sort_order,color").eq("brand_id",brandId).in("product_id",ids).order("sort_order",{ascending:true});
 const vm=new Map(),im=new Map();(variants||[]).forEach(v=>{if(!vm.has(v.product_id))vm.set(v.product_id,[]);vm.get(v.product_id).push(v)});(images||[]).forEach(v=>{if(!im.has(v.product_id))im.set(v.product_id,[]);im.get(v.product_id).push(v)});
 r.set("Cache-Control","public, max-age=30, stale-while-revalidate=60");r.json(products.map(p=>({...p,variants:vm.get(p.id)||[],images:im.get(p.id)||[]})));
});
app.get("/api/reviews",async(q,r)=>{if(!supabase)return r.status(503).json({error:"Supabase is not configured."});let brand;try{brand=await resolvePublicBrand(q)}catch{return r.status(503).json({error:"Could not resolve store brand."})}if(!brand)return r.status(404).json({error:"Store brand not found or inactive."});const {data,error}=await supabase.from("reviews").select("*").eq("brand_id",brand.id).eq("approved",true).order("created_at",{ascending:false});if(error)return r.status(500).json({error:"Could not load reviews."});r.set("Cache-Control","public, max-age=30, stale-while-revalidate=60");r.json(data||[])});
app.post("/api/reviews",rateLimit({windowMs:10*60*1000,max:10,keyPrefix:"reviews"}),async(q,r)=>{if(!supabase)return r.status(503).json({error:"Supabase is not configured."});let brand;try{brand=await resolvePublicBrand(q)}catch{return r.status(503).json({error:"Could not resolve store brand."})}if(!brand)return r.status(404).json({error:"Store brand not found or inactive."});const {name,rating,body}=q.body||{};if(!name?.trim()||!body?.trim()||!Number.isInteger(Number(rating))||Number(rating)<1||Number(rating)>5)return r.status(400).json({error:"Invalid review."});const {data,error}=await supabase.from("reviews").insert({brand_id:brand.id,name:name.trim().slice(0,80),rating:Number(rating),body:body.trim().slice(0,1000),approved:true}).select().single();if(error)return r.status(500).json({error:"Could not save review."});r.status(201).json(data)});
async function findOrCreateCustomer(customer,brandId=configuredBrandId()){
 if(!supabase||!customer?.phone)return null;
 const phone=String(customer.phone).trim();if(!phone)return null;
 const payload={name:String(customer.name||"").trim(),phone,email:customer.email?.trim()||null,city:customer.city?.trim()||null,address:customer.address?.trim()||null};
 const found=await supabase.from("customers").select("id").eq("brand_id",brandId).eq("phone",phone).maybeSingle();
 if(found.error)throw found.error;
 if(found.data?.id){
   const updated=await supabase.from("customers").update(payload).eq("id",found.data.id).select("id").maybeSingle();
   if(updated.error)throw updated.error;
   return found.data.id;
 }
 const created=await supabase.from("customers").insert({...payload,brand_id:brandId}).select("id").single();
 if(!created.error&&created.data?.id)return created.data.id;
 if(created.error){
   const retry=await supabase.from("customers").select("id").eq("brand_id",brandId).eq("phone",phone).maybeSingle();
   if(retry.error)throw retry.error;
   if(retry.data?.id){
     const updated=await supabase.from("customers").update(payload).eq("id",retry.data.id).select("id").maybeSingle();
     if(updated.error)throw updated.error;
     return retry.data.id;
   }
   throw created.error;
 }
 return null;
}
app.post("/api/orders",rateLimit({windowMs:5*60*1000,max:10,keyPrefix:"orders"}),async(q,r)=>{
 if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
 const {customer,items,payment_method}=q.body||{};
 let publicBrand;try{publicBrand=await resolvePublicBrand(q)}catch{return r.status(503).json({error:"Could not resolve store brand."})}
 if(!publicBrand)return r.status(404).json({error:"Store brand not found or inactive."});
 const brandId=String(publicBrand.id);
  if(!customer?.name||!customer?.phone||!customer?.address||!Array.isArray(items)||!items.length)return r.status(400).json({error:"Missing order details."});
  if(items.length>50)return r.status(400).json({error:"Too many order items."});
  if(items.some(i=>!i||!i.product_id||!Number.isSafeInteger(Number(i.quantity))||Number(i.quantity)<1||Number(i.quantity)>100))return r.status(400).json({error:"Invalid order item."});
  const fields=[["name",customer.name,120],["phone",customer.phone,40],["address",customer.address,500],["city",customer.city,100],["email",customer.email,254],["notes",customer.notes,1000]];
  if(fields.some(([_,v,max])=>v!==undefined&&String(v).length>max))return r.status(400).json({error:"One or more order fields are too long."});
  if(!["cod","online"].includes(payment_method))return r.status(400).json({error:"Invalid payment method."});
 const {data:products,error:pe}=await supabase.from("products").select("id,name,price,cost_price,stock,active").eq("brand_id",brandId).in("id",items.map(i=>i.product_id));if(pe)return r.status(500).json({error:"Could not load products."});
 const variantIds=items.map(i=>i.variant_id).filter(Boolean);let variants=[];if(variantIds.length){const vr=await supabase.from("product_variants").select("id,product_id,size,color,stock,active").eq("brand_id",brandId).in("id",variantIds);if(vr.error)return r.status(500).json({error:"Internal server error."});variants=vr.data||[]}
 const map=new Map((products||[]).map(p=>[p.id,p])),vmap=new Map(variants.map(v=>[v.id,v]));let total=0;const clean=[];
 for(const item of items){const rawQty=Number(item.quantity);if(!Number.isSafeInteger(rawQty)||rawQty<1||rawQty>100)return r.status(400).json({error:"Invalid quantity."});const p=map.get(item.product_id),n=rawQty,v=item.variant_id?vmap.get(item.variant_id):null;if(!p||!p.active||(!v&&n>p.stock)|| (v&&(!v.active||v.product_id!==p.id||n>v.stock)))return r.status(409).json({error:"The selected color or size is unavailable."});total+=Number(p.price)*n;clean.push({product_id:p.id,variant_id:v?.id||null,product_name:p.name,quantity:n,unit_price:p.price,cost_price:Number(p.cost_price||0),size:v?.size||item.size||null,color:v?.color||item.color||null})}
 const stockReservation=clean.map(i=>({product_id:i.product_id,variant_id:i.variant_id,quantity:i.quantity}));
 const authUser=await getAuthUser(q);let customerId=null;
 if(authUser){
   const accountProfile=await getAuthProfile(authUser.id);
   if(!accountProfile?.brand_id||String(accountProfile.brand_id)!==brandId)return r.status(403).json({error:"This account belongs to a different brand. Sign out to place an order as a guest."});
   try{
     const accountCustomer=await ensureCustomerForUser(authUser);
     if(!accountCustomer?.id)return r.status(403).json({error:"This account is not assigned to a customer record."});
     customerId=accountCustomer.id;
     const link=await supabase.from("customers").update({
       email:customer.email?.trim()||accountCustomer.email||null,
       phone:customer.phone?.trim()||accountCustomer.phone||null,
       city:customer.city?.trim()||accountCustomer.city||null,
       address:customer.address?.trim()||accountCustomer.address||"",
       name:customer.name?.trim()||accountCustomer.name||"Customer"
     }).eq("id",customerId).eq("brand_id",brandId).eq("auth_user_id",authUser.id);
     if(link.error)return r.status(500).json({error:"Could not update customer record."});
   }catch(e){return r.status(500).json({error:"Could not load customer record."});}
 }else{
   try{customerId=await findOrCreateCustomer(customer,brandId);}
   catch(e){return r.status(500).json({error:"Could not link customer record."});}
 }
 if(stockReservation.length){const reserve=await supabase.rpc("reserve_stock_items",{p_items:stockReservation});if(reserve.error)return r.status(409).json({error:"One or more selected sizes are no longer available."})}
 const {data:order,error:oe}=await supabase.from("orders").insert({customer_name:customer.name.trim(),customer_phone:customer.phone.trim(),customer_email:customer.email?.trim()||null,city:customer.city?.trim()||null,address:customer.address.trim(),notes:customer.notes?.trim()||null,payment_method,payment_status:"pending",order_status:"pending",total_amount:total,customer_id:customerId,brand_id:brandId,source:"website",stock_reserved:stockReservation.length>0}).select().single();
 if(oe&&stockReservation.length){await supabase.rpc("release_stock_items",{p_items:stockReservation});}if(oe)return r.status(500).json({error:"Could not create order."});
 const {error:ie}=await supabase.from("order_items").insert(clean.map(i=>({...i,order_id:order.id,brand_id:brandId})));if(ie){if(stockReservation.length)await supabase.rpc("release_stock_items",{p_items:stockReservation});await supabase.from("orders").delete().eq("id",order.id);return r.status(500).json({error:"Could not save order items."})}
 if(payment_method==="cod"){await supabase.from("orders").update({order_status:"confirmed"}).eq("id",order.id);return r.status(201).json({order_id:order.id,payment_required:false,message:"Order confirmed for cash on delivery."})}
 if(!(process.env.PAYMOB_SECRET_KEY&&process.env.PAYMOB_PUBLIC_KEY&&process.env.PAYMOB_INTEGRATION_ID&&process.env.PAYMOB_HMAC_SECRET&&base)){if(stockReservation.length){const release=await supabase.rpc("release_stock_items",{p_items:stockReservation});if(release.error)console.error("Failed to release reserved stock:",release.error.message);}await supabase.from("orders").update({stock_reserved:false,payment_status:"failed",order_status:"pending"}).eq("id",order.id);return r.status(503).json({error:"Online payment is not configured yet. Add Supabase + Paymob variables in Railway."});}
 const amountCents=Math.round(total*100),parts=customer.name.trim().split(/\s+/),first=parts[0]||"Customer",last=parts.slice(1).join(" ")||"Customer";
 const pay=await fetch(paymobBase+"/v1/intention/",{method:"POST",headers:{"Authorization":"Token "+process.env.PAYMOB_SECRET_KEY,"Content-Type":"application/json"},body:JSON.stringify({amount:amountCents,currency:"EGP",payment_methods:[Number(process.env.PAYMOB_INTEGRATION_ID)],items:clean.map(i=>({name:i.product_name,amount:Math.round(Number(i.unit_price)*100),description:"BPC Clothes System product",quantity:i.quantity})),billing_data:{first_name:first,last_name:last,email:customer.email||"no-email@cutdown.store",phone_number:customer.phone,apartment:"NA",building:"NA",street:customer.address,floor:"NA",city:customer.city||"Cairo",state:customer.city||"Cairo",country:"EGY"},special_reference:order.id,expiration:3600,notification_url:base+"/api/paymob/webhook",redirection_url:base+"/payment-result?order_id="+encodeURIComponent(order.id)})});
 const pd=await pay.json();if(!pay.ok){if(stockReservation.length)await supabase.rpc("release_stock_items",{p_items:stockReservation});await supabase.from("orders").update({stock_reserved:false,payment_status:"failed",order_status:"pending"}).eq("id",order.id);return r.status(502).json({error:"Payment provider rejected the request."});}const checkoutUrl=paymobBase+"/unifiedcheckout/?publicKey="+encodeURIComponent(process.env.PAYMOB_PUBLIC_KEY)+"&clientSecret="+encodeURIComponent(pd.client_secret);r.status(201).json({order_id:order.id,payment_required:true,checkout_url:checkoutUrl});
});
function verifyHmac(o,h){if(!o||!h||!process.env.PAYMOB_HMAC_SECRET)return false;const f=[o.amount_cents,o.created_at,o.currency,o.error_occured,o.has_parent_transaction,o.id,o.integration_id,o.is_3d_secure,o.is_auth,o.is_capture,o.is_refunded,o.is_standalone_payment,o.is_voided,o.order?.id,o.owner,o.pending,o.source_data?.pan,o.source_data?.sub_type,o.source_data?.type,o.success],c=crypto.createHmac("sha512",process.env.PAYMOB_HMAC_SECRET).update(f.map(String).join("")).digest("hex");return c.length===h.length&&crypto.timingSafeEqual(Buffer.from(c),Buffer.from(h))}
app.post("/api/paymob/webhook",async(q,r)=>{const o=q.body?.obj,h=String(q.query.hmac||"");if(!verifyHmac(o,h))return r.status(401).json({error:"Invalid HMAC"});if(!supabase)return r.sendStatus(503);const orderId=o.order?.merchant_order_id||o.merchant_order_id;if(!orderId)return r.json({received:true});const ord=await supabase.from("orders").select("id,total_amount,payment_status,order_status,stock_reserved").eq("id",orderId).eq("source","website").maybeSingle();if(ord.error)return r.sendStatus(503);if(!ord.data)return r.status(404).json({error:"Order not found"});if(o.integration_id!=null&&Number(o.integration_id)!==Number(process.env.PAYMOB_INTEGRATION_ID))return r.status(400).json({error:"Invalid payment integration"});if(String(o.currency||"").toUpperCase()!=="EGP")return r.status(400).json({error:"Invalid payment currency"});const expected=Math.round(Number(ord.data.total_amount)*100);if(Number(o.amount_cents)!==expected)return r.status(400).json({error:"Invalid payment amount"});const event={provider_event_id:String(o.id),order_id:orderId,success:o.success===true,payload:o};const inserted=await supabase.from("payment_events").upsert(event,{onConflict:"provider_event_id",ignoreDuplicates:true}).select("id").maybeSingle();if(inserted.error)return r.sendStatus(503);if(!inserted.data)return r.json({received:true,duplicate:true});const success=o.success===true&&!o.pending;const patch={payment_status:success?"paid":"failed",order_status:success?"confirmed":"pending"};if(success){if(ord.data.payment_status!=="paid")await supabase.from("orders").update(patch).eq("id",orderId).eq("payment_status","pending");}else{if(ord.data.payment_status!=="paid"){await supabase.from("orders").update(patch).eq("id",orderId);if(ord.data.stock_reserved){const it=await supabase.from("order_items").select("product_id,variant_id,quantity").eq("order_id",orderId);const items=(it.data||[]).map(x=>({product_id:x.product_id,variant_id:x.variant_id,quantity:x.quantity}));if(items.length){const release=await supabase.rpc("release_stock_items",{p_items:items});if(release.error)console.error("Failed to release reserved stock after payment failure:",release.error.message)}await supabase.from("orders").update({stock_reserved:false}).eq("id",orderId);}}}r.json({received:true})});
app.get("/api/payment-status",async(q,r)=>{if(!supabase)return r.status(503).json({error:"Supabase is not configured."});const id=String(q.query.order_id||"").trim();if(!id)return r.status(400).json({error:"Missing order_id."});const o=await supabase.from("orders").select("id,payment_status,order_status,total_amount,created_at").eq("id",id).eq("source","website").maybeSingle();if(o.error)return r.status(500).json({error:"Internal server error."});if(!o.data)return r.status(404).json({error:"Order not found."});r.json({order_id:o.data.id,payment_status:o.data.payment_status,order_status:o.data.order_status,total_amount:o.data.total_amount,created_at:o.data.created_at})});
app.get("/robots.txt",(_q,r)=>{r.type("text/plain").send("User-agent: *\nAllow: /store\nDisallow: /\nDisallow: /app\nDisallow: /admin\nDisallow: /account\nDisallow: /api/\nSitemap: "+base.replace(/\/$/,"")+"/sitemap.xml\n")});
app.get("/sitemap.xml",(_q,r)=>{const root=(base||"").replace(/\/$/,"");r.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${root}/store</loc></url></urlset>`) });
app.get("/payment-result",(_q,r)=>r.sendFile(path.join(__dirname,"payment-result.html")));app.get("/reset-password",(_q,r)=>r.sendFile(path.join(__dirname,"reset-password.html")));app.get("/account",(_q,r)=>r.sendFile(path.join(__dirname,"account.html")));app.get("/admin",(_q,r)=>r.sendFile(path.join(__dirname,"admin.html")));app.get("/app",(_q,r)=>r.sendFile(path.join(__dirname,"app.html")));app.get("/store",(_q,r)=>r.sendFile(path.join(__dirname,"index.html")));app.get("/",(_q,r)=>r.sendFile(path.join(__dirname,"index.html")));app.use((_q,r)=>r.sendFile(path.join(__dirname,"app.html")));
const port=process.env.PORT||3000;
app.use((err,q,r,next)=>{if(r.headersSent)return next(err);if(err?.type==="entity.parse.failed"||err?.type==="request.aborted"){if(err.type==="entity.parse.failed")return r.status(400).json({error:"Invalid JSON request body."});return r.status(400).json({error:"Request body was interrupted. Please retry."});}console.error("Unhandled request error:",err?.stack||err);r.status(500).json({error:"Internal server error."})});
const server=app.listen(port,()=>console.log("BPC Clothes System listening on "+port));
function shutdown(signal){console.log("Received "+signal+", shutting down gracefully.");server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),10000).unref();}
process.on("SIGTERM",()=>shutdown("SIGTERM"));
process.on("SIGINT",()=>shutdown("SIGINT"));
