const { PluginManager } = require('./manager');
const { PluginAPI } = require('./api');
const { OpenClawAdapter, adaptOpenClawPlugin } = require('./openclaw-adapter');

module.exports = { PluginManager, PluginAPI, OpenClawAdapter, adaptOpenClawPlugin };
