-- =====================================================================
-- Plasma Grader — chạy toàn bộ file này 1 lần trong Supabase > SQL Editor
-- (chạy lại nhiều lần cũng không sao)
-- =====================================================================

-- 1. Bảng lô ảnh
create table if not exists public.batches (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

-- 2. Bảng ảnh + kết quả phân độ
create table if not exists public.images (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  batch_id bigint not null references public.batches(id) on delete cascade,
  filename text not null,
  rel_path text not null,
  storage_path text not null,
  grade smallint check (grade between 0 and 5),
  note text not null default '',
  graded_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists images_batch_idx on public.images(batch_id);
create index if not exists images_user_idx on public.images(user_id);
create index if not exists batches_user_idx on public.batches(user_id);

-- 3. Bảo mật: mỗi người chỉ thấy / sửa dữ liệu của chính mình
alter table public.batches enable row level security;
alter table public.images  enable row level security;

drop policy if exists "own batches" on public.batches;
create policy "own batches" on public.batches for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "own images" on public.images;
create policy "own images" on public.images for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.batches b where b.id = batch_id and b.user_id = (select auth.uid()))
  );

-- 4. Thống kê tiến độ từng lô
create or replace view public.batch_stats with (security_invoker = on) as
  select b.id, b.name, b.created_at,
         count(i.id)::int    as total,
         count(i.grade)::int as graded
  from public.batches b
  left join public.images i on i.batch_id = b.id
  group by b.id;
grant select on public.batch_stats to authenticated;
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.batches, public.images to authenticated;
revoke all on public.batches, public.images, public.batch_stats from anon;

-- 5. Kho lưu ảnh (riêng tư)
insert into storage.buckets (id, name, public)
values ('plasma', 'plasma', false)
on conflict (id) do nothing;

drop policy if exists "plasma read own"   on storage.objects;
drop policy if exists "plasma insert own" on storage.objects;
drop policy if exists "plasma update own" on storage.objects;
drop policy if exists "plasma delete own" on storage.objects;
create policy "plasma read own" on storage.objects for select to authenticated
  using (bucket_id = 'plasma' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "plasma insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'plasma' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "plasma update own" on storage.objects for update to authenticated
  using (bucket_id = 'plasma' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "plasma delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'plasma' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 6. Bật đồng bộ thời gian thực
do $$
begin
  begin
    alter publication supabase_realtime add table public.images;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.batches;
  exception when duplicate_object then null;
  end;
end $$;
