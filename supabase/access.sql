-- VISUAL DEPT. · 가입 승인 기능
-- Supabase 대시보드 → SQL Editor → New query → 전체 붙여넣고 Run. 여러 번 실행해도 안전합니다.
-- 켜는 순간 이미 가입한 계정은 모두 '승인'으로 들어가고, 이후 새로 가입한 사람은 관리자가 승인해야 쓸 수 있어요.

-- 1) 회원 명단
create table if not exists public.members (
  email text primary key,
  user_id uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','approved','blocked')),
  role text not null default 'member' check (role in ('member','admin')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz
);
alter table public.members enable row level security;

-- 처음 켤 때만: 이미 있는 계정은 모두 승인
do $$ begin
  if not exists (select 1 from public.members) then
    insert into public.members (email, user_id, status, decided_at)
      select lower(email), id, 'approved', now() from auth.users where email is not null
      on conflict (email) do nothing;
  end if;
end $$;

-- 관리자 지정 (비워 두면 가장 먼저 가입한 계정)
update public.members set role = 'admin', status = 'approved'
  where email = lower(coalesce(nullif('', ''), (select email from auth.users where email is not null order by created_at limit 1)));

-- 2) 승인 여부 확인 함수
create or replace function public.vd_ok() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and status = 'approved')
$$;
create or replace function public.vd_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid() and status = 'approved' and role = 'admin')
$$;

-- 3) 새로 가입하면 자동으로 '승인 대기' (관리자가 미리 승인해 둔 이메일이면 바로 사용 가능)
create or replace function public.vd_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is null then return new; end if;
  insert into public.members (email, user_id, status) values (lower(new.email), new.id, 'pending')
    on conflict (email) do update set user_id = excluded.user_id;
  return new;
end $$;
drop trigger if exists vd_new_user on auth.users;
create trigger vd_new_user after insert on auth.users for each row execute function public.vd_new_user();

-- 4) 명단 접근: 본인 줄은 본인이, 전체는 관리자만
drop policy if exists "see self" on public.members;
create policy "see self" on public.members for select to authenticated
  using (user_id = auth.uid() or (select public.vd_admin()));
drop policy if exists "admin manage" on public.members;
create policy "admin manage" on public.members for all to authenticated
  using ((select public.vd_admin())) with check ((select public.vd_admin()));

-- 5) 승인된 사람만 데이터·이미지 사용
drop policy if exists "own docs" on public.docs;
create policy "own docs" on public.docs for all to authenticated
  using (owner = auth.uid() and (select public.vd_ok())) with check (owner = auth.uid() and (select public.vd_ok()));
drop policy if exists "read shared" on public.shared_docs;
create policy "read shared" on public.shared_docs for select to authenticated using ((select public.vd_ok()));
drop policy if exists "edit channels" on public.shared_docs;
create policy "edit channels" on public.shared_docs for all to authenticated
  using (collection = 'channels' and (select public.vd_ok())) with check (collection = 'channels' and (select public.vd_ok()));

drop policy if exists "own files read" on storage.objects;
create policy "own files read" on storage.objects for select to authenticated
  using (bucket_id = 'archive' and (storage.foldername(name))[1] = auth.uid()::text and (select public.vd_ok()));
drop policy if exists "own files write" on storage.objects;
create policy "own files write" on storage.objects for insert to authenticated
  with check (bucket_id = 'archive' and (storage.foldername(name))[1] = auth.uid()::text and (select public.vd_ok()));
drop policy if exists "own files update" on storage.objects;
create policy "own files update" on storage.objects for update to authenticated
  using (bucket_id = 'archive' and (storage.foldername(name))[1] = auth.uid()::text and (select public.vd_ok()));
drop policy if exists "own files delete" on storage.objects;
create policy "own files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'archive' and (storage.foldername(name))[1] = auth.uid()::text and (select public.vd_ok()));

-- 6) 비밀번호 변경 승인 (한 계정당 한 번 승인 → 이후 자유롭게 변경)
alter table public.members add column if not exists pw_status text not null default 'none';
alter table public.members add column if not exists pw_requested_at timestamptz;
alter table public.members add column if not exists pw_decided_at timestamptz;
create or replace function public.vd_request_pw() returns text language plpgsql security definer set search_path = public as $$
declare st text;
begin
  select pw_status into st from public.members where user_id = auth.uid() and status = 'approved';
  if st is null then return 'not_member'; end if;
  if st in ('pending', 'approved') then return st; end if;
  update public.members set pw_status = 'pending', pw_requested_at = now(), pw_decided_at = null where user_id = auth.uid();
  return 'pending';
end $$;
grant execute on function public.vd_request_pw() to authenticated;

-- 7) 회원 이름 (가입할 때 입력한 이름 · 관리자가 수정 가능)
alter table public.members add column if not exists name text;
create or replace function public.vd_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is null then return new; end if;
  insert into public.members (email, user_id, status, name) values (lower(new.email), new.id, 'pending', nullif(new.raw_user_meta_data->>'name', ''))
    on conflict (email) do update set user_id = excluded.user_id, name = coalesce(public.members.name, excluded.name);
  return new;
end $$;
update public.members m set name = nullif(u.raw_user_meta_data->>'name', '') from auth.users u
  where m.user_id = u.id and m.name is null and coalesce(u.raw_user_meta_data->>'name', '') <> '';

-- 8) 앱 설정 (업데이트 노트 숨김 항목 등) — 관리자만 저장, 승인된 사람은 읽기
drop policy if exists "admin app meta" on public.shared_docs;
create policy "admin app meta" on public.shared_docs for all to authenticated
  using (collection = 'appmeta' and (select public.vd_admin())) with check (collection = 'appmeta' and (select public.vd_admin()));
