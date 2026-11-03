/**
 * MV3 service_worker 兼容垫片 v23 —— 移植自 siyuan-plugin-browser
 * src/extensions/extensionHost.ts 的 shimBody（__sy* 前缀统一改 __ob*）。
 *
 * 版本史（上游注释摘录）：
 *   v24 剥掉 0d 节 TM extdb 守卫（闭源油猴链移除，开源暴力猴用不到）
 *   v23 userScripts.execute 补桩（SW→页面 下发用户脚本代码，出箱
 *       __obUsExecOutbox 由 cs-runtime 回包泵排空后在自建世界执行）——
 *       Violentmonkey MV3 注入链 forceContent 路径的关键通道
 *   v22 tabs.get/update 原生存在也包装（get 失败兜底假 tab；update 带 url
 *       写出箱）——VM .user.js 安装链 confirmInstall 的 getTab+tabs.update
 *   v21 事件面补全（notifications/downloads 等"有对象无事件"缺口）
 *   v20 chrome.extension 兼容（Violentmonkey SW 启动即死修复）
 *   v19 TM extdb 启动守卫（脚本主库锚定 storage.local + IndexedDB 镜像回填）
 *
 * 尾标记 ob-bg-shim-end 供换版剥离旧垫片；标记含 FNV-1a 内容哈希
 * （shimMark()），迭代内容而版本号不变时也能触发重注入。
 */
export const SHIM_VER = "v24";

