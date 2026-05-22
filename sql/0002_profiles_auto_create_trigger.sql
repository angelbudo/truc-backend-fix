-- =====================================================================
-- Trigger automàtic: crear `public.profiles` quan es registra un usuari
-- nou a `auth.users` (email/password, Google OAuth, etc).
--
-- Executa aquest script al SQL Editor del projecte Supabase
-- (sgonrrtqdcwyajsmufhs) UNA sola vegada.
--
-- És idempotent: es pot tornar a executar sense problemes.
-- =====================================================================

-- 1) Generador de friend_code de 8 caràcters (alfabet sense ambigüitats)
create or replace function public.gen_friend_code()
returns text
language plpgsql
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text := '';
  i int;
  exists_already boolean;
begin
  loop
    code := '';
    for i in 1..8 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    select exists(select 1 from public.profiles where friend_code = code)
      into exists_already;
    exit when not exists_already;
  end loop;
  return code;
end;
$$;

-- 2) Funció que s'executa amb cada nou usuari
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_display_name text;
begin
  -- Prioritats per al display_name:
  --   1. metadata.display_name (passat al signUp options.data)
  --   2. metadata.full_name / name (Google OAuth)
  --   3. part local de l'email
  --   4. fallback "Jugador"
  v_display_name := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
    nullif(trim(new.raw_user_meta_data->>'name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Jugador'
  );
  v_display_name := substr(v_display_name, 1, 24);

  insert into public.profiles (user_id, display_name, email, friend_code)
  values (
    new.id,
    v_display_name,
    new.email,
    public.gen_friend_code()
  )
  on conflict (user_id) do update
    set email = excluded.email
    where public.profiles.email is distinct from excluded.email;

  return new;
end;
$$;

-- 3) Trigger sobre auth.users (esborra si ja existeix per idempotència)
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- 4) Backfill: crear profiles per a usuaris existents que encara no en tinguin
insert into public.profiles (user_id, display_name, email, friend_code)
select
  u.id,
  substr(
    coalesce(
      nullif(trim(u.raw_user_meta_data->>'display_name'), ''),
      nullif(trim(u.raw_user_meta_data->>'full_name'), ''),
      nullif(trim(u.raw_user_meta_data->>'name'), ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
      'Jugador'
    ),
    1, 24
  ),
  u.email,
  public.gen_friend_code()
from auth.users u
left join public.profiles p on p.user_id = u.id
where p.user_id is null;
