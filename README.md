# n8n Dependency Visualizer

Visualizador interativo de dependências entre workflows n8n e suas fontes de dados (Supabase, Notion, BigQuery, Google, Microsoft, OpenAI).

## Arquitetura

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GitHub Actions                               │
│  (n8n-visualizer.yml) - Roda diariamente ou manualmente             │
│                                                                      │
│  1. Executa n8n_export_workflows.py                                  │
│  2. Executa supabase_export_tables.py                                │
│  3. Executa merge_data.py                                            │
│  4. Copia arquivos para /public + stack_data.json                   │
│  5. Deploy no GitHub Pages                                           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Scripts de Exportação                             │
│                                                                      │
│  n8n_export_workflows.py                                             │
│  └─ Conecta na API do n8n e exporta workflows                       │
│  └─ Gera: n8n_data.json                                             │
│                                                                      │
│  supabase_export_tables.py                                           │
│  └─ Conecta no Supabase e exporta tabelas + funções                 │
│  └─ Gera: supabase_data.json                                        │
│                                                                      │
│  merge_data.py                                                       │
│  └─ Combina n8n_data.json + supabase_data.json                      │
│  └─ Identifica tabelas órfãs e dependências de funções              │
│  └─ Gera: stack_data.json (usado pelo visualizador)                 │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  index.html + style.css + app.js                     │
│                                                                      │
│  Ao carregar:                                                        │
│  1. app.js tenta fetch('stack_data.json')                           │
│  2. Se encontrar, processa workflows + dados Supabase               │
│  3. Se não encontrar, fallback para n8n_data.json                   │
└─────────────────────────────────────────────────────────────────────┘
```

## Fluxo de Dados

### 1. Extração n8n (Python)

O script `n8n_export_workflows.py`:

```python
# Conecta na API do n8n
N8N_BASE_URL    # ex: https://n8n.seudominio.com
N8N_API_KEY     # API Key do n8n

# Exporta para:
# - n8n_workflows_export/{nome_workflow}.json (individual)
# - n8n_data.json (bundle para merge)
```

### 2. Extração Supabase (Python)

O script `supabase_export_tables.py`:

```python
# Conecta no Supabase
SUPABASE_URL                # ex: https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY   # Service Role Key

