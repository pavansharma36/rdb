fn main() -> anyhow::Result<()> {
    rdb_plugin_runtime::run(
        rdb_plugin_s3::S3Plugin::new(),
        rdb_plugin_s3::S3Dispatcher,
    )
}
