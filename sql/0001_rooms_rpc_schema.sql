-- =========================================================================
-- Fase 1 — Esquema base para `rooms-rpc`
-- Pegar y ejecutar en el SQL Editor de tu Supabase externo.
-- Idempotente: se puede re-ejecutar sin romper nada.
-- =========================================================================

-- ---------- Salas ---------------------------------------------------------
create table if not exists public.rooms (
  id               uuid        primary key default gen_random_uuid(),
  code             text        not null unique,
  sala_slug        text,
  status           text        not null default 'lobby'
                   check (status in ('lobby','playing','finished','abandoned')),
  target_cames     int         not null default 2,
  target_cama      int         not null default 12,
  turn_timeout_sec int         not null default 30,
  initial_mano     int         not null default 0 check (initial_mano between 0 and 3),
  seat_kinds       jsonb       not null default '["human","human","human","human"]'::jsonb,
  host_device      text        not null,
  match_state      jsonb,
  turn_started_at  timestamptz,
  paused_at        timestamptz,
  pending_proposal jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists rooms_status_idx     on public.rooms(status);
create index if not exists rooms_updated_at_idx on public.rooms(updated_at desc);
create index if not exists rooms_sala_slug_idx  on public.rooms(sala_slug) where sala_slug is not null;

-- ---------- Jugadores en cada sala ---------------------------------------
create table if not exists public.room_players (
  room_id   uuid not null references public.rooms(id) on delete cascade,
  seat      int  not null check (seat between 0 and 3),
  device_id text not null,
  name      text not null,
  last_seen timestamptz not null default now(),
  primary key (room_id, seat)
);
create index if not exists room_players_device_idx on public.room_players(device_id);

-- ---------- Chat de frases predefinidas (mesa) ---------------------------
create table if not exists public.room_chat (
  id         bigserial primary key,
  room_id    uuid not null references public.rooms(id) on delete cascade,
  seat       int  not null check (seat between 0 and 3),
  phrase_id  text not null,
  created_at timestamptz not null default now()
);
create index if not exists room_chat_room_idx on public.room_chat(room_id, created_at desc);

-- ---------- Chat de texto libre ------------------------------------------
create table if not exists public.room_text_chat (
  id         bigserial primary key,
  room_id    uuid not null references public.rooms(id) on delete cascade,
  seat       int  not null check (seat between 0 and 3),
  device_id  text not null,
  text       text not null check (length(text) between 1 and 240),
  created_at timestamptz not null default now()
);
create index if not exists room_text_chat_room_idx on public.room_text_chat(room_id, created_at desc);

-- ---------- Flags de moderación ------------------------------------------
create table if not exists public.room_chat_flags (
  id                 bigserial primary key,
  room_id            uuid not null references public.rooms(id) on delete cascade,
  target_seat        int  not null,
  target_device_id   text not null,
  reporter_device_id text not null,
  reason             text,
  message_id         bigint,
  message_text       text,
  status             text not null default 'pending'
                     check (status in ('pending','approved','dismissed')),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  decided_at         timestamptz,
  decided_by         text
);
create index if not exists room_chat_flags_room_idx   on public.room_chat_flags(room_id);
create index if not exists room_chat_flags_status_idx on public.room_chat_flags(status, created_at desc);

create table if not exists public.room_chat_flag_audit (
  id                 bigserial primary key,
  flag_id            bigint not null references public.room_chat_flags(id) on delete cascade,
  room_id            uuid not null,
  target_seat        int not null,
  target_device_id   text not null,
  reporter_device_id text not null,
  message_id         bigint,
  message_text       text,
  reason             text,
  decision           text not null,
  moderator_tag      text not null,
  flag_created_at    timestamptz not null,
  flag_expires_at    timestamptz not null,
  decided_at         timestamptz not null default now()
);

-- ---------- Chat global de cada sala (lobby) -----------------------------
create table if not exists public.sala_chat (
  id         bigserial primary key,
  sala_slug  text not null,
  device_id  text not null,
  name       text not null,
  text       text not null check (length(text) between 1 and 240),
  created_at timestamptz not null default now()
);
create index if not exists sala_chat_slug_idx on public.sala_chat(sala_slug, created_at desc);

-- ---------- Invitaciones --------------------------------------------------
create table if not exists public.invites (
  id              bigserial primary key,
  room_id         uuid not null references public.rooms(id) on delete cascade,
  room_code       text not null,
  from_device_id  text not null,
  from_name       text not null,
  to_device_id    text not null,
  status          text not null default 'pending'
                  check (status in ('pending','accepted','declined','expired')),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null
);
create index if not exists invites_to_device_idx on public.invites(to_device_id, status, created_at desc);

-- =========================================================================
-- Realtime: REPLICA IDENTITY FULL + publicación
-- =========================================================================
alter table public.rooms            replica identity full;
alter table public.room_players     replica identity full;
alter table public.room_chat        replica identity full;
alter table public.room_text_chat   replica identity full;
alter table public.sala_chat        replica identity full;
alter table public.invites          replica identity full;

do $$
begin
  perform 1 from pg_publication where pubname = 'supabase_realtime';
  if found then
    begin alter publication supabase_realtime add table public.rooms;          exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.room_players;   exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.room_chat;      exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.room_text_chat; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.sala_chat;      exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.invites;        exception when duplicate_object then null; end;
  end if;
end $$;

-- =========================================================================
-- RLS — la Edge Function escribe con service_role (bypass RLS). Los clientes
-- solo necesitan SELECT (Realtime) y un INSERT abierto en sala_chat.
-- =========================================================================
alter table public.rooms                enable row level security;
alter table public.room_players         enable row level security;
alter table public.room_chat            enable row level security;
alter table public.room_text_chat       enable row level security;
alter table public.room_chat_flags      enable row level security;
alter table public.room_chat_flag_audit enable row level security;
alter table public.sala_chat            enable row level security;
alter table public.invites              enable row level security;

do $$
declare t text;
begin
  for t in
    select unnest(array[
      'rooms','room_players','room_chat','room_text_chat',
      'sala_chat','invites'
    ])
  loop
    execute format(
      'drop policy if exists "read_%1$s" on public.%1$I;
       create policy "read_%1$s" on public.%1$I for select to anon, authenticated using (true);',
      t
    );
  end loop;
end $$;

drop policy if exists "insert_sala_chat" on public.sala_chat;
create policy "insert_sala_chat" on public.sala_chat
  for insert to anon, authenticated with check (length(text) between 1 and 240);

-- =========================================================================
-- updated_at automático
-- =========================================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists rooms_touch_updated_at on public.rooms;
create trigger rooms_touch_updated_at
  before update on public.rooms
  for each row execute function public.touch_updated_at();