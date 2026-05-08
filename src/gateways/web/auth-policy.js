'use strict';

const crypto = require('crypto');

function parseCookies(req) {
  const obj = {};
  (req?.headers?.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (!k) return;
    try {
      obj[k.trim()] = decodeURIComponent(v.join('='));
    } catch {
      obj[k.trim()] = v.join('=');
    }
  });
  return obj;
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function decodeBasicAuth(header) {
  if (!String(header || '').startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(String(header).slice(6), 'base64').toString();
    const [username, ...passwordParts] = decoded.split(':');
    return { username, password: passwordParts.join(':') };
  } catch {
    return null;
  }
}

function createWebAuthPolicy(opts = {}) {
  const {
    managerKey = '',
    authUser = '',
    authPass = '',
    sessions = new Map(),
    sessionTtl = 7 * 24 * 60 * 60 * 1000,
    loadWebappUsers: directLoadWebappUsers,
    deps = {},
  } = opts;
  const loadWebappUsers = directLoadWebappUsers || deps.loadWebappUsers || (() => []);
  const now = deps.now || opts.now || (() => Date.now());

  const hasServiceKey = req => !!managerKey && req?.headers?.['x-service-key'] === managerKey;

  const hasBasicAuth = req => {
    if (!authUser || !authPass) return false;
    const decoded = decodeBasicAuth(req?.headers?.authorization || '');
    if (!decoded) return false;
    return timingSafeStringEqual(decoded.username, authUser) && timingSafeStringEqual(decoded.password, authPass);
  };

  const basicAuthContext = req => {
    if (!hasBasicAuth(req)) return null;
    return { type: 'creator', role: 'creator', user: authUser, username: authUser, creator: true, viaBasic: true };
  };

  const sessionValid = (sessionId, sess, cookies) => {
    if (!sessionId || !sess) return false;
    if (now() - (sess.created || 0) > sessionTtl) {
      sessions.delete(sessionId);
      return false;
    }
    if (sess.viaSSO && !cookies.manager_session) {
      sessions.delete(sessionId);
      return false;
    }
    return true;
  };

  const getSessionFromReq = req => {
    const cookies = parseCookies(req);
    const sid = cookies.spore_session;
    const wsid = cookies.spore_webapp;
    const sidValid = sid && sessionValid(sid, sessions.get(sid), cookies);
    const wsidValid = wsid && sessionValid(wsid, sessions.get(wsid), cookies);
    if (sidValid && wsidValid) {
      const sCreated = sessions.get(sid)?.created || 0;
      const wCreated = sessions.get(wsid)?.created || 0;
      return wCreated >= sCreated ? wsid : sid;
    }
    if (sidValid) return sid;
    if (wsidValid) return wsid;
    return null;
  };

  const authContextFromReq = req => {
    if (hasServiceKey(req)) {
      return { type: 'admin', role: 'admin', user: 'service', username: 'service', creator: true, viaServiceKey: true };
    }
    const basic = basicAuthContext(req);
    if (basic) return basic;

    const cookies = parseCookies(req);
    const sessionId = getSessionFromReq(req);
    const sess = sessionId && sessions.get(sessionId);
    if (!sessionValid(sessionId, sess, cookies)) return null;

    const webappUsers = loadWebappUsers();
    const userRecord = sess.user && webappUsers.length > 0 ? webappUsers.find(u => u?.username === sess.user) : null;
    if (userRecord?.blocked) {
      sessions.delete(sessionId);
      return null;
    }

    const storedRole = String(userRecord?.role || sess.type || '').toLowerCase();
    let role = sess.type || 'webapp';
    if (storedRole === 'creator' || storedRole === 'admin') role = storedRole;
    const creator = role === 'creator' || role === 'admin';

    return {
      type: role,
      role,
      user: sess.user || null,
      username: sess.user || null,
      sessionId,
      cookieName: cookies.spore_webapp === sessionId ? 'spore_webapp' : 'spore_session',
      userRecord,
      creator,
    };
  };

  const checkCreatorAuth = req => {
    const ctx = authContextFromReq(req);
    return !!ctx?.creator;
  };

  const checkAuth = req => !!authContextFromReq(req);

  return {
    parseCookies,
    getSessionFromReq,
    authContextFromReq,
    checkCreatorAuth,
    checkAuth,
  };
}

module.exports = { createWebAuthPolicy, parseCookies, timingSafeStringEqual };
