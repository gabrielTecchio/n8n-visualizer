/**
 * n8n Dependency Visualizer - Application Logic
 * 
 * This file handles:
 * 1. Data loading (Auto-load, Manual folder select, n8n API)
 * 2. Data processing (n8n workflow JSON parsing to nodes/links)
 * 3. Graph visualization (D3.js force simulation)
 * 4. UI interactions (Filtering, Highlighting, Exporting)
 */

/* State Constants */
let rawNodes = [];
let rawLinks = [];
let graphData = { nodes: [], links: [] };
let simulation;
let svg, g;
let selectedTool = null;

// Grouping State: Controls if entities of a certain type are collapsed into a single group node.
// Default is false (collapsed) for a cleaner initial view.
let groupState = {
    workflow: false,
    supabase: false,
    notion: false,
    bigquery: false,
    microsoft: false,
    google: false,
    openai: false,
    other: false
};

// Color scheme for different entity types
const colorMap = {
    workflow: '#f85149',
    supabase: '#3ecf8e',
    notion: '#a371f7',
    bigquery: '#4285f4',
    microsoft: '#f9ba48',
    google: '#ff00ff',
    openai: '#ffffff',
    other: '#8b949e'
};

/**
 * Initialization: Sets up the SVG and D3 simulation
 */
function initGraph() {
    const container = d3.select('#graph');
    container.selectAll('*').remove(); // Prevent SVG duplication
    
    const width = container.node().getBoundingClientRect().width || 800;
    const height = container.node().getBoundingClientRect().height || 600;

    console.log('Initializing graph with dimensions:', width, height);

    svg = container.append('svg')
        .attr('width', width)
        .attr('height', height);

    g = svg.append('g');

    // Pan & Zoom support
    const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => g.attr('transform', event.transform));

    svg.call(zoom);

    // D3 Force Simulation configuration
    simulation = d3.forceSimulation()
        .force('link', d3.forceLink().id(d => d.id).distance(150))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(40));

    updateLegend();
}

/**
 * Resets the zoom and pan to initial state
 */
function resetZoom() {
    svg.transition().duration(750).call(
        d3.zoom().transform,
        d3.zoomIdentity
    );
}

/**
 * Updates the legend UI based on current groupState
 */
function updateLegend() {
    const legend = document.getElementById('legend');
    if (!legend) return;
    legend.innerHTML = '';

    Object.keys(groupState).forEach(type => {
        const item = document.createElement('div');
        item.className = `legend-item ${groupState[type] ? 'expanded' : 'collapsed'}`;
        item.onclick = () => toggleGroup(type);

        const dot = document.createElement('div');
        dot.className = 'legend-dot';
        dot.style.background = colorMap[type] || '#ccc';
        if (type === 'openai') dot.style.border = '1px solid #30363d';

        const label = document.createTextNode(
            type === 'workflow' ? 'n8n' :
            type.charAt(0).toUpperCase() + type.slice(1)
        );

        item.appendChild(dot);
        item.appendChild(label);

        const stateLabel = document.createElement('span');
        stateLabel.style.fontSize = '10px';
        stateLabel.style.marginLeft = '4px';
        stateLabel.style.color = '#8b949e';
        stateLabel.textContent = groupState[type] ? '(Expandido)' : '(Agrupado)';
        item.appendChild(stateLabel);

        legend.appendChild(item);
    });
}

/**
 * Toggles a group between expanded and collapsed
 */
function toggleGroup(type) {
    groupState[type] = !groupState[type];
    updateLegend();
    updateGraphData();
}

/**
 * Internal helper to safely get values from n8n Resource Locator (RL) objects or strings
 */
const getVal = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
        return v.cachedResultName || v.value || JSON.stringify(v);
    }
    return String(v);
};

/**
 * Data Parser: Converts list of n8n workflow objects into graph nodes and links
 */
