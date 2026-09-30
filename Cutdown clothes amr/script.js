const $=s=>document.querySelector(s);
const storeBrandSlug=new URLSearchParams(location.search).get("brand")||"";
const apiUrl=path=>{const u=new URL(path,location.origin);if(storeBrandSlug)u.searchParams.set("brand",storeBrandSlug);return u.pathname+u.search+u.hash};
const cartKey="bpc_cart_"+(storeBrandSlug||"default");
const fetchWithTimeout=async(url,options={},ms=3500)=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{return await fetch(url,{...options,signal:c.signal})}finally{clearTimeout(t)}};
const state={products:[],cart:JSON.parse(localStorage.getItem(cartKey)||"[]")};
function money(v){return "EGP "+Number(v||0).toLocaleString("en-EG",{maximumFractionDigits:2})}
function save(){localStorage.setItem(cartKey,JSON.stringify(state.cart));renderCart()}
function syncPaymentUI(){document.querySelectorAll(".payment label").forEach(l=>l.classList.toggle("is-selected",l.querySelector("input")?.checked));}
let productView=null;
function esc(v){return String(v??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]))}
function productColors(p){return [...new Set((p.variants||[]).map(v=>String(v.color||"").trim()).filter(Boolean))]}
function productSizes(p,color){return [...new Set((p.variants||[]).filter(v=>!color||v.color===color).map(v=>String(v.size||"").trim()).filter(Boolean))]}
function colorImages(p,color){
 const imgs=(p.images||[]).filter(x=>!color||!x.color||x.color===color).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
 if(imgs.length)return imgs.map(x=>x.public_url||x.storage_path).filter(Boolean).slice(0,3);
 return p.image_url?[p.image_url]:[];
}
function findVariant(p,color,size){return (p.variants||[]).find(v=>String(v.color||"")===String(color||"")&&String(v.size||"")===String(size||""))}
function openProduct(id){
 const p=state.products.find(x=>x.id===id);if(!p)return;
 const colors=productColors(p),firstColor=colors[0]||"",sizes=productSizes(p,firstColor),firstSize=sizes[0]||"";
 productView={p,color:firstColor,size:firstSize,quantity:1};
 $("#productName").textContent=p.name;$("#productPrice").textContent=money(p.price);
 $("#productDescription").textContent=p.description||"";
 $("#productModal").classList.add("open");renderProductView();
}
function renderProductView(){
 if(!productView)return;
 const {p,color,size}=productView,imgs=colorImages(p,color);
 $("#productMainImage").src=imgs[0]||"";$("#productMainImage").alt=p.name+" "+color;
 $("#productThumbs").innerHTML=imgs.map((src,i)=>'<button type="button" class="product-thumb '+(i===0?"active":"")+'" data-img="'+esc(src)+'"><img src="'+esc(src)+'" alt=""></button>').join("");
 $("#productThumbs").querySelectorAll("[data-img]").forEach(b=>b.onclick=()=>{$("#productMainImage").src=b.dataset.img;$("#productThumbs").querySelectorAll(".product-thumb").forEach(x=>x.classList.remove("active"));b.classList.add("active")});
 const colors=productColors(p);
 $("#colorChoices").innerHTML=colors.length?colors.map(c=>'<button type="button" class="choice '+(c===color?"selected":"")+'" data-color="'+esc(c)+'">'+esc(c)+'</button>').join(""):'<span class="choice-empty">No colors configured</span>';
 $("#colorChoices").querySelectorAll("[data-color]").forEach(b=>b.onclick=()=>{productView.color=b.dataset.color;productView.size=productSizes(p,productView.color)[0]||"";productView.quantity=1;renderProductView()});
 const sizes=productSizes(p,color);
 $("#sizeChoices").innerHTML=sizes.length?sizes.map(s=>{const v=findVariant(p,color,s);return '<button type="button" class="choice '+(s===size?"selected":"")+(v&&Number(v.stock)>0?"":" disabled")+'" data-size="'+esc(s)+'">'+esc(s)+'</button>'}).join(""):'<span class="choice-empty">No sizes configured</span>';
 $("#sizeChoices").querySelectorAll("[data-size]").forEach(b=>b.onclick=()=>{if(b.classList.contains("disabled"))return;productView.size=b.dataset.size;productView.quantity=1;renderProductView()});
 const v=findVariant(p,color,size),stock=v?Number(v.stock):0,max=Math.max(0,stock);
 $("#qtyValue").textContent=productView.quantity;$("#variantStock").textContent=v?(stock>0?stock+" available":"SOLD OUT"):"Select a size";
 $("#addProductToCart").disabled=!v||stock<=0;
 $("#productMsg").textContent=v&&stock>0?"":"Choose an available color and size.";
}
function renderProducts(){
 const el=$("#products");
 el.innerHTML=state.products.map((p,i)=>'<article class="product"><button class="product-open" data-product="'+esc(p.id)+'"><img loading="lazy" decoding="async" src="'+esc(p.image_url||colorImages(p,"")[0])+'" alt="'+esc(p.name)+'"><div class="product-info"><span>0'+(i+1)+'</span><h3>'+esc(p.name)+'</h3><p>'+money(p.price)+'</p><span class="product-cta">Add Product →</span></div></button></article>').join("");
 el.querySelectorAll("[data-product]").forEach(b=>b.onclick=()=>openProduct(b.dataset.product));
}
function addSelectedProduct(){
 if(!productView)return;
 const {p,color,size,quantity}=productView,v=findVariant(p,color,size),stock=v?Number(v.stock):0;
 if(!v||stock<=0||quantity>stock)return;
 const key=p.id+"|"+color+"|"+size;
 const found=state.cart.find(x=>x.key===key);
 if(found)found.quantity=Math.min(stock,found.quantity+quantity);
 else state.cart.push({key,product_id:p.id,variant_id:v.id,color,size,quantity});
 save();$("#productModal").classList.remove("open");openCart();
}
function renderCart(){
 const el=$("#cartItems");
 const valid=state.cart.filter(x=>state.products.some(y=>y.id===x.product_id)&&Number(x.quantity)>0);
 if(valid.length!==state.cart.length){state.cart=valid;localStorage.setItem(cartKey,JSON.stringify(state.cart))}
 $("#cartCount").textContent=state.cart.reduce((n,x)=>n+Math.max(0,Number(x.quantity)||0),0);
 let total=0;
 el.innerHTML=state.cart.map(x=>{const p=state.products.find(y=>y.id===x.product_id);if(!p)return "";total+=Number(p.price)*x.quantity;return '<div class="cart-item"><div class="cart-item-main"><span>'+esc(p.name)+' · '+esc(x.color||"")+" / "+esc(x.size||"")+" × "+x.quantity+'</span><button type="button" class="cart-less" data-cart-less="'+esc(x.key)+'" aria-label="Remove one '+esc(p.name)+'">−</button></div><b>'+money(Number(p.price)*x.quantity)+'</b></div>'}).join("")||'<p style="color:#777">Your bag is empty.</p>';
 el.querySelectorAll("[data-cart-less]").forEach(b=>b.onclick=()=>{const item=state.cart.find(x=>x.key===b.dataset.cartLess);if(!item)return;if(item.quantity>1)item.quantity-=1;else state.cart=state.cart.filter(x=>x.key!==b.dataset.cartLess);save()});
 $("#cartTotal").textContent=money(total);
}
function openCart(){$("#cart").classList.add("open")}function closeCart(){$("#cart").classList.remove("open")}
$("#cartBtn").onclick=openCart;$("#closeCart").onclick=closeCart;
$("#closeProduct").onclick=()=>$("#productModal").classList.remove("open");
$("#productModal").addEventListener("click",e=>{if(e.target.id==="productModal")e.currentTarget.classList.remove("open")});
$("#qtyMinus").onclick=()=>{if(productView){productView.quantity=Math.max(1,productView.quantity-1);renderProductView()}};
$("#qtyPlus").onclick=()=>{if(!productView)return;const v=findVariant(productView.p,productView.color,productView.size),stock=Number(v?.stock||0);if(!v||stock<=0)return;if(productView.quantity<stock){productView.quantity+=1;renderProductView()}else{$("#productMsg").textContent="Maximum available quantity: "+stock}};
$("#addProductToCart").onclick=addSelectedProduct;$("#checkoutBtn").onclick=()=>{if(!state.cart.length)return;closeCart();$("#checkout").classList.add("open")};$("#closeCheckout").onclick=()=>$("#checkout").classList.remove("open");
function showReviewMessage(text,error=false){const msg=$("#reviewMsg");msg.textContent=text;msg.classList.toggle("show",!!text);msg.classList.toggle("error",!!error);msg.style.color="";if(text&&!error){clearTimeout(window.__reviewMsgTimer);window.__reviewMsgTimer=setTimeout(()=>msg.classList.remove("show"),4500)}}
async function loadReviews(){try{const r=await fetchWithTimeout(apiUrl("/api/reviews"));if(!r.ok)throw 0;const data=await r.json();$("#reviewList").innerHTML=data.length?data.map(x=>'<article class="review"><div class="stars">'+("★".repeat(x.rating))+'</div><h3>'+String(x.name).replace(/[<>]/g,"")+'</h3><p>'+String(x.body).replace(/[<>]/g,"")+'</p></article>').join(""):'<p>No reviews yet. Be the first.</p>'}catch{$("#reviewList").innerHTML='<p>Reviews will appear here once Supabase is connected.</p>'}}
document.querySelectorAll('input[name="payment_method"]').forEach(r=>r.addEventListener("change",syncPaymentUI));
$("#reviewForm").onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector("button[type=submit]");button.disabled=true;showReviewMessage("");try{const r=await fetch(apiUrl("/api/reviews"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.fromEntries(new FormData(form)))}),d=await r.json().catch(()=>({}));if(!r.ok){showReviewMessage(d.error||"Could not post review.",true);return}form.reset();showReviewMessage("Thank you for your review ❤️ It was posted successfully.");await loadReviews();form.scrollIntoView({behavior:"smooth",block:"center"})}catch{showReviewMessage("Could not connect. Please try again.",true)}finally{button.disabled=false}};
$("#checkoutForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget),customer=Object.fromEntries(f),payment_method=customer.payment_method;delete customer.payment_method;const authHeaders=authState.session?{Authorization:"Bearer "+authState.session.access_token}:{};
const r=await fetch(apiUrl("/api/orders"),{method:"POST",headers:{"Content-Type":"application/json",...authHeaders},body:JSON.stringify({customer,items:state.cart,payment_method})}),d=await r.json();const msg=$("#checkoutMsg");if(!r.ok){msg.textContent=d.error||"Checkout failed.";return}if(payment_method==="online"&&d.checkout_url){window.location.href=d.checkout_url;return}state.cart=[];save();e.currentTarget.reset();msg.textContent=d.message||"Order confirmed."};
let storyProgress=0,pointer={x:0,y:0},scrollYValue=0,target={x:0,y:0,rot:0,scale:1,opacity:1,z:-420},current={x:0,y:0,rot:0,scale:1,opacity:1};
function updateHeroTarget(){const m=$("#floating-shirt"),hero=document.querySelector(".hero");if(!m||!hero)return;const p=Math.min(1,Math.max(0,scrollYValue/(hero.offsetHeight*.9))),fall=Math.min(1,p/.72),rebound=p>.72?Math.sin((p-.72)/.28*Math.PI)*-75:0;target.y=fall*Math.min(360,innerHeight*.42)+rebound;target.x=-pointer.x*28;target.rot=-pointer.x*4+fall*5;target.scale=1.08-fall*.12;target.opacity=1-Math.max(0,p-.9)*7;target.z=-420-fall*520}
let heroAnimationActive=true;function animateHero(){const m=$("#floating-shirt");if(!m)return;const k=.075;["x","y","rot","scale","opacity"].forEach(key=>current[key]+=(target[key]-current[key])*k);m.style.opacity=Math.max(0,current.opacity);m.style.transform="translate3d("+current.x+"px,"+current.y+"px,"+target.z+"px) scale("+current.scale+") rotateZ("+current.rot+"deg) rotateY("+(-pointer.x*2)+"deg)";if(heroAnimationActive)requestAnimationFrame(animateHero)}
const heroEl=document.querySelector(".hero");if(heroEl&&"IntersectionObserver"in window)new IntersectionObserver(entries=>{heroAnimationActive=entries[0].isIntersecting;if(heroAnimationActive)requestAnimationFrame(animateHero)},{threshold:0.01}).observe(heroEl);addEventListener("pointermove",e=>{pointer.x=(e.clientX-innerWidth/2)/innerWidth;pointer.y=(e.clientY-innerHeight/2)/innerHeight;updateHeroTarget()},{passive:true});
addEventListener("scroll",()=>{scrollYValue=scrollY;updateHeroTarget();updateStoryDepth()},{passive:true});
function updateStoryDepth(){const section=document.querySelector(".story-window"),shirt=$("#story-shirt");if(!section||!shirt)return;const r=section.getBoundingClientRect(),p=Math.min(1,Math.max(0,(innerHeight-r.top)/(innerHeight+r.height)));storyProgress=p;const fall=Math.max(0,p-.28)/.72;const y=fall*500;const x=25+Math.sin(p*Math.PI)*4;const z=-1500+fall*900;const rot=Math.sin(p*Math.PI)*2;shirt.style.transform="translate3d("+x+"%, "+y+"px, "+z+"px) scale("+(1.08-fall*.12)+") rotateZ("+rot+"deg)";}
const authState={client:null,session:null,mode:"signin",brandId:""};
async function initAuth(){try{const cfg=await fetchWithTimeout(apiUrl("/api/public-config"),{},3500).then(r=>r.ok?r.json():null);if(!cfg||!window.supabase)return;authState.brandId=String(cfg.brandId||"");const wa=String(cfg.supportWhatsApp||"").replace(/\\D/g,"")||"201080910753";const waUrl="https://wa.me/"+wa+"?text="+encodeURIComponent("أريد الاشتراك في BPC Clothes System");["#supportLink","#authSupportLink"].forEach(sel=>{const el=$(sel);if(el)el.href=waUrl});authState.client=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseKey);authState.session=(await authState.client.auth.getSession()).data?.session||null;authState.client.auth.onAuthStateChange((_e,session)=>{authState.session=session;updateAccountButton()});updateAccountButton()}catch{}}
function updateAccountButton(){const b=$("#accountBtn");if(b)b.textContent=authState.session?"Profile":"Sign in"}
function openAuth(mode="signin"){authState.mode=mode;$("#authModal").classList.add("open");$("#authTitle").textContent=mode==="signup"?"Create account.":"Sign in.";$("#authSubmit").textContent=mode==="signup"?"Create account →":"Sign in →";$("#authSwitch").textContent=mode==="signup"?"Already have an account":"Create account";$("#authName").style.display=mode==="signup"?"block":"none";$("#authPhone").style.display=mode==="signup"?"block":"none"}
async function openAccount(){if(!authState.session)return openAuth("signin");const r=await fetch("/api/auth/me",{headers:{Authorization:"Bearer "+authState.session.access_token}});const d=await r.json();if(!r.ok){await authState.client.auth.signOut();return openAuth("signin")}const admin=d.profile?.role==="admin";if(confirm((admin?"You are signed in as an admin.":"You are signed in.")+"\n\nOpen "+(admin?"Admin dashboard":"Customer account")+"?"))location.href=admin?"/admin":"/account";else await authState.client.auth.signOut()}
$("#accountBtn").onclick=openAccount;$("#closeAuth").onclick=()=>$("#authModal").classList.remove("open");$("#authForgot").onclick=()=>{location.href="/reset-password"};$("#authSwitch").onclick=()=>openAuth(authState.mode==="signup"?"signin":"signup");
$("#authForm").onsubmit=async e=>{e.preventDefault();if(!authState.client)return;const f=new FormData(e.currentTarget),email=String(f.get("email")||"").trim(),password=String(f.get("password")||""),msg=$("#authMsg");msg.textContent="";const result=authState.mode==="signup"?await fetch("/api/auth/signup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email,password,name:String(f.get("name")||"").trim(),phone:String(f.get("phone")||"").trim()})}).then(async r=>({ok:r.ok,data:await r.json().catch(()=>({}))})):(()=>authState.client.auth.signInWithPassword({email,password}).then(x=>({ok:!x.error,data:x.error?{error:x.error.message}:x.data})))();if(!result.ok){msg.textContent=result.data?.error||"Could not create account.";return}if(authState.mode==="signup"&&!result.data.session)msg.textContent="Account created. Check your email to confirm it, then sign in.";else{authState.session=result.data.session;$("#authModal").classList.remove("open");updateAccountButton()}};

(async()=>{initAuth();try{const r=await fetchWithTimeout(apiUrl("/api/products"),{},3500);if(!r.ok)throw 0;const data=await r.json();state.products=Array.isArray(data)?data:[]}catch{state.products=[]}renderProducts();renderCart();loadReviews();syncPaymentUI();document.body.classList.add("ready");updateHeroTarget();updateStoryDepth();animateHero()})();