const { AsyncLocalStorage } = require('async_hooks');
const { EventEmitter } = require('events');

const graphEvents = new EventEmitter();
graphEvents.setMaxListeners(50);

const graphScope = new AsyncLocalStorage();
const _emit = graphEvents.emit.bind(graphEvents);

function _normalizeScope(scope) {
  if (!scope) return null;
  if (typeof scope === 'string') return { graph: scope };
  if (Array.isArray(scope)) return { graphs: scope.filter(Boolean).map(String) };
  if (typeof scope === 'object') {
    const out = {};
    const graph = scope.graph || scope.graphSlug || scope.slug || null;
    const graphs = Array.isArray(scope.graphs) ? scope.graphs.filter(Boolean).map(String) : null;
    if (graphs?.length) out.graphs = graphs;
    else if (graph) out.graph = String(graph);
    for (const key of ['sessionKey', 'channelId', 'platform', 'userId', 'userName', 'isDm', 'trigger', 'route']) {
      if (scope[key] !== undefined && scope[key] !== null) out[key] = scope[key];
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

graphEvents.withGraph = function withGraph(scope, fn) {
  const normalized = _normalizeScope(scope);
  if (!normalized || typeof fn !== 'function') return fn();
  const current = graphScope.getStore();
  return graphScope.run(current ? { ...current, ...normalized } : normalized, fn);
};

graphEvents.emit = function emitWithGraphScope(eventName, payload, ...args) {
  if (eventName === 'change' && payload && typeof payload === 'object') {
    const scope = graphScope.getStore();
    if (scope) {
      const scoped = { ...payload };
      for (const [key, value] of Object.entries(scope)) {
        if ((key === 'graph' || key === 'graphs') && (scoped.graph || scoped.graphs)) continue;
        if (scoped[key] === undefined || scoped[key] === null) scoped[key] = value;
      }
      payload = scoped;
    }
  }
  return _emit(eventName, payload, ...args);
};

module.exports = graphEvents;
