/**
 * Vanilla Semantic Search Module
 *
 * Hybrid search: multi-vector cosine similarity + keyword scoring.
 *
 * Embedding sources (tried in order):
 *   1. Precomputed file  — content/embeddings.json (free, instant)
 *   2. OpenAI API        — runtime generation (needs API key)
 *   3. Keyword-only      — always works, no vectors needed
 *
 * API key (only needed for query embedding OR if no precomputed file):
 *   window.PORTFOLIO_OPENAI_KEY = 'sk-…';
 *   — or — localStorage.setItem('openai_api_key', 'sk-…');
 *
 * Usage from app.js:
 *   await SemanticSearch.seedEmbeddings(rows);
 *   const scored = await SemanticSearch.search(sqlRows, query);
 */

/* exported SemanticSearch */
window.SemanticSearch = (function () {
  'use strict';

  // ── Configuration ────────────────────────────────────────────────

  var SEMANTIC_WEIGHT = 0.7;
  var KEYWORD_WEIGHT = 0.3;
  var PRECOMPUTED_PATH = 'content/embeddings.json';

  var FIELD_WEIGHTS = {
    technical: { technical: 0.60, business: 0.25, description: 0.15 },
    business: { technical: 0.25, business: 0.60, description: 0.15 },
    neutral: { technical: 0.45, business: 0.40, description: 0.15 },
  };

  // ── Intent keyword lists ─────────────────────────────────────────

  var TECHNICAL_KEYWORDS = new Set([
    'architecture', 'system', 'implementation', 'stack', 'api',
    'backend', 'frontend', 'database', 'infrastructure', 'code',
    'algorithm', 'design', 'protocol', 'framework', 'deploy',
    'docker', 'kubernetes', 'aws', 'azure', 'terraform',
    'cicd', 'ci/cd', 'pipeline', 'vpn', 'ssl', 'iot',
    'react', 'node', 'typescript', 'python', 'nestjs',
    'postgresql', 'sql', 'graphql', 'websocket', 'rest',
    'mongodb', 'redis', 'microservices', 'serverless',
    'webpack', 'vite', 'testing', 'git', 'linux',
    'machine', 'learning', 'ml', 'ai', 'nlp', 'llm',
  ]);

  var BUSINESS_KEYWORDS = new Set([
    'impact', 'delivered', 'value', 'outcome', 'results',
    'achieved', 'revenue', 'growth', 'users', 'clients',
    'success', 'improved', 'reduced', 'increased', 'award',
    'stakeholder', 'engagement', 'confidence', 'production',
    'cost', 'efficiency', 'satisfaction', 'trust',
    'customer', 'team', 'lead', 'manage', 'strategy',
    'product', 'launch', 'scale', 'performance', 'optimize',
  ]);

  // ── State ────────────────────────────────────────────────────────

  /**
   * In-memory store. Keyed by project title (string).
   * Values: { combined: Float32Array, technical: …, business: …, description: … }
   */
  var _store = {};
  var _ready = false;
  var _mode = 'none'; // 'precomputed' | 'api' | 'keyword-only'
  var _warned = false;

  // ── Math ─────────────────────────────────────────────────────────

  function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    var dot = 0, nA = 0, nB = 0;
    for (var i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      nA += a[i] * a[i];
      nB += b[i] * b[i];
    }
    var mag = Math.sqrt(nA * nB);
    return mag === 0 ? 0 : dot / mag;
  }

  function normalizeText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s.,;:()\-]/g, '')
      .trim();
  }

  // ── API key helpers ──────────────────────────────────────────────

  function getApiKey() {
    if (typeof window !== 'undefined' && window.PORTFOLIO_OPENAI_KEY) {
      return window.PORTFOLIO_OPENAI_KEY;
    }
    try { return localStorage.getItem('openai_api_key') || ''; }
    catch (_) { return ''; }
  }

  // ── Embedding sources ────────────────────────────────────────────

  /** Load precomputed embeddings from static JSON file. */
  async function loadPrecomputed() {
    try {
      var res = await fetch(PRECOMPUTED_PATH, { cache: 'no-store' });
      if (!res.ok) return false;
      var data = await res.json();

      var count = 0;
      for (var title of Object.keys(data)) {
        var fields = data[title];
        _store[title] = {
          combined: new Float32Array(fields.combined),
          technical: new Float32Array(fields.technical),
          business: new Float32Array(fields.business),
          description: new Float32Array(fields.description),
        };
        count++;
      }

      console.log('[SemanticSearch] Loaded precomputed embeddings for ' + count + ' projects');
      return count > 0;
    } catch (err) {
      console.warn('[SemanticSearch] Could not load precomputed embeddings:', err.message || err);
      return false;
    }
  }

  /** Call OpenAI API for a single query embedding. */
  async function fetchQueryEmbedding(text) {
    var apiKey = getApiKey();
    if (!apiKey) return null;

    try {
      var res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: text,
          encoding_format: 'float',
        }),
      });

      if (!res.ok) {
        var errText = await res.text();
        console.warn('[SemanticSearch] OpenAI API ' + res.status + ':', errText);
        return null;
      }

      var json = await res.json();
      return new Float32Array(json.data[0].embedding);
    } catch (err) {
      console.warn('[SemanticSearch] Embedding request failed:', err);
      return null;
    }
  }

  /** Batch-embed array of texts via OpenAI API. */
  async function batchEmbed(texts) {
    var apiKey = getApiKey();
    if (!apiKey) return texts.map(function () { return null; });

    try {
      var res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: texts,
          encoding_format: 'float',
        }),
      });

      if (!res.ok) {
        var errText = await res.text();
        console.warn('[SemanticSearch] Batch embed failed ' + res.status + ':', errText);
        return texts.map(function () { return null; });
      }

      var json = await res.json();
      return json.data
        .sort(function (a, b) { return a.index - b.index; })
        .map(function (d) { return new Float32Array(d.embedding); });
    } catch (err) {
      console.warn('[SemanticSearch] Batch embed failed:', err);
      return texts.map(function () { return null; });
    }
  }

  /** Generate all 4 field embeddings per project via API. */
  async function generateViaApi(projects) {
    var allTexts = [];
    var index = [];

    for (var i = 0; i < projects.length; i++) {
      var fields = buildSearchTexts(projects[i]);
      var entries = [
        ['combined', fields.search_text],
        ['technical', fields.technical_text],
        ['business', fields.business_text],
        ['description', fields.description_text],
      ];
      for (var j = 0; j < entries.length; j++) {
        allTexts.push(entries[j][1]);
        index.push({ title: String(projects[i].project || ''), field: entries[j][0] });
      }
    }

    console.log('[SemanticSearch] Generating ' + allTexts.length + ' embeddings via API…');
    var vectors = await batchEmbed(allTexts);

    var successCount = 0;
    for (var k = 0; k < index.length; k++) {
      var title = index[k].title;
      var field = index[k].field;
      if (!_store[title]) {
        _store[title] = { combined: null, technical: null, business: null, description: null };
      }
      _store[title][field] = vectors[k];
      if (vectors[k]) successCount++;
    }

    return successCount > 0;
  }

  // ── Text builders ────────────────────────────────────────────────

  function buildSearchTexts(row) {
    var tech = String(row.technologies || '');
    var resp = String(row.responsibilities || '');
    var imp = String(row.impact || '');
    var high = String(row.highlights || '');
    var desc = String(row.description || '');
    var proj = String(row.project || '');
    var skills = String(row.skills || '');

    return {
      technical_text: normalizeText([tech, tech, tech, resp].join(' ')),
      business_text: normalizeText([imp, imp, high, high].join(' ')),
      description_text: normalizeText(desc),
      search_text: normalizeText([tech, tech, high, resp, imp, proj, desc, skills].join(' ')),
    };
  }

  // ── Intent detection ─────────────────────────────────────────────

  function detectIntent(query) {
    var tokens = String(query || '').toLowerCase().split(/\s+/);
    var tech = 0, biz = 0;
    for (var i = 0; i < tokens.length; i++) {
      if (TECHNICAL_KEYWORDS.has(tokens[i])) tech++;
      if (BUSINESS_KEYWORDS.has(tokens[i])) biz++;
    }
    if (tech > biz && tech >= 1) return 'technical';
    if (biz > tech && biz >= 1) return 'business';
    return 'neutral';
  }

  // ── Scoring ──────────────────────────────────────────────────────

  function multiVectorScore(queryEmb, projEmb, weights) {
    if (!projEmb) return { weighted: 0, technical: 0, business: 0, description: 0 };

    var te = projEmb.technical;
    var be = projEmb.business;
    var de = projEmb.description;

    // Fallback to combined if any domain embedding is missing
    if (!te || !be || !de) {
      var ce = projEmb.combined;
      var sim = ce ? (cosineSimilarity(queryEmb, ce) + 1) / 2 : 0;
      return { weighted: sim, technical: sim, business: sim, description: sim };
    }

    var techSim = (cosineSimilarity(queryEmb, te) + 1) / 2;
    var bizSim = (cosineSimilarity(queryEmb, be) + 1) / 2;
    var descSim = (cosineSimilarity(queryEmb, de) + 1) / 2;

    var weighted =
      weights.technical * techSim +
      weights.business * bizSim +
      weights.description * descSim;

    return { weighted: weighted, technical: techSim, business: bizSim, description: descSim };
  }

  function keywordScore(query, row) {
    var queryTokens = String(query || '')
      .toLowerCase()
      .split(/\s+/)
      .map(function (t) { return t.replace(/[^a-z0-9]/g, ''); })
      .filter(function (t) { return t.length > 2; });

    if (!queryTokens.length) return 0;

    var titleLower = String(row.project || '').toLowerCase();
    var techLower = String(row.technologies || '').toLowerCase();
    var skillLower = String(row.skills || '').toLowerCase();
    var descLower = String(row.description || '').toLowerCase();
    var searchLower = String(row.search_text || '').toLowerCase();

    var score = 0;
    var MAX_PER_TOKEN = 7.5;
    var maxScore = 0;

    for (var i = 0; i < queryTokens.length; i++) {
      var token = queryTokens[i];
      if (titleLower.includes(token)) score += 3;
      if (techLower.includes(token)) score += 2;
      if (skillLower.includes(token)) score += 1;
      if (descLower.includes(token)) score += 1;
      if (searchLower.includes(token)) score += 0.5;
      maxScore += MAX_PER_TOKEN;
    }

    return maxScore > 0 ? score / maxScore : 0;
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Load or generate embeddings.
   * Called once during boot().
   *
   * Priority: precomputed file → API generation → keyword-only.
   */
  async function seedEmbeddings(rows) {
    if (!rows || !rows.length) return;

    // 1. Try precomputed file (instant, free)
    var loaded = await loadPrecomputed();
    if (loaded) {
      _mode = 'precomputed';
      _ready = true;
      return;
    }

    // 2. Try API generation (slow, costs money)
    if (getApiKey()) {
      var generated = await generateViaApi(rows);
      if (generated) {
        _mode = 'api';
        _ready = true;
        console.log('[SemanticSearch] Mode: API-generated');
        return;
      }
    }

    // 3. Keyword-only
    _mode = 'keyword-only';
    _ready = false;
    if (!_warned) {
      console.warn(
        '[SemanticSearch] No embeddings available.\n' +
        '  Generate them: OPENAI_API_KEY=sk-… node scripts/generate_embeddings.js\n' +
        '  Or set an API key for runtime generation.\n' +
        '  Falling back to keyword-only search.'
      );
      _warned = true;
    }
  }

  /**
   * Score and rank rows using hybrid semantic + keyword scoring.
   *
   * @param {Array}  sqlRows - Row objects from SQL query (must have .project)
   * @param {string} query   - Raw query string
   * @returns {Promise<Array>} Augmented rows sorted by relevance
   */
  async function search(sqlRows, query) {
    if (!sqlRows || !sqlRows.length) return [];

    var intent = detectIntent(query);
    var weights = FIELD_WEIGHTS[intent];

    // Get query embedding
    var queryEmb = null;
    if (_ready) {
      queryEmb = await fetchQueryEmbedding(query);
    }

    var hasEmbeddings = queryEmb !== null;

    if (!hasEmbeddings && query) {
      console.log('[SemanticSearch] Keyword-only mode for: "' + query + '"');
    }

    var scored = sqlRows.map(function (row) {
      var semanticScore = 0;
      var fieldScores = null;
      var title = String(row.project || '');

      if (hasEmbeddings && _store[title]) {
        var mv = multiVectorScore(queryEmb, _store[title], weights);
        semanticScore = mv.weighted;
        fieldScores = {
          technical: mv.technical,
          business: mv.business,
          description: mv.description,
        };
      }

      var kwScore = keywordScore(query, row);

      var score = hasEmbeddings
        ? SEMANTIC_WEIGHT * semanticScore + KEYWORD_WEIGHT * kwScore
        : kwScore;

      return Object.assign({}, row, {
        _score: score,
        _semanticScore: semanticScore,
        _keywordScore: kwScore,
        _intent: intent,
        _fieldScores: fieldScores,
      });
    });

    scored.sort(function (a, b) { return b._score - a._score; });
    return scored;
  }

  return {
    seedEmbeddings: seedEmbeddings,
    search: search,
    detectIntent: detectIntent,
    buildSearchTexts: buildSearchTexts,
    keywordScore: keywordScore,
    cosineSimilarity: cosineSimilarity,
    get embeddingsReady() { return _ready; },
    get mode() { return _mode; },
  };

})();
