#!/usr/bin/env python3
"""Export a read-only snapshot of the linked Supabase project's schema to supabase/schema.sql.

Usage (needs `supabase login` + a linked project; no Docker required):
    python3 scripts/export-schema.py

Only runs SELECTs against the system catalogs through `supabase db query --linked`.
The output is a REFERENCE snapshot (not a migration): tables, constraints, indexes,
RLS policies, functions, triggers, storage buckets and approximate row counts.
"""
import datetime
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "supabase" / "schema.sql"
PUB = "'public'::regnamespace"


def q(sql: str):
    r = subprocess.run(
        ["supabase", "db", "query", "--linked", "-o", "json", sql],
        capture_output=True, text=True, cwd=ROOT,
    )
    if r.returncode != 0:
        sys.exit(f"query failed:\n{sql}\n{r.stderr}")
    out = r.stdout
    obj, _ = json.JSONDecoder().raw_decode(out[out.index("{"):])
    return obj["rows"]


cols = q(f"""
select c.relname as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as type,
       a.attnotnull as notnull, pg_get_expr(d.adbin, d.adrelid) as def
from pg_attribute a
join pg_class c on c.oid = a.attrelid
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where c.relnamespace = {PUB} and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
order by c.relname, a.attnum""")
cons = q(f"""select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
from pg_constraint where connamespace = {PUB} order by 1, 2""")
idx = q("select tablename as tbl, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2")
rls = q(f"select relname as tbl, relrowsecurity as rls from pg_class where relnamespace = {PUB} and relkind = 'r' order by 1")
pols = q("""select tablename as tbl, policyname, permissive, roles::text as roles, cmd, qual, with_check
from pg_policies where schemaname = 'public' order by 1, 2""")
funcs = q(f"""select p.proname, p.prosecdef as secdef, pg_get_functiondef(p.oid) as def
from pg_proc p where p.pronamespace = {PUB} and p.prokind = 'f' order by 1""")
trigs = q(f"""select c.relname as tbl, t.tgname, pg_get_triggerdef(t.oid) as def
from pg_trigger t join pg_class c on c.oid = t.tgrelid
where c.relnamespace = {PUB} and not t.tgisinternal order by 1, 2""")
buckets = q("select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by 1")
spols = q("""select policyname, cmd, roles::text as roles, qual, with_check from pg_policies
where schemaname = 'storage' and tablename = 'objects' order by 1""")
counts = q("select relname as tbl, n_live_tup as approx_rows from pg_stat_user_tables where schemaname = 'public' order by 1")
exts = q("select extname from pg_extension order by 1")


def by(rows, key="tbl"):
    d = {}
    for r in rows:
        d.setdefault(r[key], []).append(r)
    return d


cols_by, cons_by, idx_by, pols_by, trig_by = by(cols), by(cons), by(idx), by(pols), by(trigs)
rls_by = {r["tbl"]: r["rls"] for r in rls}
cnt_by = {r["tbl"]: r["approx_rows"] for r in counts}

lines = [
    "-- Vertly / Vexium — Supabase schema SNAPSHOT (reference only, NOT a migration)",
    f"-- Generated {datetime.date.today()} by scripts/export-schema.py from project ciuqhxrxcznmgorjeumz",
    f"-- Extensions: {', '.join(e['extname'] for e in exts)}",
    "",
]
for tbl in sorted(cols_by):
    lines.append(f"-- ── {tbl}  (~{cnt_by.get(tbl, 0)} rows, RLS {'ON' if rls_by.get(tbl) else 'OFF'}) " + "─" * 10)
    body = []
    for c in cols_by[tbl]:
        s = f'  "{c["col"]}" {c["type"]}'
        if c["notnull"]:
            s += " NOT NULL"
        if c["def"]:
            s += f' DEFAULT {c["def"]}'
        body.append(s)
    for k in cons_by.get(tbl, []):
        body.append(f'  CONSTRAINT "{k["conname"]}" {k["def"]}')
    lines.append(f'CREATE TABLE public."{tbl}" (\n' + ",\n".join(body) + "\n);")
    for i in idx_by.get(tbl, []):
        lines.append(i["indexdef"] + ";")
    if rls_by.get(tbl):
        lines.append(f'ALTER TABLE public."{tbl}" ENABLE ROW LEVEL SECURITY;')
    for p in pols_by.get(tbl, []):
        s = f'CREATE POLICY "{p["policyname"]}" ON public."{tbl}" AS {p["permissive"]} FOR {p["cmd"]} TO {p["roles"].strip("{}")}'
        if p["qual"]:
            s += f' USING ({p["qual"]})'
        if p["with_check"]:
            s += f' WITH CHECK ({p["with_check"]})'
        lines.append(s + ";")
    for t in trig_by.get(tbl, []):
        lines.append(t["def"] + ";")
    lines.append("")

lines.append("-- ── FUNCTIONS (SECURITY DEFINER marked) " + "─" * 20)
for f in funcs:
    lines.append(f'-- {f["proname"]}{"  [SECURITY DEFINER]" if f["secdef"] else ""}')
    lines.append(f["def"].rstrip() + ";")
    lines.append("")

lines.append("-- ── STORAGE " + "─" * 20)
for b in buckets:
    lines.append(f"-- bucket {b['id']}: public={b['public']} size_limit={b['file_size_limit']} mime={b['allowed_mime_types']}")
for p in spols:
    s = f'-- storage.objects policy "{p["policyname"]}" FOR {p["cmd"]} TO {p["roles"].strip("{}")}'
    if p["qual"]:
        s += f' USING ({p["qual"]})'
    if p["with_check"]:
        s += f' WITH CHECK ({p["with_check"]})'
    lines.append(s)

OUT.write_text("\n".join(lines) + "\n")
print(f"wrote {OUT.relative_to(ROOT)}: {len(cols_by)} tables, {len(funcs)} functions, {len(pols)} policies, {len(buckets)} buckets")
