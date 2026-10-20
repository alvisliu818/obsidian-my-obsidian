import esbuild from "esbuild";

const production = process.argv[2] === "production";

esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "@codemirror/state", "@codemirror/view"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  charset: "utf8",
  outfile: "main.js",
  minify: production,
}).catch(() => process.exit(1));
