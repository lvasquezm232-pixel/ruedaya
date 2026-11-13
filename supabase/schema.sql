-- RUEDAYA: esquema inicial para Supabase (PostgreSQL + Realtime)
-- Ejecutar en un proyecto Supabase nuevo desde SQL Editor.
-- Antes de producción: revisar permisos, documentación, privacidad y pruebas de concurrencia.

create extension if not exists pgcrypto;

create type public.app_role as enum ('passenger','driver','admin');
create type public.driver_status as enum ('offline','available','queued','negotiating','busy','blocked');
create type public.ride_status as enum ('searching','negotiating','confirmed','driver_arriving','in_progress','completed','cancelled','no_drivers');
create type public.response_status as enum ('waiting','active','passed','withdrawn','assigned');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  role public.app_role not null default 'passenger',
  created_at timestamptz not null default now()
);

create table public.drivers (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  vehicle_plate text,
  vehicle_description text,
  verification_status text not null default 'pending' check (verification_status in ('pending','approved','rejected')),
  status public.driver_status not null default 'offline',
  lat double precision,
  lng double precision,
  location_updated_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  check ((lat is null and lng is null) or (lat between -90 and 90 and lng between -180 and 180))
);

create table public.ride_requests (
  id uuid primary key default gen_random_uuid(),
  passenger_id uuid not null references public.profiles(id),
  pickup_label text,
  pickup_lat double precision not null,
  pickup_lng double precision not null,
  destination_label text not null,
  destination_lat double precision,
  destination_lng double precision,
  status public.ride_status not null default 'searching',
  active_driver_id uuid references public.drivers(user_id),
  agreed_fare numeric(10,2) check (agreed_fare is null or agreed_fare > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (pickup_lat between -90 and 90 and pickup_lng between -180 and 180)
);

create table public.ride_responses (
  id bigint generated always as identity primary key,
  ride_id uuid not null references public.ride_requests(id) on delete cascade,
  driver_id uuid not null references public.drivers(user_id),
  response_order integer not null,
  responded_at timestamptz not null default clock_timestamp(),
  status public.response_status not null default 'waiting',
  unique (ride_id, driver_id),
  unique (ride_id, response_order)
);

create table public.ride_messages (
  id bigint generated always as identity primary key,
  ride_id uuid not null references public.ride_requests(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);

create table public.ride_confirmations (
  ride_id uuid not null references public.ride_requests(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  fare numeric(10,2) not null check (fare > 0),
  confirmed_at timestamptz not null default now(),
  primary key (ride_id, user_id)
);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null unique references public.ride_requests(id),
  passenger_id uuid not null references public.profiles(id),
  driver_id uuid not null references public.drivers(user_id),
  fare numeric(10,2) not null check (fare > 0),
  status text not null default 'assigned' check (status in ('assigned','arriving','in_progress','completed','cancelled')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index drivers_status_location_idx on public.drivers(status, location_updated_at desc);
create index ride_requests_passenger_idx on public.ride_requests(passenger_id, created_at desc);
create index ride_responses_order_idx on public.ride_responses(ride_id, response_order);
create index ride_messages_ride_idx on public.ride_messages(ride_id, created_at);
create unique index one_live_trip_per_driver on public.trips(driver_id) where status in ('assigned','arriving','in_progress');

-- Perfiles automáticos: cada usuario nuevo empieza como pasajero.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name','Usuario'), 'passenger');
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Activar RLS. Las escrituras de estados/cola deben pasar por funciones RPC seguras que se agregan en la siguiente etapa.
alter table public.profiles enable row level security;
alter table public.drivers enable row level security;
alter table public.ride_requests enable row level security;
alter table public.ride_responses enable row level security;
alter table public.ride_messages enable row level security;
alter table public.ride_confirmations enable row level security;
alter table public.trips enable row level security;

-- Perfiles: cada usuario puede leer y actualizar su propio perfil, nunca cambiar su rol desde el cliente.
create policy "profiles read own" on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles update own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Conductores aprobados y conectados: lectura básica solo para usuarios autenticados.
create policy "drivers read authenticated" on public.drivers for select to authenticated using (verification_status = 'approved' or user_id = auth.uid());
create policy "drivers insert own" on public.drivers for insert to authenticated with check (user_id = auth.uid());
create policy "drivers update own" on public.drivers for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Solicitudes: el pasajero ve las suyas; el conductor ve solo solicitudes activas mientras estén buscando.
create policy "passenger reads own rides" on public.ride_requests for select to authenticated using (passenger_id = auth.uid() or (status = 'searching' and exists(select 1 from public.drivers d where d.user_id = auth.uid() and d.status = 'available' and d.verification_status = 'approved')) or active_driver_id = auth.uid());
create policy "passenger creates ride" on public.ride_requests for insert to authenticated with check (passenger_id = auth.uid());

-- Respuestas: participantes del viaje pueden leer la cola. RPC debe controlar las inserciones en orden.
create policy "participants read responses" on public.ride_responses for select to authenticated using (
  exists(select 1 from public.ride_requests r where r.id = ride_id and (r.passenger_id = auth.uid() or r.active_driver_id = auth.uid()))
  or driver_id = auth.uid()
);

-- Mensajes: solo pasajero y conductor del turno activo pueden leer/enviar.
create policy "ride participants read messages" on public.ride_messages for select to authenticated using (
  exists(select 1 from public.ride_requests r where r.id = ride_id and (r.passenger_id = auth.uid() or r.active_driver_id = auth.uid()))
);
create policy "active participants send messages" on public.ride_messages for insert to authenticated with check (
  sender_id = auth.uid() and exists(
    select 1 from public.ride_requests r where r.id = ride_id and r.status = 'negotiating'
    and (r.passenger_id = auth.uid() or r.active_driver_id = auth.uid())
  )
);

-- Las confirmaciones se podrán leer por las partes del viaje.
create policy "participants read confirmations" on public.ride_confirmations for select to authenticated using (
  exists(select 1 from public.ride_requests r where r.id = ride_id and (r.passenger_id = auth.uid() or r.active_driver_id = auth.uid()))
);

create policy "trip participants read trips" on public.trips for select to authenticated using (passenger_id = auth.uid() or driver_id = auth.uid());

-- Habilitar tablas necesarias en Supabase Realtime desde Dashboard > Database > Publications.
-- Añadir: drivers, ride_requests, ride_responses, ride_messages, trips.
-- IMPORTANTE: NO exponer service_role key en el navegador. La siguiente etapa debe añadir RPC SECURITY DEFINER
-- para responder atómicamente, pasar al siguiente turno y confirmar la tarifa doblemente.