function processWorkflows(files) {
    rawNodes = [];
    rawLinks = [];
    const nodeMap = new Map();

    files.forEach(workflow => {
        const workflowId = workflow.id;
        const workflowName = workflow.name;

        // Create n8n Workflow node
        addNode(nodeMap, workflowId, workflowName, 'workflow');

        // Extract dependencies from internal nodes
        (workflow.nodes || []).forEach(node => {
            const nodeType = node.type;
            const params = node.parameters || {};
            const creds = node.credentials || {};

            // OpenAI Extraction
            if (nodeType.includes('openai') || nodeType.includes('OpenAi') || creds.openAiApi) {
                const modelName = getVal(params.model || params.modelId || params.modelName || 'OpenAI');
                const sourceId = `openai_${modelName}`;
                addNode(nodeMap, sourceId, modelName, 'openai');
                rawLinks.push({ source: workflowId, target: sourceId, type: 'uses' });

                if (creds.openAiApi) {
                    const credName = getVal(creds.openAiApi.name || creds.openAiApi.id || 'OpenAI API');
                    const credId = `cred_openai_${credName}`;
                    addNode(nodeMap, credId, `Cred: ${credName}`, 'credential openai');
                    rawLinks.push({ source: sourceId, target: credId, type: 'auth' });
                }
            }

            // Qdrant Extraction
            if (nodeType.includes('qdrant') || nodeType.includes('Qdrant') || creds.qdrantRestApi || creds.qdrantApi) {
                const qCreds = creds.qdrantRestApi || creds.qdrantApi;
                const collection = getVal(params.collectionName || params.qdrantCollection || 'Qdrant');
                const sourceId = `qdrant_${collection}`;
                addNode(nodeMap, sourceId, collection, 'other');
                rawLinks.push({ source: workflowId, target: sourceId, type: 'uses' });

                if (qCreds) {
                    const credName = getVal(qCreds.name || qCreds.id || 'Qdrant API');
                    const credId = `cred_qdrant_${credName}`;
                    addNode(nodeMap, credId, `Cred: ${credName}`, 'credential other');
                    rawLinks.push({ source: sourceId, target: credId, type: 'auth' });
                }
            }

            // Supabase Extraction
            if (nodeType.includes('supabase') || nodeType.includes('Supabase') || nodeType.includes('vectorStoreSupabase')) {
                const tableName = getVal(params.tableName || 'Supabase');
                if (tableName) {
                    const sourceId = `supabase_${tableName}`;
                    addNode(nodeMap, sourceId, tableName, 'supabase');
                    rawLinks.push({ source: workflowId, target: sourceId, type: 'uses' });

                    if (creds.supabaseApi) {
                        const cName = getVal(creds.supabaseApi.name || creds.supabaseApi.id || 'Supabase API');
                        const credId = `cred_supabase_${cName}`;
                        addNode(nodeMap, credId, `Cred: ${cName}`, 'credential supabase');
                        rawLinks.push({ source: sourceId, target: credId, type: 'auth' });
                    }
                }
            }

            // Notion Extraction
            if (nodeType.includes('notion') || nodeType.includes('Notion')) {
                const databaseName = getVal(params.databaseId || params.tableName || 'Notion');
                if (databaseName) {
                    const sourceId = `notion_${databaseName}`;
                    addNode(nodeMap, sourceId, databaseName, 'notion');
                    rawLinks.push({ source: workflowId, target: sourceId, type: 'uses' });

                    if (creds.notionApi) {
                        const cName = getVal(creds.notionApi.name || creds.notionApi.id || 'Notion API');
                        const credId = `cred_notion_${cName}`;
                        addNode(nodeMap, credId, `Cred: ${cName}`, 'credential notion');
                        rawLinks.push({ source: sourceId, target: credId, type: 'auth' });
                    }
                }
            }

            // BigQuery Extraction
            if (nodeType.includes('bigquery') || nodeType.includes('BigQuery')) {
                let tableName = getVal(params.tableId);
                if (!tableName && params.datasetId && params.tableId) {
                    tableName = `${params.datasetId}.${params.tableId}`;
                }

                if (tableName) {
                    const sourceId = `bigquery_${tableName}`;
                    addNode(nodeMap, sourceId, tableName, 'bigquery');
                    rawLinks.push({ source: workflowId, target: sourceId, type: 'uses' });

                    if (creds.googleBigQueryOAuth2Api) {
                        const credId = `cred_bigquery_${creds.googleBigQueryOAuth2Api.name || creds.googleBigQueryOAuth2Api.id}`;
                        addNode(nodeMap, credId, getVal(creds.googleBigQueryOAuth2Api.name) || 'BigQuery API', 'credential bigquery');
                        rawLinks.push({ source: sourceId, target: credId, type: 'auth' });
                    }
                }
            }

            // SharePoint Extraction
            if (nodeType.includes('httpRequest') && creds.microsoftSharePointOAuth2Api) {
                const url = params.url || '';
                const match = url.match(/\/sites\/([^\/]+)/);
                const siteName = match ? match[1] : 'SharePoint';
                const sourceId = `microsoft_${siteName}`;
                addNode(nodeMap, sourceId, siteName, 'microsoft');
                rawLinks.push({ source: workflowId, target: sourceId, type: 'uses' });

                const credId = `cred_microsoft_${creds.microsoftSharePointOAuth2Api.name || creds.microsoftSharePointOAuth2Api.id}`;
                addNode(nodeMap, credId, getVal(creds.microsoftSharePointOAuth2Api.name) || 'Microsoft SharePoint', 'credential microsoft');
                rawLinks.push({ source: sourceId, target: credId, type: 'auth' });
            }

            // Other entity patterns can be added here...
        });
    });

    rawNodes = Array.from(nodeMap.values());
    updateToolsList();
    updateGraphData();
    setTimeout(resetZoom, 500); 
}

