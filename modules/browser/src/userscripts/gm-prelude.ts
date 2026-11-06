/**
 * GM_* 前奏：宿主直装用户脚本注入时先执行的一段垫片，把暴力猴/TM 风格的
 * GM_* API 补齐到页面环境里。
 *
 * - GM_get/setValue 族走页面 localStorage（按脚本名隔离 key 前缀）——与旧
 *   browser 实现同款语义。
 * - GM_xmlhttpRequest 走 IPC 桥（ob-us-request → 宿主 requestUrl →
 *   ob-us-response），绕开页面 CORS——宿主在 WebviewController 的
 *   ipc-message 里应答。
 * - contextIsolation=no，注入代码可达 require('electron').ipcRenderer。
 */
export function buildGmPrelude(rec: {
	name: string;
	version: string;
	namespace?: string;
	code: string;
}): string {
	const meta = JSON.stringify({ name: rec.name, version: rec.version, namespace: rec.namespace });
	return `
(function () {
  var __gmMeta = ${meta};
  var __gmKey = "__obUs." + __gmMeta.name + ".";
  var __ipc = null;
  try { __ipc = require("electron").ipcRenderer; } catch (e) {}
  var unsafeWindow = window;
  var GM_info = { script: __gmMeta, version: "4.18", handler: "MyKernel Browser" };
  var GM_getValue = function (k, d) { try { var v = localStorage.getItem(__gmKey + String(k)); return v === null ? (d === undefined ? undefined : d) : v; } catch (e) { return d; } };
  var GM_setValue = function (k, v) { try { localStorage.setItem(__gmKey + String(k), String(v)); } catch (e) {} };
  var GM_deleteValue = function (k) { try { localStorage.removeItem(__gmKey + String(k)); } catch (e) {} };
  var GM_listValues = function () { try { var out = []; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(__gmKey) === 0) out.push(k.slice(__gmKey.length)); } return out; } catch (e) { return []; } };
  var GM_addStyle = function (css) { try { var s = document.createElement("style"); s.textContent = String(css); (document.head || document.documentElement).appendChild(s); return s; } catch (e) { return null; } };
  var GM_registerMenuCommand = function (caption, fn) { try { window.__obGmMenus = window.__obGmMenus || []; window.__obGmMenus.push({ caption: String(caption), fn: fn }); } catch (e) {} return { id: window.__obGmMenus ? window.__obGmMenus.length : 0 }; };
  var GM_unregisterMenuCommand = function () {};
  var GM_setClipboard = function (text) { try { navigator.clipboard && navigator.clipboard.writeText(String(text)); } catch (e) {} };
  var GM_notification = function (details, ondone) { try { console.info("[GM notification]", details && (details.title || details.text)); } catch (e) {} if (typeof ondone === "function") { try { ondone(); } catch (e2) {} } };
  var GM_openInTab = function (url, opts) { try { window.open(String(url), "_blank"); } catch (e) {} return { closed: false }; };
  var GM_getResourceText = function () { return ""; };
  var GM_getResourceURL = function () { return ""; };
  var GM_addValueChangeListener = function () { return 0; };
  var GM_removeValueChangeListener = function () {};
  var GM_download = function (details, name) { try { var a = document.createElement("a"); a.href = typeof details === "string" ? details : details.url; a.download = name || ""; document.body.appendChild(a); a.click(); a.remove(); } catch (e) {} };
  var GM_xmlhttpRequest = function (details) {
    if (!__ipc) { if (details.onerror) setTimeout(function () { details.onerror(new Error("ipc unavailable")); }, 0); return; }
    var rid = Math.random().toString(36).slice(2);
    var onResp = function (payload) {
      if (!payload || payload.rid !== rid) return;
      __ipc.removeListener("ob-us-response", onResp);
      var wrap = {
        status: payload.status,
        responseHeaders: payload.headers,
        responseText: payload.body,
        response: payload.body,
        readyState: 4,
        finalUrl: payload.finalUrl || details.url,
      };
      if (payload.error) { if (details.onerror) details.onerror(payload.error); }
      else if (details.onload) details.onload(wrap);
    };
    __ipc.on("ob-us-response", onResp);
    __ipc.sendToHost("ob-us-request", {
      rid: rid,
      params: {
        method: String(details.method || "GET").toUpperCase(),
        url: String(details.url || ""),
        headers: details.headers || null,
        body: details.data == null ? null : String(details.data),
      },
    });
    return { abort: function () { try { __ipc.removeListener("ob-us-response", onResp); } catch (e) {} } };
  };
  var GM = { info: GM_info, getValue: GM_getValue, setValue: GM_setValue, deleteValue: GM_deleteValue, listValues: GM_listValues, addStyle: GM_addStyle, xmlhttpRequest: GM_xmlhttpRequest, setClipboard: GM_setClipboard, registerMenuCommand: GM_registerMenuCommand, openInTab: GM_openInTab, download: GM_download };
})();
`;
}

/** 拼装最终注入体：GM 前奏 + 脚本源码。 */
export function withGmPrelude(rec: { name: string; version: string; namespace?: string; code: string }): string {
	return buildGmPrelude(rec) + "\n" + rec.code;
}
