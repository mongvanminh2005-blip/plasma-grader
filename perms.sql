-- Chỉ quản trị viên kiểm soát dữ liệu: đổi tên / chia sẻ / gộp / xoá lô, xoá ảnh, xoá file.
-- Người dùng khác chỉ tải ảnh lên (lô của mình) và phân loại. Chạy sau roles.sql.

-- LÔ
drop policy if exists "batches update" on public.batches;
create policy "batches update" on public.batches for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "batches delete" on public.batches;
create policy "batches delete" on public.batches for delete to authenticated
  using ((select public.is_admin()));
alter table public.batches alter column shared set default true;   -- lô mới mọi người cùng thấy

-- ẢNH: xoá hẳn chỉ quản trị viên; đưa vào thùng rác / chuyển lô / đổi file cũng chỉ quản trị viên
drop policy if exists "images delete" on public.images;
create policy "images delete" on public.images for delete to authenticated
  using ((select public.is_admin()));
create or replace function public.guard_image_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.deleted_at is distinct from old.deleted_at or new.batch_id <> old.batch_id
      or new.storage_path <> old.storage_path or new.user_id <> old.user_id)
     and not public.is_admin() then
    raise exception 'Chỉ quản trị viên được xoá, chuyển lô hoặc thay file ảnh';
  end if;
  return new;
end $$;

-- FILE ẢNH
drop policy if exists "plasma delete own" on storage.objects;
create policy "plasma delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'plasma' and (select public.is_admin()));

-- GỘP LÔ: chỉ quản trị viên
create or replace function public.merge_batches(target bigint, sources bigint[], new_name text default null)
returns integer language plpgsql set search_path = '' as $$
declare moved int;
begin
  if not public.is_admin() then raise exception 'Chỉ quản trị viên được gộp lô'; end if;
  sources := array(select distinct s from unnest(sources) s where s <> target);
  if coalesce(array_length(sources, 1), 0) = 0 then raise exception 'Chọn ít nhất 2 lô để gộp'; end if;
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
