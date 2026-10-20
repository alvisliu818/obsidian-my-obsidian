import { json } from "@/lib/json";

// eslint-disable-next-line @typescript-eslint/naming-convention
declare const __USERSCRIPT__: string;

process.once("document-start", () => {
  console.log("preload.js");
  const scriptId = "monkey-patch-xmlhttprequest";
  const script =
    `try{` +
    __USERSCRIPT__ +
    `}finally{` +
    json`document.getElementById(${scriptId})?.remove();` +
    `}`;
  // if (!window.location.hostname.endsWith("bilibili.com")) {
  //   return;
  // }
  const scriptEl = document.createElement("script");
  scriptEl.id = scriptId;
  if (window.trustedTypes) {
    const policy = window.trustedTypes.createPolicy("preload", {
      createScript: (src) => src,
    });
    scriptEl.textContent = policy.createScript(script) as any;
  } else {
    scriptEl.textContent = script;
  }
  document.documentElement.prepend(script);
});
