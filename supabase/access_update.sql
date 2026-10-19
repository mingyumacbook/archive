
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

-- 9) 문의 채팅 (회원 ↔ 마스터 1:1) · 공지 메시지함
--    회원은 자기 대화만, 마스터는 모든 대화를 봐요. 보낸 메시지는 5분 안에만 고칠 수 있어요.
create table if not exists public.chat_inq (
  id uuid primary key default gen_random_uuid(),
  uid uuid not null references auth.users(id) on delete cascade,
  cat text not null check (cat in ('bug','idea','cut','etc')),
  title text not null,
  st text not null default 'new' check (st in ('new','doing','done','hold')),
  created_at timestamptz not null default now()
);
create table if not exists public.chat_msgs (
  id uuid primary key default gen_random_uuid(),
  uid uuid not null references auth.users(id) on delete cascade,
  sender text not null check (sender in ('u','a','s')),
  body text not null default '',
  img text,
  inq uuid references public.chat_inq(id) on delete cascade,
  st text,
  edited boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists chat_msgs_uid_at on public.chat_msgs (uid, created_at);
create table if not exists public.chat_read (
  uid uuid not null references auth.users(id) on delete cascade,
  who text not null check (who in ('u','a','n')),
  at timestamptz not null default now(),
  primary key (uid, who)
);
alter table public.chat_inq enable row level security;
alter table public.chat_msgs enable row level security;
alter table public.chat_read enable row level security;

-- 바꾸면 안 되는 값은 그대로 유지 (상태는 마스터만 바꿀 수 있어요)
create or replace function public.vd_chat_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.uid := old.uid; new.created_at := old.created_at;
  if tg_table_name = 'chat_msgs' then new.sender := old.sender; new.inq := old.inq; new.st := old.st;
  elsif not public.vd_admin() then new.st := old.st; new.cat := old.cat;
  end if;
  return new;
end $$;
drop trigger if exists vd_chat_guard on public.chat_msgs;
create trigger vd_chat_guard before update on public.chat_msgs for each row execute function public.vd_chat_guard();
drop trigger if exists vd_chat_guard on public.chat_inq;
create trigger vd_chat_guard before update on public.chat_inq for each row execute function public.vd_chat_guard();

drop policy if exists "chat inq read" on public.chat_inq;
create policy "chat inq read" on public.chat_inq for select to authenticated
  using ((uid = auth.uid() and (select public.vd_ok())) or (select public.vd_admin()));
drop policy if exists "chat inq add" on public.chat_inq;
create policy "chat inq add" on public.chat_inq for insert to authenticated
  with check (uid = auth.uid() and st = 'new' and (select public.vd_ok()));
drop policy if exists "chat inq edit" on public.chat_inq;
create policy "chat inq edit" on public.chat_inq for update to authenticated
  using ((uid = auth.uid() and created_at > now() - interval '5 minutes' and (select public.vd_ok())) or (select public.vd_admin()))
  with check ((uid = auth.uid() and (select public.vd_ok())) or (select public.vd_admin()));
drop policy if exists "chat inq delete" on public.chat_inq;
create policy "chat inq delete" on public.chat_inq for delete to authenticated using ((select public.vd_admin()));

drop policy if exists "chat msgs read" on public.chat_msgs;
create policy "chat msgs read" on public.chat_msgs for select to authenticated
  using ((uid = auth.uid() and (select public.vd_ok())) or (select public.vd_admin()));
drop policy if exists "chat msgs add" on public.chat_msgs;
create policy "chat msgs add" on public.chat_msgs for insert to authenticated
  with check ((uid = auth.uid() and sender = 'u' and (select public.vd_ok())) or (sender in ('a','s') and (select public.vd_admin())));
drop policy if exists "chat msgs edit" on public.chat_msgs;
create policy "chat msgs edit" on public.chat_msgs for update to authenticated
  using (created_at > now() - interval '5 minutes' and ((sender = 'u' and uid = auth.uid() and (select public.vd_ok())) or (sender = 'a' and (select public.vd_admin()))))
  with check ((sender = 'u' and uid = auth.uid()) or (sender = 'a' and (select public.vd_admin())));
drop policy if exists "chat msgs delete" on public.chat_msgs;
create policy "chat msgs delete" on public.chat_msgs for delete to authenticated using ((select public.vd_admin()));

drop policy if exists "chat read marks" on public.chat_read;
create policy "chat read marks" on public.chat_read for all to authenticated
  using ((uid = auth.uid() and who in ('u','n') and (select public.vd_ok())) or (who = 'a' and (select public.vd_admin())))
  with check ((uid = auth.uid() and who in ('u','n') and (select public.vd_ok())) or (who = 'a' and (select public.vd_admin())));

-- 공지 (마스터가 쓰고, 승인된 회원은 읽기)
drop policy if exists "admin notices" on public.shared_docs;
create policy "admin notices" on public.shared_docs for all to authenticated
  using (collection = 'notices' and (select public.vd_admin())) with check (collection = 'notices' and (select public.vd_admin()));
