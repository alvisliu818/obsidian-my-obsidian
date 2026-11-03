declare module 'i18next' {
  interface CustomTypeOptions {
    enableSelector: true;
    defaultNS: 'translation';
    // 注意：不带 resources —— i18next 26 的 selector 类型在 TS 5.9 下
    // 一旦给出具体 resources（lib 的 CustomTypeOptionsResources<
    // DefaultTranslationsBase & typeof translationsMap.en>）整个
    // t(selector) 重载就会失配（attachment-collector 全部 TS2345），
    // 'optimize' 模式也救不回来。代价：selector 回调的 $ 推断不出键
    // 类型，源码里显式标 ($: any)。运行时行为不受影响。
  }
}
