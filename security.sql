-- =====================================================================
-- Plasma Grader — gia cố bảo mật (chạy sau setup.sql, admin.sql, collab.sql)
--  * Tài khoản mới phải được quản trị viên DUYỆT mới xem / chấm / tải ảnh
--  * Tài khoản có thể bị KHOÁ
--  * Thu hồi các quyền thừa trên bảng
-- =====================================================================

alter table public.profiles add column if not exists approved boolean not null default false;
alter table public.profiles add column if not exists approved_at timestamptz;
-- tài khoản hiện có (đã dùng trước khi bật duyệt) được giữ quyền
update public.profiles set approved = true, approved_at = coalesce(approved_at, now()) where not approved;
update public.profiles p set approved = true where exists (select 1 from public.admins a where a.user_id = p.id);

create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.approved)
      or exists (select 1 from public.admins a where a.user_id = (select auth.uid()));
$$;
revoke all on function public.is_approved() from public, anon;
grant execute on function public.is_approved() to authenticated;

-- quyền xem lô: phải được duyệt
create or replace function public.can_view_batch(bid bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_approved() and exists (select 1 from public.batches b
    where b.id = bid and (b.user_id = (select auth.uid()) or b.shared or public.is_admin()));
$$;

-- ---------- batches ----------
drop policy if exists "batches select" on public.batches;
drop policy if exists "batches insert" on public.batches;
drop policy if exists "batches update" on public.batches;
drop policy if exists "batches delete" on public.batches;
create policy "batches select" on public.batches for select to authenticated
  using ((select public.is_approved()) and (user_id = (select auth.uid()) or shared or (select public.is_admin())));
create policy "batches insert" on public.batches for insert to authenticated
  with check ((select public.is_approved()) and user_id = (select auth.uid()));
create policy "batches update" on public.batches for update to authenticated
  using ((select public.is_approved()) and (user_id = (select auth.uid()) or (select public.is_admin())))
  with check ((select public.is_approved()) and (user_id = (select auth.uid()) or (select public.is_admin())));
create policy "batches delete" on public.batches for delete to authenticated
  using ((select public.is_approved()) and (user_id = (select auth.uid()) or (select public.is_admin())));

-- ---------- images ----------
drop policy if exists "images select" on public.images;
drop policy if exists "images insert" on public.images;
drop policy if exists "images update" on public.images;
drop policy if exists "images delete" on public.images;
create policy "images select" on public.images for select to authenticated
  using ((select public.is_approved()) and (user_id = (select auth.uid()) or public.can_view_batch(batch_id)));
create policy "images insert" on public.images for insert to authenticated
  with check ((select public.is_approved()) and user_id = (select auth.uid())
    and exists (select 1 from public.batches b where b.id = batch_id and b.user_id = (select auth.uid())));
create policy "images update" on public.images for update to authenticated
  using ((select public.is_approved()) and (user_id = (select auth.uid()) or public.can_view_batch(batch_id)))
  with check ((select public.is_approved()) and (user_id = (select auth.uid()) or public.can_view_batch(batch_id)));
create policy "images delete" on public.images for delete to authenticated
  using ((select public.is_approved()) and (user_id = (select auth.uid()) or (select public.is_admin())));

-- ---------- ratings ----------
drop policy if exists "ratings select" on public.ratings;
drop policy if exists "ratings insert" on public.ratings;
drop policy if exists "ratings update" on public.ratings;
drop policy if exists "ratings delete" on public.ratings;
create policy "ratings select" on public.ratings for select to authenticated
  using ((select public.is_approved()) and exists (select 1 from public.images i where i.id = image_id));
create policy "ratings insert" on public.ratings for insert to authenticated
  with check ((select public.is_approved()) and user_id = (select auth.uid())
    and exists (select 1 from public.images i where i.id = image_id));
create policy "ratings update" on public.ratings for update to authenticated
  using ((select public.is_approved()) and user_id = (select auth.uid()))
  with check ((select public.is_approved()) and user_id = (select auth.uid()));
create policy "ratings delete" on public.ratings for delete to authenticated
  using ((select public.is_approved()) and (user_id = (select auth.uid()) or (select public.is_admin())));

-- ---------- profiles: chưa duyệt chỉ thấy hồ sơ của mình ----------
drop policy if exists "read profiles" on public.profiles;
create policy "read profiles" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_approved()));

