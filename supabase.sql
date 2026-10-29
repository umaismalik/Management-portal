-- Paste this whole file in Supabase > SQL Editor > Run (one time)
create table if not exists kv (key text primary key, value jsonb not null);
alter table kv enable row level security;
insert into storage.buckets (id, name, public) values ('uploads', 'uploads', false) on conflict (id) do nothing;
