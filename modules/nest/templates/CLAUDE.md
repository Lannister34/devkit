## NestJS

Every Nest app in the repo repeats one skeleton — a reader who knows one app knows them all:

```
apps/<app>/src/
  main.ts                    bootstrap only: NestFactory, global wiring calls, listen/init
  modules/app.module.ts      composition root
  modules/<feature>/
    <feature>.module.ts
    <feature>.controller.ts  HTTP apps; <feature>.consumer.ts in queue workers
    <feature>.service.ts
    dto/  types/             only when the feature actually has them
```

- **Role suffixes name Nest's own artifact kinds.** Kebab-case, dot-chained: `.module` `.controller`
  `.service` `.repository` `.entity` `.dto` `.enum` `.guard` `.interceptor` `.pipe` `.filter`
  `.gateway` `.middleware` `.strategy` `.consumer` `.factory`. One class per file; a feature's second
  service is a second role-named file (`customer.service.ts` + `customer-bucket.service.ts`), never a
  second class in the first. A suffix outside Nest's vocabulary is a recorded decision, not an
  improvisation — an invented `.logic` or `.core` names nothing.
- **Layers flow one way.** Controller/consumer: decorators, validation, delegation — no business
  logic. Service: the feature's behaviour. Data access sits behind the service and is extracted into
  a repository on the seam triggers (second consumer, atomic multi-step, state-machine update, a
  query whose correctness is not obvious) — not from the first one-line call. The direction never
  reverses: a repository importing a service, or a controller reaching past its service to a data
  client, is a violation wherever it appears. A service class defined in `main.ts` is a feature that
  has not been given its module yet.
- **The composition root composes.** `app.module.ts` lists infrastructure modules, then feature
  modules, and binds cross-cutting behaviour globally through `APP_GUARD` / `APP_INTERCEPTOR` /
  `APP_PIPE` tokens. Conditional logic or I/O in a root module is a finding; a cross-cutting guard
  attached to one controller instead of bound globally is one too. Config follows core's
  one-module rule — here that module is `ConfigModule` with a validated model.
- **Workers differ at the edges only.** Controllers become consumers, `listen()` becomes `init()`
  plus a health probe; the skeleton stays. If a worker grows a layout of its own, that is a skeleton
  change — record the decision, do not drift into it.
