// esbuild aliases "react" to this file: plugins must share Stash's React instance.
const React = window.PluginApi.React;

export default React;
export const {
  Fragment,
  createContext,
  createElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} = React;
