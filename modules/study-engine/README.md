# modules/study-engine

Future home of the pure-TypeScript study engine (Phase 6): study-component
derivation, deterministic question generation, distractor selection, session
state machine and attempt records. This module must never import React, DOM
APIs or database clients — it runs identically in the browser and on the
server (see `docs/ARCHITECTURE.md` §2).

No implementation exists yet by design (Phase 1 creates boundaries only).
