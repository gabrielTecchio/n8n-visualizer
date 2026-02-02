"""
Merge Data Script

Combines n8n workflow data with Supabase metadata to create a unified
stack_data.json for the visualizer.

This script:
1. Reads n8n_data.json (workflows)
2. Reads supabase_data.json (tables and functions)
3. Cross-references to identify which tables/functions are used by n8n
4. Generates stack_data.json with unified data

Usage:
    python merge_data.py
"""

import json
import re
from pathlib import Path
from datetime import datetime, timezone


def load_json(path):
    """Load JSON file, return None if not found."""
    p = Path(path)
    if not p.exists():
        return None
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def extract_supabase_references_from_workflows(workflows):
    """
    Extract all Supabase table names and RPC function names referenced in n8n workflows.
    Returns (set of table names, set of function names)
    """
    tables_used = set()
    functions_used = set()

    for workflow in workflows:
        for node in workflow.get("nodes", []):
            node_type = (node.get("type") or "").lower()
            params = node.get("parameters", {})

            # Supabase node - extract table name
            if "supabase" in node_type:
                table_name = get_value(params.get("tableName"))
                if table_name and table_name != "Supabase":
                    tables_used.add(table_name)

                # Check for RPC operation
                operation = get_value(params.get("operation"))
                if operation == "call":
                    func_name = get_value(params.get("functionName") or params.get("rpc"))
                    if func_name:
                        functions_used.add(func_name)

            # HTTP Request that might call Supabase RPC
            if "httprequest" in node_type or "http" in node_type:
                url = get_value(params.get("url", ""))
                # Match /rest/v1/rpc/function_name
                match = re.search(r"/rpc/([a-zA-Z_][a-zA-Z0-9_]*)", url)
                if match:
                    functions_used.add(match.group(1))

    return tables_used, functions_used


def get_value(v):
    """Safely extract value from n8n Resource Locator objects or strings."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        return v.get("cachedResultName") or v.get("value") or ""
    return str(v)


def main():
    # 1. Load n8n data
    n8n_data = load_json("n8n_data.json")
    if not n8n_data:
        n8n_data = load_json("n8n_workflows_export/n8n_data.json")

    if not n8n_data:
        print("AVISO: n8n_data.json não encontrado. Gerando apenas com dados do Supabase.")
        workflows = []
    else:
        workflows = n8n_data.get("workflows", []) if isinstance(n8n_data, dict) else n8n_data

    # 2. Load Supabase data
    supabase_data = load_json("supabase_data.json")
    if not supabase_data:
        supabase_data = load_json("supabase_export_tables/supabase_data.json")

    if not supabase_data:
        print("AVISO: supabase_data.json não encontrado. Execute supabase_export_tables.py primeiro.")
        supabase_data = {"tables": [], "functions": [], "metadata": {}}

    # 3. Extract what n8n uses
    tables_used_by_n8n, functions_used_by_n8n = extract_supabase_references_from_workflows(workflows)
    print(f"n8n usa {len(tables_used_by_n8n)} tabelas: {sorted(tables_used_by_n8n)}")
    print(f"n8n usa {len(functions_used_by_n8n)} funções: {sorted(functions_used_by_n8n)}")

    # 4. Enrich tables with usage info
    enriched_tables = []
    for table in supabase_data.get("tables", []):
        name = table.get("name")
        enriched_tables.append({
            "name": name,
            "schema": table.get("schema", "public"),
            "used_by_n8n": name in tables_used_by_n8n
        })

    # 5. Enrich functions with usage info
    enriched_functions = []
    for func in supabase_data.get("functions", []):
        name = func.get("name")
        enriched_functions.append({
            "name": name,
            "schema": func.get("schema", "public"),
            "tables_used": func.get("tables_used", []),
            "used_by_n8n": name in functions_used_by_n8n
        })

    # 6. Build unified output
    stack_data = {
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "workflow_count": len(workflows),
            "table_count": len(enriched_tables),
            "function_count": len(enriched_functions),
            "tables_used_by_n8n": len(tables_used_by_n8n),
            "functions_used_by_n8n": len(functions_used_by_n8n)
        },
        "workflows": workflows,
        "supabase": {
            "tables": enriched_tables,
            "functions": enriched_functions
        }
    }

    # 7. Save output
    output_path = Path("stack_data.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(stack_data, f, ensure_ascii=False, indent=2, default=str)

    print(f"\nGerado: {output_path}")
    print(f"  - {len(workflows)} workflows")
    print(f"  - {len(enriched_tables)} tabelas ({len(tables_used_by_n8n)} usadas pelo n8n)")
    print(f"  - {len(enriched_functions)} funções ({len(functions_used_by_n8n)} usadas pelo n8n)")


if __name__ == "__main__":
    main()
