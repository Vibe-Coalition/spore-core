/**
 * retrieval.js — Graph Retrieval Engine
 *
 * Search, ranking, graph walk, temporal queries, LLM reranking,
 * and context assembly for the graph context engine.
 *
 */

const { embedText } = require('./embedder');

const SEARCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'like',
  'through', 'after', 'over', 'between', 'out', 'up', 'not', 'no',
  'but', 'what', 'which', 'who', 'when', 'where', 'how', 'that', 'this',
  'it', 'its', 'my', 'your', 'his', 'her', 'we', 'they', 'them', 'i',
  'me', 'you', 'he', 'she', 'and', 'or', 'so', 'if', 'then', 'than',
  'just', 'also', 'very', 'too', 'quite', 'really', 'some', 'any',
  'all', 'each', 'every', 'much', 'many', 'more', 'most', 'other',
]);

const SYNONYM_MAP = {
  bedtime: ['sleep', 'awake', 'night', 'stayed up', 'insomnia', 'rest'],
  sleep: ['bedtime', 'awake', 'night', 'rest', 'nap', 'insomnia'],
  cost: ['price', 'paid', 'spent', 'expense', 'bought', 'purchased', 'dollar'],
  expense: ['cost', 'price', 'paid', 'spent', 'bought', 'purchased'],
  bought: ['purchased', 'acquired', 'got', 'ordered', 'picked up'],
  purchased: ['bought', 'acquired', 'got', 'ordered', 'picked up'],
  completed: ['finished', 'done', 'built', 'made'],
  started: ['began', 'initiated', 'launched', 'kicked off'],
  total: ['combined', 'sum', 'altogether', 'overall'],
  hours: ['time', 'duration', 'minutes', 'played', 'spent'],
  trips: ['travel', 'visited', 'went', 'drove', 'vacation', 'journey'],
  driving: ['drove', 'road trip', 'drive', 'car trip', 'commute'],
};

function _expandQueryTerms(words) {
  const expanded = new Set(words);
  for (const w of words) {
    const synonyms = SYNONYM_MAP[w.toLowerCase()];
    if (synonyms) {
      for (const s of synonyms) expanded.add(s);
    }
  }
  return [...expanded];
}

