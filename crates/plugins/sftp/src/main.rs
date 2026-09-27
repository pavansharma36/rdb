fn main() -> anyhow::Result<()> {
    rdb_plugin_runtime::run(
        rdb_plugin_sftp::SftpPlugin::new(),
        rdb_plugin_sftp::SftpDispatcher,
    )
}
