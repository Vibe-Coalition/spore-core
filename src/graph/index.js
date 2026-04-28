const { GraphContext } = require('./context');
const feed = require('./feed');
const { setManager, getActive, embedNode, embedNodeAsync, embedText, buildNodeText } = require('./embedder');
const graphEvents = require('./events');
const { GraphRegistry } = require('./multi');

module.exports = {
  GraphContext, GraphRegistry, feed, graphEvents,
  setEmbedderManager: setManager,
  getActiveEmbedder: getActive,
  embedNode, embedNodeAsync, embedText, buildNodeText,
};
