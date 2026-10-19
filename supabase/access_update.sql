
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
