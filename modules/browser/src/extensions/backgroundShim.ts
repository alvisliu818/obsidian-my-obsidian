/**
 * MV3 Service Worker 垫片（Chromium/Electron 通用防御，对齐思源 2026-11-25 修复）。
 *
 * 只做两件与闪退直接相关的事：
 *  1. userScripts.register 入口收敛非法 @match（双星 TLD 通配 → 单星通配），
 *     记录到 self.__obUsFixLog 供宿主提醒；
 *  2. chrome.alarms 保活只在扩展自己 manifest 声明 alarms 权限时才调用 ——
 *     Electron 里无权限扩展仍能看到 chrome.alarms 对象，直接注册原生事件会
 *     触发 EventRouter 的 unauthorized extension ID 校验（bad Mojo reason 123），
 *     native 层直接杀 renderer，try/catch 拦不住。
 *
 * 垫片写到扩展目录的 background 文件头（幂等 + 版本哈希 + 尾标记换版剥离），
 * 这样 SW 重启后仍然生效；SiYuan 特有的 /api/file 运行态存储不在本模块范围。
 */

export const SHIM_END = "/* ob-bg-shim-end */";

/** SW 源码是否需要垫片（压缩代码里 chrome 常被别名化，只能按裸关键字判断）。 */
export function needsBackgroundShim(source: string): boolean {
  return /userScripts|alarms/.test(source);
}

/** FNV-1a：垫片内容变了就换标记，避免「改了垫片但标记没变被跳过」。 */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function backgroundShimSource(autoFixScriptMatch: boolean): string {
  const body = `
;(function () {
    try {
        if (typeof chrome === "undefined") return;
        // === 非法 @match 自动修复（对齐思源 2026-11-25）===
        // 新版 Chromium 对 *://**/* 这类非法通配的 userScripts.register
        // 会判扩展越权并杀渲染进程（bad Mojo, reason 123）；注册前改写成
        // 合法写法，记录修复 id 由宿主去重提醒。
        var __obAutoFixMatch = ${autoFixScriptMatch ? "true" : "false"};
        var __obFixMatch = function (m) {
            return typeof m === "string" ? m.replace(/\\*:\\/\\/\\*\\*/g, "*://*") : m;
        };
        var __obUsFixLog = self.__obUsFixLog = self.__obUsFixLog || [];
        if (__obAutoFixMatch && chrome.userScripts && chrome.userScripts.register && !chrome.userScripts.__obRegisterWrapped) {
            var __obOrigRegister = chrome.userScripts.register.bind(chrome.userScripts);
            var __obRegister = function (scripts) {
                try {
                    if (Array.isArray(scripts)) {
                        for (var i = 0; i < scripts.length; i++) {
                            var s = scripts[i];
                            if (!s || typeof s !== "object") continue;
                            var fixed = false;
                            if (Array.isArray(s.matches)) {
                                var nm = s.matches.map(function (m) { var n = __obFixMatch(m); if (n !== m) fixed = true; return n; });
                                s.matches = nm;
                            }
                            if (Array.isArray(s.excludeMatches)) {
                                var ne = s.excludeMatches.map(function (m) { var n = __obFixMatch(m); if (n !== m) fixed = true; return n; });
                                s.excludeMatches = ne;
                            }
                            if (fixed && s.id && __obUsFixLog.indexOf(s.id) < 0) __obUsFixLog.push(s.id);
                        }
                    }
                } catch (eFix) {}
                return __obOrigRegister(scripts);
            };
            __obRegister.__obRegisterWrapped = true;
            try { Object.defineProperty(chrome.userScripts, "register", { configurable: true, value: __obRegister }); }
            catch (eProp) { try { chrome.userScripts.register = __obRegister; } catch (eAssign) {} }
        }
        // === alarms 权限门控（对齐思源 2026-11-25 bad Mojo 根治）===
        // 无 alarms 权限的扩展 SW 里 chrome.alarms 对象仍存在，直接
        // alarms.create / onAlarm.addListener 会走原生 EventRouter 授权校验；
        // 必须先看自己的 manifest.permissions。
        try {
            var __obHasAlarms = false;
            try {
                var __obPerms = (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().permissions) || [];
                __obHasAlarms = __obPerms.indexOf("alarms") >= 0;
            } catch (ePerm) {}
            if (__obHasAlarms && chrome.alarms && !self.__obKeepAliveAlarm) {
                self.__obKeepAliveAlarm = 1;
                chrome.alarms.create("obKeepAlive", { periodInMinutes: 0.4 });
                chrome.alarms.onAlarm.addListener(function () {
                    try { chrome.runtime.getPlatformInfo(function () {}); } catch (e) {}
                });
            }
        } catch (eAlarms) {}
    } catch (e) {}
})();
${SHIM_END}
`;
  return `/* ob-bg-shim:v1:${hash(body)} */${body}`;
}

/** 换版时剥掉旧垫片段，只保留扩展自己的源码。 */
export function stripBackgroundShim(source: string): string {
  if (!/^\/\* ob-bg-shim:v\d+[^*]*\*\//.test(source)) return source;
  const i = source.lastIndexOf(SHIM_END);
  if (i < 0) return source;
  return source.slice(i + SHIM_END.length).replace(/^\s*\n/, "");
}

/** userScripts 类扩展的空注入 marker 文件名（不能以 `_` 开头，Chromium 保留前缀）。 */
export const EVENT_MARKER_FILE = "sy-noop-marker.js";
export const EVENT_MARKER_SOURCE =
  "/* obsidian-browser: noop injection marker. Authorizes this extension's event " +
  "listeners in the renderer (Chromium ScriptInjectionTracker). Do not delete. */\n";
