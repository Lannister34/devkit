## TypeScript

- **No `any`, and no cast that erases a type.** `noExplicitAny` is a lint error, and `strict` bans
  the implicit kind. `as T` on a value nothing narrowed — parsed JSON, `response.json()`, a caught
  error — claims a shape instead of checking it: narrow with a schema or a type guard. No
  `@ts-ignore`; use `@ts-expect-error` with a stated reason, and only where genuinely unavoidable.
- **`unknown` is a boundary type, not an escape hatch.** It is permitted only where the runtime shape
  is genuinely not knowable — parsed JSON, `catch` bindings, third-party callback payloads — and must
  be narrowed by a schema or type guard **in the same function**. `unknown` as a return type, a field
  type, or a parameter on an internal interface is a bug: the type is derivable, so write it.
- **No non-null assertions (`!`).** Narrow, or handle the nullish case.
- **No cast-built test doubles.** Never `as unknown as X`. Depend on a narrow port and implement it
  with a typed mock.
- **Value mapping over a closed key set is a lookup, not control flow.** `Record<Key, Value>` (or a
  `satisfies`-checked table), never `switch`/`case`, never an `if`/`else` chain, never a nested
  ternary. A lookup makes a missing key a type error instead of a forgotten branch. This covers
  dispatch too: choosing a handler by discriminant is a `Record` of functions.
- **A shape is declared once.** A type or interface whose fields mirror one declared elsewhere is
  the same shape: import it, or derive it (`Pick`/`Omit`/`z.infer`) from the owner. Twin
  declarations are not equivalent — they are two owners that have not diverged yet, and nothing
  will announce it when they do.
- **Test files belong to the typecheck program.** The build config excludes them from the output
  directory, but `tsc --noEmit` must still see them — the test runner transpiles without
  type-checking, so a test file excluded from both is checked by nothing.
- **Core's gates, and the names they rely on.** Biome's `noProcessEnv` fails an environment read
  anywhere but the config module, which is therefore `config.ts`, a `config/` directory, or a
  `*.config.*` file; `noReExportAll` and `noImportCycles` hold the surface rule's `export *` and
  direction halves, and a deep import into another feature module stays with review.
  `devkit-comments` holds the Comments rule, in `lint` and pre-commit, against
  `.devkit/comments-baseline.json`: per-file counts that `devkit-comments --update-baseline` records
  once and then only ever lowers.
