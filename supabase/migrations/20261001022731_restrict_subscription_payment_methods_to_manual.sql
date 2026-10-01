begin;
alter table public.subscriptions drop constraint if exists subscriptions_payment_method_check;
alter table public.subscriptions add constraint subscriptions_payment_method_check check (payment_method = any (array['manual'::text,'instapay'::text,'vodafone_cash'::text]));
alter table public.subscription_payments drop constraint if exists subscription_payments_payment_method_check;
alter table public.subscription_payments add constraint subscription_payments_payment_method_check check (payment_method = any (array['manual'::text,'instapay'::text,'vodafone_cash'::text]));
commit;