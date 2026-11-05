/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * `chrome.*` shim handed to content scripts and to extension popups.
 *
 * Deliberately partial: background pages and service workers never run (there
 * is no extension runtime here), so anything that needs one simply no-ops.
 * Everything else — storage, i18n, getURL, messaging — is implemented on top of
 * localStorage and a plain event bus in the page.
 */
export function buildShimSource(extId: string, baseUrl: string): string {
  return `
(function () {
  if (window.__obChromeShim) return;
  var ID = ${JSON.stringify(extId)};
  var BASE = ${JSON.stringify(baseUrl)};
  var PREFIX = "obext:" + ID + ":";
  var listeners = [];
  var bus = {
    addListener: function (fn) { listeners.push(fn); },
    removeListener: function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener: function (fn) { return listeners.indexOf(fn) >= 0; },
    emit: function (msg) { listeners.slice().forEach(function (fn) { try { fn(msg); } catch (e) {} }); }
  };
  function store() {
    try { return window.localStorage; } catch (e) { return null; }
  }
  function readAll() {
    var s = store(), out = {};
    if (!s) return out;
    for (var i = 0; i < s.length; i++) {
      var k = s.key(i);
      if (k && k.indexOf(PREFIX) === 0) out[k.slice(PREFIX.length)] = JSON.parse(s.getItem(k));
    }
    return out;
  }
  function area() {
    return {
      get: function (keys, cb) {
        var all = readAll(), out = {};
        if (keys == null) out = all;
        else if (typeof keys === "string") { if (keys in all) out[keys] = all[keys]; }
        else if (Array.isArray(keys)) keys.forEach(function (k) { if (k in all) out[k] = all[k]; });
        else Object.keys(keys).forEach(function (k) { out[k] = (k in all) ? all[k] : keys[k]; });
        if (typeof cb === "function") cb(out);
        return Promise.resolve(out);
      },
      set: function (items, cb) {
        var s = store();
        if (s) Object.keys(items).forEach(function (k) { s.setItem(PREFIX + k, JSON.stringify(items[k])); });
        if (typeof cb === "function") cb();
        return Promise.resolve();
      },
      remove: function (keys, cb) {
        var s = store();
        var list = typeof keys === "string" ? [keys] : keys;
        if (s && list) list.forEach(function (k) { s.removeItem(PREFIX + k); });
        if (typeof cb === "function") cb();
        return Promise.resolve();
      },
      clear: function (cb) {
        var s = store();
        if (s) readAll() && Object.keys(readAll()).forEach(function (k) { s.removeItem(PREFIX + k); });
        if (typeof cb === "function") cb();
        return Promise.resolve();
      },
      getBytesInUse: function () { return Promise.resolve(0); }
    };
  }
  var runtime = {
    id: ID,
    lastError: null,
    getURL: function (p) { return BASE + String(p || "").replace(/^\\/+/, ""); },
    getManifest: function () { return window.__obExtManifest || {}; },
    sendMessage: function (msg, cb) { bus.emit(msg); if (typeof cb === "function") cb(null); return Promise.resolve(null); },
    onMessage: bus,
    onInstalled: bus,
    connect: function () { return { postMessage: function () {}, onMessage: bus, disconnect: function () {} }; },
    getPlatformInfo: function (cb) { var i = { os: "win", arch: "x86-64" }; if (cb) cb(i); return Promise.resolve(i); }
  };
  var i18n = {
    getMessage: function (key) {
      var m = (window.__obExtManifest && window.__obExtManifest.__messages) || {};
      return m[key] ? m[key].message : "";
    },
    getUILanguage: function () { return navigator.language || "zh-CN"; }
  };
  var shim = {
    runtime: runtime,
    extension: { getURL: runtime.getURL, getBackgroundPage: function () { return null; } },
    storage: { local: area(), sync: area(), onChanged: bus },
    i18n: i18n,
    tabs: {
      query: function (q, cb) { var t = [{ id: 1, url: location.href, title: document.title }]; if (cb) cb(t); return Promise.resolve(t); },
      sendMessage: function (msg) { bus.emit(msg); return Promise.resolve(); },
      create: function (o) { window.open(o && o.url, "_blank"); },
      executeScript: function () { return Promise.resolve(); }
    },
    action: { setBadgeText: function () {}, setIcon: function () {}, setTitle: function () {}, onClicked: bus },
    browserAction: { setBadgeText: function () {}, setIcon: function () {}, setTitle: function () {}, onClicked: bus },
    notifications: { create: function () {} },
    scripting: { executeScript: function () { return Promise.resolve(); }, insertCSS: function () { return Promise.resolve(); } }
  };
  try {
    if (!window.chrome) window.chrome = shim;
    else Object.keys(shim).forEach(function (k) { if (!(k in window.chrome)) window.chrome[k] = shim[k]; });
  } catch (e) { window.chrome = shim; }
  window.__obChromeShim = true;
})();
`;
}
