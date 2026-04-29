declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.webp" {
  const src: string;
  export default src;
}
declare module "*.jpg" {
  const src: string;
  export default src;
}
declare module "*.svg" {
  const src: string;
  export default src;
}
// Side-effect CSS imports (e.g. `import "./echo.css"`). Vite handles
// the actual bundling; this declaration just satisfies TypeScript so
// the import doesn't fire ts(2882).
declare module "*.css";
