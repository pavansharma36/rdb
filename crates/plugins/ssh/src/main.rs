fn main() -> anyhow::Result<()> {
    rdb_plugin_runtime::run(
        rdb_plugin_ssh::SshPlugin::new(),
        rdb_plugin_ssh::SshDispatcher,
    )
}