/**
 * Graph Aggregator: Processes rawNodes and rawLinks based on groupState to produce graphData
 */
function updateGraphData() {
    const idMap = new Map();
    const visibleNodesMap = new Map();

    // 1. Group nodes as requested
    rawNodes.forEach(node => {
        let effectiveGroup = getGroup(node);

        if (groupState[effectiveGroup] === false) {
            // Collapsed: Multiple entities merge into one 'group' node
            const groupId = `group_${effectiveGroup}`;
            idMap.set(node.id, groupId);

            if (!visibleNodesMap.has(groupId)) {
                let labelName = effectiveGroup === 'workflow' ? 'n8n' : effectiveGroup.charAt(0).toUpperCase() + effectiveGroup.slice(1);
                visibleNodesMap.set(groupId, {
                    id: groupId,
                    label: labelName,
                    type: 'group',
                    groupType: effectiveGroup,
                    count: 1
                });
            } else {
                const gNode = visibleNodesMap.get(groupId);
                gNode.count++;
                let labelName = effectiveGroup === 'workflow' ? 'n8n' : effectiveGroup.charAt(0).toUpperCase() + effectiveGroup.slice(1);
                gNode.label = `${labelName} (${gNode.count})`;
            }
        } else {
            // Expanded: Entities shown individually
            idMap.set(node.id, node.id);
            visibleNodesMap.set(node.id, { ...node });
        }
    });

    graphData.nodes = Array.from(visibleNodesMap.values());

    // 2. Map and aggregate links according to node grouping
    const linkMap = new Map();
    rawLinks.forEach(link => {
        const sourceId = idMap.get(link.source);
        const targetId = idMap.get(link.target);

        if (sourceId && targetId && sourceId !== targetId) {
            const key = `${sourceId}->${targetId}`;
            if (!linkMap.has(key)) {
                linkMap.set(key, { source: sourceId, target: targetId, type: link.type, id: key });
            }
        }
    });

    graphData.links = Array.from(linkMap.values());

    updateStats();
    updateToolsList();
    renderGraph();
}

/**
 * D3 Renderer: Draws the SVG elements based on graphData
 */