-- ---------- kho ảnh ----------
drop policy if exists "plasma read own"   on storage.objects;
drop policy if exists "plasma insert own" on storage.objects;
drop policy if exists "plasma update own" on storage.objects;
drop policy if exists "plasma delete own" on storage.objects;
create policy "plasma read own" on storage.objects for select to authenticated
  using (bucket_id = 'plasma' and (select public.is_approved()) and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or (select public.is_admin())
    or exists (select 1 from public.images i where i.storage_path = objects.name)));
create policy "plasma insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'plasma' and (select public.is_approved())
    and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "plasma update own" on storage.objects for update to authenticated
  using (bucket_id = 'plasma' and (select public.is_approved())
    and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "plasma delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'plasma' and (select public.is_approved())
    and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_admin())));

-- kho ảnh: chỉ nhận ảnh, tối đa 30 MB/ảnh
update storage.buckets set file_size_limit = 31457280,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/bmp','image/tiff','image/heic','image/heif','image/gif']
where id = 'plasma';

-- ---------- quản trị: duyệt / khoá tài khoản ----------
create or replace function public.admin_set_approved(target uuid, approve boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên được dùng chức năng này'; end if;
  if target = auth.uid() and not approve then raise exception 'Không thể tự khoá tài khoản của chính mình'; end if;
  update public.profiles set approved = approve, approved_at = case when approve then now() else null end where id = target;
  if not approve then
    delete from public.admins where user_id = target;       -- khoá thì bỏ luôn quyền quản trị
    delete from auth.sessions where user_id = target;      -- đăng xuất mọi thiết bị
    delete from auth.refresh_tokens where user_id::uuid = target;
  end if;
end $$;
revoke all on function public.admin_set_approved(uuid, boolean) from public, anon;
grant execute on function public.admin_set_approved(uuid, boolean) to authenticated;

drop function if exists public.admin_list_users();
create function public.admin_list_users()
returns table (id uuid, username text, email text, created_at timestamptz, last_sign_in_at timestamptz,
               is_admin boolean, approved boolean, batches int, images int, graded int, storage_bytes bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên được dùng chức năng này'; end if;
  return query
    select u.id, coalesce(p.username, split_part(u.email, '@', 1))::text, u.email::text, u.created_at, u.last_sign_in_at,
           exists (select 1 from public.admins a where a.user_id = u.id),
           coalesce(p.approved, false),
           (select count(*)::int from public.batches b where b.user_id = u.id),
           (select count(*)::int from public.images i where i.user_id = u.id),
           (select count(*)::int from public.ratings r where r.user_id = u.id and r.grade is not null),
           (select coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint from storage.objects o
              where o.bucket_id = 'plasma' and (storage.foldername(o.name))[1] = u.id::text)
    from auth.users u left join public.profiles p on p.id = u.id
    order by coalesce(p.approved, false), u.created_at;
end $$;
revoke all on function public.admin_list_users() from public, anon;
grant execute on function public.admin_list_users() to authenticated;

-- cấp quyền quản trị thì tự duyệt luôn
create or replace function public.admin_set_admin(target uuid, make_admin boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên được dùng chức năng này'; end if;
  if target = auth.uid() and not make_admin then raise exception 'Không thể tự bỏ quyền quản trị của chính mình'; end if;
  if make_admin then
    insert into public.admins (user_id) values (target) on conflict do nothing;
    update public.profiles set approved = true, approved_at = coalesce(approved_at, now()) where id = target;
  else delete from public.admins where user_id = target; end if;
end $$;

-- ---------- thu hồi quyền thừa (TRUNCATE bỏ qua RLS) ----------
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;
revoke all on public.profiles, public.admins, public.ratings, public.batches, public.images, public.batch_stats from anon;
alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;
