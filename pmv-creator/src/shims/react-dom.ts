// esbuild aliases "react-dom" to this file in the classic bundle: portals must come from the
// ReactDOM that renders Stash's tree (a bundled copy reads the internals of the wrong React).
const ReactDOM = window.PluginApi.ReactDOM;

export default ReactDOM;
export const { createPortal } = ReactDOM;