function renderGraph() {
    if (graphData.nodes.length === 0) return;

    g.selectAll('*').remove();

    // Draw Links
    const link = g.append('g')
        .selectAll('path')
        .data(graphData.links)
        .enter().append('path')
        .attr('class', 'link');

    // Draw Nodes
    const node = g.append('g')
        .selectAll('g')
        .data(graphData.nodes)
        .enter().append('g')
        .attr('class', d => `node ${d.type} ${d.groupType || ''}`)
        .call(d3.drag()
            .on('start', dragstarted)
            .on('drag', dragged)
            .on('end', dragended))
        .on('click', (event, d) => {
            if (d.type === 'group') {
                event.stopPropagation();
                toggleGroup(d.groupType);
            }
        });

    // Node Visuals
    node.append('circle')
        .attr('r', d => d.type === 'group' ? 30 + (d.count * 0.5) : (d.type === 'workflow' ? 20 : 15))
        .style('stroke', d => d.type === 'group' ? colorMap[d.groupType] : null)
        .style('fill', d => d.type === 'group' ? colorMap[d.groupType] : null);

    // Tooltips
    node.append('title').text(d => d.type === 'group' ? `${d.label} Group (${d.count} items)` : d.label);

    // Labels
    node.append('text')
        .attr('dy', d => d.type === 'group' ? 45 : 30)
        .attr('text-anchor', 'middle')
        .text(d => d.label.length > 15 ? d.label.substring(0, 15) + '...' : d.label);

    // Start Force Simulation
    simulation.nodes(graphData.nodes);
    simulation.force('link').links(graphData.links);

    // Grouping Force Logic (Clustering)
    const groups = {};
    graphData.nodes.forEach(d => {
        const group = d.type === 'group' ? 'group' : getGroup(d);
        if (!groups[group]) groups[group] = [];
        groups[group].push(d);
    });

    simulation.on('tick', () => {
        const alpha = simulation.alpha();
        const k = alpha * 0.5; // Strong clustering force

        Object.values(groups).forEach(groupNodes => {
            if (groupNodes.length < 2) return;
            let x = 0, y = 0, count = 0;
            groupNodes.forEach(d => { 
                if (!isNaN(d.x) && !isNaN(d.y)) { x += d.x; y += d.y; count++; }
            });
            if (count > 0) {
                x /= count; y /= count;
                groupNodes.forEach(d => {
                    if (!isNaN(d.x) && !isNaN(d.y)) {
                        d.x += (x - d.x) * k;
                        d.y += (y - d.y) * k;
                    }
                });
            }
        });

        link.attr('d', d => {
            if (!d.source || !d.target || isNaN(d.source.x) || isNaN(d.target.x)) return null;
            return `M${d.source.x},${d.source.y}L${d.target.x},${d.target.y}`;
        });

        node.attr('transform', d => isNaN(d.x) ? null : `translate(${d.x},${d.y})`);
    });

    simulation.alpha(1).restart();
}

/**
 * Helper to determine which color group a node belongs to
 */
function getGroup(node) {
    const type = node.type || '';
    if (type.includes('supabase')) return 'supabase';
    if (type.includes('notion')) return 'notion';
    if (type.includes('bigquery')) return 'bigquery';
    if (type.includes('microsoft')) return 'microsoft';
    if (type.includes('google')) return 'google';
    if (type.includes('openai')) return 'openai';
    if (type.includes('workflow')) return 'workflow';
    return 'other';
}

/* UI Utility Functions */

function updateStats() {
    const workflows = rawNodes.filter(n => n.type === 'workflow').length;
    const sources = rawNodes.filter(n => getGroup(n) !== 'workflow' && getGroup(n) !== 'other' && !n.type.includes('credential')).length;
    document.getElementById('workflowCount').textContent = workflows;
    document.getElementById('sourceCount').textContent = sources;
}

function updateToolsList() {
    const list = document.getElementById('toolsList');
    if (!list) return;
    list.innerHTML = '';

    const grouped = {};
    rawNodes.filter(n => getGroup(n) !== 'workflow' && !n.type.includes('credential')).forEach(n => {
        let type = getGroup(n);
        if (!grouped[type]) grouped[type] = [];
        grouped[type].push(n);
    });

    Object.keys(grouped).sort().forEach(type => {
        const header = document.createElement('div');
        header.className = 'category-header';
        header.innerHTML = `${type} <span class="category-toggle">${groupState[type] ? 'Expandido' : 'Agrupado'}</span>`;
        header.onclick = () => toggleGroup(type);
        list.appendChild(header);

        grouped[type].forEach(n => {
            const count = rawLinks.filter(l => l.target === n.id).length;
            const div = document.createElement('div');
            div.className = 'tool-item';
            div.innerHTML = `${n.label} <span class="tool-count">${count}</span>`;
            div.onclick = (e) => { e.stopPropagation(); highlightTool(n.id, div); };
            list.appendChild(div);
        });
    });
}

