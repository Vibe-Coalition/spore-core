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
    const graph = scope.graph || scope.graphSlug || scope.slug || null;
    const graphs = Array.isArray(scope.graphs) ? scope.graphs.filter(Boolean).map(String) : null;
    if (graphs?.length) return { graphs };
    if (graph) return { graph: String(graph) };
  }
  return null;
}

graphEvents.withGraph = function withGraph(scope, fn) {
  const normalized = _normalizeScope(scope);
  if (!normalized || typeof fn !== 'function') return fn();
  return graphScope.run(normalized, fn);
};

graphEvents.emit = function emitWithGraphScope(eventName, payload, ...args) {
  if (eventName === 'change' && payload && typeof payload === 'object') {
    const scope = graphScope.getStore();
    if (scope && !payload.graph && !payload.graphs) {
      payload = { ...payload, ...scope };
    }
  }
  return _emit(eventName, payload, ...args);
};

module.exports = graphEvents;
