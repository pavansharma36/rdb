# rdb

A cross-platform desktop client for databases and message brokers, built with
[Tauri](https://tauri.app) (Rust backend) and React + TypeScript (frontend).
One app to connect to relational databases, document stores, and queues through
a unified, plugin-based architecture.

Ships today with three plugins:

| Plugin | Kind | What it talks to |
| --- | --- | --- |
| **PostgreSQL** | `rdbms` | PostgreSQL 12+ databases (via `sqlx`) |
| **MongoDB** | `document` | MongoDB and Atlas clusters |
| **RabbitMQ** | `messaging` | RabbitMQ brokers over AMQP 0-9-1 (via `lapin`) |

---

## Highlights

- **Unified workspace** — one window, a sidebar of saved connections, and a
  workspace per connection rendered according to its plugin `kind`.
- **Plugin architecture** — each backend is a self-contained crate implementing
  a small set of Rust traits. The frontend renders connection forms and
  workspaces generically from a plugin's declared config schema and `kind`.
- **RDBMS editing** — browse schemas/tables, run SQL, and stage multi-cell
  edits (inserts/updates/deletes) that commit atomically in a single
  transaction.
- **Document & messaging surfaces** — query MongoDB collections; declare,
  publish to, and consume from RabbitMQ queues.
- **Saved connections** — connection profiles persist across restarts as
  human-readable JSON in the OS app-data directory.

---

## Architecture

```
┌──────────────────────────────────────────────┐
│ Frontend (React + TypeScript, Vite)           │
│   src/                                         │
│   - App.tsx, Sidebar, ConnectionForm          │
│   - workspaces/{Rdbms,Document,Messaging}      │
│   - api.ts  ← typed bridge to Tauri commands   │
└───────────────┬────────────────────────────────┘
                │  @tauri-apps/api  invoke(...)
┌───────────────▼────────────────────────────────┐
│ Tauri host (Rust)  —  src-tauri/                │
│   - lib.rs   builds the PluginRegistry          │
│   - commands.rs   #[tauri::command] surface     │
│   - persistence.rs   saved connection profiles  │
└───────────────┬────────────────────────────────┘
                │  rdb-core traits (Plugin, Connection)
┌───────────────▼────────────────────────────────┐
│ Plugins (Rust workspace crates)                 │
│   crates/rdb-core            core types/traits  │
│   crates/rdb-rdbms-common    RDBMS trait + types│
│   crates/plugins/postgres    sqlx               │
│   crates/plugins/mongodb     mongodb            │
│   crates/plugins/rabbitmq    lapin              │
└─────────────────────────────────────────────────┘
```

### Crates

- **`rdb-core`** — backend-agnostic foundation. Defines `Plugin` and
  `Connection` traits, `PluginKind`, the serializable config-schema types
  (`PluginInfo`, `ConfigField`, …) the UI builds forms from, `ConnectionId`,
  `PluginError`, and the `PluginRegistry` that tracks plugins and live
  connections.
- **`rdb-rdbms-common`** — the `RdbmsPlugin` trait and shared relational types
  (`Schema`, `Table`, `Column`, `QueryResult`, `RowChanges`, `ApplyResult`, …).
  Any relational plugin implements this in addition to `rdb_core::Plugin` and
  reuses the same `rdbms` UI module.
- **`crates/plugins/*`** — one crate per backend, each implementing `Plugin`
  (and `RdbmsPlugin` for relational backends).

> **Note on the current model:** plugins are **statically linked** into the
> Tauri host today — `build_registry()` in `src-tauri/src/lib.rs` registers each
> one, so the shipped binary contains every driver. A planned refactor moves to
> **out-of-process sidecar plugins** the host loads at runtime over
> line-delimited JSON-RPC on stdio. See [`plugin-architecture.md`](./plugin-architecture.md)
> for the full design.

### Key types (Rust ⇄ TypeScript)

All cross-boundary types are `Serialize`/`Deserialize` in Rust and mirrored in
`src/api.ts`. A `ConnectionId` is a UUID that serializes as a string; live
connection handles (`PgPool`, `mongodb::Client`, `lapin::Connection`) stay in
the backend and are referenced everywhere by that id.

---

## Project layout

```
rdb/
├── Cargo.toml              Rust workspace (core, rdbms-common, 3 plugins, host)
├── package.json            Frontend deps + Vite/Tauri scripts
├── vite.config.ts          Vite config (dev server on :1420)
├── index.html              Frontend entry
├── plugin-architecture.md  Design doc: runtime-loaded sidecar plugins
├── crates/
│   ├── rdb-core/           Plugin/Connection traits, registry, shared types
│   ├── rdb-rdbms-common/   RdbmsPlugin trait + relational types
│   └── plugins/
│       ├── postgres/       PostgreSQL plugin (sqlx)
│       ├── mongodb/        MongoDB plugin
│       └── rabbitmq/       RabbitMQ plugin (lapin)
├── src/                    React + TypeScript frontend
│   ├── App.tsx             Top-level app shell + connection lifecycle
│   ├── api.ts              Typed bridge to Tauri commands
│   ├── store.ts            Saved-connection persistence (frontend side)
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── ConnectionForm.tsx
│   │   └── workspaces/     Rdbms / Document / Messaging workspaces
│   └── styles.css
└── src-tauri/              Tauri host
    ├── Cargo.toml
    ├── tauri.conf.json     App/window/bundle config
    └── src/
        ├── lib.rs          Builds registry, registers commands
        ├── commands.rs     #[tauri::command] surface
        ├── persistence.rs  Saved connection profiles (connections.json)
        └── main.rs
```

---

## Getting started

### Prerequisites

- **Rust** (stable) and Cargo — https://rustup.rs
- **Node.js** 18+ and npm
- **Tauri 2 system dependencies** for your OS — see the
  [Tauri prerequisites guide](https://tauri.app/start/prerequisites/)
  (on macOS: Xcode Command Line Tools).

### Install

```bash
npm install
```

(Rust dependencies are fetched automatically on first build.)

### Run in development

Plugins are out-of-process executables the host discovers at runtime, so build
and install them first, then point the host at the same directory:

```bash
npm run plugins:dev                     # builds the 3 bundled plugins + manifests
RDB_PLUGINS_DIR=$PWD/dev-plugins npm run tauri dev
```

This starts the Vite dev server on `http://localhost:1420` and launches the
Tauri window with hot-reload for both the Rust and frontend code. Without any
plugins installed the connection form will be empty — install one (see
[Plugins](#plugins)).

### Build a release bundle

```bash
npm run tauri build
```

Produces platform installers/bundles under `src-tauri/target/release/bundle/`.

### Useful sub-commands

| Command | Description |
| --- | --- |
| `npm run dev` | Frontend-only Vite dev server |
| `npm run build` | Type-check (`tsc`) and build the frontend |
| `cargo build` | Build the full Rust workspace |
| `cargo test` | Run Rust tests across the workspace |
| `npm run plugins:dev` | Build the bundled plugins and install them into `dev-plugins/` |

---

## Plugins

The host ships with only `rdb-core` and loads plugins at runtime from the
plugins directory (`$RDB_PLUGINS_DIR`, else `<app-data>/plugins`). Each plugin
is a standalone executable plus a generated `<id>.plugin.json` manifest; the
host talks to it over line-delimited JSON-RPC on stdio.

### Install from GitHub (in-app)

Click **⤓ Install plugin** in the sidebar, enter a repo (`owner/name`) and
optionally a release tag, then **Fetch release**. The app picks the asset
matching your OS/arch, shows the published SHA-256, and — on confirmation —
downloads, verifies the checksum, and installs it. The plugin appears in the
New-connection form immediately, no rebuild required.

> ⚠️ Plugins are native executables that run with full access to your machine.
> Only install plugins you trust. Downloads are checksum-verified for integrity,
> not authenticity; on macOS an unsigned/un-notarized binary may be blocked by
> Gatekeeper on first launch.

### Publishing a plugin (release convention)

For a plugin repo to be installable, each GitHub Release must include:

- **One binary per platform** whose asset name contains the Rust **target
  triple**, e.g. `rdb-plugin-mysql-aarch64-apple-darwin`
  (`…-x86_64-pc-windows-msvc.exe` on Windows).
- **A checksums asset**: `SHA256SUMS` (or `checksums.txt`) with
  `<sha256>  <asset-name>` lines, or a per-asset `<asset-name>.sha256`.

No manifest is shipped — the host generates it by running the verified binary's
`--describe` at install time. Build a plugin as a binary crate whose `main`
calls `rdb_plugin_runtime::run(plugin, dispatcher)`.

### Local development

`npm run plugins:dev` builds the three bundled plugins, copies the binaries into
`dev-plugins/`, and writes their manifests (via each binary's `--describe`).
Set `RDB_PLUGINS_DIR=$PWD/dev-plugins` when launching the app.

---

## Using the app

1. Click **+** in the sidebar to create a connection. Pick a plugin
   (PostgreSQL / MongoDB / RabbitMQ); the form is generated from that plugin's
   declared config schema.
2. **Test** the config, then **Save**. Profiles persist across restarts.
3. Select a saved connection to **connect**. The workspace that opens depends
   on the plugin kind:
   - **RDBMS** — schema/table tree, SQL editor, results grid, and inline cell
     editing with staged Save/Cancel.
   - **Document** — browse databases/collections and run `find` queries.
   - **Messaging** — declare queues, publish messages, and consume.

### Where data is stored

Saved connection profiles live at `<app_data_dir>/connections.json` (the exact
path is OS-specific). The file is human-readable JSON.

> ⚠️ **Security note:** connection configs — **including passwords** — are
> stored in plaintext in `connections.json`. Treat the file accordingly. A
> secure-credential store is not yet implemented.

---

## Adding a new plugin

The shared traits make new backends small to add. For a relational backend:

1. Create a crate under `crates/plugins/<name>` depending on `rdb-core` and
   (for relational backends) `rdb-rdbms-common`.
2. Implement `rdb_core::Plugin` — return a `PluginInfo` with
   `kind: PluginKind::Rdbms` and a `config_schema` describing the connection
   form, plus a `connect` that opens and returns an `Arc<dyn Connection>`.
3. For relational backends, also implement `RdbmsPlugin`
   (`list_schemas`, `list_tables`, `describe_table`, `execute`, and optionally
   `apply_changes` for editing).
4. Register it in `src-tauri/src/lib.rs`’s `build_registry()` and add the crate
   to the workspace in `Cargo.toml`.

Non-relational backends pick a different `PluginKind` (`Document`, `Messaging`,
or `Other`) and the frontend renders the matching workspace. See the existing
MongoDB and RabbitMQ plugins as references.

---

## For AI agents working in this repo

- **Stack:** Tauri 2 + Rust workspace backend; React 18 + TypeScript + Vite
  frontend. Communication is via Tauri `invoke` commands defined in
  `src-tauri/src/commands.rs` and mirrored in `src/api.ts`.
- **The type contract lives in two mirrored places.** Any change to a
  cross-boundary struct in Rust (`rdb-core`, `rdb-rdbms-common`, or a plugin)
  must be reflected in `src/api.ts`. serde uses `rename_all = "lowercase"` for
  enums and `camelCase` for saved-connection persistence — match the existing
  casing.
- **Plugins are statically registered** in `src-tauri/src/lib.rs`
  (`build_registry()`); the typed command surface (`rdbms_*`, `doc_*`, `mq_*`)
  is the current transport. `plugin-architecture.md` describes a *planned*
  move to generic, runtime-loaded sidecar plugins — it is a design doc, not the
  current state. Verify against the code before assuming the sidecar model.
- **Live connection handles never cross the IPC boundary.** They stay in the
  backend keyed by `ConnectionId` (a UUID). Don't try to serialize a pool or
  client.
- **No git history** is present in this checkout (`git` is not initialized).
- **Build/run:** `npm run tauri dev` for end-to-end; `cargo test` for backend
  unit tests; `npm run build` to type-check the frontend.

---

## License

Dual-licensed under **MIT OR Apache-2.0** (see `Cargo.toml`).
