-- ============================================================
-- NEB 1887 School Bus Management — Supabase Database Schema
-- Run this entire file in Supabase → SQL Editor → New Query
-- ============================================================

-- 1. STUDENTS
create table if not exists students (
  id          serial primary key,
  name        text not null,
  grade       int  not null,
  guardian    text,
  contact     text,
  address     text,
  active      boolean default true,
  created_at  timestamptz default now()
);

-- 2. TRANSACTIONS
create table if not exists transactions (
  id          text primary key,
  student_id  int references students(id) on delete cascade,
  amount      numeric(10,2) not null,
  method      text not null check (method in ('GCash','Cash')),
  date        date not null default current_date,
  period      text not null,
  ref         text,
  status      text default 'confirmed' check (status in ('confirmed','pending','cancelled')),
  note        text,
  created_at  timestamptz default now()
);

-- 3. SETTINGS  (key-value store for rates etc.)
create table if not exists settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz default now()
);

-- 4. EXPENSES
create table if not exists expenses (
  id          serial primary key,
  period      text not null,
  category    text not null check (category in ('Fuel','Salary','Maintenance','Other')),
  amount      numeric(10,2) not null,
  description text,
  date        date not null default current_date,
  created_at  timestamptz default now()
);

-- ── SEED DEFAULT SETTINGS ────────────────────────────────────
insert into settings (key, value) values
  ('daily_rate',    '240'),
  ('school_days',   '22'),
  ('driver_rate',   '500'),
  ('gcash_number',  '09XX-XXX-XXXX'),
  ('gcash_name',    'Lucky Shining Star Dev. Corp.'),
  ('bus_unit',      'NEB 1887')
on conflict (key) do nothing;

-- ── SEED STUDENTS ────────────────────────────────────────────
insert into students (name, grade, guardian, contact, address) values
  ('Abello, Jansen',           10, 'Cherry Abello',        '0939-916-1535', '079, Madugo, Bagumbayan, Roxas, Or. Mindoro'),
  ('Barola, Ivana Bleszy',     10, 'Ivan Barola',          '0950-468-2235', 'Purok 2, Ogbot, Bongabong, Or. Mindoro'),
  ('Calderon, Gweneth',        10, 'Sheryl Calderon',      '0949-116-5560', 'Sta Fe, Bagumbayan, Roxas, Or. Mindoro'),
  ('Dimapilis, Giovani Pablo',  9, 'Florybelle Dimapilis', '0966-940-1445', 'Sta Fe, Bagumbayan, Roxas, Or. Mindoro'),
  ('Doong, Princess',           7, 'Bong Doong',           '0919-558-8888', 'New Dangay, Roxas, Or. Mindoro'),
  ('Galindez, Raphael',         8, 'Rosine Galindez',      '0994-750-4315', 'Camantigue, Bongabong, Or. Mindoro'),
  ('Galindez, Von',            12, 'Domingo Galindez',     '0915-310-0036', 'Cabrera St., Bagumbayan, Roxas, Or. Mindoro'),
  ('Gregorio, Phil Justine',    9, 'Domingo Galindez',     '0917-163-1640', 'Sitio Pantalan, Poblacion, Mansalay, Or. Mindoro'),
  ('Gregorio, Jairah Lerisse',  7, 'Jennibeth Gregorio',   '0917-163-1640', 'Sitio Pantalan, Poblacion, Mansalay, Or. Mindoro'),
  ('Magluyan, Audrey May',     10, 'Madelyn Magluyan',     '0921-926-3173', 'Cabrera St., Bagumbayan, Roxas, Or. Mindoro'),
  ('Martinez, Louise Noelle',  11, 'Edison Martinez',      '0906-280-6657', 'Upper Odiong, Roxas, Or. Mindoro'),
  ('Panoy, Xave Chryslier',     7, 'Lowell Panoy',         '0933-821-3669', 'Sta Fe, Bagumbayan, Roxas, Or. Mindoro'),
  ('Suarez, Carmela Yvonne',    7, 'Yvan Suarez',          '0905-247-5960', 'Centro, Labasan, Bongabong, Or. Mindoro'),
  ('Suzara, Vito',              8, 'Bioz Suzara',          '0999-992-1541', 'Odiong, Roxas, Or. Mindoro'),
  ('Suzara, Zhia',              7, 'Bioz Suzara',          '0999-992-1541', 'Odiong, Roxas, Or. Mindoro'),
  ('Valencia, Gia',            11, 'Robert Valencia',      '0966-029-7020', 'Odiong, Roxas, Or. Mindoro')
on conflict do nothing;

-- ── ROW LEVEL SECURITY (optional but recommended) ────────────
-- Enable RLS so only authenticated users can read/write
-- (comment these out if you want open access during testing)
alter table students     enable row level security;
alter table transactions enable row level security;
alter table settings     enable row level security;
alter table expenses     enable row level security;

-- Allow all operations for authenticated users
create policy "auth_all" on students     for all using (auth.role() = 'authenticated');
create policy "auth_all" on transactions for all using (auth.role() = 'authenticated');
create policy "auth_all" on settings     for all using (auth.role() = 'authenticated');
create policy "auth_all" on expenses     for all using (auth.role() = 'authenticated');

-- ── HELPFUL VIEWS ────────────────────────────────────────────
-- Monthly collection summary
create or replace view monthly_summary as
select
  period,
  count(*)                                          as txn_count,
  sum(amount)                                       as total_collected,
  sum(case when method = 'GCash' then amount else 0 end) as gcash_total,
  sum(case when method = 'Cash'  then amount else 0 end) as cash_total
from transactions
where status = 'confirmed'
group by period
order by period;

-- Student balance per period
create or replace view student_balances as
select
  s.id,
  s.name,
  s.grade,
  t.period,
  sum(t.amount) as paid
from students s
left join transactions t on t.student_id = s.id and t.status = 'confirmed'
group by s.id, s.name, s.grade, t.period;
