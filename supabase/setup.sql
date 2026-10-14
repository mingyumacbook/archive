-- ARCHIVE · Supabase setup
-- Supabase 대시보드 → SQL Editor → New query → 이 파일 전체를 붙여넣고 Run.
-- 여러 번 실행해도 안전합니다.

-- 1) 개인 데이터: 아카이브·폴더·라인시트·설정 (각자 본인 것만 보임)
create table if not exists public.docs (
  owner uuid not null references auth.users(id) on delete cascade default auth.uid(),
  collection text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (owner, collection, id)
);
alter table public.docs enable row level security;
drop policy if exists "own docs" on public.docs;
create policy "own docs" on public.docs for all to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

-- 2) 공용 데이터: 뉴스 피드·트렌드·채널 (로그인한 사람 모두 보기)
create table if not exists public.shared_docs (
  collection text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
alter table public.shared_docs enable row level security;
drop policy if exists "read shared" on public.shared_docs;
create policy "read shared" on public.shared_docs for select to authenticated using (true);
drop policy if exists "edit channels" on public.shared_docs;
create policy "edit channels" on public.shared_docs for all to authenticated
  using (collection = 'channels') with check (collection = 'channels');

-- 3) 실시간 반영
alter table public.docs replica identity full;
alter table public.shared_docs replica identity full;
do $$ begin
  begin alter publication supabase_realtime add table public.docs; exception when others then null; end;
  begin alter publication supabase_realtime add table public.shared_docs; exception when others then null; end;
end $$;

-- 4) 이미지 저장소 (본인 폴더만 접근)
insert into storage.buckets (id, name, public) values ('archive', 'archive', false)
  on conflict (id) do nothing;
drop policy if exists "own files read" on storage.objects;
create policy "own files read" on storage.objects for select to authenticated
  using (bucket_id = 'archive' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own files write" on storage.objects;
create policy "own files write" on storage.objects for insert to authenticated
  with check (bucket_id = 'archive' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own files update" on storage.objects;
create policy "own files update" on storage.objects for update to authenticated
  using (bucket_id = 'archive' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "own files delete" on storage.objects;
create policy "own files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'archive' and (storage.foldername(name))[1] = auth.uid()::text);
