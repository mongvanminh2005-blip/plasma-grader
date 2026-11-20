-- =====================================================================
-- Plasma Grader — THÙNG RÁC (xoá mềm). Chạy sau security.sql
-- Ảnh / lô bị xoá được giữ 30 ngày, khôi phục được; sau đó website xoá hẳn.
-- =====================================================================
alter table public.images  add column if not exists deleted_at timestamptz;
alter table public.batches add column if not exists deleted_at timestamptz;
create index if not exists images_deleted_idx  on public.images(deleted_at)  where deleted_at is not null;
create index if not exists batches_deleted_idx on public.batches(deleted_at) where deleted_at is not null;

-- người khác chỉ thấy lô chung CHƯA bị xoá; chủ lô và quản trị viên thấy cả lô trong thùng rác
create or replace function public.can_view_batch(bid bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_approved() and exists (select 1 from public.batches b
    where b.id = bid and (b.user_id = (select auth.uid()) or public.is_admin() or (b.shared and b.deleted_at is null)));
$$;

drop policy if exists "batches select" on public.batches;
create policy "batches select" on public.batches for select to authenticated
  using ((select public.is_approved()) and (user_id = (select auth.uid()) or (select public.is_admin()) or (shared and deleted_at is null)));

drop policy if exists "images select" on public.images;
create policy "images select" on public.images for select to authenticated
  using ((select public.is_approved()) and (
    user_id = (select auth.uid()) or (select public.is_admin())
    or (deleted_at is null and public.can_view_batch(batch_id))));

-- chỉ chủ ảnh / quản trị viên được xoá-khôi phục, đổi lô hoặc đổi file ảnh
create or replace function public.guard_image_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.deleted_at is distinct from old.deleted_at or new.batch_id <> old.batch_id
      or new.storage_path <> old.storage_path or new.user_id <> old.user_id)
     and not (old.user_id = auth.uid() or public.is_admin()) then
    raise exception 'Chỉ người tải ảnh lên hoặc quản trị viên được thay đổi điều này';
  end if;
  return new;
end $$;
revoke all on function public.guard_image_update() from public, anon, authenticated;
drop trigger if exists guard_image_update on public.images;
create trigger guard_image_update before update on public.images
  for each row execute function public.guard_image_update();

-- thống kê lô: bỏ lô / ảnh trong thùng rác
drop view if exists public.batch_stats;
create view public.batch_stats with (security_invoker = on) as
  select b.id, b.name, b.created_at, b.user_id, b.shared, p.username as owner,
    (select count(*) from public.images i where i.batch_id = b.id and i.deleted_at is null)::int as total,
    (select count(*) from public.ratings r join public.images i on i.id = r.image_id
       where i.batch_id = b.id and i.deleted_at is null and r.user_id = (select auth.uid()) and r.grade is not null)::int as graded,
    (select count(distinct r.user_id) from public.ratings r join public.images i on i.id = r.image_id
       where i.batch_id = b.id and i.deleted_at is null and r.grade is not null)::int as raters
  from public.batches b left join public.profiles p on p.id = b.user_id
  where b.deleted_at is null;
grant select on public.batch_stats to authenticated;
revoke all on public.batch_stats from anon;

create or replace function public.admin_overview()
returns json language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên được dùng chức năng này'; end if;
  return json_build_object(
    'users',   (select count(*) from auth.users),
    'batches', (select count(*) from public.batches where deleted_at is null),
    'images',  (select count(*) from public.images i join public.batches b on b.id = i.batch_id where i.deleted_at is null and b.deleted_at is null),
    'graded',  (select count(distinct r.image_id) from public.ratings r join public.images i on i.id = r.image_id where r.grade is not null and i.deleted_at is null),
    'ratings', (select count(*) from public.ratings where grade is not null),
    'trash',   (select count(*) from public.images where deleted_at is not null) + (select count(*) from public.batches where deleted_at is not null),
    'storage_bytes', (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where bucket_id = 'plasma'),
    'db_bytes', pg_database_size(current_database())
  );
end $$;
