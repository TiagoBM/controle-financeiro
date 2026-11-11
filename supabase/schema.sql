-- Controle financeiro: tabelas, segurança e tempo real.
-- Cole tudo no Supabase em: SQL Editor > New query > Run.
-- Pode rodar mais de uma vez sem problema.

create table if not exists public.categories (
  id       text primary key,
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name     text not null,
  color    text not null default '#64748b',
  budget   bigint not null default 0            -- orçamento mensal em centavos (0 = sem orçamento)
);

create table if not exists public.cards (
  id           text primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null,
  closing_day  smallint not null check (closing_day between 1 and 31),
  due_day      smallint not null check (due_day between 1 and 31),
  limit_cents  bigint not null default 0,       -- limite em centavos (0 = não informado)
  color        text not null default '#7c3aed'
);

create table if not exists public.expenses (
  id            text primary key,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  description   text not null,
  category_id   text not null,
  card_id       text,                           -- null = sem cartão (dinheiro, Pix, débito…)
  date          date not null,                  -- data da compra
  installments  smallint not null default 1 check (installments between 1 and 120),
  total         bigint not null check (total > 0),  -- valor total em centavos
  notes         text not null default ''
);

create index if not exists categories_user_idx on public.categories (user_id);
create index if not exists cards_user_idx on public.cards (user_id);
create index if not exists expenses_user_idx on public.expenses (user_id);

-- Acesso pela API apenas para usuários logados.
revoke all on public.categories, public.cards, public.expenses from anon;
grant select, insert, update, delete on public.categories, public.cards, public.expenses to authenticated;

-- Segurança: cada pessoa só enxerga e altera os próprios dados.
alter table public.categories enable row level security;
alter table public.cards enable row level security;
alter table public.expenses enable row level security;

drop policy if exists "dono" on public.categories;
drop policy if exists "dono" on public.cards;
drop policy if exists "dono" on public.expenses;
create policy "dono" on public.categories for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "dono" on public.cards for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "dono" on public.expenses for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Tempo real: avisa os outros aparelhos quando algo muda.
do $$
declare t text;
begin
  foreach t in array array['categories', 'cards', 'expenses'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
