"""
Supabase Export Tables & Functions

Exports all tables and functions from Supabase, including dependency analysis
for RPC functions (which tables they use).

Generates:
- supabase_export_tables/*.json (individual table data)
- supabase_data.json (bundle for the visualizer)

Required Supabase RPCs:
- public.list_tables(_schemas TEXT[])
- public.list_functions(_schemas TEXT[])
- public.list_function_dependencies(_schemas TEXT[])
"""

import os
import json
from pathlib import Path
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").rstrip("/")
SUPABASE_KEY = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY") or "").strip()
OUT_DIR = "supabase_export_tables"
SCHEMAS = [s.strip() for s in (os.getenv("SCHEMAS", "public")).split(",") if s.strip()]

if not SUPABASE_URL:
    raise SystemExit("Faltou SUPABASE_URL no .env")
if not SUPABASE_KEY:
    raise SystemExit("Faltou SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_ANON_KEY) no .env")

Path(OUT_DIR).mkdir(parents=True, exist_ok=True)

rest_base = f"{SUPABASE_URL}/rest/v1"

headers = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Accept": "application/json",
}


def sb_request(method, path, params=None, json_body=None):
    url = f"{rest_base}{path}"
    r = requests.request(method, url, headers=headers, params=params, json=json_body, timeout=60)
    if r.status_code == 404:
        return None  # RPC may not exist
    r.raise_for_status()
    return r.json()


def list_tables():
    result = sb_request("POST", "/rpc/list_tables", json_body={"_schemas": SCHEMAS})
    if result is None:
        raise SystemExit(
            "RPC list_tables não encontrada. Crie a função no Supabase:\n"
            "CREATE OR REPLACE FUNCTION public.list_tables(_schemas TEXT[] DEFAULT ARRAY['public'])\n"
            "RETURNS TABLE(schema_name TEXT, table_name TEXT) ..."
        )
    return result


def list_functions():
    result = sb_request("POST", "/rpc/list_functions", json_body={"_schemas": SCHEMAS})
    return result or []


def list_function_dependencies():
    """
    Calls RPC to get table dependencies for each function.
    Returns a list of {function_name, function_schema, referenced_table, referenced_schema}
    """
    result = sb_request("POST", "/rpc/list_function_dependencies", json_body={"_schemas": SCHEMAS})
    return result or []


def fetch_all_rows(schema_name, table_name, page_size=1000):
    rows = []
    start = 0

    while True:
        end = start + page_size - 1
        h = dict(headers)
        h["Range-Unit"] = "items"
        h["Range"] = f"{start}-{end}"

        url = f"{rest_base}/{table_name}"
        r = requests.get(url, headers=h, params={"select": "*", "limit": 1}, timeout=60)
        if r.status_code == 416:
            break
        r.raise_for_status()
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        start += page_size

    return rows


def build_functions_with_dependencies(functions, dependencies):
    """
    Combine functions list with their table dependencies.
    Returns a list of {schema, name, tables_used: [...]}
    """
    # Build a map: (schema, function_name) -> [table_names]
    dep_map = {}
    for dep in dependencies:
        key = (dep.get("function_schema", "public"), dep.get("function_name"))
        if key not in dep_map:
            dep_map[key] = set()
        table_name = dep.get("referenced_table")
        if table_name:
            dep_map[key].add(table_name)

    result = []
    for fn in functions:
        schema = fn.get("schema_name") or fn.get("function_schema") or "public"
        name = fn.get("function_name") or fn.get("name")
        key = (schema, name)
        tables_used = sorted(dep_map.get(key, []))
        result.append({
            "schema": schema,
            "name": name,
            "tables_used": tables_used
        })

    return result


def main():
    # 1. Get tables
    tables = list_tables()
    print(f"Encontradas {len(tables)} tabelas em {SCHEMAS}")

    # 2. Get functions
    functions = list_functions()
    print(f"Encontradas {len(functions)} funções customizadas em {SCHEMAS}")

    # 3. Get function dependencies (may not exist yet)
    dependencies = list_function_dependencies()
    if dependencies:
        print(f"Encontradas {len(dependencies)} dependências de funções")
    else:
        print("RPC list_function_dependencies não encontrada ou sem resultados. Funções serão exportadas sem dependências.")

    # 4. Save individual table data files
    tables_out = Path(OUT_DIR) / "_list_tables.json"
    with open(tables_out, "w", encoding="utf-8") as f:
        json.dump(tables, f, ensure_ascii=False, indent=2, default=str)

    functions_out = Path(OUT_DIR) / "_list_custom_functions.json"
    with open(functions_out, "w", encoding="utf-8") as f:
        json.dump(functions, f, ensure_ascii=False, indent=2, default=str)

    for t in tables:
        schema = t.get("schema_name", "public")
        table = t.get("table_name")
        if not table:
            continue
        print(f"Baixando: {schema}.{table}")

        data = fetch_all_rows(schema, table)

        out_path = Path(OUT_DIR) / f"{schema}.{table}.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2, default=str)

    # 5. Build bundle for visualizer
    tables_for_bundle = [
        {"schema": t.get("schema_name", "public"), "name": t.get("table_name")}
        for t in tables if t.get("table_name")
    ]

    functions_for_bundle = build_functions_with_dependencies(functions, dependencies)

    bundle = {
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "table_count": len(tables_for_bundle),
            "function_count": len(functions_for_bundle)
        },
        "tables": tables_for_bundle,
        "functions": functions_for_bundle
    }

    bundle_path = Path(OUT_DIR) / "supabase_data.json"
    with open(bundle_path, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False, indent=2, default=str)

    root_bundle_path = Path("supabase_data.json")
    with open(root_bundle_path, "w", encoding="utf-8") as f:
        json.dump(bundle, f, ensure_ascii=False, indent=2, default=str)

    print(f"\nOK. Export em '{OUT_DIR}/'")
    print(f"Bundle salvo em: {bundle_path} e {root_bundle_path}")


if __name__ == "__main__":
    main()