function _cosine(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

let findSimilarNodes = null;

function classifyQueryType(query) {
  const q = query.toLowerCase();
  if (/\bhow\s+many\b|\bhow\s+much\b|\btotal\b|\ball\s+the\b|\blist\s+all\b|\bevery\b|\bhow\s+many\s+\w+\s+(?:did|have|do|was|were|are|has)\b|\bcombined\b|\bin\s+total\b/.test(q))
    return 'aggregation';
  if (/\byou\s+(?:suggest|recommend|said|told|mention)\w*\b|\bour\s+previous\b|\bprevious\s+(?:chat|conversation)\b|\byou\s+gave\b|\bremind\s+me\s+(?:what|how|of)\b|\bcan\s+you\s+remind\b|\bfollow\s+up\s+on\s+our\b/.test(q))
    return 'assistant-recall';
  if (/\bcurrently\b|\bstill\b|\bnow\b|\busing\s+the\s+same\b|\bswitched\s+to\b|\bchanged\s+to\b|\bdo\s+i\s+still\b|\bis\s+(?:my|her|his|their)\b.*\bsame\b|\blatest\b|\bupdated\b|\bmost\s+recent\b/.test(q))
    return 'knowledge-update';
  if (/\bsuggest\b|\brecommend\b|\bwhat\s+should\b|\bany\s+(?:advice|tips|ideas|suggestions)\b|\bcan\s+you\s+(?:help|suggest|recommend)\b|\bwhat\s+(?:can|could|would)\s+(?:I|we)\b/.test(q))
    return 'preference';
  if (/\bwhen\s+did\b|\bhow\s+long\b|\bbefore\b|\bafter\b|\bfirst\b|\blast\b|\bbetween\s+.+?\s+and\b|\bhow\s+many\s+days\b|\bago\b/.test(q))
    return 'temporal';
  return 'specific';
}

const QUERY_TYPE_PARAMS = {
  aggregation: { maxResults: 100, relevantBudget: 18000, episodeBudget: 8000, episodeCount: 15, attrPerNode: 25, maxContextNodes: 80 },
  'knowledge-update': { maxResults: 50, relevantBudget: 8000, episodeBudget: 6000, episodeCount: 14, attrPerNode: 14, maxContextNodes: 30 },
  'assistant-recall': { maxResults: 50, relevantBudget: 8000, episodeBudget: 6000, episodeCount: 16, attrPerNode: 12, maxContextNodes: 30 },
  preference: { maxResults: 50, relevantBudget: 8000, episodeBudget: 5000, episodeCount: 14, attrPerNode: 12, maxContextNodes: 30 },
  temporal: { maxResults: 60, relevantBudget: 10000, episodeBudget: 6000, episodeCount: 14, attrPerNode: 14, maxContextNodes: 40 },
  specific: { maxResults: 50, relevantBudget: 8000, episodeBudget: 4000, episodeCount: 10, attrPerNode: 12, maxContextNodes: 25 },
};

function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ── Mixin: attaches retrieval methods to GraphContext.prototype ────────────

function applyRetrievalMixin(GraphContext) {
  const proto = GraphContext.prototype;

  proto.getNode = function getNode(id) {
    const row = this.stmt('getNode', 'SELECT * FROM nodes WHERE id = ?').get(id);
    if (!row) return null;
    return this._hydrateNode(row);
  };

  proto.getNodeByLabel = function getNodeByLabel(label) {
    const lbl = label.toLowerCase();

    let row = this.stmt('getNodeByLabel', 'SELECT * FROM nodes WHERE LOWER(label) = ?').get(lbl);
    if (row) return this._hydrateNode(row);

    const aliasRow = this.stmt('getNodeByAlias', 'SELECT node_id FROM aliases WHERE LOWER(alias) = ?').get(lbl);
    if (aliasRow) {
      row = this.stmt('getNode', 'SELECT * FROM nodes WHERE id = ?').get(aliasRow.node_id);
      if (row) return this._hydrateNode(row);
    }

    const idNorm = lbl.replace(/[\s:]/g, '-');
    row = this.stmt('getNode', 'SELECT * FROM nodes WHERE id = ?').get(idNorm);
    if (row) return this._hydrateNode(row);

    return null;
  };

  proto.searchNodes = function searchNodes(query, provenance) {
    const exactQ = query.toLowerCase();

    const _provFilter = provenance === 'self'
      ? ` AND (n.provenance = 'self' OR n.provenance IS NULL)`
      : provenance ? ` AND n.provenance = '${provenance}'` : '';

    const _runQuery = (term) => {
      const q = '%' + term.toLowerCase() + '%';
      const sql = `
        SELECT DISTINCT n.* FROM nodes n
        LEFT JOIN aliases a ON a.node_id = n.id
        LEFT JOIN aspects asp ON asp.node_id = n.id
        LEFT JOIN attributes attr ON attr.aspect_id = asp.id
        WHERE (LOWER(n.label) LIKE ? OR LOWER(n.description) LIKE ?
           OR LOWER(n.id) LIKE ? OR LOWER(a.alias) LIKE ?
           OR LOWER(attr.content) LIKE ?)
        ${_provFilter}
        ORDER BY n.importance DESC LIMIT 50
      `;
      try {
        return this.db.prepare(sql).all(q, q, q, q, q);
      } catch { return []; }
    };

    const seen = new Set();
    const allRows = [];
    for (const row of _runQuery(exactQ)) {
      if (!seen.has(row.id)) { seen.add(row.id); allRows.push(row); }
    }

    const queryWords = exactQ.split(/\s+/).filter(w => w.length >= 2 && !SEARCH_STOPWORDS.has(w));
    if (queryWords.length > 1) {
      for (const word of queryWords.slice(0, 6)) {
        for (const row of _runQuery(word)) {
          if (!seen.has(row.id)) { seen.add(row.id); allRows.push(row); }
        }
      }
    }

    const nodes = allRows.map(r => this._hydrateNode(r));

    const _singleTermRelevance = (node, term) => {
      const label = (node.label || '').toLowerCase();
      const id = (node.id || '').toLowerCase();
      const aliases = (node.aliases || []).map(a => a.toLowerCase());
      if (label === term || id === term) return 0;
      if (aliases.includes(term)) return 1;
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wb = new RegExp(`\\b${esc}\\b`, 'i');
      if (wb.test(label)) return 2;
      if (aliases.some(a => wb.test(a))) return 3;
      if (label.includes(term) || id.includes(term)) return 4;
      if (aliases.some(a => a.includes(term))) return 5;
      return 6;
    };

    const _relevance = (node) => {
      const fullRel = _singleTermRelevance(node, exactQ);
      if (fullRel <= 5) return fullRel;

      if (queryWords.length > 1) {
        let wordHits = 0;
        let bestWordRel = 6;
        for (const w of queryWords) {
          const r = _singleTermRelevance(node, w);
          if (r <= 5) wordHits++;
          if (r < bestWordRel) bestWordRel = r;
        }
        if (wordHits > 0) {
          return 7 + Math.min(bestWordRel, 2) - wordHits * 0.1;
        }
      }
      return 10;
    };

    nodes.sort((a, b) => {
      const ra = _relevance(a), rb = _relevance(b);
      if (ra !== rb) return ra - rb;
      return (b.importance || 0) - (a.importance || 0);
    });

    return nodes.slice(0, 30);
  };

  proto.searchNodesSelf = function searchNodesSelf(query) {
    return this.searchNodes(query, 'self');
  };

  proto.vectorSearch = async function vectorSearch(query, topK = 15) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return [];

    const queryVec = await embedText(query, apiKey);
    const rows = this.db.prepare('SELECT id, embedding FROM nodes WHERE embedding IS NOT NULL').all();

    const scored = [];
    for (const row of rows) {
      try {
        const vec = JSON.parse(row.embedding);
        scored.push({ id: row.id, score: _cosine(queryVec, vec) });
      } catch (e) { this.log.warn('[retrieval] JSON.parse failed: ' + e.message); }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(r => {
      const node = this.getNode(r.id);
      return node ? { ...node, _vectorScore: parseFloat(r.score.toFixed(4)) } : null;
    }).filter(Boolean);
  };

  proto.vectorSearchSelf = async function vectorSearchSelf(query, topK = 15) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return [];

    const queryVec = await embedText(query, apiKey);
    const rows = this.db.prepare(`
      SELECT id, embedding FROM nodes
      WHERE embedding IS NOT NULL AND (provenance = 'self' OR provenance IS NULL)
    `).all();

    const scored = [];
    for (const row of rows) {
      try {
        const vec = JSON.parse(row.embedding);
        scored.push({ id: row.id, score: _cosine(queryVec, vec) });
      } catch (e) { this.log.warn('[retrieval] JSON.parse failed: ' + e.message); }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(r => {
      const node = this.getNode(r.id);
      return node ? { ...node, _vectorScore: parseFloat(r.score.toFixed(4)) } : null;
    }).filter(Boolean);
  };

  proto.hybridSearch = async function hybridSearch(query, topK = 20) {
    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorSearch(query, topK).catch(() => []),
      Promise.resolve(this.searchNodes(query)),
    ]);
    return this._mergeHybridResults(query, vectorResults, keywordResults, topK);
  };

  proto.hybridSearchSelf = async function hybridSearchSelf(query, topK = 20) {
    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorSearchSelf(query, topK).catch(() => []),
      Promise.resolve(this.searchNodesSelf(query)),
    ]);
    return this._mergeHybridResults(query, vectorResults, keywordResults, topK);
  };

  proto._mergeHybridResults = function _mergeHybridResults(query, vectorResults, keywordResults, topK) {
    const exactQ = query.toLowerCase();

    const _keywordTier = (node) => {
      const label = (node.label || '').toLowerCase();
      const id = (node.id || '').toLowerCase();
      const aliases = (node.aliases || []).map(a => a.toLowerCase());
      if (label === exactQ || id === exactQ) return 0;
      if (aliases.includes(exactQ)) return 1;
      const wb = new RegExp(`\\b${exactQ.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (wb.test(label)) return 2;
      if (aliases.some(a => wb.test(a))) return 3;
      if (label.includes(exactQ) || id.includes(exactQ)) return 4;
      if (aliases.some(a => a.includes(exactQ))) return 5;
      return 6;
    };

    const scoreMap = new Map();

    for (let i = 0; i < keywordResults.length; i++) {
      const node = keywordResults[i];
      const tier = _keywordTier(node);
      const keyScore = tier <= 1 ? 1.0 - tier * 0.1
        : tier <= 3 ? 0.7 - (tier - 2) * 0.1
          : 0.4 - (tier - 4) * 0.1;
      const posBonus = 0.05 * (1 - i / Math.max(keywordResults.length, 1));
      scoreMap.set(node.id, { node, score: keyScore + posBonus, source: 'keyword' });
    }

    for (const node of vectorResults) {
      const vecScore = node._vectorScore || 0;
      const normVec = Math.min(0.8, Math.max(0, (vecScore - 0.3) / 0.6) * 0.8);
      const existing = scoreMap.get(node.id);
      if (existing) {
        existing.score = Math.max(existing.score, normVec) + 0.05;
        existing.source = 'both';
      } else {
        scoreMap.set(node.id, { node, score: normVec, source: 'vector' });
      }
    }

    const now = Date.now();
    const sevenDaysMs = 7 * 86400000;
    for (const entry of scoreMap.values()) {
      const node = entry.node;
      if (!node.aspects) continue;
      for (const asp of node.aspects) {
        for (const attr of asp.attributes) {
          if (attr.documentDate) {
            const docTime = new Date(attr.documentDate).getTime();
            if (!isNaN(docTime) && (now - docTime) < sevenDaysMs) {
              entry.score += 0.05;
              break;
            }
          }
        }
        if (entry.score > 1.0) break;
      }
    }

    const entries = [...scoreMap.values()];
    entries.sort((a, b) => b.score - a.score);
    return entries.slice(0, topK).map(e => {
      e.node._hybridScore = e.score;
      return e.node;
    });
  };

  proto._detectTemporalQuery = function _detectTemporalQuery(query) {
    const q = query.toLowerCase();
    const temporalKeywords = /\b(first|before|after|between|how many days|earlier|later|which.*first|when did|what date|how long|recent|latest|oldest|newest|last time|previously|prior to|following|subsequent)\b/i;
    const datePattern = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

    if (!temporalKeywords.test(q) && !datePattern.test(q)) return null;

    const dates = [];
    const isoMatches = query.match(/\d{4}-\d{2}-\d{2}/g);
    if (isoMatches) dates.push(...isoMatches);
    return { isTemporal: true, dates };
  };

  proto._searchByDateProximity = function _searchByDateProximity(targetDates, limit = 10) {
    if (!this.db || !targetDates || targetDates.length === 0) return [];
    try {
      const nodeIds = new Set();
      for (const d of targetDates) {
        const rows = this.db.prepare(`
          SELECT DISTINCT asp.node_id
          FROM attributes a
          JOIN aspects asp ON a.aspect_id = asp.id
          WHERE a.event_date IS NOT NULL
            AND a.event_date BETWEEN date(?, '-30 days') AND date(?, '+30 days')
          LIMIT ?
        `).all(d, d, limit);
        for (const r of rows) nodeIds.add(r.node_id);
      }
      return [...nodeIds].slice(0, limit);
    } catch {
      return [];
    }
  };

  proto.getEdges = function getEdges(nodeId) {
    // LIMIT 5000 is a safety cap — real nodes never have anywhere close to
    // this many edges. If hit, the graph is malformed and the missing edges
    // are the least of the operator's problems.
    const rows = this.stmt('getEdges', `
      SELECT * FROM edges WHERE source = ? OR target = ? LIMIT 5000
    `).all(nodeId, nodeId);
    if (rows.length === 5000) this.log?.warn?.(`[graph] getEdges(${nodeId}) hit 5000-row cap`);
    return rows;
  };

  proto.getNodesByType = function getNodesByType(type, provenance) {
    let sql = 'SELECT * FROM nodes WHERE type = ?';
    const params = [type];

    if (provenance) {
      sql += ' AND provenance = ?';
      params.push(provenance);
    }

    // Safety cap — a single type with 10k+ nodes would already blow the
    // prompt-section budget; this just stops the SELECT from OOMing first.
    sql += ' ORDER BY importance DESC LIMIT 10000';

    const rows = this.stmt(`getByType${provenance ? '_' + provenance : ''}`, sql).all(...params);
    if (rows.length === 10000) this.log?.warn?.(`[graph] getNodesByType(${type}) hit 10000-row cap`);
    return rows.map(r => this._hydrateNode(r));
  };

  proto.getNodesByTypeSelf = function getNodesByTypeSelf(type) {
    return this.getNodesByType(type, 'self');
  };

  proto._hydrateNode = function _hydrateNode(row) {
    const node = {
      id: row.id,
      label: row.label,
      type: row.type,
      description: row.description || '',
      importance: row.importance,
    };

    try {
      const extra = JSON.parse(row.extra || '{}');
      Object.assign(node, extra);
    } catch (e) { this.log.warn('[retrieval] JSON.parse failed: ' + e.message); }

    node.aliases = this.stmt('getAliases', 'SELECT alias FROM aliases WHERE node_id = ?')
      .all(row.id).map(r => r.alias);

    const aspects = this.stmt('getAspects', 'SELECT * FROM aspects WHERE node_id = ?').all(row.id);
    node.aspects = aspects.map(asp => {
      let attrs;
      try {
        attrs = this.stmt('getAttrs', 'SELECT content, importance, event_date, document_date, source_excerpt, updated_at FROM attributes WHERE aspect_id = ?').all(asp.id);
      } catch {
        try {
          attrs = this.db.prepare('SELECT content, importance, event_date, document_date, source_excerpt FROM attributes WHERE aspect_id = ?').all(asp.id);
        } catch {
          attrs = this.db.prepare('SELECT content, importance FROM attributes WHERE aspect_id = ?').all(asp.id);
        }
      }
      return {
        name: asp.name,
        weight: asp.weight,
        attributes: attrs.map(a => ({
          content: a.content,
          importance: a.importance,
          eventDate: a.event_date || null,
          documentDate: a.document_date || null,
          sourceExcerpt: a.source_excerpt || null,
          updatedAt: a.updated_at || null,
        })),
      };
    });

    return node;
  };

  proto._rerankWithLLM = async function _rerankWithLLM(llmClient, query, candidates) {
    const summaries = candidates.slice(0, 20).map((node, i) => {
      const attrs = (node.aspects || [])
        .flatMap(a => (a.attributes || []).map(at => at.content))
        .slice(0, 5)
        .join('; ');
      return `${i}: ${node.label} (${node.type}) — ${(node.description || '').slice(0, 100)}${attrs ? ' | ' + attrs.slice(0, 250) : ''}`;
    });

    const response = await _withTimeout(llmClient.messages.create({
      model: this.config?.learnerModel || this.config?.casualModel || this.config?.model,
      max_tokens: 120,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `Given the question: "${query}"\n\nWhich of these memory entries are most relevant? Return ONLY the indices (comma-separated, most relevant first, max 12):\n\n${summaries.join('\n')}`,
      }],
    }), 30000, 'rerank');

    const text = (response.content?.[0]?.text || '').trim();
    const seen = new Set();
    const indices = (text.match(/\d+/g) || []).map(Number).filter(i => {
      if (i >= candidates.length || seen.has(i)) return false;
      seen.add(i);
      return true;
    });
    if (indices.length === 0) return candidates;

    const reranked = indices.map(i => candidates[i]);
    for (const c of candidates) {
      if (!reranked.includes(c)) reranked.push(c);
    }
    return reranked;
  };

  proto._llmDecomposeQuery = async function _llmDecomposeQuery(llmClient, query) {
    const response = await _withTimeout(llmClient.messages.create({
      model: this.config?.learnerModel || this.config?.casualModel || this.config?.model,
      max_tokens: 250,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `Decompose this question into search queries for a knowledge graph containing personal memories, events, and facts about a user.

Question: "${query}"

Return ONLY valid JSON (no markdown):
{"entities":["entity1","entity2"],"subQueries":["search query 1","search query 2"],"dateRange":{"from":"YYYY-MM-DD or null","to":"YYYY-MM-DD or null"}}

Rules:
- entities: key people, places, events, or things mentioned
- subQueries: 2-5 focused search queries that together would find all info needed to answer
- Include alternate terms and synonyms for key concepts (e.g. "model kit" → also search "diorama", "scale model"; "trip" → also "vacation", "travel")
- For "how many" questions, include queries that search for individual items, not just the collection
- dateRange: approximate date range if temporal, else null
- Keep queries short and specific`,
      }],
    }), 30000, 'decompose');

    const text = (response.content?.[0]?.text || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.log.warn(`[graph] _llmDecomposeQuery: no JSON found in response: "${text.slice(0, 120)}"`);
      return null;
    }
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      this.log.warn(`[graph] _llmDecomposeQuery: JSON parse failed: ${e.message} | raw: "${jsonMatch[0].slice(0, 120)}"`);
      return null;
    }
  };

  proto._extractQueryEntities = function _extractQueryEntities(messageContent) {
    const pinned = [];
    const seen = new Set();

    const _tryPin = (name) => {
      if (!name || name.length < 2 || seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      const node = this.getNodeByLabel(name);
      if (node) pinned.push(node);
    };

    const STOP_WORDS = /^(The|This|That|What|When|Where|Who|How|Why|Which|Does|Did|Can|Could|Would|Should|Have|Has|Is|Are|Was|Were|Do|My|His|Her|Its|Our|Their|Your|If|But|And|Also|Then|After|Before|Since|Because|However|Although|Please|Yes|No|Sure|Ok|Thank|Thanks|I|You|We|They|It|He|She|Not|So|Yet|Or|As|At|To|In|On|Of|For|With|From|About)$/;

    const capPattern = /\b([A-Z][A-Za-z]*(?:[\s.-]+(?:[A-Z][A-Za-z]*|\d+[A-Za-z]*|[A-Za-z]+\d+))*)\b/g;
    let m;
    while ((m = capPattern.exec(messageContent)) !== null) {
      const name = m[1].trim();
      if (name.length < 2) continue;
      if (STOP_WORDS.test(name)) continue;
      _tryPin(name);
      const words = name.split(/\s+/);
      if (words.length > 1) {
        for (let len = words.length - 1; len >= 2; len--) {
          for (let start = 0; start + len <= words.length; start++) {
            _tryPin(words.slice(start, start + len).join(' '));
          }
        }
      }
    }

    const quotePattern = /["']([^"']{2,})["']/g;
    while ((m = quotePattern.exec(messageContent)) !== null) {
      _tryPin(m[1].trim());
    }

    const STOP_SET = new Set(['the', 'a', 'an', 'my', 'i', 'we', 'you', 'did', 'do', 'was', 'were', 'is', 'are', 'had', 'has', 'have', 'to', 'in', 'on', 'at', 'of', 'for', 'with', 'from', 'and', 'or', 'but', 'not', 'how', 'what', 'when', 'where', 'which', 'who', 'many', 'much', 'long', 'first', 'last', 'before', 'after', 'between', 'days', 'that', 'this', 'it']);
    const words = messageContent.replace(/[?!.,;:'"]/g, '').split(/\s+/).filter(w => w.length > 1);
    for (let len = Math.min(5, words.length); len >= 2; len--) {
      for (let start = 0; start + len <= words.length; start++) {
        const phrase = words.slice(start, start + len);
        const meaningful = phrase.filter(w => !STOP_SET.has(w.toLowerCase()));
        if (meaningful.length < 1) continue;
        const joined = phrase.join(' ');
        if (seen.has(joined.toLowerCase())) continue;
        seen.add(joined.toLowerCase());
        try {
          const row = this.db.prepare('SELECT * FROM nodes WHERE LOWER(label) LIKE ? LIMIT 1')
            .get(`%${joined.toLowerCase()}%`);
          if (row && !seen.has(row.id)) {
            seen.add(row.id);
            pinned.push(this._hydrateNode(row));
          }
        } catch (e) { this.log.warn('[retrieval] db.prepare failed: ' + e.message); }
      }
      if (pinned.length >= 6) break;
    }

    return pinned;
  };

  proto._parseTemporalHints = function _parseTemporalHints(messageContent) {
    const lower = messageContent.toLowerCase();
    const hints = { hasTemporal: false, dateRef: null, direction: null };

    const dateMatch = lower.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (dateMatch) {
      hints.hasTemporal = true;
      hints.dateRef = dateMatch[1];
      return hints;
    }

    const temporalWords = /\b(when|how long|before|after|last|recent|latest|first|earliest|during|since|until|ago|yesterday|tomorrow|previous|next|current|now)\b/;
    if (temporalWords.test(lower)) {
      hints.hasTemporal = true;
      if (/\b(latest|recent|last|current|now)\b/.test(lower)) hints.direction = 'recent';
      if (/\b(first|earliest|original|initial)\b/.test(lower)) hints.direction = 'earliest';
    }

    return hints;
  };

  proto._searchHints = function _searchHints(query, limit = 10) {
    if (!this.db) return [];
    try {
      const tbl = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hints_fts'").get();
      if (!tbl) return [];

      const words = query.toLowerCase().replace(/[?!.,;:'"]/g, '').split(/\s+/).filter(w => w.length > 2);
      if (words.length === 0) return [];
      const ftsQuery = words.join(' OR ');

      const rows = this.db.prepare(`
        SELECT h.node_id FROM hints_fts
        JOIN hints h ON hints_fts.rowid = h.id
        WHERE hints_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit * 2);

      const seen = new Set();
      const nodeIds = [];
      for (const r of rows) {
        if (!seen.has(r.node_id)) {
          seen.add(r.node_id);
          nodeIds.push(r.node_id);
          if (nodeIds.length >= limit) break;
        }
      }
      return nodeIds;
    } catch {
      return [];
    }
  };

  proto._searchAttributesFTS = function _searchAttributesFTS(query, limit = 10) {
    if (!this.db) return [];
    try {
      const tbl = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attr_fts'").get();
      if (!tbl) return [];

      const baseWords = query.toLowerCase().replace(/[?!.,;:'"]/g, '').split(/\s+/).filter(w => w.length > 2 && !SEARCH_STOPWORDS.has(w));
      if (baseWords.length === 0) return [];
      const words = _expandQueryTerms(baseWords);
      const ftsQuery = words.join(' OR ');

      const rows = this.db.prepare(`
        SELECT asp.node_id, a.content, a.event_date, rank
        FROM attr_fts
        JOIN attributes a ON attr_fts.rowid = a.rowid
        JOIN aspects asp ON a.aspect_id = asp.id
        WHERE attr_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit * 3);

      const seen = new Set();
      const nodeIds = [];
      for (const r of rows) {
        if (!seen.has(r.node_id)) {
          seen.add(r.node_id);
          nodeIds.push(r.node_id);
          if (nodeIds.length >= limit) break;
        }
      }
      return nodeIds;
    } catch {
      return [];
    }
  };

  /**
   * Search across all attached shared project graphs.
   * Returns nodes tagged with _project metadata for provenance.
   */
  proto._searchSharedGraphs = function _searchSharedGraphs(query, limit = 20) {
    if (!this._sharedGraphs || this._sharedGraphs.length === 0) return [];
    const q = '%' + query.toLowerCase() + '%';
    const results = [];
    const seen = new Set();

    for (const sg of this._sharedGraphs) {
      try {
        const rows = this.db.prepare(`
          SELECT DISTINCT n.* FROM ${sg.alias}.nodes n
          LEFT JOIN ${sg.alias}.aliases a ON a.node_id = n.id
          LEFT JOIN ${sg.alias}.aspects asp ON asp.node_id = n.id
          LEFT JOIN ${sg.alias}.attributes attr ON attr.aspect_id = asp.id
          WHERE (LOWER(n.label) LIKE ? OR LOWER(n.description) LIKE ?
             OR LOWER(n.id) LIKE ? OR LOWER(a.alias) LIKE ?
             OR LOWER(attr.content) LIKE ?)
          ORDER BY n.importance DESC LIMIT ?
        `).all(q, q, q, q, q, limit);

        for (const row of rows) {
          const key = `${sg.slug}:${row.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const node = this._hydrateSharedNode(row, sg);
          results.push(node);
        }
      } catch (e) {
        this.log?.warn?.(`[shared-graph] Search failed for "${sg.slug}": ${e.message}`);
      }
    }

    return results.slice(0, limit);
  };

  /**
   * Hydrate a node row from a shared (attached) graph DB.
   * Pulls aspects/attributes from the attached schema and tags with project info.
   */
  proto._hydrateSharedNode = function _hydrateSharedNode(row, sg) {
    const node = {
      id: row.id,
      label: row.label,
      type: row.type,
      description: row.description || '',
      importance: row.importance,
      _project: sg.slug,
      _projectName: sg.name,
    };

    try {
      const extra = JSON.parse(row.extra || '{}');
      Object.assign(node, extra);
    } catch (e) { this.log.warn('[retrieval] JSON.parse failed: ' + e.message); }

    try {
      node.aliases = this.db.prepare(`SELECT alias FROM ${sg.alias}.aliases WHERE node_id = ?`)
        .all(row.id).map(r => r.alias);
    } catch { node.aliases = []; }

    try {
      const aspects = this.db.prepare(`SELECT * FROM ${sg.alias}.aspects WHERE node_id = ?`).all(row.id);
      node.aspects = aspects.map(asp => {
        let attrs;
        try {
          attrs = this.db.prepare(`SELECT content, importance, event_date, document_date, source_excerpt, updated_at FROM ${sg.alias}.attributes WHERE aspect_id = ?`).all(asp.id);
        } catch {
          try {
            attrs = this.db.prepare(`SELECT content, importance, event_date, document_date, source_excerpt FROM ${sg.alias}.attributes WHERE aspect_id = ?`).all(asp.id);
          } catch {
            attrs = this.db.prepare(`SELECT content, importance FROM ${sg.alias}.attributes WHERE aspect_id = ?`).all(asp.id);
          }
        }
        return {
          name: asp.name,
          weight: asp.weight,
          attributes: attrs.map(a => ({
            content: a.content,
            importance: a.importance,
            eventDate: a.event_date || null,
            documentDate: a.document_date || null,
            sourceExcerpt: a.source_excerpt || null,
            updatedAt: a.updated_at || null,
          })),
        };
      });
    } catch { node.aspects = []; }

    return node;
  };

  proto._searchEpisodes = function _searchEpisodes(query, limit = 5) {
    if (!this.db) return [];
    try {
      const tbl = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='episodes_fts'").get();
      if (!tbl) return [];

      const baseWords = query.toLowerCase().replace(/[?!.,;:'"]/g, '').split(/\s+/).filter(w => w.length > 2 && !SEARCH_STOPWORDS.has(w));
      if (baseWords.length === 0) return [];
      const words = _expandQueryTerms(baseWords);
      const ftsQuery = words.join(' OR ');

      const rows = this.db.prepare(`
        SELECT e.id, e.content, e.observed_at, e.session_id, rank
        FROM episodes_fts
        JOIN episodes e ON episodes_fts.rowid = e.id
        WHERE episodes_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, limit);

      return rows.map(r => ({
        id: r.id,
        content: r.content,
        observedAt: r.observed_at,
        sessionId: r.session_id,
      }));
    } catch {
      return [];
    }
  };

  /**
   * Check which episodes have been superseded — their extracted facts
   * were later replaced by newer information from a different episode.
   */
  proto._findSupersededEpisodes = function _findSupersededEpisodes(episodeIds) {
    if (!this.db || episodeIds.length === 0) return new Map();
    const result = new Map();
    try {
      const hasTbl = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='attribute_history'").get();
      if (!hasTbl) return result;

      for (const epId of episodeIds) {
        const rows = this.db.prepare(`
          SELECT ah.old_content, ah.new_content, a.updated_at
          FROM attribute_history ah
          JOIN attributes a ON a.id = ah.attribute_id
          WHERE ah.source_episode_id = ?
          ORDER BY ah.changed_at DESC
          LIMIT 3
        `).all(epId);
        if (rows.length > 0) {
          result.set(epId, rows.map(r => ({
            old: r.old_content.substring(0, 80),
            new: r.new_content.substring(0, 80),
            updatedAt: r.updated_at,
          })));
        }
      }
    } catch (e) { this.log.warn('[retrieval] db.prepare failed: ' + e.message); }
    return result;
  };

  proto._graphWalk = function _graphWalk(seedNodeIds, maxDepth = 2, maxNodes = 10) {
    if (!this.db || seedNodeIds.size === 0) return [];
    const visited = new Set(seedNodeIds);
    const agentId = this.config.agentId || 'spore';
    visited.add(agentId);
    const results = [];
    let frontier = [...seedNodeIds];

    for (let depth = 1; depth <= maxDepth; depth++) {
      const nextFrontier = [];
      for (const nid of frontier) {
        try {
          const edges = this.db.prepare(
            'SELECT source, target FROM edges WHERE source = ? OR target = ?'
          ).all(nid, nid);
          for (const e of edges) {
            const neighbor = e.source === nid ? e.target : e.source;
            if (!visited.has(neighbor)) {
              visited.add(neighbor);
              nextFrontier.push(neighbor);
              results.push({ id: neighbor, depth });
            }
          }
        } catch (e) { this.log.warn('[retrieval] db.prepare failed: ' + e.message); }
      }
      frontier = nextFrontier;
      if (results.length >= maxNodes) break;
    }

    return results.slice(0, maxNodes);
  };

  proto._decomposeTemporalQuery = function _decomposeTemporalQuery(messageContent) {
    const q = messageContent.replace(/[?!.]+$/, '').trim();

    let m = q.match(/between\s+(?:the\s+|my\s+)?['"]?(.+?)['"]?\s+and\s+(?:the\s+|my\s+)?['"]?(.+?)['"]?\s*$/i);
    if (m) return [m[1].trim(), m[2].trim()];

    m = q.match(/(?:which|what|who)\s+.+?,?\s+(?:the\s+|my\s+)?['"]?(.+?)['"]?\s+or\s+(?:the\s+|my\s+)?['"]?(.+?)['"]?\s*$/i);
    if (m) return [m[1].trim(), m[2].trim()];

    m = q.match(/how\s+(?:many|long)\s+days?\s+(?:before|after|since|until)\s+(?:the\s+|my\s+)?['"]?(.+?)['"]?\s+did\s+.+?(?:the\s+|my\s+)?['"]?(.+?)['"]?\s*$/i);
    if (m) return [m[1].trim(), m[2].trim()];

    m = q.match(/how\s+(?:many|long)\s+days?\s+.+?between\s+(?:the\s+|my\s+)?['"]?(.+?)['"]?\s+and\s+(?:the\s+|my\s+)?['"]?(.+?)['"]?\s*$/i);
    if (m) return [m[1].trim(), m[2].trim()];

    m = q.match(/how\s+(?:many|long)\s+days?\s+.+?(?:the\s+|my\s+)?['"]?(.{4,40}?)['"]?\s+.{2,20}\s+(?:the\s+|my\s+)?['"]?(.{4,40}?)['"]?\s*$/i);
    if (m && m[1] !== m[2]) return [m[1].trim(), m[2].trim()];

    return null;
  };

  proto._scoreNodeAttributes = function _scoreNodeAttributes(node, queryWords, todayStr, temporalHints) {
    const scored = [];
    for (const asp of (node.aspects || [])) {
      for (const attr of (asp.attributes || [])) {
        const isExpired = attr.eventDate && attr.eventDate < todayStr;
        const contentLower = (attr.content || '').toLowerCase();
        const aspLower = (asp.name || '').toLowerCase();
        const hits = queryWords.filter(w => contentLower.includes(w) || aspLower.includes(w)).length;
        const importanceBoost = ((attr.importance || 5) - 5) / 20;

        let temporalBoost = 0;
        if (temporalHints.hasTemporal && attr.eventDate) {
          temporalBoost += 0.5;
          if (temporalHints.dateRef && attr.eventDate.startsWith(temporalHints.dateRef.substring(0, 7))) {
            temporalBoost += 0.7;
          }
          if (temporalHints.direction === 'recent') {
            const daysDiff = Math.abs((new Date(todayStr) - new Date(attr.eventDate)) / 86400000);
            temporalBoost += daysDiff < 30 ? 0.6 : daysDiff < 90 ? 0.4 : 0.15;
          }
          if (temporalHints.direction === 'earliest') {
            temporalBoost += 0.3;
          }
        }

        scored.push({
          aspName: asp.name, content: attr.content,
          score: hits + importanceBoost + temporalBoost,
          isExpired, eventDate: attr.eventDate, sourceExcerpt: attr.sourceExcerpt,
          documentDate: attr.documentDate, updatedAt: attr.updatedAt,
        });
      }
    }
    if (temporalHints.direction === 'recent') {
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.eventDate || '').localeCompare(a.eventDate || '');
      });
    } else if (temporalHints.direction === 'earliest') {
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.eventDate || 'z').localeCompare(b.eventDate || 'z');
      });
    } else {
      scored.sort((a, b) => b.score - a.score);
    }
    return scored;
  };

  /**
   * Detect conflicting values across different aspects of the same node.
   * Returns an array of conflict annotation strings, or empty.
   */
  proto._detectCrossAspectConflicts = function _detectCrossAspectConflicts(scoredAttrs) {
    const _DATE_RE = /(?:as of |since |on |dated? )(\d{4}-\d{2}-\d{2})/i;
    const _extractInlineDate = (text) => {
      const m = text.match(_DATE_RE);
      return m ? m[1] : null;
    };
    const _extractNumbers = (text) => {
      return (text.match(/\d+[.:]\d+|\d+/g) || []).filter(n => n.length <= 10);
    };
    const _topicWords = (text) => {
      return new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 3 && !SEARCH_STOPWORDS.has(w)));
    };

    const byAspect = new Map();
    for (const a of scoredAttrs) {
      if (!byAspect.has(a.aspName)) byAspect.set(a.aspName, []);
      byAspect.get(a.aspName).push(a);
    }
    if (byAspect.size < 2) return [];

    const allAttrs = [];
    for (const [aspName, attrs] of byAspect) {
      for (const a of attrs) {
        const bestDate = a.eventDate || a.documentDate || _extractInlineDate(a.content) || a.updatedAt || null;
        allAttrs.push({ ...a, bestDate, topicWords: _topicWords(a.content), numbers: _extractNumbers(a.content) });
      }
    }

    const conflicts = [];
    const seen = new Set();
    for (let i = 0; i < allAttrs.length; i++) {
      for (let j = i + 1; j < allAttrs.length; j++) {
        const a = allAttrs[i], b = allAttrs[j];
        if (a.aspName === b.aspName) continue;

        let overlap = 0;
        for (const w of a.topicWords) { if (b.topicWords.has(w)) overlap++; }
        const minSize = Math.min(a.topicWords.size, b.topicWords.size);
        if (minSize < 2 || overlap / minSize < 0.5) continue;

        const aNumbers = a.numbers.join(',');
        const bNumbers = b.numbers.join(',');
        if (aNumbers === bNumbers) continue;
        if (!aNumbers && !bNumbers) continue;

        const key = [a.aspName, b.aspName].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);

        if (a.bestDate && b.bestDate && a.bestDate !== b.bestDate) {
          const newer = a.bestDate > b.bestDate ? a : b;
          const older = a.bestDate > b.bestDate ? b : a;
          conflicts.push(`  - ⚠️ CONFLICT: "${older.content.substring(0, 60)}" (${older.aspName}, ${older.bestDate}) vs "${newer.content.substring(0, 60)}" (${newer.aspName}, ${newer.bestDate}) — **use the ${newer.bestDate} value (more recent)**`);
        } else if (a.bestDate && !b.bestDate) {
          conflicts.push(`  - ⚠️ CONFLICT: "${b.content.substring(0, 60)}" (${b.aspName}, undated) vs "${a.content.substring(0, 60)}" (${a.aspName}, ${a.bestDate}) — **prefer the dated value**`);
        } else if (!a.bestDate && b.bestDate) {
          conflicts.push(`  - ⚠️ CONFLICT: "${a.content.substring(0, 60)}" (${a.aspName}, undated) vs "${b.content.substring(0, 60)}" (${b.aspName}, ${b.bestDate}) — **prefer the dated value**`);
        } else {
          conflicts.push(`  - ⚠️ POSSIBLE CONFLICT: "${a.content.substring(0, 60)}" (${a.aspName}) vs "${b.content.substring(0, 60)}" (${b.aspName}) — values differ, check episodes for recency`);
        }
      }
    }
    return conflicts.slice(0, 3);
  };

  proto._buildRelevantContext = function _buildRelevantContext(messageContent, opts = {}) {
    if (!messageContent || messageContent.length < 10) return null;

    const agentId = this.config.agentId || 'spore';
    const todayStr = opts._referenceDate || new Date().toISOString().substring(0, 10);
    const queryLower = messageContent.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3 && !SEARCH_STOPWORDS.has(w));
    const temporalHints = this._parseTemporalHints(messageContent);
    const queryType = opts._queryType || 'specific';
    const qp = opts._queryParams || QUERY_TYPE_PARAMS.specific;
    const maxContextNodes = qp.maxContextNodes;

    const pinned = this._extractQueryEntities(messageContent);
    const pinnedIds = new Set(pinned.map(n => n.id));

    const searchResults = (opts._precomputedResults || this.searchNodesSelf(messageContent))
      .filter(n => n.id !== agentId && !pinnedIds.has(n.id));

    const results = [...pinned, ...searchResults].slice(0, maxContextNodes);

    if (this._sharedGraphs && this._sharedGraphs.length > 0) {
      try {
        const sharedResults = this._searchSharedGraphs(messageContent, 15);
        const seenIds = new Set(results.map(n => n.id));
        for (const sn of sharedResults) {
          const localKey = `shared:${sn._project}:${sn.id}`;
          if (!seenIds.has(localKey) && results.length < maxContextNodes + 10) {
            sn._origId = sn.id;
            sn.id = localKey;
            results.push(sn);
            seenIds.add(localKey);
          }
        }
      } catch (e) { this.log.warn('[retrieval] _searchSharedGraphs failed: ' + e.message); }
    }

    if (queryType === 'aggregation' || queryType === 'preference') {
      const userNode = this.getNode(agentId);
      if (userNode && !new Set(results.map(n => n.id)).has(agentId)) {
        userNode._isUserPersonNode = true;
        results.unshift(userNode);
      } else if (userNode) {
        const existing = results.find(n => n.id === agentId);
        if (existing) existing._isUserPersonNode = true;
      }
    }

    if (queryType === 'aggregation') {
      try {
        const seenIds = new Set(results.map(n => n.id));
        seenIds.add(agentId);
        const edges = this.db.prepare(`
          SELECT e.type as edge_type, n.* FROM edges e
          JOIN nodes n ON n.id = CASE WHEN e.source = ? THEN e.target ELSE e.source END
          WHERE (e.source = ? OR e.target = ?)
          ORDER BY n.importance DESC
          LIMIT 150
        `).all(agentId, agentId, agentId);
        let edgeHits = 0;
        for (const row of edges) {
          if (!seenIds.has(row.id) && edgeHits < 100) {
            const node = this._hydrateNode(row);
            node._hybridScore = 0.15;
            results.push(node);
            seenIds.add(row.id);
            edgeHits++;
          }
        }
        if (edgeHits > 0) {
          this.log.info?.(`[graph] Aggregation edge traversal: added ${edgeHits} connected entities`);
        }
      } catch (ee) {
        this.log.debug?.(`[graph] Edge traversal: ${ee.message}`);
      }
    }

    if (temporalHints.hasTemporal) {
      const subQueries = this._decomposeTemporalQuery(messageContent);
      if (subQueries) {
        const seenIds = new Set(results.map(n => n.id));
        seenIds.add(agentId);
        for (const sq of subQueries) {
          if (!sq || sq.length < 3) continue;
          const sqPinned = this._extractQueryEntities(sq);
          for (const n of sqPinned) {
            if (!seenIds.has(n.id) && results.length < maxContextNodes + 6) {
              results.push(n);
              seenIds.add(n.id);
            }
          }
          const sqResults = this.searchNodesSelf(sq);
          for (const n of sqResults) {
            if (n.id !== agentId && !seenIds.has(n.id) && results.length < maxContextNodes + 6) {
              results.push(n);
              seenIds.add(n.id);
            }
          }
        }
      }
    }

    try {
      const seenIds = new Set(results.map(n => n.id));
      seenIds.add(agentId);
      const ftsNodeIds = [
        ...this._searchHints(messageContent, 10),
        ...this._searchAttributesFTS(messageContent, 10),
      ];
      for (const nid of ftsNodeIds) {
        if (!seenIds.has(nid) && results.length < maxContextNodes + 8) {
          const node = this._hydrateNode(this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(nid));
          if (node) { results.push(node); seenIds.add(nid); }
        }
      }
    } catch (e) { this.log.warn('[retrieval] Set failed: ' + e.message); }

    if (temporalHints.hasTemporal) {
      const refDate = opts._referenceDate || todayStr;
      try {
        const seenIds = new Set(results.map(n => n.id));
        seenIds.add(agentId);
        const dateRows = this.db.prepare(`
          SELECT DISTINCT n.* FROM nodes n
          JOIN aspects a ON a.node_id = n.id
          JOIN attributes attr ON attr.aspect_id = a.id
          WHERE attr.event_date IS NOT NULL
            AND attr.event_date BETWEEN date(?, '-180 days') AND date(?, '+180 days')
            AND n.id != ?
          ORDER BY n.importance DESC
          LIMIT 20
        `).all(refDate, refDate, agentId);
        for (const row of dateRows) {
          if (!seenIds.has(row.id) && results.length < maxContextNodes + 8) {
            results.push(this._hydrateNode(row));
            seenIds.add(row.id);
          }
        }
      } catch (e) { this.log.warn('[retrieval] Set failed: ' + e.message); }
    }

    if (queryType === 'preference') {
      try {
        const seenIds = new Set(results.map(n => n.id));
        seenIds.add(agentId);
        const prefRows = this.db.prepare(`
          SELECT DISTINCT n.* FROM nodes n
          JOIN aspects a ON a.node_id = n.id
          WHERE (a.name LIKE '%prefer%' OR a.name LIKE '%favorite%' OR a.name LIKE '%interest%'
                 OR a.name LIKE '%habit%' OR a.name LIKE '%like%' OR a.name LIKE '%taste%')
            AND n.id != ?
          ORDER BY n.importance DESC
          LIMIT 15
        `).all(agentId);
        for (const row of prefRows) {
          if (!seenIds.has(row.id) && results.length < maxContextNodes + 5) {
            results.push(this._hydrateNode(row));
            seenIds.add(row.id);
          }
        }
      } catch (e) { this.log.warn('[retrieval] Set failed: ' + e.message); }
    }

    if (results.length === 0) return null;

    const allNodeIds = new Set(results.map(n => n.id));
    const parts = [
      '## Relevant Context (from graph)',
      '_Reading guide for this context:_',
      '_- Attributes marked **(LATEST)** or with more recent dates override older values on the same topic._',
      '_- ⚠️ CONFLICT annotations mean the same fact appears on different aspects with different values — trust the one with the more recent date._',
      '_- ⚠️ PARTIALLY OUTDATED on conversation excerpts means the graph has newer information — prefer the graph value._',
      '_- When the same entity shows different states over time (moved to X, then moved to Y), the most recently dated entry is current._',
    ];

    for (let ri = 0; ri < results.length; ri++) {
      const node = results[ri];
      const isPinned = pinnedIds.has(node.id);
      const desc = node.description ? `: ${node.description}` : '';
      const scoredAttrs = this._scoreNodeAttributes(node, queryWords, todayStr, temporalHints);

      const attrCap = qp.attrPerNode;
      const isUserNode = node._isUserPersonNode;
      const baseLimit = queryType === 'aggregation'
        ? (isUserNode ? 20 : (isPinned ? attrCap + 2 : attrCap))
        : (isPinned ? 20 : (ri === 0 ? 15 : 6));
      const nonExpired = scoredAttrs.filter(a => !a.isExpired);
      let topAttrs;
      if (nonExpired.length > 50) {
        const strong = nonExpired.filter(a => a.score >= 1.5);
        const rest = nonExpired.filter(a => a.score < 1.5).slice(0, Math.max(0, baseLimit - strong.length));
        topAttrs = [...strong.slice(0, 30), ...rest];
      } else {
        topAttrs = nonExpired.slice(0, baseLimit);
      }
      const topExpired = scoredAttrs.filter(a => a.isExpired && a.score > 0).slice(0, isPinned ? 4 : 2);

      if (topAttrs.length === 0 && topExpired.length === 0 && !desc) continue;

      const projTag = node._project ? ` [shared: ${node._projectName || node._project}]` : '';
      parts.push(`- **${node.label}** (${node.type})${desc}${projTag}`);

      const byAspect = new Map();
      for (const a of topAttrs) {
        if (!byAspect.has(a.aspName)) byAspect.set(a.aspName, []);
        byAspect.get(a.aspName).push({ content: a.content, eventDate: a.eventDate || null });
      }
      for (const [aspName, entries] of byAspect) {
        if (entries.length > 1 && entries.some(e => e.eventDate)) {
          const dated = entries.filter(e => e.eventDate).sort((a, b) => b.eventDate.localeCompare(a.eventDate));
          const undated = entries.filter(e => !e.eventDate);
          const formatted = [];
          for (let ei = 0; ei < dated.length; ei++) {
            const prefix = ei === 0 ? '(LATEST) ' : '';
            formatted.push(`${prefix}${dated[ei].content} [${dated[ei].eventDate}]`);
          }
          for (const u of undated) formatted.push(u.content);
          parts.push(`  - ${aspName}: ${formatted.join('; ')}`);
        } else {
          const formatted = entries.map(e => e.content + (e.eventDate ? ` [${e.eventDate}]` : ''));
          parts.push(`  - ${aspName}: ${formatted.join('; ')}`);
        }
      }
      for (const ex of topExpired) {
        parts.push(`  - ~${ex.aspName} (SUPERSEDED): ${ex.content} [${ex.eventDate}]~`);
      }

      const conflictNotes = this._detectCrossAspectConflicts(scoredAttrs);
      for (const note of conflictNotes) parts.push(note);

      if (queryType !== 'aggregation' && ri < 3) {
        try {
          const edges = this.getEdges(node.id);
          let neighborCount = 0;
          for (const edge of edges) {
            if (neighborCount >= 4) break;
            const neighborId = edge.source === node.id ? edge.target : edge.source;
            if (allNodeIds.has(neighborId) || neighborId === agentId) continue;

            const neighbor = this.getNode(neighborId);
            if (!neighbor) continue;

            const neighborAttrs = this._scoreNodeAttributes(neighbor, queryWords, todayStr, temporalHints);
            const relevantAttrs = neighborAttrs.filter(a => !a.isExpired && a.score > 0).slice(0, 2);
            const attrStr = relevantAttrs.length > 0
              ? ': ' + relevantAttrs.map(a => a.content).join('; ')
              : (neighbor.description ? ': ' + neighbor.description.slice(0, 100) : '');
            parts.push(`  - → ${edge.type} → **${neighbor.label}**${attrStr}`);
            allNodeIds.add(neighborId);
            neighborCount++;
          }
        } catch (e) { this.log.warn('[retrieval] getEdges failed: ' + e.message); }
      }
    }

    try {
      const nodeIdList = [...allNodeIds];
      if (nodeIdList.length >= 2) {
        const labelMap = new Map();
        for (const n of results) labelMap.set(n.id, n.label);
        for (const nid of nodeIdList) {
          if (!labelMap.has(nid)) {
            const row = this.db.prepare('SELECT label FROM nodes WHERE id = ?').get(nid);
            if (row) labelMap.set(nid, row.label);
          }
        }
        const edgeRelations = [];
        const edgeSeen = new Set();
        const idSet = new Set(nodeIdList);
        for (const nid of nodeIdList) {
          const edges = this.getEdges(nid);
          for (const e of edges) {
            const otherId = e.source === nid ? e.target : e.source;
            if (!idSet.has(otherId)) continue;
            const key = `${e.source}-${e.type}-${e.target}`;
            if (edgeSeen.has(key)) continue;
            edgeSeen.add(key);
            edgeRelations.push(`${labelMap.get(e.source) || e.source} → ${e.type} → ${labelMap.get(e.target) || e.target}`);
          }
        }
        if (edgeRelations.length > 0) {
          parts.push('- **Relationships**: ' + edgeRelations.slice(0, 8).join('; '));
        }
      }
    } catch (e) { this.log.warn('[retrieval] Map failed: ' + e.message); }

    try {
      const derivedFacts = this.db.prepare(
        "SELECT content, source_node_ids FROM derived_facts WHERE invalidated_at IS NULL ORDER BY created DESC LIMIT 10"
      ).all();
      if (derivedFacts.length > 0) {
        const matched = derivedFacts.filter(df => {
          const contentLower = df.content.toLowerCase();
          return queryWords.some(w => contentLower.includes(w));
        }).slice(0, 2);
        for (const df of matched) {
          parts.push(`- _Inferred: ${df.content}_`);
        }
      }
    } catch (e) { this.log.warn('[retrieval] db.prepare failed: ' + e.message); }

    try {
      const nodeIdList = [...allNodeIds];
      if (nodeIdList.length > 0) {
        const placeholders = nodeIdList.map(() => '?').join(',');
        const reflections = this.db.prepare(
          `SELECT r.content, n.label FROM reflections r
           LEFT JOIN nodes n ON n.id = r.node_id
           WHERE r.node_id IN (${placeholders})
           ORDER BY r.created DESC LIMIT 10`
        ).all(...nodeIdList);
        const matched = reflections.filter(r => {
          const cLower = (r.content || '').toLowerCase();
          return queryWords.some(w => cLower.includes(w));
        }).slice(0, 3);
        for (const r of matched) {
          parts.push(`- _Reflection${r.label ? ` [${r.label}]` : ''}: ${r.content}_`);
        }
      }
    } catch (e) { this.log.warn('[retrieval] nodeIdList.map failed: ' + e.message); }

    return parts.join('\n');
  };
}

module.exports = { applyRetrievalMixin, classifyQueryType, QUERY_TYPE_PARAMS, SEARCH_STOPWORDS, _expandQueryTerms };
