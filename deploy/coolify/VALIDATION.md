# Local preparation checks —22 October2026, Europe/Berlin

Base production source: `9a73bc6fcf5466062736b68b49beab76384e6998`. The reviewed additions cover Coolify migration configuration, public branding/ERP navigation and observation, and scheduled private evidence drafts. No database schema, existing approved content, production data, package lock or credential changed.

- Backend: TypeScript build and all20 Jest suites/148tests passed after the final collector changes. Coverage includes repeat collection, a lost committed response, unresolved-outcome fencing across newer observations, definite SQL rejection, persistent private receipts, explicit delegation and unchanged review/publication restrictions. The existing rate-limit cleanup timer remains an open handle reported by the baseline npm script, which uses `--forceExit`.
- Frontend: explicit typecheck and all four UI/observation contracts passed (`test:changelog-ui`, `test:access-ui`, `test:public-brand-ui`, `test:erp-status`). The branding owner also verified the production Next15.5.27 build using synthetic public bindings and no production connection.
- Operator helpers:20 Python tests passed with `TMPDIR=/private/tmp`. macOS's default `/var`→`/private/var` alias causes one existing path-validation fixture failure without that canonical temporary path; no guard or helper source was weakened.
- Both full Compose variants passed interpolation/configuration with synthetic values. The source-build variant additionally validates the private automation volume and explicit disabled-by-default actor configuration. No rendered secret configuration was used.
- The shell collector wrapper passed `sh -n`; `git diff --check` passed.

Local runtime was macOS/Node26.8.2. The recovered production images use Node22.23.3. A local Docker daemon is unavailable, so new image builds and nginx's runtime config check were not performed here. Linux image/runtime checks, exact-head remote CI, the single Coolify schedule/lock, live database reconciliation and migration acceptance remain separate evidence.