export const SHIM_BODY = `;(function () {
    try {
        if (typeof chrome === "undefined") return;
        // 0) onMessage handlers 收集数组：无条件最顶部创建 —— background 顶层的
        //    addListener 稍后 push 进同一数组；宿主 routeSendMessage 据此判断
        //    "handler 已注册（非空）" 还是 "仍在启动期（空 → 重试）"。
        //    （此前数组在 onMessage 包装内创建，若包装条件不满足则数组缺失，
        //    宿主会误报 "垫片未运行" 且无重试依据。）
        self.__obOnMessageHandlers = self.__obOnMessageHandlers || [];
        // 0b) 消息归一（垫片统一兼容点）：SW 侧部分扩展 handler 对可选字段无
        //     保护（实测 TM loadTree：referrer 缺失 → pd.level(undefined) 抛
        //     "Cannot read properties of undefined (reading 'replace')" →
        //     options 页引导走 fail → 原生 confirm 同步阻塞 JS 线程，页面假死
        //     并弹 "An internal error occurred"）。宿主的三条消息路由
        //     （CS→SW sendMessage / port 派发 / storage onChanged 回程）都经
        //     此归一，兼容逻辑只住这一处。
        self.__obNormalizeMsg = function (msg) {
            try {
                if (msg && typeof msg === "object") {
                    if (msg.method === "loadTree" && msg.referrer === undefined) {
                        msg = Object.assign({}, msg, { referrer: (typeof msg.origin === "string" && msg.origin) || "options" });
                    }
                }
            } catch (e) {}
            return msg;
        };
        // 0c) onInstalled 收集 + 真首次放行：Electron 每次 loadExtension（含本
        //     插件启动时的 removeExtension+loadExtension 保活/重载）都以
        //     reason=install 派发 onInstalled —— 实测 TM 据此每次启动都开
        //     tampermonkey.net/installed.php 欢迎页签（旧 tabs.create 假桩静默
        //     吞掉所以从未暴露，create 实装后每个 SW 启动都弹页签）。属性替换后
        //     原生事件落到无监听的原生对象上自然被吞；是否放行改由 storage
        //     持久标记决定（按扩展隔离，真·首次安装语义）。
        try {
            if (chrome.runtime && chrome.runtime.onInstalled && !chrome.runtime.onInstalled.__obWrapped) {
                var oiFns = [];
                var oiWrapped = {
                    addListener: function (fn) { if (typeof fn === "function") oiFns.push(fn); },
                    removeListener: function (fn) { var i = oiFns.indexOf(fn); if (i >= 0) oiFns.splice(i, 1); },
                };
                oiWrapped.__obWrapped = true;
                try { Object.defineProperty(chrome.runtime, "onInstalled", { configurable: true, get: function () { return oiWrapped; } }); } catch (eOi) { try { chrome.runtime.onInstalled = oiWrapped; } catch (eOi2) {} }
                var oiEmit = function (details) { for (var i = 0; i < oiFns.length; i++) { try { oiFns[i](details); } catch (eOi3) {} } };
                oiWrapped.__obEmit = oiEmit;
                try {
                    chrome.storage.local.get(["__obOiSeen"], function (v) {
                        if (v && v.__obOiSeen) return;
                        try { chrome.storage.local.set({ __obOiSeen: Date.now() }, function () {}); } catch (eOi4) {}
                        oiEmit({ reason: "install" });
                    });
                } catch (eOi5) {}
            }
        } catch (e) {}
        // 0e) chrome.extension 兼容（v20，Violentmonkey SW 启动即死修复）：VM 2.50
        //     的 sw.js 顶层 probe chrome.extension.isAllowedFileSchemeAccess /
        //     isAllowedIncognitoAccess（真实 SW 实证报
        //     "O.extension.isAllowedIncognitoAccess is not a function" → 顶层
        //     TypeError → SW 启动即死、has_started_service_worker 恒 false →
        //     popup 的 OpenDashboard 等消息全部路由到死 SW，设置/加号按钮无反应）。
        //     Electron 的 chrome.extension 命名空间存在但缺这两个方法 —— 补
        //     回调+Promise 双语义桩（能力探测语义：无 incognito/文件访问回 false
        //     即可让扩展初始化走完）。
        try {
            if (typeof chrome.extension === "undefined") { try { chrome.extension = {}; } catch (eXt0) {} }
            if (chrome.extension && typeof chrome.extension.isAllowedFileSchemeAccess !== "function") {
                chrome.extension.isAllowedFileSchemeAccess = function (cb) { try { if (typeof cb === "function") cb(false); } catch (eXt1) {} return Promise.resolve(false); };
            }
            if (chrome.extension && typeof chrome.extension.isAllowedIncognitoAccess !== "function") {
                chrome.extension.isAllowedIncognitoAccess = function (cb) { try { if (typeof cb === "function") cb(false); } catch (eXt2) {} return Promise.resolve(false); };
            }
        } catch (e) {}
        // 0f) 事件面补全（v21）：求值期实测 chrome.notifications 等**整体缺失**
        //     （mutProbe 实证：undefined，非"有对象无事件"）——第 1 节的通用壳
        //     只带 5 个泛型事件（onChanged/onClicked/onCommand/onInstalled/
        //     onStartup），缺 VM sw.js 顶层要用的 onClosed/onShown 等 →
        //     browser.notifications.onClosed.addListener 直接 TypeError（SW 启动
        //     即死第二幕）。本节按命名空间补完整事件面：命名空间缺失则建壳，
        //     已存在则只补缺失的事件壳。
        try {
            var obMkEvent = function () {
                var fns = [];
                return {
                    addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                    removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                    hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
                };
            };
            var syCloneNs = function (ns, name, ev) {
                var merged = {};
                try {
                    var names = Object.getOwnPropertyNames(ns);
                    for (var iK = 0; iK < names.length; iK++) {
                        try {
                            var d = Object.getOwnPropertyDescriptor(ns, names[iK]);
                            if (d && d.get) Object.defineProperty(merged, names[iK], d);
                            else if (d) { d.configurable = true; Object.defineProperty(merged, names[iK], d); }
                        } catch (eC1) {}
                    }
                } catch (eC2) {}
                merged[name] = ev;
                return merged;
            };
            var syEnsureEvent = function (parent, childKey, name) {
                if (!parent) return;
                var ns = parent[childKey];
                if (!ns || typeof ns !== "object" && typeof ns !== "function") {
                    try { parent[childKey] = {}; } catch (eNs) { return; }
                    ns = parent[childKey];
                }
                var cur = ns[name];
                if (cur && typeof cur.addListener === "function") return;
                var ev = obMkEvent();
                try { Object.defineProperty(ns, name, { configurable: true, get: function () { return ev; } }); } catch (eA) {}
                if (ns[name] && typeof ns[name].addListener === "function") return;
                try { ns[name] = ev; } catch (eB) {}
                if (ns[name] && typeof ns[name].addListener === "function") return;
                try {
                    var merged = syCloneNs(ns, name, ev);
                    try { Object.defineProperty(parent, childKey, { configurable: true, get: function () { return merged; } }); } catch (eD) { try { parent[childKey] = merged; } catch (eE) {} }
                } catch (eF) {}
            };
            var syEventFaces = [
                ["notifications", "onClicked"], ["notifications", "onClosed"], ["notifications", "onShown"],
                ["notifications", "onButtonClicked"], ["notifications", "onPermissionLevelChanged"],
                ["downloads", "onChanged"], ["downloads", "onCreated"], ["downloads", "onErased"],
                ["alarms", "onAlarm"], ["commands", "onCommand"],
                ["omnibox", "onInputStarted"], ["omnibox", "onInputChanged"], ["omnibox", "onInputEntered"], ["omnibox", "onInputCancelled"],
            ];
            for (var iEF = 0; iEF < syEventFaces.length; iEF++) {
                var face = syEventFaces[iEF];
                syEnsureEvent(chrome, face[0], face[1]);
            }
        } catch (e) {}
        // 1) 通用存在性垫片：background 里引用到的缺失命名空间统一补空壳，
        //    否则任何一处 undefined 访问都会让 SW 整个崩掉（实测 SiYuan Clip
        //    第一行 contextMenus、中段 commands 各崩一次）。
        var eventHub = function () {
            var fns = [];
            return {
                addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                __emit: function () { var a = arguments; fns.forEach(function (fn) { try { fn.apply(null, a); } catch (e) {} }); },
            };
        };
        var MISSING = ["contextMenus", "commands", "action", "browserAction", "pageAction",
            "notifications", "cookies", "downloads", "webNavigation", "webRequest",
            "declarativeNetRequest", "idle", "alarms", "permissions", "sessions",
            "topSites", "bookmarks", "history", "omnibox", "pageCapture"];
        MISSING.forEach(function (ns) {
            if (chrome[ns]) return;
            chrome[ns] = { onChanged: eventHub() };
            // 常见事件口补 addListener（保证注册不抛）
            ["onClicked", "onCommand", "onInstalled", "onStartup", "onChanged"].forEach(function (ev) {
                chrome[ns][ev] = eventHub();
            });
        });
        // 引擎拦截链需要 webRequest/webNavigation 的**全套请求事件**
        // （v4 空壳只补了 5 个通用事件 → AdGuard engine 启动报 .addListener undefined）
        try {
            var REQ_EVENTS = ["onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived",
                "onAuthRequired", "onResponseStarted", "onBeforeRedirect", "onCompleted", "onErrorOccurred"];
            var NAV_EVENTS = ["onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted",
                "onErrorOccurred", "onCreatedNavigationTarget", "onReferenceFragmentUpdated",
                "onTabReplaced", "onHistoryStateUpdated", "onDomainChanged"];
            ["webRequest", "declarativeNetRequest"].forEach(function (ns) {
                if (!chrome[ns]) chrome[ns] = {};
                REQ_EVENTS.forEach(function (ev) {
                    if (!chrome[ns][ev] || typeof chrome[ns][ev].addListener !== "function") chrome[ns][ev] = eventHub();
                });
            });
            if (!chrome.webNavigation) chrome.webNavigation = {};
            NAV_EVENTS.forEach(function (ev) {
                if (!chrome.webNavigation[ev] || typeof chrome.webNavigation[ev].addListener !== "function") chrome.webNavigation[ev] = eventHub();
            });
            // privacy 壳（AdGuard StealthService 调 privacy.network.webRTCIPHandlingPolicy）
            if (!chrome.privacy) chrome.privacy = {};
            if (!chrome.privacy.network) chrome.privacy.network = {};
            ["webRTCIPHandlingPolicy", "networkPredictionEnabled"].forEach(function (k) {
                if (!chrome.privacy.network[k]) chrome.privacy.network[k] = {
                    get: function (d, cb) { var v = { value: "default" }; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); },
                    set: function (d, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); },
                    clear: function (d, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); },
                };
            });
            if (!chrome.webNavigation.getAllFrames) chrome.webNavigation.getAllFrames = function (opts, cb) { var v = []; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
        } catch (e) {}
        // 6) 给 webextension-polyfill 的 browser 对象补 webNavigation：
        //    polyfill 的 schema 天生不含 webNavigation（AdGuard 代码却引用
        //    browser.webNavigation.*），垫片执行时 polyfill 尚未构建，故延迟一拍
        //    注入 —— 晚于 polyfill 构建、早于 engine.start 的异步流程。
        setTimeout(function () {
            try {
                if (typeof browser !== "undefined" && browser && !browser.webNavigation && chrome.webNavigation) {
                    browser.webNavigation = chrome.webNavigation;
                }
            } catch (e) {}
        }, 0);
        // commands 补 API 形态（manifest 里声明的快捷键注册）
        if (chrome.commands && !chrome.commands.getAll) {
            chrome.commands.getAll = function (cb) { cb && cb([]); };
        }
        // chrome.windows 补桩：AdGuard init 链调 WindowsApi.update → chrome.windows.*，
        // Electron SW 里 chrome.windows 缺失 → TypeError → init 中断（实测
        // 设置页 React 不挂载的直接原因）。补齐 create/update/remove/getAll/getLastFocused。
        if (!chrome.windows) {
            chrome.windows = {
                create: function (opts, cb) { var w = { id: 1 }; if (typeof cb === "function") { try { cb(w); } catch (e) {} } return Promise.resolve(w); },
                update: function (id, props, cb) { var w = { id: id }; if (typeof cb === "function") { try { cb(w); } catch (e) {} } return Promise.resolve(w); },
                remove: function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); },
                getAll: function (cb) { var v = []; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); },
                getLastFocused: function (cb) { var w = { id: 1 }; if (typeof cb === "function") { try { cb(w); } catch (e) {} } return Promise.resolve(w); },
                onCreated: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } },
                onRemoved: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } },
                onFocusChanged: { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } },
            };
        }
        // 3) onInstalled 补发：Electron 不触发 runtime.onInstalled，而不少扩展
        //    把 contextMenus.create 全放它的回调里（实测 SiYuan Clip）——
        //    不补发则菜单注册永不执行。SW 每次唤醒补发一次正符合
        //    "重启需重新注册内存态菜单"的生命周期语义。
        try {
            if (chrome.runtime && chrome.runtime.onInstalled && !chrome.runtime.onInstalled.__obWrapped) {
                var oiFns = [];
                var wrapped = {
                    addListener: function (fn) { if (typeof fn === "function") oiFns.push(fn); },
                    removeListener: function (fn) { var i = oiFns.indexOf(fn); if (i >= 0) oiFns.splice(i, 1); },
                };
                Object.defineProperty(chrome.runtime, "onInstalled", {
                    configurable: true,
                    get: function () { return wrapped; },
                });
                wrapped.__obWrapped = true;
                // Chromium 原生触发在 Electron 下不存在；延迟让扩展先完成顶层注册
                setTimeout(function () {
                    oiFns.forEach(function (fn) { try { fn({ reason: "install" }); } catch (e) {} });
                }, 200);
            }
        } catch (e) {}
        // 2) contextMenus 特化：记录注册项，点击经 storage 通道由宿主触发
        if (!chrome.contextMenus.__obStore) {
            var store = { items: {}, click: eventHub() };
            chrome.contextMenus.removeAll = function (cb) { store.items = {}; if (cb) cb(); };
            chrome.contextMenus.create = function (props) { if (props && props.id) store.items[props.id] = props; };
            chrome.contextMenus.onClicked = store.click;
            chrome.contextMenus.__obStore = store;
            self.__obContextMenuStore = store;
            // 宿主点击菜单 → 写 storage → 这里触发 onClicked
            if (chrome.storage && chrome.storage.onChanged) {
                chrome.storage.onChanged.addListener(function (changes, area) {
                    try {
                        if (area !== "local" || !changes.__obMenuClick) return;
                        var p = changes.__obMenuClick.newValue;
                        store.click.__emit(p.info, p.tab);
                    } catch (e) {}
                });
            }
        }
        // 3) runtime.onMessage 路由（CS→SW 方向的通用替代）：
        //    Electron 没实现 SW↔CS 消息路由（SW 的 tabs.sendMessage 恒报
        //    "Receiving end does not exist"，CS 的 runtime.sendMessage 同理静默丢失）。
        //    这里包装 onMessage.addListener 收集扩展注册的 handlers，
        //    配合 storage 通道（__obRouteIn 请求 / __obRouteResp_<id> 响应）
        //    用官方 chrome.storage 实现两端路由 —— storage 在 CS 和 SW 里
        //    都是真实可用的（实测）。CS 侧的发送端 shim 由 sw-bridge 经 CDP
        //    注入到扩展的 isolated world。
        try {
            if (chrome.runtime && chrome.runtime.onMessage && !chrome.runtime.onMessage.__obWrapped) {
                var omFns = [];
                var omWrapped = {
                    addListener: function (fn) { if (typeof fn === "function") omFns.push(fn); },
                    removeListener: function (fn) { var i = omFns.indexOf(fn); if (i >= 0) omFns.splice(i, 1); },
                };
                Object.defineProperty(chrome.runtime, "onMessage", {
                    configurable: true,
                    get: function () { return omWrapped; },
                });
                omWrapped.__obWrapped = true;
                self.__obOnMessageHandlers = omFns;
                if (chrome.storage && chrome.storage.onChanged) {
                    chrome.storage.onChanged.addListener(function (changes, area) {
                        try {
                            if (area !== "local" || !changes.__obRouteIn || !changes.__obRouteIn.newValue) return;
                            var env = changes.__obRouteIn.newValue;
                            if (!env || typeof env.reqId === "undefined") return;
                            var responded = false;
                            var sendResponse = function (resp) {
                                if (responded) return;
                                responded = true;
                                var key = "__obRouteResp_" + env.reqId;
                                var item = {};
                                item[key] = { resp: resp === undefined ? null : resp };
                                try { chrome.storage.local.set(item); } catch (e) {}
                            };
                            var anySync = false;
                            omFns.forEach(function (fn) {
                                try {
                                    var r = fn(self.__obNormalizeMsg ? self.__obNormalizeMsg(env.msg) : env.msg, env.sender || { id: "sy-host" }, sendResponse);
                                    if (r === true) {
                                        // handler 返回 true 表示异步 sendResponse，等待其回调
                                    } else if (r !== undefined && r !== false) {
                                        // r===false 是 Chrome 语义的"我不回包"，不作为回包值
                                        //（与 cs-runtime routeSendMessage 的同语义修正一致）
                                        anySync = true;
                                        sendResponse(r);
                                    }
                                } catch (e) {}
                            });
                            if (!anySync && omFns.length === 0) sendResponse(undefined);
                        } catch (e) {}
                    });
                }
            }
        } catch (e) {}
        // 3b) storage.managed 补桩：Electron 无 managed storage（企业策略存储）。
        //     TM 启动探测它，原生缺失抛 "managed is not available" → 重试 4 轮
        //     （每轮带延时）拖慢 SW 启动。补空桩（get 恒空对象）→ TM 立即走
        //     storage.local 分支。sync 保持原生（Electron 原生 sync 实测可用）。
        try {
            if (chrome.storage && !chrome.storage.managed) {
                chrome.storage.managed = {
                    get: function (keys, cb) {
                        var empty = {};
                        if (typeof cb === "function") { try { cb(empty); } catch (e) {} }
                        return Promise.resolve(empty);
                    },
                };
            }
        } catch (e) {}
        // 4) runtime.onConnect 端口语义（AdGuard 等经 port 与 SW 通信取状态）：
        //    Electron 没实现扩展间 port 路由。这里收集 onConnect listeners；
        //    宿主（cs-runtime routePortMessage）经 CDP 建连时构造 port 对象派发，
        //    port.postMessage 写入 outbox、由宿主轮询带回页面世界。
        try {
            if (chrome.runtime && chrome.runtime.onConnect && !chrome.runtime.onConnect.__obWrapped) {
                var ocFns = [];
                var ocWrapped = {
                    addListener: function (fn) { if (typeof fn === "function") ocFns.push(fn); },
                    removeListener: function (fn) { var i = ocFns.indexOf(fn); if (i >= 0) ocFns.splice(i, 1); },
                };
                Object.defineProperty(chrome.runtime, "onConnect", {
                    configurable: true,
                    get: function () { return ocWrapped; },
                });
                ocWrapped.__obWrapped = true;
                self.__obOnConnectFns = ocFns;
                self.__obPorts = self.__obPorts || {};
                self.__obPortOutbox = self.__obPortOutbox || {};
            }
        } catch (e) {}
        // 5-pre) tabs.query 过滤语义补全（独立节：不受 5 的 __obTabWrapped 守卫
        //    影响，旧垫片文件换版堆叠时也能生效）。Electron 原生 query 不认
        //    active/lastFocusedWindow 过滤（实测 {active,lastFocusedWindow} 恒 []），
        //    TM 的 popup 会话靠它解析"面板所属活动页签"——查空则 loadTree 无
        //    tab 上下文（面板显示 no access、脚本状态全丢）。宿主经 tabevent 喂
        //    的 tab 存 __obLastFedTab，作为活动页签并入结果，再做简化过滤。
        try {
            if (chrome.tabs && !chrome.tabs.__obQueryPatched) {
                self.__obLastFedTab = self.__obLastFedTab || null;
                var origTabsQuery = typeof chrome.tabs.query === "function" ? chrome.tabs.query.bind(chrome.tabs) : null;
                var syUrlMatch = function (pattern, url) {
                    try {
                        var m = /^(\\*|https?|file|ftp|urn):\\/\\/(\\*(?:\\.[^\\/ *]+)?|\\*|[^\\/ *]+)(\\/.*)$/.exec(pattern);
                        if (!m) return false;
                        if (!/^https?:\\/\\//i.test(url || "")) return false;
                        var u = new URL(url);
                        var scheme = u.protocol.replace(":", "");
                        if (m[1] !== "*" && m[1] !== scheme) return false;
                        var host = u.host, hostOk = m[2] === "*" || (m[2].indexOf("*.") === 0 ? host === m[2].slice(2) || host.indexOf("." + m[2].slice(2), host.length - ("." + m[2].slice(2)).length) >= 0 : host === m[2] || host === m[2].split(":")[0]);
                        if (!hostOk) return false;
                        var rx = new RegExp("^" + m[3].replace(/[.+?^{}()|[\]\\\\$]/g, "\\\\$&").replace(/\\*/g, ".*") + "$");
                        return rx.test((u.pathname || "/") + (u.search || ""));
                    } catch (e) { return false; }
                };
                chrome.tabs.query = function (props, cb) {
                    // deferred 模式：原生可能是回调式（返回 undefined）也可能是 promise
                    // 式 —— 两种都接住，promise 式调用方（await chrome.tabs.query）拿
                    // 到的恒是数组。done 守卫防回调+promise 双触发。
                    var done = false, resolveP = null;
                    var finish = function (nativeList) {
                        if (done) return;
                        done = true;
                        var list = (nativeList && nativeList.slice && nativeList.slice()) || [];
                        // 扩展自身页面（popup/options 真源 webview）不是"用户页签"：
                        // Electron 原生 query 会把扩展 popup webview 当 active 页签
                        // 返回且排最前（实测），TM getActiveTab 取第一个 → 面板把
                        // 扩展页当当前页 → getFailureReason 判 noninjectable →
                        // "cannot run userscripts"（首启实测根因）。一律剔除。
                        list = list.filter(function (t) { return !/^chrome-extension:\\/\\//i.test(t.url || ""); });
                        // 原生对同一 webview 可能返回重复条目（实测 baidu ×2）→ 去重
                        var seenTabs = {};
                        list = list.filter(function (t) { var k = String(t.id) + "|" + (t.url || ""); if (seenTabs[k]) return false; seenTabs[k] = 1; return true; });
                        var fed = self.__obLastFedTab;
                        if (fed && !list.some(function (t) { return String(t.id) === String(fed.id); })) list = list.concat([fed]);
                        var p = props || {};
                        if (p.active || p.highlighted) list = list.filter(function (t) { return t.active; });
                        if (p.windowId !== undefined && p.windowId !== -1 && p.windowId !== 1) list = list.filter(function (t) { return t.windowId === p.windowId; });
                        if (p.url) {
                            var pats = Array.isArray(p.url) ? p.url : [p.url];
                            list = list.filter(function (t) { return pats.some(function (pt) { return syUrlMatch(pt, t.url || ""); }); });
                        }
                        if (typeof cb === "function") { try { cb(list); } catch (e) {} }
                        if (resolveP) resolveP(list);
                        return list;
                    };
                    var pending = new Promise(function (res) { resolveP = res; });
                    if (origTabsQuery) {
                        try {
                            var qr = origTabsQuery(props || {}, function (v) { finish(v); });
                            if (qr && typeof qr.then === "function") {
                                return qr.then(function (v) { return finish(v); }, function () { return finish([]); });
                            }
                            // 原生纯回调式：回调已挂上，原生按契约必回调 → pending 必 resolve
                            return pending;
                        } catch (e) { /* 原生抛错走兜底 */ }
                    }
                    finish([]);
                    return pending;
                };
                chrome.tabs.__obQueryPatched = true;
            }
        } catch (e) {}
        // 5) chrome.tabs 事件收集（AdGuard 等靠 onCreated/onUpdated 维护 tabContext，
        //    Electron SW 里这些事件永不触发 → 扩展取 tab 状态时 getTabContext 恒
        //    undefined → popup 卡 loading）。宿主经 "tabevent" 通道手工喂 tab。
        try {
            if (chrome.tabs && !chrome.tabs.__obTabWrapped) {
                // 5a) tabs API 补桩：Electron 原生 tabs 缺 create/update/remove 等，
                //     AdGuard onInstalled 流程调 tabs.create 直接 TypeError →
                //     初始化链中断（tabsApi.start 永不执行 → popup 取状态卡 loading）。
                //     create **实装**：SW 无法直接开宿主页签，写内存出箱 __obTabCreateOutbox，
                //     宿主路由 sendmessage 完成后排空 → bp.openUrl 真实开页签
                //     （实测 TM popup「查找新脚本」走 SW newTab handler → tabs.create，
                //     旧假桩静默吞掉 → 无反应/空页签）。update 同样写出箱（VM MV3
                //     confirmInstall 走 tabs.update(tabId,{url:confirmUrl}) 替换当前
                //     页签打开安装确认页 —— 假桩静默吞 URL → confirm 页永不出现，
                //     .user.js 安装链 9s 回落报"未找到油猴扩展"）。remove 仍为桩。
                if (!chrome.tabs.create) chrome.tabs.create = function (props, cb) { var u = (props && props.url) || ""; try { if (u) { self.__obTabCreateOutbox = self.__obTabCreateOutbox || []; self.__obTabCreateOutbox.push({ url: String(u), active: !props || props.active !== false }); } } catch (e) {} var t = { id: 1, index: 0, windowId: 1, active: true, url: u }; if (typeof cb === "function") { try { cb(t); } catch (e) {} } return Promise.resolve(t); };
                // ★ update 包装（v22，原生存在也要包）：VM MV3 confirmInstall 走
                //     tabs.update(tabId,{url:confirmUrl}) 替换当前页签打开安装确认页
                //     —— 原生 update 是无宿主页签模型的静默 no-op（"No such tab"），
                //     confirm 页 URL 被吞 → .user.js 安装链 9s 回落报"未找到油猴扩展"。
                //     带 url 的 update 一律写 __obTabCreateOutbox（宿主排空 openUrl），
                //     再委托原生（失败/无效果也无害）。
                if (chrome.tabs && !chrome.tabs.__obUpdatePatched) {
                    var origTabsUpdate = typeof chrome.tabs.update === "function" ? chrome.tabs.update.bind(chrome.tabs) : null;
                    chrome.tabs.update = function (id, props, cb) {
                        var u = (props && props.url) || "";
                        try { if (u) { self.__obTabCreateOutbox = self.__obTabCreateOutbox || []; self.__obTabCreateOutbox.push({ url: String(u), active: !props || props.active !== false }); } } catch (e) {}
                        // ★ 必须恒返回 Promise：Electron 原生 update 可能返回 undefined，
                        //     VM 的 .catch(noop) 链会炸（实测 "reading 'catch' of undefined"）
                        var out = null;
                        if (origTabsUpdate) { try { out = origTabsUpdate(id, props, cb); } catch (e) { out = null; } }
                        if (!out || typeof out.then !== "function") {
                            var t = { id: typeof id === "number" ? id : 1, url: u };
                            if (typeof cb === "function") { try { cb(t); } catch (e2) {} }
                            out = Promise.resolve(t);
                        }
                        return out;
                    };
                    chrome.tabs.__obUpdatePatched = true;
                }
                if (!chrome.tabs.remove) chrome.tabs.remove = function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); };
                // ★ windows 补桩（v22）：原生 windows 对象存在但缺 getCurrent 等
                //     （"有对象无方法"，同 0f 的镜像问题）—— VM 的 qt 用
                //     windows.getCurrent 解析窗口上下文，缺方法直接 TypeError。
                if (chrome.windows && !chrome.windows.__obWinPatched) {
                    var syWinStub = function () { return { id: 1, index: 0, focused: true, type: "normal", state: "normal", incognito: false, alwaysOnTop: false, width: 1200, height: 800, left: 0, top: 0, tabs: [{ id: 1, url: "" }] }; };
                    var syWinMethod = function (w) { return function (q, cb) { var win = w(); if (typeof q === "function") { try { q(win); } catch (e) {} return; } if (typeof cb === "function") { try { cb(win); } catch (e) {} } return Promise.resolve(win); }; };
                    if (typeof chrome.windows.getCurrent !== "function") chrome.windows.getCurrent = syWinMethod(syWinStub);
                    if (typeof chrome.windows.getLastFocused !== "function") chrome.windows.getLastFocused = syWinMethod(syWinStub);
                    if (typeof chrome.windows.get !== "function") chrome.windows.get = syWinMethod(syWinStub);
                    if (typeof chrome.windows.getAll !== "function") chrome.windows.getAll = function (q, cb) { var win = syWinStub(); if (typeof q === "function") { try { q([win]); } catch (e) {} return; } if (typeof cb === "function") { try { cb([win]); } catch (e) {} } return Promise.resolve([win]); };
                    if (typeof chrome.windows.update !== "function") chrome.windows.update = function (id, props, cb) { var win = syWinStub(); if (typeof cb === "function") { try { cb(win); } catch (e) {} } return Promise.resolve(win); };
                    chrome.windows.__obWinPatched = true;
                }
                // ★ get 包装（v22，原生存在也要包）：VM maybeInstallUserJs 的
                //     getTab(tabId) 在合成 tabId（出箱/派发用 id=1）上原生恒 reject
                //     "No such tab" → await 抛 → confirmInstall 永不执行。失败兜底
                //     返回最小假 tab，语义对齐"页签存在但无导航信息"。
                if (chrome.tabs && !chrome.tabs.__obGetPatched) {
                    var origTabsGet = typeof chrome.tabs.get === "function" ? chrome.tabs.get.bind(chrome.tabs) : null;
                    chrome.tabs.get = function (id, cb) {
                        var fake = { id: typeof id === "number" ? id : 1, index: 0, windowId: 1, active: false, pinned: false, incognito: false, url: "", title: "" };
                        var p = origTabsGet
                            ? Promise.resolve().then(function () { return origTabsGet(id); }).catch(function () { return fake; })
                            : Promise.resolve(fake);
                        if (typeof cb === "function") {
                            p.then(function (t) { try { cb(t); } catch (e) {} }, function () { try { cb(fake); } catch (e) {} });
                            return;
                        }
                        return p;
                    };
                    chrome.tabs.__obGetPatched = true;
                }
                if (!chrome.tabs.reload) chrome.tabs.reload = function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); };
                if (chrome.tabs.TAB_ID_NONE === undefined) chrome.tabs.TAB_ID_NONE = -1;
                // 5b-2) declarativeNetRequest 虚拟存储：AdGuard 引擎启动会把十几万条
                //     规则经 updateDynamicRules/updateSessionRules 写入 Electron 原生
                //     DNR —— 实测大规则集写入挂起，Engine.start 永不返回，其后的消息
                //     handler 注册全部不执行（设置页/弹窗数据全 undefined）。宿主的
                //     dnrEngine 已独立执行真实拦截，这里把写入/读出改为**内存虚拟
                //     存储**（写入即时成功且可回读——tswebextension 应用规则后会
                //     校验回读，空回读会死循环重试），init 顺利越过；规则不触达
                //     原生 DNR（真实拦截由宿主 dnrEngine 负责）。
                if (chrome.declarativeNetRequest) {
                    self.__obDnrStore = { dynamic: [], session: [] };
                    const syDnrApply = function (store, p) {
                        p = p || {};
                        var remove = p.removeRuleIds || [];
                        var add = p.addRules || [];
                        for (var i = 0; i < remove.length; i++) {
                            store = store.filter(function (r) { return r.id !== remove[i]; });
                        }
                        for (var j = 0; j < add.length; j++) {
                            var found = false;
                            for (var k = 0; k < store.length; k++) {
                                if (store[k].id === add[j].id) { store[k] = add[j]; found = true; break; }
                            }
                            if (!found) store.push(add[j]);
                        }
                        return store;
                    };
                    const syDnrOk = function (cb) { if (typeof cb === "function") { try { cb(); } catch (e) {} } return Promise.resolve(); };
                    chrome.declarativeNetRequest.updateDynamicRules = function (p, cb) {
                        self.__obDnrStore.dynamic = syDnrApply(self.__obDnrStore.dynamic, p);
                        return syDnrOk(cb);
                    };
                    chrome.declarativeNetRequest.updateSessionRules = function (p, cb) {
                        self.__obDnrStore.session = syDnrApply(self.__obDnrStore.session, p);
                        return syDnrOk(cb);
                    };
                    chrome.declarativeNetRequest.getDynamicRules = function (p, cb) {
                        var cb2 = typeof p === "function" ? p : cb;
                        if (typeof cb2 === "function") { try { cb2(self.__obDnrStore.dynamic); } catch (e) {} }
                        // ★ Promise 路径必须返回数组（不能 {}）：AdGuard 引擎启动链
                        //   await getDynamicRules() 后直接 .map —— 拿到 {} 抛
                        //   "existingRules.map is not a function" → TsWebExtension
                        //   innerStart 失败 → 整个 app 初始化中断（TabsApi 等全没跑）
                        //   → popup 永远卡 loader（2026-10-31 实测定案）
                        return Promise.resolve(self.__obDnrStore.dynamic);
                    };
                    chrome.declarativeNetRequest.getSessionRules = function (p, cb) {
                        var cb2 = typeof p === "function" ? p : cb;
                        if (typeof cb2 === "function") { try { cb2(self.__obDnrStore.session); } catch (e) {} }
                        return Promise.resolve(self.__obDnrStore.session);
                    };
                }
                // 5c) permissions API 补桩：AdGuard 引擎启动链调 permissions.contains
                //     （Electron 原生缺失 → "Cannot be started"）。MV3 所需权限默认放行。
                if (chrome.permissions) {
                    if (!chrome.permissions.contains) chrome.permissions.contains = function (perms, cb) { var v = true; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
                    if (!chrome.permissions.request) chrome.permissions.request = function (perms, cb) { var v = true; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
                    if (!chrome.permissions.remove) chrome.permissions.remove = function (perms, cb) { var v = true; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
                    if (!chrome.permissions.getAll) chrome.permissions.getAll = function (cb) { var v = { origins: [], permissions: [] }; if (typeof cb === "function") { try { cb(v); } catch (e) {} } return Promise.resolve(v); };
                }
                // 5b) tabs 事件收集（AdGuard 等靠 onCreated/onUpdated 维护 tabContext，
                //     Electron SW 里这些事件永不触发 → 宿主经 "tabevent" 通道手工喂 tab）
                var tcFns = [], tuFns = [], taFns = [];
                var tabEvFor = function (fns) {
                    return {
                        addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                        removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                        hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
                    };
                };
                try { Object.defineProperty(chrome.tabs, "onCreated", { configurable: true, get: function () { return tabEvFor(tcFns); } }); } catch (e) { chrome.tabs.onCreated = tabEvFor(tcFns); }
                try { Object.defineProperty(chrome.tabs, "onUpdated", { configurable: true, get: function () { return tabEvFor(tuFns); } }); } catch (e) { chrome.tabs.onUpdated = tabEvFor(tuFns); }
                try { Object.defineProperty(chrome.tabs, "onActivated", { configurable: true, get: function () { return tabEvFor(taFns); } }); } catch (e) { chrome.tabs.onActivated = tabEvFor(taFns); }
                chrome.tabs.__obTabWrapped = true;
                self.__obTabCreatedFns = tcFns;
                self.__obTabUpdatedFns = tuFns;
                self.__obTabActivatedFns = taFns;
                // 5d) tabs.sendMessage 回程路由：Electron 原生实现恒报
                //     "Receiving end does not exist"（SW↔CS 消息路由缺失）——
                //     剪藏 tip/结果回不到页面、lastError 刷屏的根因。请求写
                //     __obTabsOutbox，宿主在 routeSendMessage 后的监听窗口内
                //     轮询取走 → 派发到 content 世界 → evalInSw 写回 __obTabsPending。
                try {
                    var tsmSeq = 0;
                    var tsm = function (tabId, msg, cb, respCb) {
                        var callback = typeof cb === "function" ? cb : (typeof respCb === "function" ? respCb : null);
                        var rid = "t" + (++tsmSeq) + "_" + Date.now().toString(36);
                        self.__obTabsOutbox = self.__obTabsOutbox || [];
                        self.__obTabsOutbox.push({ id: rid, tabId: typeof tabId === "number" ? tabId : null, msg: msg === undefined ? null : msg });
                        // ★ 恒返回 Promise：VM 的 ft = tabs.sendMessage(...).catch(ht) 直接
                        //   链式调用，undefined 返回值会让 .catch 炸（实测 .user.js 安装链
                        //   在 sendTabCmd("Stop") 处 TypeError 整链死）。
                        return new Promise(function (resolve) {
                            if (callback) {
                                self.__obTabsPending = self.__obTabsPending || {};
                                self.__obTabsPending[rid] = function (respJson) {
                                    delete self.__obTabsPending[rid];
                                    var resp;
                                    try { resp = respJson == null ? undefined : JSON.parse(respJson); } catch (e3) { resp = undefined; }
                                    try { callback(resp); } catch (e3) {}
                                    resolve(resp);
                                };
                                setTimeout(function () {
                                    if (self.__obTabsPending && self.__obTabsPending[rid]) {
                                        delete self.__obTabsPending[rid];
                                        try { callback(undefined); } catch (e3) {}
                                        resolve(undefined);
                                    }
                                }, 20000);
                            } else {
                                resolve(undefined);
                            }
                        });
                    };
                    try { Object.defineProperty(chrome.tabs, "sendMessage", { configurable: true, get: function () { return tsm; } }); }
                    catch (e2) { chrome.tabs.sendMessage = tsm; }
                } catch (e) {}
            }
        } catch (e) {}
        // 5e) chrome.storage.sync 修复：Electron SW 原生 sync.get 回调 undefined
        //     （实测 SiYuan Clip storageSyncGet 拿到 undefined → 解构抛 TypeError
        //     → article 剪藏流程崩进 catch → tip_siyuan_kernel_unavailable）。
        //     与宿主 CS 代理同策略：sync 代理到 local（CS 世界经宿主代理同样落
        //     在 SW 的 storage.local，数据同源）。
        try {
            if (chrome.storage && (!chrome.storage.sync || !chrome.storage.sync.__obShim)) {
                var syncArea = {
                    __obShim: true,
                    get: function (keys, cb) {
                        var done = function (v) { if (typeof cb === "function") { try { cb(v == null ? {} : v); } catch (e3) {} } };
                        try {
                            var p = chrome.storage.local.get(keys == null ? {} : keys, done);
                            if (p && typeof p.then === "function") p.then(function (v) { done(v); }, function () { done({}); });
                            return p;
                        } catch (e2) { done({}); }
                    },
                    set: function (items, cb) { return chrome.storage.local.set(items == null ? {} : items, cb); },
                    remove: function (keys, cb) { return chrome.storage.local.remove(keys == null ? [] : keys, cb); },
                    clear: function (cb) { return chrome.storage.local.clear(cb); },
                    getBytesInUse: function (keys, cb) { var v = 0; if (typeof cb === "function") { try { cb(v); } catch (e3) {} } return Promise.resolve(v); },
                };
                try { Object.defineProperty(chrome.storage, "sync", { configurable: true, get: function () { return syncArea; } }); }
                catch (e2) { chrome.storage.sync = syncArea; }
            }
        } catch (e) {}
        // 6) chrome.userScripts 适配（Tampermonkey 等 MV3 用户脚本扩展）：
        //    Electron 原生缺 userScripts API（probe 实测），TM 5.x 探测不到即
        //    降级为"无法运行脚本"。按 Chrome 契约补一层：注册表存内存 +
        //    chrome.storage.local 持久化（SW 重启后 getScripts 仍可答），并用
        //    自增版本号标记变更 —— 宿主（userscriptInjector.ts）比对版本号，
        //    变了就全量对账注册表，把脚本代码注入页面自建世界执行；GM API 由
        //    扩展自身 bootstrap 经 chrome.runtime.sendMessage（v15 路由）与 SW
        //    通信。注意 TM 幂等：GA() 每次启动 getScripts 后可能不再重复
        //    register —— 全量对账 + 持久化 + 启动水合是唯一可靠的宿主同步通道。
        try {
            if (!chrome.userScripts) {
                var US_KEY = "__obUserScriptsReg";
                var US_VER_KEY = "__obUserScriptsRegVersion";
                var usLoad = function () {
                    return new Promise(function (resolve) {
                        try {
                            chrome.storage.local.get([US_KEY, US_VER_KEY], function (v) {
                                resolve({ reg: (v && v[US_KEY]) || {}, ver: (v && v[US_VER_KEY]) || 0 });
                            });
                        } catch (e2) { resolve({ reg: {}, ver: 0 }); }
                    });
                };
                var usSave = function (reg, ver) {
                    try {
                        var item = {};
                        item[US_KEY] = reg;
                        item[US_VER_KEY] = ver;
                        chrome.storage.local.set(item);
                    } catch (e2) {}
                };
                var usClone = function (x) { try { return JSON.parse(JSON.stringify(x)); } catch (e2) { return x; } };
                var usCommit = function (reg, ver) {
                    self.__obUserScriptsReg = reg;
                    self.__obUserScriptsVersion = ver;
                    usSave(reg, ver);
                };
                // SW 启动即异步水合内存注册表与版本号（宿主 drain 直接读内存，
                // 不依赖扩展先调用过一次 API；TM 幂等跳过 register 时也拿得到）
                self.__obUserScriptsReg = self.__obUserScriptsReg || {};
                self.__obUserScriptsVersion = self.__obUserScriptsVersion || 0;
                usLoad().then(function (loaded) {
                    self.__obUserScriptsReg = loaded.reg;
                    self.__obUserScriptsVersion = loaded.ver;
                });
                chrome.userScripts = {
                    ExecutionWorld: { MAIN: "MAIN", USER_SCRIPT: "USER_SCRIPT" },
                    register: function (scripts, cb) {
                        return usLoad().then(function (loaded) {
                            var reg = loaded.reg;
                            scripts = Array.isArray(scripts) ? scripts : [scripts];
                            for (var i = 0; i < scripts.length; i++) {
                                var s = scripts[i];
                                if (!s || !s.id) continue;
                                reg[s.id] = usClone(s);
                            }
                            usCommit(reg, loaded.ver + 1);
                            if (typeof cb === "function") { try { cb(); } catch (e3) {} }
                        });
                    },
                    getScripts: function (filter, cb) {
                        var cb2 = typeof filter === "function" ? filter : cb;
                        return usLoad().then(function (loaded) {
                            var reg = loaded.reg;
                            var ids = (filter && typeof filter === "object" && filter.ids) || null;
                            var list = [];
                            for (var k in reg) { if (!ids || ids.indexOf(k) >= 0) list.push(reg[k]); }
                            if (typeof cb2 === "function") { try { cb2(list); } catch (e3) {} }
                            return list;
                        });
                    },
                    unregister: function (filter, cb) {
                        return usLoad().then(function (loaded) {
                            var reg = loaded.reg;
                            var ids = (filter && filter.ids) || null;
                            for (var k in reg) { if (!ids || ids.indexOf(k) >= 0) delete reg[k]; }
                            usCommit(reg, loaded.ver + 1);
                            if (typeof cb === "function") { try { cb(); } catch (e3) {} }
                        });
                    },
                    update: function (ids, props, cb) {
                        return usLoad().then(function (loaded) {
                            var reg = loaded.reg;
                            ids = Array.isArray(ids) ? ids : [ids];
                            props = Array.isArray(props) ? props : ids.map(function () { return props; });
                            for (var i = 0; i < ids.length; i++) {
                                if (reg[ids[i]] && props[i]) {
                                    var merged = usClone(reg[ids[i]]);
                                    for (var k2 in props[i]) merged[k2] = props[i][k2];
                                    reg[ids[i]] = merged;
                                }
                            }
                            usCommit(reg, loaded.ver + 1);
                            if (typeof cb === "function") { try { cb(); } catch (e3) {} }
                        });
                    },
                    reset: function (cb) {
                        return usLoad().then(function (loaded) {
                            usCommit({}, loaded.ver + 1);
                            if (typeof cb === "function") { try { cb(); } catch (e3) {} }
                        });
                    },
                    configureWorld: function (props, cb) {
                        // messaging/csp：自建世界恒有消息桥，无需配置
                        if (typeof cb === "function") { try { cb(); } catch (e3) {} }
                        return Promise.resolve();
                    },
                    // execute（v23 增）：MV3 用户脚本代码的 SW→页面 下发通道。
                    // Violentmonkey 注入链的关键路径：页面引导在隔离世界拿不到页面
                    // realm（GetInjected 回包 page:false → 引导发 InjectionFeedback
                    // 带 forceContent:true）→ SW 侧 triageRealms 把脚本判为 content
                    // realm → 真实脚本代码经 injectContentRealm → userScripts.execute
                    // 下发。缺此方法时代码静默丢失（setTimeout fire-and-forget 吞错），
                    // 页面只收到 code:"" 的空壳 → Run{ids:[]} 永远无脚本执行。
                    // SW 无法直接 eval 页面 —— 代码落 __obUsExecOutbox，宿主
                    // cs-runtime 的 SW 回包泵（600ms 轮询）取走后在扩展自建世界执行
                    // （= Chrome USER_SCRIPT 世界语义：与引导同世界，共享 VM bridge
                    // 全局）。回包 [{result:null}]：VM 只用结果通知 UNWRAP/报错，
                    // 代码执行本身 fire-and-forget。
                    execute: function (details) {
                        try {
                            var jsCode = "";
                            if (details && details.js) {
                                for (var i = 0; i < details.js.length; i++) {
                                    jsCode += (details.js[i] && details.js[i].code) || "";
                                }
                            }
                            // 可注入性探针短路（VM isInjectable 发 code:'true' 并要求
                            // [0].result===true）：宿主对每个 http(s) 页无条件建 VM
                            // 内容世界，探针恒可执行 —— 直接断言成功。恒回 null 会让
                            // initPopup 判 noninjectable → 面板 "cannot run userscripts"
                            // + 空列表（首启实测必然复现，非时序问题）。
                            if (jsCode === "true") {
                                return Promise.resolve([{ result: true }]);
                            }
                            if (jsCode) {
                                self.__obUsExecOutbox = self.__obUsExecOutbox || [];
                                self.__obUsExecOutbox.push({
                                    code: jsCode,
                                    injectImmediately: !!(details && details.injectImmediately),
                                    tabId: details && details.target ? details.target.tabId : undefined,
                                    frameIds: details && details.target && details.target.frameIds || null,
                                });
                            }
                        } catch (e2) {}
                        return Promise.resolve([{ result: null }]);
                    },
                };
            }
        } catch (e) {}
        // 7) notifications / downloads 最小动作桩（v15 只补了事件壳，TM 的
        //    GM_notification / GM_download 走这两个 API，缺 create/download 直接抛）
        try {
            if (chrome.notifications && !chrome.notifications.create) {
                chrome.notifications.create = function (id, opts, cb) {
                    if (typeof id === "object") { opts = id; id = "n" + Date.now(); }
                    console.log("[sy-shim] notifications.create:", (opts && opts.title) || id);
                    if (typeof cb === "function") { try { cb(id); } catch (e3) {} }
                    return id;
                };
                chrome.notifications.clear = function (id, cb) { if (typeof cb === "function") { try { cb(true); } catch (e3) {} } return Promise.resolve(true); };
                chrome.notifications.update = function (id, opts, cb) { if (typeof cb === "function") { try { cb(true); } catch (e3) {} } return Promise.resolve(true); };
            }
            if (chrome.downloads && !chrome.downloads.download) {
                chrome.downloads.download = function (opts, cb) {
                    console.warn("[sy-shim] chrome.downloads.download 未实现（改用页内下载）:", opts && opts.url);
                    if (typeof cb === "function") { try { cb(undefined); } catch (e3) {} }
                    return Promise.resolve(undefined);
                };
            }
        } catch (e) {}
        // 9) webRequest 真实事件面 + 阻塞桥（2026-10-31"阻塞桥"定案）：扩展的
        //    webRequest 监听器由宿主代理——垫片在 addListener 时**连同 filter
        //    （urls/types）一起登记**并暴露快照；宿主（BrowserTab registerWebRequest）
        //    对每个请求先按 filter 预筛，命中才经 evalInSw 合成派发，收集扩展
        //    返回的 {cancel/redirectUrl} 并执行。TM 的 .user.js 安装拦截（阻塞 +
        //    ask.html?aid 重定向）由此原生走通（真 ask.html 确认页）。派发量被
        //    filter 预筛压到趋近于零，不拖累页面加载。
        try {
            if (chrome.webRequest && !chrome.webRequest.__obReal) {
                var wrFns = self.__obWebRequestFns = self.__obWebRequestFns || {};
                var wrFilters = self.__obWebRequestFilters = self.__obWebRequestFilters || {};
                var wrEv = function (name) {
                    var entries = wrFns[name] = wrFns[name] || [];
                    var filters = wrFilters[name] = wrFilters[name] || [];
                    return {
                        addListener: function (fn, filter) {
                            if (typeof fn !== "function") return;
                            entries.push(fn);
                            filters.push(filter && typeof filter === "object"
                                ? { urls: Array.isArray(filter.urls) ? filter.urls.map(String) : null, types: Array.isArray(filter.types) ? filter.types.map(String) : null }
                                : null);
                        },
                        removeListener: function (fn) {
                            var i = entries.indexOf(fn);
                            if (i >= 0) { entries.splice(i, 1); filters.splice(i, 1); }
                        },
                        hasListener: function (fn) { return entries.indexOf(fn) >= 0; },
                    };
                };
                chrome.webRequest = {
                    __obReal: true,
                    onBeforeRequest: wrEv("onBeforeRequest"),
                    onBeforeSendHeaders: wrEv("onBeforeSendHeaders"),
                    onSendHeaders: wrEv("onSendHeaders"),
                    onHeadersReceived: wrEv("onHeadersReceived"),
                    onAuthRequired: wrEv("onAuthRequired"),
                    onBeforeRedirect: wrEv("onBeforeRedirect"),
                    onResponseStarted: wrEv("onResponseStarted"),
                    onCompleted: wrEv("onCompleted"),
                    onErrorOccurred: wrEv("onErrorOccurred"),
                    MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20,
                    OnBeforeSendHeadersOptions: { EXTRA_HEADERS: ["extraHeaders"] },
                    OnHeadersReceivedOptions: { EXTRA_HEADERS: ["extraHeaders"] },
                    OnAuthRequiredOptions: { EXTRA_HEADERS: ["extraHeaders"] },
                    handlerBehaviorChanged: function (cb) { if (typeof cb === "function") { try { cb(); } catch (eWr) {} } return Promise.resolve(); },
                };
            }
        } catch (e) {}
        // 10) downloads 真实事件面：TM MV3 的 .user.js 安装入口是
        //     downloads.onCreated（真 Chrome 把 .user.js 当下载，TM 观察后自己
        //     fetch URL、登记待装、tabs.create 开 ask.html）。宿主拦 .user.js
        //     导航后经 evalInSw 调 __obEmitDownload 合成下载事件 → TM 原生安装
        //     流（含 ask.html?aid 确认页）完整走通。search 按宿主合成条目作答。
        try {
            if (chrome.downloads && !chrome.downloads.__obReal) {
                var dlFns = self.__obDownloadFns = self.__obDownloadFns || {};
                var dlEv = function (name) {
                    var fns = dlFns[name] = dlFns[name] || [];
                    return {
                        addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                        removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                        hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
                    };
                };
                var dlItems = self.__obDownloadItems = self.__obDownloadItems || {};
                chrome.downloads.__obReal = true;
                chrome.downloads.onCreated = dlEv("onCreated");
                chrome.downloads.onChanged = dlEv("onChanged");
                chrome.downloads.onErased = dlEv("onErased");
                chrome.downloads.search = function (q, cb) {
                    var items = [];
                    try {
                        for (var k in dlItems) {
                            var it = dlItems[k];
                            if (!q || (!q.id && !q.url) || (q.id && String(it.id) === String(q.id)) || (q.url && String(it.url).indexOf(String(q.url)) >= 0)) items.push(it);
                        }
                    } catch (eDl1) {}
                    if (typeof cb === "function") { try { cb(items); } catch (eDl2) {} }
                    return Promise.resolve(items);
                };
                chrome.downloads.cancel = function (id, cb) { if (typeof cb === "function") { try { cb(true); } catch (eDl3) {} } return Promise.resolve(true); };
                chrome.downloads.erase = function (q, cb) { if (typeof cb === "function") { try { cb([]); } catch (eDl4) {} } return Promise.resolve([]); };
                chrome.downloads.pause = function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (eDl5) {} } return Promise.resolve(); };
                chrome.downloads.resume = function (id, cb) { if (typeof cb === "function") { try { cb(); } catch (eDl6) {} } return Promise.resolve(); };
                // 宿主入口：合成一条下载（触发 onCreated 监听器）
                self.__obEmitDownload = function (url) {
                    var did = "sy-dl-" + Date.now();
                    var item = { id: did, url: String(url), filename: decodeURIComponent((String(url).split("?")[0].split("/").pop() || "file")), state: "in_progress", bytesReceived: 0, totalBytes: 0, mime: "text/plain" };
                    dlItems[did] = item;
                    var fns2 = dlFns.onCreated || [];
                    for (var j = 0; j < fns2.length; j++) { try { fns2[j](item); } catch (eDl7) {} }
                    // ★ 立即补 onChanged → complete：TM 的安装处理在下载完成后才开始
                    //   （真 Chrome 下载瞬间完成），合成条目停在 in_progress 会让其
                    //   handler 永远等待（实测 ask.html 永不开）。合成下载没有真实
                    //   传输过程，直接落到 complete。
                    item.state = "complete";
                    item.bytesReceived = 1;
                    item.totalBytes = 1;
                    var fns3 = dlFns.onChanged || [];
                    var delta = { id: did, state: { previous: "in_progress", current: "complete" } };
                    for (var k = 0; k < fns3.length; k++) { try { fns3[k](delta); } catch (eDl8) {} }
                    return did;
                };
            }
        } catch (e) {}
        // 11) webNavigation 真实事件面：TM 的安装检测（.user.js 导航观察）与
        //     各类 URL 感知逻辑依赖导航事件流；哑桩时代注册被静默吞掉。宿主
        //     （BrowserTab did-navigate）按 onCommitted 合成派发，监听器数组
        //     暴露到 self.__obWebNavFns 供宿主预筛。
        try {
            if (chrome.webNavigation && !chrome.webNavigation.__obReal) {
                var wnFns = self.__obWebNavFns = self.__obWebNavFns || {};
                var wnEv = function (name) {
                    var fns = wnFns[name] = wnFns[name] || [];
                    return {
                        addListener: function (fn) { if (typeof fn === "function") fns.push(fn); },
                        removeListener: function (fn) { var i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); },
                        hasListener: function (fn) { return fns.indexOf(fn) >= 0; },
                    };
                };
                chrome.webNavigation = {
                    __obReal: true,
                    onBeforeNavigate: wnEv("onBeforeNavigate"),
                    onCommitted: wnEv("onCommitted"),
                    onDOMContentLoaded: wnEv("onDOMContentLoaded"),
                    onCompleted: wnEv("onCompleted"),
                    onErrorOccurred: wnEv("onErrorOccurred"),
                    onCreatedNavigationTarget: wnEv("onCreatedNavigationTarget"),
                    onHistoryStateUpdated: wnEv("onHistoryStateUpdated"),
                    onReferenceFragmentUpdated: wnEv("onReferenceFragmentUpdated"),
                    onTabReplaced: wnEv("onTabReplaced"),
                    getAllFrames: function (opts, cb) { var v = [{ frameId: 0, url: String(location.href), parentFrameId: -1 }]; if (typeof cb === "function") { try { cb(v); } catch (eWn1) {} } return Promise.resolve(v); },
                    getFrame: function (opts, cb) { var v = { frameId: 0, url: String(location.href), parentFrameId: -1 }; if (typeof cb === "function") { try { cb(v); } catch (eWn2) {} } return Promise.resolve(v); },
                };
            }
        } catch (e) {}
    } catch (e) {}
// S) chrome.scripting 下发（AdGuard MV3 的元素隐藏 CSS 与 JS scriptlet 都
    //    从 background 经 chrome.scripting.insertCSS/executeScript 注入 ——
    //    Electron 不实现该 API，缺位 = AdGuard 过滤完全不生效）。这里把请求
    //    push 进 __obScriptingRequests，宿主泵（cs-runtime startScriptingPump）
    //    轮询取走并落到对应 webview。scriptlet func 是 AdGuard 预构建的独立
    //    函数（无模块闭包，专为序列化设计），String() 后可在页面主世界执行。
    try {
        if (!chrome.scripting) {
            var pushReq = function (payload) {
                try {
                    self.__obScriptingRequests = self.__obScriptingRequests || [];
                    self.__obScriptingRequests.push(JSON.stringify(payload));
                } catch (e2) {}
            };
            chrome.scripting = {
                insertCSS: function (opts, cb) {
                    var o = opts || {};
                    pushReq({ kind: "css", tabId: o.target && o.target.tabId, css: String(o.css == null ? "" : o.css), origin: o.origin });
                    if (typeof cb === "function") { try { cb(); } catch (e3) {} }
                    return Promise.resolve();
                },
                executeScript: function (opts, cb) {
                    var o = opts || {};
                    var payload = { kind: "js", tabId: o.target && o.target.tabId, world: o.world, injectImmediately: o.injectImmediately };
                    if (o.files) { try { payload.files = JSON.parse(JSON.stringify(o.files)); } catch (e3) {} }
                    if (o.func) { try { payload.func = String(o.func); } catch (e3) {} }
                    if (o.args) { try { payload.args = JSON.parse(JSON.stringify(o.args)); } catch (e3) {} }
                    pushReq(payload);
                    if (typeof cb === "function") { try { cb([]); } catch (e3) {} }
                    return Promise.resolve([]);
                },
                registerContentScripts: function () { return Promise.resolve(); },
                getRegisteredContentScripts: function (cb) {
                    var v = [];
                    if (typeof cb === "function") { try { cb(v); } catch (e3) {} }
                    return Promise.resolve(v);
                },
                unregisterContentScripts: function () { return Promise.resolve(); },
                updateContentScripts: function () { return Promise.resolve(); },
            };
        }
    } catch (e) {}

})();
/* ob-bg-shim-end */`;

export const SHIM_END_MARK = "/* ob-bg-shim-end */";

/** FNV-1a 内容哈希 → 头标记（内容变了哈希就变，幂等判定天然正确）。 */
export function shimMark(): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < SHIM_BODY.length; i++) {
		h ^= SHIM_BODY.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return "/* ob-bg-shim:" + SHIM_VER + ":" + (h >>> 0).toString(36) + " */";
}
