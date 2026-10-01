begin;
drop index if exists public.ux_products_brand_desktop_id;
create unique index ux_products_brand_desktop_id on public.products (brand_id, desktop_id);
drop index if exists public.ux_variants_brand_desktop_id;
create unique index ux_variants_brand_desktop_id on public.product_variants (brand_id, desktop_variant_id);
commit;