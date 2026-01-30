# export_workflows.py
import os
import re
import json
from pathlib import Path
from urllib.parse import urljoin
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

load_dotenv()

N8N_BASE_URL = (os.getenv("N8N_BASE_URL") or "").strip()
N8N_API_KEY = (os.getenv("N8N_API_KEY") or "").strip()

OUT_DIR = "n8n_workflows_export"
VERIFY_TLS = os.getenv("VERIFY_TLS", "true").lower() not in ("0", "false", "no")
TIMEOUT = int(os.getenv("HTTP_TIMEOUT", "60"))

if not N8N_BASE_URL:
    raise SystemExit("N8N_BASE_URL não encontrado no .env (ex: https://seu-n8n.up.railway.app)")
if not N8N_API_KEY:
    raise SystemExit("N8N_API_KEY não encontrado no .env")

if not N8N_BASE_URL.endswith("/"):
    N8N_BASE_URL += "/"

Path(OUT_DIR).mkdir(parents=True, exist_ok=True)

def safe_name(name: str) -> str:
    name = name or "workflow"
    name = re.sub(r'[<>:"/\\|?*\x00-\x1F]', "_", name)
    name = re.sub(r"\s+", " ", name).strip()
    return name[:120]

def safe_id(s: str) -> str:
    s = str(s)
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", s)
    return s[:80]

session = requests.Session()
session.headers.update({
    "X-N8N-API-KEY": N8N_API_KEY,
    "Accept": "application/json",
})

def api_get(path: str, params=None):
    url = urljoin(N8N_BASE_URL, path.lstrip("/"))
    r = session.get(url, params=params, timeout=TIMEOUT, verify=VERIFY_TLS)

    if r.status_code == 401:
        raise SystemExit("401 Unauthorized. Verifique N8N_API_KEY / API habilitada.")
    if r.status_code == 400:
        raise SystemExit(f"400 Bad Request em {url} params={params}\nResposta: {r.text[:500]}")
    if r.status_code == 404:
        return None

    r.raise_for_status()
    return r.json()

def list_workflows():
    data = api_get("/api/v1/workflows", {"active": "true"})
    if data is not None:
        if isinstance(data, list):
            return data
        return data.get("data") or data.get("items") or []

    data = api_get("/rest/workflows")
    if data is None:
        raise SystemExit("Não encontrei /api/v1/workflows nem /rest/workflows.")
    if isinstance(data, list):
        return data
    return data.get("data") or data.get("items") or []

def get_workflow(workflow_id: str):
    workflow_id = str(workflow_id)

    data = api_get(f"/api/v1/workflows/{workflow_id}")
    if data is not None:
        return data

    data = api_get(f"/rest/workflows/{workflow_id}")
    if data is not None:
        return data

    raise SystemExit(f"Não consegui buscar workflow id={workflow_id} (nem em /api/v1 nem em /rest).")

workflows = list_workflows()
print(f"Encontrados {len(workflows)} workflows. Baixando detalhes...")

all_workflows_data = []
exported = 0
for w in workflows:
    workflow_id = w.get("id")
    if not workflow_id:
        continue

    detail = get_workflow(workflow_id)

    name = detail.get("name") or w.get("name") or "workflow"
    # Adicionar ao bundle
    all_workflows_data.append(detail)
    
    filename = f"{safe_name(name)}.json"
    path = Path(OUT_DIR) / filename

    with open(path, "w", encoding="utf-8") as f:
        json.dump(detail, f, ensure_ascii=False, indent=2, default=str)

    print("Exportado:", filename)
    exported += 1

# Salvar bundle completo para o visualizador
bundle_path = Path(OUT_DIR) / "n8n_data.json"
root_bundle_path = Path("n8n_data.json")

# Criar objeto final com metadados
final_data = {
    "metadata": {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "workflow_count": exported
    },
    "workflows": all_workflows_data
}

with open(bundle_path, "w", encoding="utf-8") as f:
    json.dump(final_data, f, ensure_ascii=False, indent=2, default=str)

with open(root_bundle_path, "w", encoding="utf-8") as f:
    json.dump(final_data, f, ensure_ascii=False, indent=2, default=str)

print(f"\nOK. Total: {exported} workflows em '{OUT_DIR}/'")
print(f"Bundle salvo em: {bundle_path} e {root_bundle_path}")
