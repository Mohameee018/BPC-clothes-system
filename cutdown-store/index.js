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
const allowedOrigins=String(process.env.CORS_ORIGINS||"").split(",").map(x=>x.trim().replace(/\/$/,"")).filter(Boolean);
app.use(cors({origin:(origin,cb)=>{if(!origin||allowedOrigins.includes(origin))return cb(null,true);return cb(null,false);},methods:["GET","POST","OPTIONS"],allowedHeaders:["Authorization","Content-Type"]}));
app.use((q,r,next)=>{if(q.headers.authorization)r.setHeader("Cache-Control","no-store");r.setHeader("X-Content-Type-Options","nosniff");r.setHeader("X-Frame-Options","DENY");r.setHeader("Referrer-Policy","strict-origin-when-cross-origin");r.setHeader("Permissions-Policy","camera=(),microphone=(),geolocation=()");if(q.secure)r.setHeader("Strict-Transport-Security","max-age=31536000; includeSubDomains");next()});
app.use(compression({threshold:"1kb"}));
app.use(express.json({limit:"12mb"}));
const blockedStatic=/^\/(?:server\.js|package(?:-lock)?\.json|\.env(?:\..*)?|supabase[^/]*\.sql)(?:$|\/)/i;
app.use((q,r,next)=>blockedStatic.test(q.path)?r.status(404).end():next());
app.use(express.static(__dirname,{index:"index.html",etag:true,maxAge:"1h",setHeaders:(res,file)=>{if(path.extname(file).toLowerCase()===".html")res.setHeader("Cache-Control","public, max-age=0, must-revalidate")}}));
const supabase=process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY?createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY):null;
const rateBuckets=new Map();
function rateLimit({windowMs=60000,max=60,keyPrefix="api"}={}){return (q,r,next)=>{const now=Date.now(),key=keyPrefix+":"+q.ip+":"+q.path,old=rateBuckets.get(key)||{start:now,count:0};if(now-old.start>=windowMs){old.start=now;old.count=0}old.count++;rateBuckets.set(key,old);if(old.count>max)return r.status(429).json({error:"Too many requests. Please try again later."});next()}}
setInterval(()=>{const cutoff=Date.now()-10*60*1000;for(const [k,v] of rateBuckets)if(v.start<cutoff)rateBuckets.delete(k)},5*60*1000).unref();
async function resolvePublicBrand(req){
 if(!supabase)return null;
 const host=String(req.headers?.host||"").split(":")[0].toLowerCase();
 if(host){
   const brands=await supabase.from("brands").select("id,name,slug,active,website_url,settings").eq("active",true).not("website_url","is",null).limit(500);
   if(brands.error)throw brands.error;
   const match=(brands.data||[]).find(b=>{try{return new URL(String(b.website_url||"")).hostname.toLowerCase()===host}catch{return false}});
   if(match)return match;
 }
 const requested=String(req.query?.brand||req.body?.brand_slug||"").trim().toLowerCase();
 if(requested){
   const found=await supabase.from("brands").select("id,name,slug,active,website_url,settings").eq("slug",requested).eq("active",true).maybeSingle();
   if(found.error)throw found.error;
   return found.data||null;
 }
 return null;
}