# Exporta para:
# - supabase_export_tables/*.json (dados das tabelas)
# - supabase_data.json (metadados para merge)
```

**RPCs Necessárias no Supabase:**

```sql
-- Lista tabelas
CREATE OR REPLACE FUNCTION public.list_tables(_schemas TEXT[] DEFAULT ARRAY['public'])
RETURNS TABLE(schema_name TEXT, table_name TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT n.nspname::TEXT, c.relname::TEXT
  FROM pg_class c
  JOIN pg_namespace n ON c.relnamespace = n.oid
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname = ANY(_schemas);
END;
$$;

-- Lista funções customizadas
CREATE OR REPLACE FUNCTION public.list_functions(_schemas TEXT[] DEFAULT ARRAY['public'])
RETURNS TABLE(schema_name TEXT, function_name TEXT)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT n.nspname::TEXT, p.proname::TEXT
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = ANY(_schemas)
    AND p.prokind = 'f'
    AND NOT p.proname LIKE 'pg_%';
END;
$$;

-- Lista dependências de funções (quais tabelas cada função usa)
CREATE OR REPLACE FUNCTION public.list_function_dependencies(_schemas TEXT[] DEFAULT ARRAY['public'])
RETURNS TABLE(
  function_name TEXT,
  function_schema TEXT,
  referenced_table TEXT,
  referenced_schema TEXT
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.proname::TEXT AS function_name,
    n.nspname::TEXT AS function_schema,
    c.relname::TEXT AS referenced_table,
    cn.nspname::TEXT AS referenced_schema
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  CROSS JOIN LATERAL (
    SELECT DISTINCT 
      regexp_matches(p.prosrc, 
        '(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?(?:(\w+)\.)?(\w+)', 
        'gi'
      ) AS matches
  ) extracted
  JOIN pg_class c ON c.relname = extracted.matches[2] 
    AND c.relkind IN ('r', 'p', 'v', 'm')
  JOIN pg_namespace cn ON c.relnamespace = cn.oid
  WHERE n.nspname = ANY(_schemas)
    AND cn.nspname = ANY(_schemas)
    AND p.prokind = 'f'
  ORDER BY function_name, referenced_table;
END;
$$;

-- Permissões
GRANT EXECUTE ON FUNCTION public.list_tables TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_functions TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_function_dependencies TO anon, authenticated, service_role;
```

### 3. Merge (Python)

O script `merge_data.py`:

```python
# Combina os dados
# - Lê n8n_data.json e supabase_data.json
# - Identifica tabelas usadas vs não usadas pelo n8n
# - Inclui dependências de funções RPC
# - Gera stack_data.json
```

### 4. Deploy (GitHub Actions)

O workflow `.github/workflows/n8n-visualizer.yml`:

- **Trigger**: Diariamente à meia-noite OU manualmente
- **Secrets necessários**: `N8N_BASE_URL`, `N8N_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- **Resultado**: GitHub Pages com index.html + stack_data.json

## Formato do stack_data.json

```json
{
  "metadata": {
    "generated_at": "2025-02-02T12:00:00Z",
    "workflow_count": 15,
    "table_count": 25,
    "function_count": 10,
    "tables_used_by_n8n": 12,
    "functions_used_by_n8n": 5
  },
  "workflows": [...],
  "supabase": {
    "tables": [
      { "name": "users", "schema": "public", "used_by_n8n": true },
      { "name": "legacy_data", "schema": "public", "used_by_n8n": false }
    ],
    "functions": [
      { 
        "name": "get_user_stats", 
        "schema": "public",
        "tables_used": ["users", "transactions"],
        "used_by_n8n": true
      }
    ]
  }
}
```

## Entidades Detectadas

| Tipo            | Cor        | Descrição                                      |
|-----------------|------------|------------------------------------------------|
| Workflow        | Vermelho   | Workflows do n8n                               |
| Supabase        | Verde      | Tabelas usadas pelo n8n                        |
| Supabase Orphan | Verde escuro (tracejado) | Tabelas não usadas pelo n8n     |
| RPC Function    | Verde claro| Funções RPC do Supabase                        |
| Notion          | Roxo       | Databases do Notion                            |
| BigQuery        | Azul       | Tabelas do BigQuery                            |
| Microsoft       | Laranja    | Outlook, SharePoint                            |
| Google          | Magenta    | Google Calendar                                |
| OpenAI          | Branco     | Modelos OpenAI                                 |

## Funcionalidades do Visualizador

- **Agrupamento**: Clique na legenda para expandir/colapsar grupos
- **Busca**: Campo de texto filtra nós por nome
- **Análise de Impacto**: Clique em uma fonte para ver workflows afetados
- **Dependências RPC**: Visualize quais tabelas cada função RPC utiliza
- **Tabelas Órfãs**: Identifique tabelas não utilizadas pelo n8n
- **Exportar MD**: Gera documentação em Markdown
- **Zoom/Pan**: Mouse scroll + arrastar

## Configuração Local

1. Crie um arquivo `.env`:
```
N8N_BASE_URL=https://seu-n8n.com
N8N_API_KEY=sua-api-key
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key
SCHEMAS=public
```

2. Execute os scripts:
```bash
pip install -r requirements.txt
python n8n_export_workflows.py
python supabase_export_tables.py
python merge_data.py
```

3. Abra `index.html` no navegador

## Configuração GitHub Actions

1. Adicione os secrets no repositório:
   - `N8N_BASE_URL`
   - `N8N_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`

2. O workflow roda automaticamente ou via "Run workflow" na aba Actions

3. Acesse via GitHub Pages: `https://{usuario}.github.io/{repo}/`
