-- Vai trò người phân loại (Bác sĩ / Sinh viên) + bỏ bước quản trị viên duyệt tài khoản mới.
-- Chạy sau trash.sql.

-- 1) Tài khoản mới dùng được ngay (quản trị viên vẫn có thể "Khoá" một tài khoản)
alter table public.profiles alter column approved set default true;

-- 2) Vai trò: tự chọn khi đăng ký, quản trị viên đổi được
alter table public.profiles add column if not exists role text not null default 'student';
do $$ begin
  alter table public.profiles add constraint profiles_role_check check (role in ('student', 'doctor'));
exception when duplicate_object then null; end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, username, role, approved, approved_at)
  values (new.id, split_part(new.email, '@', 1),
          case when new.raw_user_meta_data->>'role' = 'doctor' then 'doctor' else 'student' end,
          true, now())
  on conflict (id) do nothing;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

create or replace function public.admin_set_role(target uuid, new_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên được đổi vai trò'; end if;
  if new_role not in ('student', 'doctor') then raise exception 'Vai trò không hợp lệ'; end if;
  update public.profiles set role = new_role where id = target;
end $$;
revoke all on function public.admin_set_role(uuid, text) from public, anon;
grant execute on function public.admin_set_role(uuid, text) to authenticated;
