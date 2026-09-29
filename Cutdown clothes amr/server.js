import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createClient} from "@supabase/supabase-js";

dotenv.config();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
app.use(cors());
app.use(express.json({limit:"1mb"}));
app.use(express.static(__dirname));

const supabase=process.env.SUPABASE_URL&&process.env.SUPABASE_SERVICE_ROLE_KEY
 ? createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY):null;

app.get("/api/health",(_req,res)=>res.json({ok:true,supabase:!!supabase,paymentProvider:process.env.PAYMENT_PROVIDER||"paymob"}));

app.get("/api/products",async(_req,res)=>{
 if(!supabase)return res.status(503).json({error:"Supabase is not configured."});
 const {data,error}=await supabase.from("products").select("*").eq("active",true).order("created_at",{ascending:false});
 if(error)return res.status(500).json({error:error.message}); res.json(data||[]);
});

app.get("/api/reviews",async(_req,res)=>{
 if(!supabase)return res.status(503).json({error:"Supabase is not configured."});
 const {data,error}=await supabase.from("reviews").select("*").eq("approved",true).order("created_at",{ascending:false});
 if(error)return res.status(500).json({error:error.message}); res.json(data||[]);
});

app.post("/api/reviews",async(req,res)=>{
 if(!supabase)return res.status(503).json({error:"Supabase is not configured."});
 const {name,rating,body}=req.body||{};
 if(!name?.trim()||!body?.trim()||!Number.isInteger(Number(rating))||Number(rating)<1||Number(rating)>5)return res.status(400).json({error:"Invalid review."});
 const {data,error}=await supabase.from("reviews").insert({name:name.trim().slice(0,80),rating:Number(rating),body:body.trim().slice(0,1000),approved:true}).select().single();
 if(error)return res.status(500).json({error:error.message}); res.status(201).json(data);
});

app.post("/api/orders",async(req,res)=>{
 if(!supabase)return res.status(503).json({error:"Supabase is not configured."});
 const {customer,items,payment_method}=req.body||{};
 if(!customer?.name||!customer?.phone||!customer?.address||!Array.isArray(items)||!items.length)return res.status(400).json({error:"Missing order details."});
 if(!["cod","online"].includes(payment_method))return res.status(400).json({error:"Invalid payment method."});
 const ids=items.map(i=>i.product_id);
 const {data:products,error:pe}=await supabase.from("products").select("id,name,price,stock,active").in("id",ids);
 if(pe)return res.status(500).json({error:pe.message});
 const map=new Map((products||[]).map(p=>[p.id,p])); let total=0; const clean=[];
 for(const item of items){const p=map.get(item.product_id);const q=Math.max(1,Math.floor(Number(item.quantity)));if(!p||!p.active||q>p.stock)return res.status(409).json({error:"A product is unavailable."});total+=Number(p.price)*q;clean.push({product_id:p.id,product_name:p.name,quantity:q,unit_price:p.price,size:item.size||null,color:item.color||null});}
 const {data:order,error:oe}=await supabase.from("orders").insert({customer_name:customer.name.trim(),customer_phone:customer.phone.trim(),customer_email:customer.email?.trim()||null,city:customer.city?.trim()||null,address:customer.address.trim(),notes:customer.notes?.trim()||null,payment_method,payment_status:"pending",order_status:"pending",total_amount:total}).select().single();
 if(oe)return res.status(500).json({error:oe.message});
 const {error:ie}=await supabase.from("order_items").insert(clean.map(i=>({...i,order_id:order.id})));
 if(ie){await supabase.from("orders").delete().eq("id",order.id);return res.status(500).json({error:ie.message});}
 if(payment_method==="cod")return res.status(201).json({order_id:order.id,payment_required:false,message:"Order confirmed for cash on delivery."});
 if(!(process.env.PAYMOB_SECRET_KEY&&process.env.PAYMOB_INTEGRATION_ID))return res.status(503).json({error:"Online payment is not configured. Add Paymob credentials in Railway Variables."});
 const base=process.env.PUBLIC_BASE_URL;
 if(!base)return res.status(503).json({error:"PUBLIC_BASE_URL is not configured."});
 const amountCents=Math.round(total*100);
 const itemsPayload=clean.map(i=>({name:i.product_name,amount:Math.round(Number(i.unit_price)*100),description:"Cutdown product",quantity:i.quantity}));
 const first=(customer.name||"Customer").trim().split(" ")[0]||"Customer";
 const last=(customer.name||"").trim().split(" ").slice(1).join(" ")||"Customer";
 const payRes=await fetch("https://accept.paymob.com/v1/intention/",{method:"POST",headers:{"Authorization":"Token "+process.env.PAYMOB_SECRET_KEY,"Content-Type":"application/json"},body:JSON.stringify({amount:amountCents,currency:"EGP",payment_methods:[Number(process.env.PAYMOB_INTEGRATION_ID)],items:itemsPayload,billing_data:{first_name:first,last_name:last,phone_number:customer.phone,email:customer.email||"no-email@cutdown.store",street:customer.address,city:customer.city||"Cairo",country:"EG",state:customer.city||"Cairo",apartment:"NA",building:"NA",floor:"NA"},special_reference:order.id,notification_url:base+"/api/paymob/webhook",redirection_url:base+"/payment-result"})});
 const pd=await payRes.json();
 if(!payRes.ok)return res.status(502).json({error:"Payment provider rejected the request.",details:pd});
 await supabase.from("orders").update({payment_status:"pending"}).eq("id",order.id);
 res.status(201).json({order_id:order.id,payment_required:true,client_secret:pd.client_secret,intention_id:pd.id});
});

app.post("/api/paymob/webhook",async(req,res)=>{
 if(!supabase)return res.sendStatus(503);
 const body=req.body||{}; const obj=body.obj||body;
 const success=obj.success===true||obj.success==="true";
 const merchantRef=obj.order?.merchant_order_id||obj.merchant_order_id||obj.special_reference;
 if(merchantRef){await supabase.from("orders").update({payment_status:success?"paid":"failed",order_status:success?"confirmed":"pending"}).eq("id",merchantRef);}
 res.sendStatus(200);
});

app.get("/payment-result",(req,res)=>res.sendFile(path.join(__dirname,"payment-result.html")));
app.use((req,res)=>res.sendFile(path.join(__dirname,"index.html")));
const port=process.env.PORT||3000;
app.listen(port,()=>console.log("Cutdown Store listening on "+port));