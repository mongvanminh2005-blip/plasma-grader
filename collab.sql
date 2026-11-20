-- =====================================================================
-- Plasma Grader — nhiều người cùng chấm (chạy sau setup.sql và admin.sql)
-- =====================================================================

-- Lô chung: mọi tài khoản xem và chấm được
alter table public.batches add column if not exists shared boolean not null default true;

-- Điểm riêng của từng người cho từng ảnh
create table if not exists public.ratings (
  image_id bigint not null references public.images(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  grade smallint check (grade between 0 and 5),
  note text not null default '',
  graded_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (image_id, user_id)
);
create index if not exists ratings_user_idx on public.ratings(user_id);
alter table public.ratings enable row level security;
grant select, insert, update, delete on public.ratings to authenticated;
revoke all on public.ratings from anon;

-- chuyển điểm cũ (images.grade/note) sang ratings của người tải ảnh
insert into public.ratings (image_id, user_id, grade, note, graded_at)
  select id, user_id, grade, note, graded_at from public.images
  where grade is not null or note <> ''
on conflict (image_id, user_id) do nothing;

-- quyền xem một lô (security definer để tránh vòng lặp chính sách)
create or replace function public.can_view_batch(bid bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.batches b
    where b.id = bid and (b.user_id = (select auth.uid()) or b.shared or public.is_admin()));
$$;
revoke all on function public.can_view_batch(bigint) from public, anon;
grant execute on function public.can_view_batch(bigint) to authenticated;

-- batches
drop policy if exists "own batches" on public.batches;
drop policy if exists "batches select" on public.batches;
drop policy if exists "batches insert" on public.batches;
drop policy if exists "batches update" on public.batches;
drop policy if exists "batches delete" on public.batches;
create policy "batches select" on public.batches for select to authenticated
  using (user_id = (select auth.uid()) or shared or (select public.is_admin()));
create policy "batches insert" on public.batches for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "batches update" on public.batches for update to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()))
  with check (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "batches delete" on public.batches for delete to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- images
drop policy if exists "own images" on public.images;
drop policy if exists "images select" on public.images;
drop policy if exists "images insert" on public.images;
drop policy if exists "images update" on public.images;
drop policy if exists "images delete" on public.images;
create policy "images select" on public.images for select to authenticated
  using (user_id = (select auth.uid()) or public.can_view_batch(batch_id));
create policy "images insert" on public.images for insert to authenticated
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.batches b where b.id = batch_id and b.user_id = (select auth.uid())));
-- cập nhật (vùng khoanh) được phép trên lô mình xem được
create policy "images update" on public.images for update to authenticated
  using (user_id = (select auth.uid()) or public.can_view_batch(batch_id))
  with check (user_id = (select auth.uid()) or public.can_view_batch(batch_id));
create policy "images delete" on public.images for delete to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- ratings: ai xem được ảnh thì xem được điểm của ảnh đó; chỉ sửa điểm của chính mình
drop policy if exists "ratings select" on public.ratings;
drop policy if exists "ratings insert" on public.ratings;
drop policy if exists "ratings update" on public.ratings;
drop policy if exists "ratings delete" on public.ratings;
create policy "ratings select" on public.ratings for select to authenticated
  using (exists (select 1 from public.images i where i.id = image_id));
create policy "ratings insert" on public.ratings for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.images i where i.id = image_id));
create policy "ratings update" on public.ratings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "ratings delete" on public.ratings for delete to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- tên người dùng hiển thị cho mọi người
drop policy if exists "read profiles" on public.profiles;
create policy "read profiles" on public.profiles for select to authenticated using (true);

-- ảnh: xem được nếu thuộc lô mình xem được
drop policy if exists "plasma read own" on storage.objects;
create policy "plasma read own" on storage.objects for select to authenticated
  using (bucket_id = 'plasma' and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or (select public.is_admin())
    or exists (select 1 from public.images i where i.storage_path = objects.name)
  ));

