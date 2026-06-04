//! PostgreSQL sidecar plugin entry point.
//!
//! Speaks line-delimited JSON-RPC over stdio via [`rdb_plugin_runtime`]; the
//! RDBMS capability ops (`rdbms.execute`, `rdbms.apply_changes`, ...) are routed
//! to [`PostgresPlugin`]'s `RdbmsPlugin` impl by [`RdbmsDispatcher`].
//!
//! Run with `--describe` to print the plugin manifest (`PluginInfo`) and exit.

use rdb_plugin_postgres::PostgresPlugin;
use rdb_rdbms_common::RdbmsDispatcher;

fn main() -> anyhow::Result<()> {
    rdb_plugin_runtime::run(PostgresPlugin::new(), RdbmsDispatcher(PostgresPlugin::new()))
}
