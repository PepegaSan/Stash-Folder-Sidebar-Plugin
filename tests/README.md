# Quick Markers checks

No test connects to a running Stash or writes markers into a library.

Run the storage and range checks with Node:

```powershell
node --test tests/quickMarkers.guide.test.cjs
```

The browser checks need Playwright. Install it in your development environment,
then run:

```powershell
node --test --test-timeout=20000 tests/quickMarkers.browser.test.cjs
```

`PLAYWRIGHT_MODULE` can point to an existing Playwright package, `TEST_CHROME` to a
local Chrome executable, and `TEST_OUTPUT` to a screenshot directory. Otherwise
Playwright uses its installed Chromium.

The fixtures mock all GraphQL responses and simulate scene changes, player time,
failed mutations and delayed saves. Stash UI uses its normal DOM implementation.
Classic Stash's component runs in a small hooks/DOM adapter, so these checks do not
replace a compatibility check inside a real Stash/React host.