async function requireDesktopSync(q,r,next){
  if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
  const got=String(q.headers.authorization||"").replace(/^Bearer\s+/i,"").trim();
  if(!got)return r.status(401).json({error:"Desktop login required."});
  const user=await getAuthUser(q);
  if(!user)return r.status(401).json({error:"Desktop session expired. Please sign in again."});
  const profile=await getAuthProfile(user.id);
  if(profile?.role!=="admin"||!profile?.brand_id)return r.status(403).json({error:"Brand administrator access required."});
  const brandId=String(profile.brand_id);
  const brand=await supabase.from("brands").select("id,active").eq("id",brandId).maybeSingle();
  if(brand.error||!brand.data?.active)return r.status(403).json({error:"This brand is inactive or unavailable."});
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
  const variants=Array.isArray(p.variants)?p.variants:[];
  if(variants.length){const rows=variants.map(v=>({brand_id:q.brandId,desktop_variant_id:String(v.desktop_variant_id||v.id),product_id:productId,sku:String(v.sku||""),size:String(v.size||""),color:String(v.color||""),stock:Math.max(0,Number(v.stock||0)),active:v.active!==false}));const vu=await supabase.from("product_variants").upsert(rows,{onConflict:"brand_id,desktop_variant_id"});if(vu.error)return r.status(500).json({error:"Internal server error."});const ids=rows.map(v=>v.desktop_variant_id);const stale=await supabase.from("product_variants").delete().eq("brand_id",q.brandId).eq("product_id",productId).not("desktop_variant_id","in","("+ids.join(",")+")");if(stale.error)return r.status(500).json({error:"Internal server error."});}else{const clear=await supabase.from("product_variants").delete().eq("brand_id",q.brandId).eq("product_id",productId);if(clear.error)return r.status(500).json({error:"Internal server error."});}
  const inv=await supabase.from("inventory").select("id").eq("brand_id",q.brandId).eq("product_id",productId).eq("warehouse_id",warehouseId).is("variant_id",null).maybeSingle();
  if(inv.error)return r.status(500).json({error:"Internal server error."});
  if(inv.data){const iu=await supabase.from("inventory").update({quantity:stock,updated_at:new Date().toISOString()}).eq("id",inv.data.id);if(iu.error)return r.status(500).json({error:"Internal server error."});}
  else{const ii=await supabase.from("inventory").insert({brand_id:q.brandId,product_id:productId,warehouse_id:warehouseId,quantity:stock});if(ii.error)return r.status(500).json({error:"Internal server error."});}
  const images=Array.isArray(p.images)?p.images.slice(0,50):[];
  if(images.length || p.images){
    const old=await supabase.from("product_images").select("storage_path").eq("brand_id",q.brandId).eq("product_id",productId);
    if(old.data?.length)await supabase.storage.from("product-images").remove(old.data.map(x=>x.storage_path).filter(Boolean));
    await supabase.from("product_images").delete().eq("brand_id",q.brandId).eq("product_id",productId);
    const imageRows=[];
    for(const img of images){
      if(!img.data_base64)continue;
      const bytes=Buffer.from(String(img.data_base64),"base64");if(bytes.length>1572864)return r.status(413).json({error:"Product image is too large. Maximum is 1.5 MB per image."});
      const detected=detectImage(bytes);if(!detected)return r.status(415).json({error:"Unsupported product image type."});
      const ext=detected.ext,color=String(img.color||"").trim().slice(0,80),sort=Number(img.sort_order||0);
      const path="desktop/"+safeFileName(p.desktop_id)+"/"+safeFileName(color||"default")+"-"+sort+"."+ext;
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
app.post("/api/auth/signup",rateLimit({windowMs:10*60*1000,max:5,keyPrefix:"signup"}),async(q,r)=>{
 if(!authClient||!supabase)return r.status(503).json({error:"Supabase Auth is not configured."});
 const email=String(q.body?.email||"").trim().toLowerCase(),password=String(q.body?.password||""),name=String(q.body?.name||"").trim(),phone=String(q.body?.phone||"").trim();let publicBrand;try{publicBrand=await resolvePublicBrand(q)}catch{return r.status(503).json({error:"Could not resolve store brand."})}if(!publicBrand)return r.status(404).json({error:"Store brand not found or inactive."});
 if(!email||password.length<6)return r.status(400).json({error:"Email and password are required; password must be at least 6 characters."});
 const signed=await authClient.auth.signUp({email,password,options:{data:{name,phone}}});
 if(signed.error)return r.status(400).json({error:signed.error.message});
 const user=signed.data.user;
 if(!user)return r.status(400).json({error:"Account could not be created."});
 const profile=await supabase.from("profiles").update({brand_id:publicBrand.id,role:"customer",name,phone}).eq("id",user.id);
 if(profile.error)return r.status(500).json({error:"Account created but brand assignment failed. Please contact support."});
 r.status(201).json({user:{id:user.id,email:user.email||null},session:signed.data.session||null,requires_email_confirmation:!signed.data.session});
});
app.post("/api/desktop/auth/login",rateLimit({windowMs:10*60*1000,max:10,keyPrefix:"desktop-login"}),async(q,r)=>{
 if(!authClient||!supabase)return r.status(503).json({error:"Supabase Auth is not configured."});
 const email=String(q.body?.email||"").trim(),password=String(q.body?.password||"");
 if(!email||!password)return r.status(400).json({error:"Email and password are required."});
 const signed=await authClient.auth.signInWithPassword({email,password});
 if(signed.error||!signed.data?.session)return r.status(401).json({error:"Invalid email or password."});
 const user=signed.data.user,profile=await getAuthProfile(user.id);
 if(profile?.role!=="admin"||!profile?.brand_id){await authClient.auth.signOut();return r.status(403).json({error:"This account is not assigned to a brand administrator."});}
 const brand=await supabase.from("brands").select("id,name,slug,active").eq("id",profile.brand_id).maybeSingle();
 if(brand.error||!brand.data?.active){await authClient.auth.signOut();return r.status(403).json({error:"This brand is inactive or unavailable."});}
 r.json({access_token:signed.data.session.access_token,refresh_token:signed.data.session.refresh_token,expires_at:signed.data.session.expires_at,user:{id:user.id,email:user.email||null},profile,brand:brand.data});
});
async function requireSuperAdmin(req,res){
 const user=await getAuthUser(req); if(!user)return {ok:false,response:res.status(401).json({error:"Not authenticated."})};
 const expected=String(process.env.CUTDOWN_SUPER_ADMIN_EMAIL||"").trim().toLowerCase();
 if(!expected||String(user.email||"").toLowerCase()!==expected)return {ok:false,response:res.status(403).json({error:"Super administrator access required."})};
 return {ok:true,user};
}
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
 const url=String(process.env.CUTDOWN_DESKTOP_DOWNLOAD_URL||"").trim();
 const sha=String(process.env.CUTDOWN_DESKTOP_SHA256||"").trim().toLowerCase();
 if(url&&/^https:\/\//i.test(url)&&/^[a-f0-9]{64}$/.test(sha)){
   return r.json({brand:brand.data,version:String(process.env.CUTDOWN_DESKTOP_VERSION||"1.0.0"),download_url:url,sha256:sha,mandatory:String(process.env.CUTDOWN_DESKTOP_UPDATE_MANDATORY||"false")==="true"});
 }
 return r.status(404).json({error:"No desktop update is configured for this brand/channel."});
});
app.get("/api/public-config",async(q,r)=>{if(!process.env.SUPABASE_URL)return r.status(503).json({error:"Supabase URL is not configured."});try{const brand=await resolvePublicBrand(q);if(!brand)return r.status(404).json({error:"Store brand not found or inactive."});r.json({supabaseUrl:process.env.SUPABASE_URL,supabaseKey:SUPABASE_PUBLISHABLE_KEY,brandId:brand.id,brandSlug:brand.slug,brandName:brand.name,settings:brand.settings&&typeof brand.settings==="object"?brand.settings:{}})}catch{return r.status(503).json({error:"Could not resolve store brand."})}});
app.get("/api/auth/me",async(q,r)=>{const user=await getAuthUser(q);if(!user)return r.status(401).json({error:"Not authenticated."});r.json({user:{id:user.id,email:user.email||null},profile:await getAuthProfile(user.id)})});

async function requireBrandAdmin(req,res){const user=await getAuthUser(req);if(!user)return null;const profile=await getAuthProfile(user.id);if(!profile||profile.role!=="admin"||!profile.brand_id)return null;const brand=await supabase.from("brands").select("id,active").eq("id",profile.brand_id).maybeSingle();if(brand.error||!brand.data?.active)return null;return {user,profile};}
app.get("/api/admin/ping",async(q,r)=>{const admin=await requireBrandAdmin(q,r);if(!admin)return r.status(403).json({error:"Admin access required."});r.json({ok:true,admin:true,brand_id:admin.profile.brand_id})});
app.post("/api/account/profile",async(q,r)=>{
 const user=await getAuthUser(q); if(!user)return r.status(401).json({error:"Not authenticated."});
 const accountProfile=await getAuthProfile(user.id);if(!accountProfile?.brand_id)return r.status(403).json({error:"This account is not assigned to a brand."});let accountBrand;try{accountBrand=await resolvePublicBrand(q)}catch{return r.status(503).json({error:"Could not resolve store brand."})}if(!accountBrand?.active||String(accountBrand.id)!==String(accountProfile.brand_id))return r.status(403).json({error:"This account does not belong to this store."});
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
 const profile=await getAuthProfile(user.id);if(!profile?.brand_id)return r.status(403).json({error:"This account is not assigned to a brand."});let accountBrand;try{accountBrand=await resolvePublicBrand(q)}catch{return r.status(503).json({error:"Could not resolve store brand."})}if(!accountBrand?.active||String(accountBrand.id)!==String(profile.brand_id))return r.status(403).json({error:"This account does not belong to this store."});
 const orders=await supabase.from("orders").select("*,order_items(*)").eq("brand_id",String(profile.brand_id)).eq("customer_id",customer.id).order("created_at",{ascending:false}).limit(50);
 if(orders.error)return r.status(500).json({error:"Internal server error."});r.json({customer,orders:orders.data||[]});
});
app.get("/api/admin/orders",async(q,r)=>{
 const user=await getAuthUser(q); if(!user)return r.status(401).json({error:"Not authenticated."});
 const profile=await getAuthProfile(user.id); if(profile?.role!=="admin"||!profile.brand_id)return r.status(403).json({error:"Admin access required."});
 const orders=await supabase.from("orders").select("*,order_items(*),customers(name,email,phone,city,address)").eq("brand_id",profile.brand_id).eq("source","website").order("created_at",{ascending:false}).limit(100);
 if(orders.error)return r.status(500).json({error:"Internal server error."});r.json((orders.data||[]).map(o=>({...o,customer:o.customers||null})));
});
app.post("/api/admin/orders/status",async(q,r)=>{
 const user=await getAuthUser(q); if(!user)return r.status(401).json({error:"Not authenticated."});
 const profile=await getAuthProfile(user.id); if(profile?.role!=="admin"||!profile.brand_id)return r.status(403).json({error:"Admin access required."});
 const brandId=String(profile.brand_id);const {order_id,order_status,delivery_status}=q.body||{};if(!order_id||(!order_status&&!delivery_status))return r.status(400).json({error:"Missing order status."});
 const orderStatuses=["Not Prepared","Preparing","Prepared","Completed"];
 const deliveryStatuses=["Pending","With Shipping Company","Out for Delivery","Delivered","Returned"];
 if(order_status&&!orderStatuses.includes(String(order_status)))return r.status(400).json({error:"Invalid order status."});
 if(delivery_status&&!deliveryStatuses.includes(String(delivery_status)))return r.status(400).json({error:"Invalid delivery status."});
 const patch={}; if(order_status)patch.order_status=String(order_status);if(delivery_status)patch.delivery_status=String(delivery_status);
 const updated=await supabase.from("orders").update(patch).eq("id",order_id).eq("brand_id",brandId).eq("source","website").select("id,order_status,delivery_status").maybeSingle();
 if(updated.error)return r.status(500).json({error:"Internal server error."});if(!updated.data)return r.status(404).json({error:"Website order not found."});r.json({ok:true,order:updated.data});
});

/* Railway healthcheck: keep this endpoint lightweight and independent of external services.
   The application can still report Supabase failures through its normal API endpoints. */
app.get("/api/health",(_q,r)=>r.status(200).json({ok:true,service:"cutdown-store"}));

app.get("/api/products",async(q,r)=>{
 if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
 let publicBrand;try{publicBrand=await resolvePublicBrand(q)}catch{return r.status(503).json({error:"Could not resolve store brand."})}if(!publicBrand)return r.status(404).json({error:"Store brand not found or inactive."});const brandId=String(publicBrand.id); const {data,error}=await supabase.from("products").select("*").eq("brand_id",brandId).eq("active",true).order("created_at",{ascending:false});
 if(error)return r.status(500).json({error:"Could not load products."});const products=data||[],ids=products.map(p=>p.id);if(!ids.length)return r.json([]);
 const {data:variants}=await supabase.from("product_variants").select("id,product_id,desktop_variant_id,sku,size,color,stock,active").eq("brand_id",brandId).in("product_id",ids).eq("active",true);
 const {data:images}=await supabase.from("product_images").select("id,product_id,storage_path,public_url,alt_text,sort_order,color").eq("brand_id",brandId).in("product_id",ids).order("sort_order",{ascending:true});
 const vm=new Map(),im=new Map();(variants||[]).forEach(v=>{if(!vm.has(v.product_id))vm.set(v.product_id,[]);vm.get(v.product_id).push(v)});(images||[]).forEach(v=>{if(!im.has(v.product_id))im.set(v.product_id,[]);im.get(v.product_id).push(v)});
 r.set("Cache-Control","public, max-age=30, stale-while-revalidate=60");r.json(products.map(p=>({...p,variants:vm.get(p.id)||[],images:im.get(p.id)||[]})));
});
app.get("/api/reviews",async(q,r)=>{if(!supabase)return r.status(503).json({error:"Supabase is not configured."});let brand;try{brand=await resolvePublicBrand(q)}catch{return r.status(503).json({error:"Could not resolve store brand."})}if(!brand)return r.status(404).json({error:"Store brand not found or inactive."});const {data,error}=await supabase.from("reviews").select("*").eq("brand_id",brand.id).eq("approved",true).order("created_at",{ascending:false});if(error)return r.status(500).json({error:"Could not load reviews."});r.set("Cache-Control","public, max-age=30, stale-while-revalidate=60");r.json(data||[])});
app.post("/api/reviews",rateLimit({windowMs:10*60*1000,max:10,keyPrefix:"reviews"}),async(q,r)=>{if(!supabase)return r.status(503).json({error:"Supabase is not configured."});let brand;try{brand=await resolvePublicBrand(q)}catch{return r.status(503).json({error:"Could not resolve store brand."})}if(!brand)return r.status(404).json({error:"Store brand not found or inactive."});const {name,rating,body}=q.body||{};if(!name?.trim()||!body?.trim()||!Number.isInteger(Number(rating))||Number(rating)<1||Number(rating)>5)return r.status(400).json({error:"Invalid review."});const {data,error}=await supabase.from("reviews").insert({brand_id:brand.id,name:name.trim().slice(0,80),rating:Number(rating),body:body.trim().slice(0,1000),approved:true}).select().single();if(error)return r.status(500).json({error:"Could not save review."});r.status(201).json(data)});
async function findOrCreateCustomer(customer,brandId){
 if(!supabase||!customer?.phone)return null;
 const phone=String(customer.phone).trim();if(!phone)return null;
 const payload={name:String(customer.name||"").trim(),phone,email:customer.email?.trim()||null,city:customer.city?.trim()||null,address:customer.address?.trim()||null};
 const found=await supabase.from("customers").select("id").eq("brand_id",brandId).eq("phone",phone).maybeSingle();
 if(found.error)throw found.error;
 if(found.data?.id)return found.data.id;
 const created=await supabase.from("customers").insert({...payload,brand_id:brandId}).select("id").single();
 if(!created.error&&created.data?.id)return created.data.id;
 if(created.error){
   const retry=await supabase.from("customers").select("id").eq("brand_id",brandId).eq("phone",phone).maybeSingle();
   if(retry.error)throw retry.error;
   if(retry.data?.id)return retry.data.id;
   throw created.error;
 }
 return null;
}
app.post("/api/orders",rateLimit({windowMs:5*60*1000,max:10,keyPrefix:"orders"}),async(q,r)=>{
  if(!supabase)return r.status(503).json({error:"Supabase is not configured."});
  const {customer,items}=q.body||{};
  let publicBrand;try{publicBrand=await resolvePublicBrand(q)}catch{return r.status(503).json({error:"Could not resolve store brand."})}
  if(!publicBrand)return r.status(404).json({error:"Store brand not found or inactive."});
  const brandId=String(publicBrand.id),requestId=String(q.body?.request_id||"").trim();
  if(requestId&&!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId))return r.status(400).json({error:"Invalid checkout request ID."});
  if(requestId){const prior=await supabase.from("orders").select("id").eq("brand_id",brandId).eq("client_request_id",requestId).maybeSingle();if(prior.error)return r.status(500).json({error:"Could not check the previous order request."});if(prior.data)return r.status(200).json({order_id:prior.data.id,payment_required:false,duplicate:true,message:"This order request was already processed."});}
  if(!customer?.name||!customer?.phone||!customer?.address||!Array.isArray(items)||!items.length)return r.status(400).json({error:"Missing order details."});
  if(items.length>50)return r.status(400).json({error:"Too many order items."});
  if(items.some(i=>!i||!i.product_id||!Number.isSafeInteger(Number(i.quantity))||Number(i.quantity)<1||Number(i.quantity)>100))return r.status(400).json({error:"Invalid order item."});
  const fields=[["name",customer.name,120],["phone",customer.phone,40],["address",customer.address,500],["city",customer.city,100],["email",customer.email,254],["notes",customer.notes,1000]];
  if(fields.some(([_,v,max])=>v!==undefined&&String(v).length>max))return r.status(400).json({error:"One or more order fields are too long."});
  const {data:products,error:pe}=await supabase.from("products").select("id,name,price,stock,active").eq("brand_id",brandId).in("id",items.map(i=>i.product_id));
  if(pe)return r.status(500).json({error:"Could not load products."});
  const variantIds=items.map(i=>i.variant_id).filter(Boolean);let variants=[];
  if(variantIds.length){const vr=await supabase.from("product_variants").select("id,product_id,size,color,stock,active").eq("brand_id",brandId).in("id",variantIds);if(vr.error)return r.status(500).json({error:"Internal server error."});variants=vr.data||[]}
  const map=new Map((products||[]).map(p=>[p.id,p])),vmap=new Map(variants.map(v=>[v.id,v]));let total=0;const clean=[];
  for(const item of items){const qty=Number(item.quantity),p=map.get(item.product_id),v=item.variant_id?vmap.get(item.variant_id):null;if(!Number.isSafeInteger(qty)||qty<1||qty>100)return r.status(400).json({error:"Invalid quantity."});if(!p||!p.active||(!v&&qty>p.stock)||(v&&(!v.active||v.product_id!==p.id||qty>v.stock)))return r.status(409).json({error:"The selected color or size is unavailable."});total+=Number(p.price)*qty;clean.push({product_id:p.id,variant_id:v?.id||null,product_name:p.name,quantity:qty,unit_price:p.price,size:v?.size||item.size||null,color:v?.color||item.color||null})}
  const stockReservation=clean.map(i=>({product_id:i.product_id,variant_id:i.variant_id,quantity:i.quantity}));
  const authUser=await getAuthUser(q);let customerId=null;
  if(authUser){const signedProfile=await getAuthProfile(authUser.id);if(!signedProfile?.brand_id||String(signedProfile.brand_id)!==brandId)return r.status(403).json({error:"This account belongs to a different store."});try{const accountCustomer=await ensureCustomerForUser(authUser);if(!accountCustomer?.id)return r.status(403).json({error:"This account is not assigned to a customer record."});customerId=accountCustomer.id;const link=await supabase.from("customers").update({email:customer.email?.trim()||accountCustomer.email||null,phone:customer.phone?.trim()||accountCustomer.phone||null,city:customer.city?.trim()||accountCustomer.city||null,address:customer.address?.trim()||accountCustomer.address||"",name:customer.name?.trim()||accountCustomer.name||"Customer"}).eq("id",customerId).eq("brand_id",brandId).eq("auth_user_id",authUser.id);if(link.error)return r.status(500).json({error:"Could not update customer record."});}catch{return r.status(500).json({error:"Could not load customer record."});}}
  else{try{customerId=await findOrCreateCustomer(customer,brandId)}catch{return r.status(500).json({error:"Could not link customer record."});}}
  const reserved=await supabase.rpc("reserve_stock_items",{p_items:stockReservation});
  if(reserved.error){if(requestId){const prior=await supabase.from("orders").select("id").eq("brand_id",brandId).eq("client_request_id",requestId).maybeSingle();if(prior.data)return r.status(200).json({order_id:prior.data.id,payment_required:false,duplicate:true,message:"This order request was already processed."});}return r.status(409).json({error:"One or more selected sizes are no longer available."});}
  const {data:order,error:oe}=await supabase.from("orders").insert({customer_name:customer.name.trim(),customer_phone:customer.phone.trim(),customer_email:customer.email?.trim()||null,city:customer.city?.trim()||null,address:customer.address.trim(),notes:customer.notes?.trim()||null,payment_method:"cod",payment_status:"pending",order_status:"confirmed",total_amount:total,customer_id:customerId,brand_id:brandId,source:"website",stock_reserved:stockReservation.length>0,client_request_id:requestId||null}).select("id").single();
  if(oe){if(stockReservation.length){const release=await supabase.rpc("release_stock_items",{p_items:stockReservation});if(release.error)console.error("Failed to release stock after order creation error:",release.error.message);}if(requestId){const prior=await supabase.from("orders").select("id").eq("brand_id",brandId).eq("client_request_id",requestId).maybeSingle();if(prior.data)return r.status(200).json({order_id:prior.data.id,payment_required:false,duplicate:true,message:"This order request was already processed."});}return r.status(500).json({error:"Could not create order."});}
  const {error:ie}=await supabase.from("order_items").insert(clean.map(i=>({...i,order_id:order.id,brand_id:brandId})));
  if(ie){if(stockReservation.length){const release=await supabase.rpc("release_stock_items",{p_items:stockReservation});if(release.error)console.error("Failed to release stock after order item error:",release.error.message);}await supabase.from("orders").delete().eq("id",order.id).eq("brand_id",brandId);return r.status(500).json({error:"Could not save order items."});}
  r.status(201).json({order_id:order.id,payment_required:false,message:"Order confirmed for cash on delivery."});
 });
app.get("/reset-password",(_q,r)=>r.sendFile(path.join(__dirname,"reset-password.html")));app.get("/account",(_q,r)=>r.sendFile(path.join(__dirname,"account.html")));app.get("/admin",(_q,r)=>r.sendFile(path.join(__dirname,"admin.html")));app.use((_q,r)=>r.sendFile(path.join(__dirname,"index.html")));
const port=process.env.PORT||3000;
app.use((err,q,r,next)=>{console.error("Unhandled request error:",err?.stack||err);if(r.headersSent)return next(err);r.status(500).json({error:"Internal server error."})});

export default app;

let server=null;
if(!process.env.VERCEL){
  server=app.listen(port,()=>console.log("Cutdown Store listening on "+port));
}
function shutdown(signal){console.log("Received "+signal+", shutting down gracefully.");if(!server)return process.exit(0);server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),10000).unref();}
process.on("SIGTERM",()=>shutdown("SIGTERM"));
process.on("SIGINT",()=>shutdown("SIGINT"));
