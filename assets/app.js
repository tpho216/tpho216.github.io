/* global initSqlJs */

(function () {
  const els = {
    buildTime: document.getElementById('build-time'),
    status: document.getElementById('status'),
    search: document.getElementById('global-search'),
    clear: document.getElementById('clear-search'),
    grid: document.getElementById('projects'),
    empty: document.getElementById('empty'),
    resultsCount: document.getElementById('results-count'),
    resultsQuery: document.getElementById('results-query'),
    editJsonBtn: document.getElementById('edit-json-btn'),
    jsonEditorModal: document.getElementById('json-editor-modal'),
    closeEditorBtn: document.getElementById('close-editor-btn'),
    jedisonContainer: document.getElementById('jedison-container'),
  };

  const state = {
    db: null,
    buildInfo: null,
    allRowsCount: 0,
    query: '',
    results: [],
    isReady: false,
    error: null,
  };

  const COLUMNS = [
    'project',
    'description',
    'responsibilities',
    'highlights',
    'impact',
    'technologies',
    'skills',
    'dates',
  ];

  const LIKE_COLUMNS = [
    'project',
    'description',
    'responsibilities',
    'highlights',
    'impact',
    'technologies',
    'skills',
    'dates',
  ];

  const DEBOUNCE_MS = 180;

  boot().catch((err) => {
    state.error = err instanceof Error ? err : new Error(String(err));
    setStatus('Failed to initialize. Check console for details.', 'error');
    render();
    // eslint-disable-next-line no-console
    console.error(err);
  });

  function setStatus(text, tone) {
    els.status.textContent = text;
    els.status.dataset.tone = tone || 'info';
  }

  async function boot() {
    console.log('[Boot] Starting app initialization...');
    wireEvents();
    console.log('[Boot] Events wired');

    setStatus('Loading content…', 'info');
    console.log('[Boot] Fetching build-info.json...');
    const buildInfo = await fetchOptionalJson('content/build-info.json', {});
    state.buildInfo = buildInfo;
    console.log('[Boot] Build info loaded:', buildInfo);
    renderBuildInfo(buildInfo);

    console.log('[Boot] Fetching projects.json...');
    const rows = await fetchRequiredJson('content/projects.json');
    console.log('[Boot] Projects loaded, count:', rows?.length);

    setStatus('Initializing SQLite (WASM)…', 'info');
    console.log('[Boot] Loading SQLite WASM module...');
    const SQL = await initSqlJs({
      locateFile: (file) =>
        `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.11.0/${file}`,
    });
    console.log('[Boot] SQLite module loaded');
    const db = new SQL.Database();
    state.db = db;
    console.log('[Boot] Database instance created');

    console.log('[Boot] Initializing schema...');
    initSchema(db);
    console.log('[Boot] Inserting rows...');
    insertRows(db, rows);
    state.allRowsCount = countAll(db);
    console.log('[Boot] Database ready, total projects:', state.allRowsCount);

    state.isReady = true;
    setStatus('Ready. Type to search.', 'success');
    console.log('[Boot] App fully initialized and ready');

    state.query = '';
    state.results = runSearch(db, parseQuery(''));
    console.log('[Boot] Initial search complete, results:', state.results.length);
    render();
    console.log('[Boot] Initial render complete');
  }

  function wireEvents() {
    const onInput = debounce((e) => {
      const q = String(e.target.value || '');
      state.query = q;
      if (state.db) state.results = runSearch(state.db, parseQuery(q));
      render();
    }, DEBOUNCE_MS);

    els.search.addEventListener('input', onInput);
    els.clear.addEventListener('click', () => {
      els.search.value = '';
      state.query = '';
      if (state.db) state.results = runSearch(state.db, parseQuery(''));
      els.search.focus();
      render();
    });

    // JSON Editor modal events
    els.editJsonBtn.addEventListener('click', openJsonEditor);
    els.closeEditorBtn.addEventListener('click', closeJsonEditor);
    els.jsonEditorModal.addEventListener('click', (e) => {
      if (e.target === els.jsonEditorModal) closeJsonEditor();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && !isTextInputFocused()) {
        e.preventDefault();
        els.search.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (els.search.value) {
          els.search.value = '';
          state.query = '';
          if (state.db) state.results = runSearch(state.db, parseQuery(''));
          render();
        } else {
          els.search.blur();
        }
      }
    });
  }

  function isTextInputFocused() {
    const a = document.activeElement;
    if (!a) return false;
    const tag = a.tagName ? a.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea') return true;
    return Boolean(a.isContentEditable);
  }

  function renderBuildInfo(buildInfo) {
    if (buildInfo && buildInfo.buildTime) {
      const d = new Date(buildInfo.buildTime);
      els.buildTime.textContent = 'Last updated: ' + d.toLocaleString();
      return;
    }
    els.buildTime.textContent = 'Last updated: —';
  }

  function initSchema(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY,
        project TEXT,
        description TEXT,
        responsibilities TEXT,
        highlights TEXT,
        impact TEXT,
        technologies TEXT,
        skills TEXT,
        dates TEXT,
        year INTEGER
      );
    `);

    db.run('CREATE INDEX IF NOT EXISTS idx_projects_year ON projects(year);');
    db.run('CREATE INDEX IF NOT EXISTS idx_projects_project ON projects(project);');
  }

  function insertRows(db, rows) {
    const stmt = db.prepare(`
      INSERT INTO projects (
        project, description, responsibilities, highlights, impact, technologies, skills, dates, year
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);

    db.run('BEGIN;');
    try {
      for (const row of rows || []) {
        const normalized = normalizeRow(row);
        stmt.run([
          normalized.project,
          normalized.description,
          normalized.responsibilities,
          normalized.highlights,
          normalized.impact,
          normalized.technologies,
          normalized.skills,
          normalized.dates,
          normalized.year,
        ]);
      }
    } finally {
      stmt.free();
      db.run('COMMIT;');
    }
  }

  function normalizeRow(row) {
    const get = (k) => {
      const v = row?.[k] ?? row?.[capitalize(k)] ?? '';
      return v == null ? '' : String(v);
    };
    const dates = get('dates');
    const year = extractYear(dates);

    return {
      project: get('project'),
      description: get('description'),
      responsibilities: get('responsibilities'),
      highlights: get('highlights'),
      impact: get('impact'),
      technologies: get('technologies'),
      skills: get('skills'),
      dates,
      year,
    };
  }

  function extractYear(text) {
    const m = String(text || '').match(/\b(19|20)\d{2}\b/);
    return m ? Number(m[0]) : null;
  }

  function parseQuery(input) {
    const raw = String(input || '').trim();
    if (!raw) return { tokens: [], tech: [], skill: [], year: null };

    const parts = raw.split(/\s+/g).filter(Boolean);
    const out = { tokens: [], tech: [], skill: [], year: null };

    for (const part of parts) {
      const kv = part.match(/^([a-zA-Z]+):(.*)$/);
      if (!kv) {
        out.tokens.push(part);
        continue;
      }

      const key = kv[1].toLowerCase();
      const value = (kv[2] || '').trim();
      if (!value) continue;

      if (key === 'tech' || key === 'technology' || key === 'technologies') {
        out.tech.push(value);
        continue;
      }
      if (key === 'skill' || key === 'skills') {
        out.skill.push(value);
        continue;
      }
      if (key === 'year') {
        const y = Number(value);
        if (Number.isFinite(y) && y >= 1970 && y <= 2100) out.year = y;
        else out.tokens.push(part);
        continue;
      }

      out.tokens.push(part);
    }

    return out;
  }

  function buildSearchSql(parsed) {
    const where = [];
    const params = [];

    // Free tokens: AND semantics; each token matches any column.
    for (const token of parsed.tokens || []) {
      const t = token.toLowerCase();
      const clause = LIKE_COLUMNS.map((c) => `LOWER(${c}) LIKE ?`).join(' OR ');
      where.push(`(${clause})`);
      for (let i = 0; i < LIKE_COLUMNS.length; i++) params.push(`%${t}%`);
    }

    // Operators
    for (const t of parsed.tech || []) {
      where.push('(LOWER(technologies) LIKE ?)');
      params.push(`%${t.toLowerCase()}%`);
    }
    for (const s of parsed.skill || []) {
      where.push('(LOWER(skills) LIKE ?)');
      params.push(`%${s.toLowerCase()}%`);
    }
    if (parsed.year != null) {
      where.push('(year = ?)');
      params.push(parsed.year);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      SELECT id, ${COLUMNS.join(', ')}, year
      FROM projects
      ${whereSql}
      ORDER BY (year IS NULL) ASC, year DESC, project COLLATE NOCASE ASC;
    `;

    return { sql, params };
  }

  function runSearch(db, parsed) {
    const { sql, params } = buildSearchSql(parsed);
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  function countAll(db) {
    const stmt = db.prepare('SELECT COUNT(*) AS c FROM projects;');
    try {
      stmt.step();
      const row = stmt.getAsObject();
      return Number(row.c || 0);
    } finally {
      stmt.free();
    }
  }

  function render() {
    const q = String(state.query || '').trim();
    const results = state.results || [];

    if (!state.isReady && !state.error) {
      els.resultsCount.textContent = 'Loading…';
      els.resultsQuery.textContent = '';
      return;
    }

    if (state.error) {
      els.resultsCount.textContent = 'Error';
      els.resultsQuery.textContent = 'Initialization failed.';
      els.grid.textContent = '';
      els.empty.hidden = false;
      els.empty.querySelector('.empty-title').textContent = 'Something went wrong';
      els.empty.querySelector('.empty-sub').textContent =
        'Please refresh. If the problem persists, open the console for details.';
      return;
    }

    els.resultsCount.textContent = `${results.length} / ${state.allRowsCount} projects`;
    els.resultsQuery.textContent = q ? `Query: ${q}` : 'Query: —';

    els.grid.textContent = '';
    if (!results.length) {
      els.empty.hidden = false;
      return;
    }
    els.empty.hidden = true;

    const frag = document.createDocumentFragment();
    for (const row of results) frag.appendChild(renderCard(row));
    els.grid.appendChild(frag);
  }

  function renderCard(row) {
    const card = document.createElement('article');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';

    const title = document.createElement('h2');
    title.className = 'card-title';
    title.textContent = String(row.project || 'Untitled project');

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    meta.textContent = formatMeta(row);

    head.appendChild(title);
    head.appendChild(meta);

    const desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = String(row.description || '').trim() || '—';

    const tagRow = document.createElement('div');
    tagRow.className = 'tag-row';
    const techTags = splitTags(row.technologies);
    const skillTags = splitTags(row.skills);
    for (const t of techTags.slice(0, 8)) tagRow.appendChild(tag('tech', t));
    for (const s of skillTags.slice(0, 8)) tagRow.appendChild(tag('skill', s));

    const body = document.createElement('div');
    body.className = 'card-body';

    const blocks = [
      ['Responsibilities', row.responsibilities],
      ['Highlights', row.highlights],
      ['Impact', row.impact],
    ];
    for (const [label, value] of blocks) {
      const v = String(value || '').trim();
      if (!v) continue;
      const section = document.createElement('div');
      section.className = 'kv';
      const k = document.createElement('div');
      k.className = 'kv-k';
      k.textContent = label;
      const vv = document.createElement('div');
      vv.className = 'kv-v';
      vv.textContent = v;
      section.appendChild(k);
      section.appendChild(vv);
      body.appendChild(section);
    }

    card.appendChild(head);
    card.appendChild(desc);
    if (tagRow.childNodes.length) card.appendChild(tagRow);
    if (body.childNodes.length) card.appendChild(body);

    return card;
  }

  function formatMeta(row) {
    const dates = String(row.dates || '').trim();
    const year = row.year != null ? String(row.year) : '';
    if (dates) return dates;
    if (year) return year;
    return '';
  }

  function splitTags(value) {
    const raw = String(value || '').trim();
    if (!raw) return [];
    const parts = raw
      .split(/[,/|•\n\r\t]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
    return uniq(parts).slice(0, 16);
  }

  function tag(kind, text) {
    const el = document.createElement('span');
    el.className = `tag tag-${kind}`;
    el.textContent = text;
    return el;
  }

  function uniq(arr) {
    return Array.from(new Set(arr));
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  async function fetchOptionalJson(path, fallback) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) return fallback;
      return await res.json();
    } catch {
      return fallback;
    }
  }

  async function fetchRequiredJson(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(
        `Missing ${path} (HTTP ${res.status}). If testing locally, run a local server and create content/projects.json.`,
      );
    }
    return await res.json();
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) window.clearTimeout(t);
      t = window.setTimeout(() => fn.apply(this, args), ms);
    };
  }

  let jedisonInstance = null;

  async function openJsonEditor() {
    console.log('[JSON Editor] Edit button clicked');
    try {
      // Fetch the projects.json file
      console.log('[JSON Editor] Fetching content/projects.json...');
      const response = await fetch('content/projects.json', { cache: 'no-store' });
      console.log('[JSON Editor] Response status:', response.status, response.ok);
      if (!response.ok) throw new Error('Failed to load projects.json');

      const data = await response.json();
      console.log('[JSON Editor] Data loaded, projects count:', data?.length);

      // Clear container
      els.jedisonContainer.innerHTML = '';
      console.log('[JSON Editor] Container cleared');

      // Initialize Jedison with the data
      console.log('[JSON Editor] Initializing Jedison...');
      jedisonInstance = new Jedison.Create({
        container: els.jedisonContainer,
        theme: new Jedison.ThemeBootstrap5(),
        iconLib: 'bootstrap-icons',
        btnContents: false,
        data: data,
        schema: {
          type: 'array',
          title: 'Projects',
          'x-format': 'nav-vertical',
          'x-titleTemplate': '{{ value.project }}',
          items: {
            type: 'object',
            title: 'Project',
            properties: {
              project: {
                type: 'string',
                title: 'Project Name'
              },
              dates: {
                type: 'string',
                title: 'Dates'
              },
              description: {
                type: 'string',
                title: 'Description',
                'x-format': 'textarea'
              },
              responsibilities: {
                type: 'string',
                title: 'Responsibilities',
                'x-format': 'textarea'
              },
              highlights: {
                type: 'string',
                title: 'Highlights',
                'x-format': 'textarea'
              },
              impact: {
                type: 'string',
                title: 'Impact',
                'x-format': 'textarea'
              },
              technologies: {
                type: 'string',
                title: 'Technologies',
                'x-format': 'textarea'
              },
              skills: {
                type: 'string',
                title: 'Skills',
                'x-format': 'textarea'
              }
            }
          }
        }
      });
      console.log('[JSON Editor] Jedison initialized:', jedisonInstance);

      // Show modal
      els.jsonEditorModal.style.display = 'block';
      console.log('[JSON Editor] Modal displayed');
    } catch (err) {
      console.error('[JSON Editor] Failed to open JSON editor:', err);
      alert('Failed to load JSON editor. Check console for details.');
    }
  }

  function closeJsonEditor() {
    console.log('[JSON Editor] Closing editor');
    els.jsonEditorModal.style.display = 'none';
    if (jedisonInstance) {
      els.jedisonContainer.innerHTML = '';
      jedisonInstance = null;
      console.log('[JSON Editor] Editor instance cleared');
    }
  }
})();