function highlightTool(toolId, element) {
    document.querySelectorAll('.tool-item').forEach(el => el.classList.remove('selected'));
    element.classList.add('selected');
    
    // Reset visuals
    d3.selectAll('.node').classed('highlighted', false);
    d3.selectAll('.link').classed('highlighted', false);

    const node = rawNodes.find(n => n.id === toolId);
    let effectiveId = toolId;
    if (node && !groupState[getGroup(node)]) effectiveId = `group_${getGroup(node)}`;

    // Highlight target and its neighbors
    const neighbors = new Set([effectiveId]);
    graphData.links.forEach(l => {
        const s = l.source.id || l.source;
        const t = l.target.id || l.target;
        if (s === effectiveId || t === effectiveId) {
            neighbors.add(s); neighbors.add(t);
            d3.selectAll('.link').filter(d => (d.source.id || d.source) === s && (d.target.id || d.target) === t).classed('highlighted', true);
        }
    });

    d3.selectAll('.node').filter(d => neighbors.has(d.id)).classed('highlighted', true);
    showImpact(toolId);
}

function showImpact(toolId) {
    const affected = rawLinks.filter(l => l.target === toolId).map(l => rawNodes.find(n => n.id === l.source)).filter(n => n?.type === 'workflow');
    const panel = document.getElementById('impactPanel');
    const list = document.getElementById('impactList');
    if (affected.length > 0) {
        panel.style.display = 'block';
        list.innerHTML = affected.map(wf => `<li>${wf.label}</li>`).join('');
    } else panel.style.display = 'none';
}

/* D3 Drag Handlers */
function dragstarted(event, d) { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; }
function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
function dragended(event, d) { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }

/**
 * Data Loaders
 */
async function tryAutoLoad() {
    const status = document.getElementById('autoLoadStatus');
    try {
        const res = await fetch('n8n_data.json');
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (Array.isArray(data)) {
            processWorkflows(data);
            status.textContent = 'Dados carregados automaticamente via GitHub Actions 🚀';
            status.style.color = '#3fb950';
        }
    } catch (e) {
        document.getElementById('manualConnect').style.display = 'block';
        status.style.display = 'none';
    }
}

async function handleFolderSelect(event) {
    const files = Array.from(event.target.files).filter(f => f.name.endsWith('.json'));
    const status = document.getElementById('autoLoadStatus');
    status.style.display = 'block'; status.textContent = 'Processando arquivos...';
    
    let workflowData = [];
    for (const file of files) {
        try {
            const json = JSON.parse(await file.text());
            Array.isArray(json) ? workflowData.push(...json) : workflowData.push(json);
        } catch(e) {}
    }
    
    if (workflowData.length > 0) {
        processWorkflows(workflowData);
        status.textContent = `${workflowData.length} fluxos carregados ✅`;
        document.getElementById('manualConnect').style.display = 'none';
    }
}

async function fetchFromApi() {
    const url = document.getElementById('n8nUrl').value.replace(/\/$/, '');
    const key = document.getElementById('n8nKey').value;
    if (!url || !key) return alert('URL e API Key são obrigatórios');

    try {
        const res = await fetch(`${url}/api/v1/workflows`, { headers: { 'X-N8N-API-KEY': key } });
        const list = (await res.json()).data || [];
        const details = await Promise.all(list.map(w => fetch(`${url}/api/v1/workflows/${w.id}`, { headers: { 'X-N8N-API-KEY': key } }).then(r => r.json())));
        processWorkflows(details);
        document.getElementById('manualConnect').style.display = 'none';
    } catch (e) {
        alert('Erro ao conectar. Verifique o CORS no n8n.');
    }
}

function exportMarkdown() {
    let md = `# n8n Dependencies Report\nGenerated: ${new Date().toLocaleString()}\n\n## Stats\n- Workflows: ${rawNodes.filter(n => n.type === 'workflow').length}\n\n`;
    // Building a simple tree...
    const workflows = rawNodes.filter(n => n.type === 'workflow');
    workflows.forEach(wf => {
        md += `### ${wf.label}\n`;
        const deps = rawLinks.filter(l => l.source === wf.id).map(l => rawNodes.find(n => n.id === l.target));
        deps.forEach(d => md += `- ${d.label} (${getGroup(d)})\n`);
        md += '\n';
    });

    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'n8n-dependencies.md';
    a.click();
}

/* Event Listeners */
document.getElementById('searchInput')?.addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    d3.selectAll('.node').classed('highlighted', d => term && d.label.toLowerCase().includes(term));
});

// Start the app
initGraph();
tryAutoLoad();
