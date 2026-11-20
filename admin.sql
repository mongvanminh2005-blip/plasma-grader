-- =====================================================================
-- Plasma Grader — quyền QUẢN TRỊ (chạy sau setup.sql)
-- Gán quản trị viên: insert into public.admins(user_id)
--   select id from auth.users where email = '<ten-dang-nhap>@users.plasma-grader.app';
-- =====================================================================

-- Hồ sơ người dùng (tên hiển thị) — tạo tự động khi đăng ký
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- Danh sách quản trị viên (không đọc trực tiếp từ trình duyệt)
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = (select auth.uid()));
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, username) values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
insert into public.profiles (id, username)
  select id, split_part(email, '@', 1) from auth.users on conflict (id) do nothing;

grant select on public.profiles to authenticated;
drop policy if exists "read profiles" on public.profiles;
create policy "read profiles" on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

-- Chính sách: chủ sở hữu HOẶC quản trị viên
drop policy if exists "own batches" on public.batches;
create policy "own batches" on public.batches for all to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()))
  with check (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists "own images" on public.images;
create policy "own images" on public.images for all to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()))
  with check (
    (user_id = (select auth.uid())
      and exists (select 1 from public.batches b where b.id = batch_id and b.user_id = (select auth.uid())))
    or (select public.is_admin())
  );

drop policy if exists "plasma read own"   on storage.objects;
drop policy if exists "plasma delete own" on storage.objects;
create policy "plasma read own" on storage.objects for select to authenticated
  using (bucket_id = 'plasma' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_admin())));
create policy "plasma delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'plasma' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select public.is_admin())));

-- Thống kê lô kèm người sở hữu
drop view if exists public.batch_stats;
create view public.batch_stats with (security_invoker = on) as
  select b.id, b.name, b.created_at, b.user_id, p.username as owner,
         count(i.id)::int as total, count(i.grade)::int as graded
  from public.batches b
  left join public.profiles p on p.id = b.user_id
  left join public.images i on i.batch_id = b.id
  group by b.id, p.username;
grant select on public.batch_stats to authenticated;
revoke all on public.batch_stats from anon;

-- ---------- Hàm dành riêng cho quản trị viên ----------
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
           (select count(i.grade)::int from public.images i where i.user_id = u.id),
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
    'graded',  (select count(grade) from public.images),
    'storage_bytes', (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where bucket_id = 'plasma'),
    'db_bytes', pg_database_size(current_database())
  );
end $$;

create or replace function public.admin_set_password(target uuid, new_password text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên được dùng chức năng này'; end if;
  if length(new_password) < 6 then raise exception 'Mật khẩu tối thiểu 6 ký tự'; end if;
  update auth.users set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')), updated_at = now()
  where id = target;
end $$;

create or replace function public.admin_set_admin(target uuid, make_admin boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên được dùng chức năng này'; end if;
  if target = auth.uid() and not make_admin then raise exception 'Không thể tự bỏ quyền quản trị của chính mình'; end if;
  if make_admin then insert into public.admins (user_id) values (target) on conflict do nothing;
  else delete from public.admins where user_id = target; end if;
end $$;

create or replace function public.admin_delete_user(target uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên được dùng chức năng này'; end if;
  if target = auth.uid() then raise exception 'Không thể tự xoá tài khoản của chính mình'; end if;
  delete from auth.users where id = target;  -- lô, ảnh, hồ sơ bị xoá theo (cascade)
end $$;

revoke all on function public.admin_list_users(), public.admin_overview(),
  public.admin_set_password(uuid, text), public.admin_set_admin(uuid, boolean), public.admin_delete_user(uuid)
  from public, anon;
grant execute on function public.admin_list_users(), public.admin_overview(),
  public.admin_set_password(uuid, text), public.admin_set_admin(uuid, boolean), public.admin_delete_user(uuid)
  to authenticated;
