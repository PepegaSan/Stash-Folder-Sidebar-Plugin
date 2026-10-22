/** Classic Stash entry: registers the editor page and a navbar button (uses Stash's own React). */
import React, { useState } from "react";
import "./styles.css";
import { classicHost } from "./host";
import { App } from "./ui/App";

// Not below /plugin/: Stash's server owns that prefix (assets, javascript, css) and answers 404 for anything
// else there, so a reload or deep link to /plugin/<id> would break. Any other path falls through to the SPA.
const ROUTE = "/pmv-creator";
const api = window.PluginApi;

function ClassicPage() {
  // the host reads the query once per visit of the page
  const [host] = useState(classicHost);
  return <App host={host} />;
}

api.register.route(ROUTE, ClassicPage);

// Performer page: "⚡ PMV: <name>" opens a new project with the generator set to this performer. (The label has no
// words: the editor's language is only known once it runs.)
api.patch.before<{ children?: React.ReactNode; performer?: { id: string; name: string } }>("PerformerDetailsPanel.DetailGroup", (props) => {
  const performer = props.performer;
  if (!performer) return [props];
  const { Link } = api.libraries.ReactRouterDOM;
  return [
    {
      ...props,
      children: (
        <>
          {props.children}
          <div className="detail-item pmv-performer-link">
            <Link to={`${ROUTE}?performer=${performer.id}`} className="btn btn-sm btn-secondary" title={`PMV Creator: ${performer.name}`}>
              ⚡ PMV: {performer.name}
            </Link>
          </div>
        </>
      ),
    },
  ];
});

api.patch.before("MainNavBar.UtilityItems", (props) => {
  const { Link } = api.libraries.ReactRouterDOM;
  return [
    {
      children: (
        <>
          {props.children}
          <Link to={ROUTE} className="nav-utility" title="PMV Creator">
            <button type="button" className="btn minimal d-flex align-items-center h-100">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="2" y="5" width="20" height="14" rx="2" />
                <path d="M7 15V9M11 15v-4M15 15V8M19 15v-2" />
              </svg>
            </button>
          </Link>
        </>
      ),
    },
  ];
});