-- thống kê lô: tổng ảnh, số ảnh TÔI đã chấm, số người đã chấm
drop view if exists public.batch_stats;
create view public.batch_stats with (security_invoker = on) as
  select b.id, b.name, b.created_at, b.user_id, b.shared, p.username as owner,
    (select count(*) from public.images i where i.batch_id = b.id)::int as total,
    (select count(*) from public.ratings r join public.images i on i.id = r.image_id
       where i.batch_id = b.id and r.user_id = (select auth.uid()) and r.grade is not null)::int as graded,
    (select count(distinct r.user_id) from public.ratings r join public.images i on i.id = r.image_id
       where i.batch_id = b.id and r.grade is not null)::int as raters
  from public.batches b left join public.profiles p on p.id = b.user_id;
grant select on public.batch_stats to authenticated;
revoke all on public.batch_stats from anon;

-- quản trị: số ảnh đã chấm lấy từ ratings
create or replace function public.admin_list_users()
returns table (id uuid, username text, email text, created_at timestamptz, last_sign_in_at timestamptz,
               is_admin boolean, batches int, images int, graded int, storage_bytes bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên được dùng chức năng này'; end if;
  return query
    select u.id, coalesce(p.username, split_part(u.email, '@', 1))::text, u.email::text, u.created_at, u.last_sign_in_at,
           exists (select 1 from public.admins a where a.user_id = u.id),
           (select count(*)::int from public.batches b where b.user_id = u.id),
           (select count(*)::int from public.images i where i.user_id = u.id),
           (select count(*)::int from public.ratings r where r.user_id = u.id and r.grade is not null),
           (select coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint from storage.objects o
              where o.bucket_id = 'plasma' and (storage.foldername(o.name))[1] = u.id::text)
    from auth.users u left join public.profiles p on p.id = u.id
    order by u.created_at;
end $$;

create or replace function public.admin_overview()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên được dùng chức năng này'; end if;
  return json_build_object(
    'users',   (select count(*) from auth.users),
    'batches', (select count(*) from public.batches),
    'images',  (select count(*) from public.images),
    'graded',  (select count(distinct image_id) from public.ratings where grade is not null),
    'ratings', (select count(*) from public.ratings where grade is not null),
    'storage_bytes', (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where bucket_id = 'plasma'),
    'db_bytes', pg_database_size(current_database())
  );
end $$;

-- đồng bộ thời gian thực cho điểm
do $$ begin
  begin alter publication supabase_realtime add table public.ratings;
  exception when duplicate_object then null; end;
end $$;

-- Gộp nhiều lô vào lô đích (chạy với quyền của người gọi: RLS vẫn áp dụng)
create or replace function public.merge_batches(target bigint, sources bigint[], new_name text default null)
returns int language plpgsql security invoker set search_path = '' as $$
declare moved int; bad int;
begin
  sources := array(select distinct s from unnest(sources) s where s <> target);
  if coalesce(array_length(sources, 1), 0) = 0 then raise exception 'Chọn ít nhất 2 lô để gộp'; end if;
  select count(*) into bad from public.batches b
    where b.id = any(sources || target) and b.user_id <> (select auth.uid()) and not public.is_admin();
  if bad > 0 then raise exception 'Chỉ gộp được các lô của bạn (hoặc quản trị viên gộp mọi lô)'; end if;
  if (select count(*) from public.batches b where b.id = any(sources || target)) <> array_length(sources, 1) + 1 then
    raise exception 'Không tìm thấy một số lô';
  end if;
  update public.images set batch_id = target where batch_id = any(sources);
  get diagnostics moved = row_count;
  update public.batches set
    name = coalesce(nullif(trim(new_name), ''), name),
    shared = shared or exists (select 1 from public.batches s where s.id = any(sources) and s.shared)
  where id = target;
  delete from public.batches where id = any(sources);
  return moved;
end $$;
revoke all on function public.merge_batches(bigint, bigint[], text) from public, anon;
grant execute on function public.merge_batches(bigint, bigint[], text) to authenticated;
