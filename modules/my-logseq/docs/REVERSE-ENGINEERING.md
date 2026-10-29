# 逆向工程手册（Obsidian 内部 API 与第三方插件）

> 2026-10-04 会话沉淀。当天战果：宿主 Obsidian 原生 Properties 编辑器组件、
> 逆向确认原生 source mode 的视图状态语义、为 TraceTime 插件做大纲粒度 fork +
> 块编辑器标签集成。方法为主，事实为例。

## 1. 工具链：asar 切片用 node，不要硬刚 grep

- `grep -ao "pattern.{0,700}"` 在本机是 ugrep：复杂度超限直接报错，且 UTF-8
  多字节字符会让字节偏移错位。**只在找"特征串是否存在/出现几次"时用 grep**。
- 主力手法（node 读 asar，latin1 即可）：

  ```js
  const s = fs.readFileSync('D:/programs/Obsidian/resources/obsidian.asar', 'latin1');
  const i = s.indexOf('特征串');            // 定位
  s.slice(i - 2500, i + 1200)               // 宽上下文切片
  // 枚举全部出现点：
  let i = -1; while ((i = s.indexOf(pat, i + 1)) >= 0) hits.push(i);
  // 列出一个类的全部方法：
  [...rest.matchAll(/t\.prototype\.([A-Za-z_$][\w$]*)=function/g)]
  ```

- 切片落盘成文件再 Read/fold，不要指望一次 console 输出读完。
- **特征串选择**：类名是压缩名（tO/jm/nO/W6），不猜名字，找 DOM class 字符串
  （"metadata-container"）、命令 id、i18n 文案、接口方法名（saveFrontmatter）、
  被调用的宿主方法（this.owner.X）。

## 2. 宿主内部组件：owner-shim 模式

要在一个自有视图里挂 Obsidian 内部组件（如原生 Properties 编辑器 `.metadata-container`）：

1. **构造签名**：读构造函数体（`i.app = t, i.owner = n` → `new Ctor(app, owner)`）。
2. **宿主接口**：grep 组件类里所有 `this.owner.X` 的引用 → 得出 owner 必须实现的
   方法集（Properties 编辑器：`getFile / saveFrontmatter(record) /
   shiftFocusBefore / shiftFocusAfter / onMarkdownFold / getHoverSource`）。
3. **数据契约**：读原生宿主的同名实现（MarkdownView.saveFrontmatter =
   kI(text, record) 外科手术式替换 frontmatter 区；save 全量 record）。
4. **生命周期**：内部类继承 Component 基类（`_loaded/_events/_children`）——
   手动挂载调 `load()`（带防重入），不要直接 `onload()`；卸载 `unload()`。
5. **类的获取**：未导出的类从活实例拿（`view.metadataEditor.constructor`）；
   没有活实例时（接管模式下没有原生视图）用一个临时 leaf 闪现原生视图再
   detach，构造函数缓存复用。
6. **读写路径**：组件的 `synchronize(record)` 按行渲染且按 key 复用行对象
   （聚焦行不被冲掉）；保存统一走 `owner.saveFrontmatter(serialize())` 全量
   record——宿主 shim 里把 record 回写成页面自己的格式即可。
7. **别忘了真实调用点**：`new tO(` 有 3 处（两个 MarkdownView 构造 + 一个
   Modal），每处都示范了真实的接线方式（addChild、appendChild(containerEl)）。

## 3. 视图状态语义：找"应用自己怎么设置"

不要猜 ViewState 字段语义。例：`mode:'source'|'preview'` 只区分编辑/阅读，
live preview 与 raw source 由 `state.source` 布尔区分——确认来自核心设置切换
代码 `o.state.source = "live-preview" !== t; leaf.setViewState(o)`。搜
`state.mode=` / `state.source=` 的原生赋值点即可。

## 4. 第三方插件集成

- **有源码就读源码**（用户 clone 了 TraceTime）：语法、持久化格式、清理生命周期
  一目了然，比 asar 猜测快一个数量级。没有源码时上述 asar 手法同样适用。
- **找公开数据面**：`tracker.getState(path).index.blocks` 是公开数组（文档序、
  from/to/modifiedAt）——消费它的状态，别重实现它的解析器；但要读懂解析器语法
  才能做块匹配（normalize 规则：折叠空白、去空行——缩进被抹平意味着任意深度
  可匹配）。
- **生命周期陷阱**：retainOnly 只统计原生 MarkdownView 的路径 → 未在原生视图
  打开的文件被逐出；需要 ensureFile + 有界重试。
- **数据模型是限制时改 fork**：上游把无空行的连续列表行合并成一个块（一个时间
  戳）→ fork 的 parseBlocks 按行分块（大纲粒度），expandEditWindow 同步在列表
  行处停边（否则每次按键重解析全文件）；旧记录按 hash 尽量回迁。
- **它的扩展可能也运行在我们的编辑器里**（workspace.editorExtensions +
  editorInfoField 解析出文件）——用 editCounter/applyEdit 副作用验证；小文档
  事务喂给整文件索引有损坏风险，必要时在挂载层过滤。

## 5. 逆向结论必须闭环验证

每个从逆向得出的假设都在真实 Obsidian 上用 CDP probe 验证（部署 → spawn →
connectOverCDP → 断言）。今天的例子：Properties 组件挂载、原生 source mode
切换语义、TraceTime 标签逐项时间戳（mtime 回拨 2h 制造可区分信号）。

**页面侧插桩定位疑难**：给插件方法包计数器（ensureFile/openFile 调用序）、
每秒轮询内部状态（states.size/labels 数）、捕获 console.error + pageerror；
"手动调用成功 / 渲染路径不触发"这类对照能直接定位断点（本次 = 渲染递归）。

## 6. 本日踩坑清单（反例教训）

- **渲染递归**：render walk → 每行查找 → 状态缺失 → 再触发 walk → 无限递归
  栈溢出，表现为"功能永远不生效"。修法：定时器分隔的有界重试 + pending 标志，
  查找函数里绝不同步重入 walk。
- **可变状态对象的缓存失效**：reconcile 原地变更同一 state 对象，按对象身份
  缓存必然过期——用内容指纹（text.length + 块数 + ΣmodifiedAt）。
- **probe 选择器**：`.first()` 会命中行里的键名输入框（改了键而不是值！）；值
  控件可能是 input/textarea/[contenteditable] 三种形态；点击监听在
  `.block-content-static` holder 上而非 `.block-content`；合成点击必须带真实
  clientX/Y；需要可区分时间戳时用 utimesSync 在启动前回拨 mtime。
- **"不生效"先查消费端**：功能无效未必是坏的，可能是半实现（pageSourceMode
  标志只有编辑路径消费、静态渲染从未读它）——`grep -rn` 列出全部消费点再下结论。
- **能用原生机制就不要重造**：Page source mode 最终改成直接切原生 source mode
  （一行 setViewState），替换掉了整套装管 + 渲染分支的自定义实现。
