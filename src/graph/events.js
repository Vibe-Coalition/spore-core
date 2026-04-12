const { EventEmitter } = require('events');

const graphEvents = new EventEmitter();
graphEvents.setMaxListeners(50);

module.exports = graphEvents;
