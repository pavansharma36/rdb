//! GitHub release helpers for installing plugins from prebuilt assets.
//!
//! Pure, network-isolated logic (asset selection, checksum parsing, target
//! triple) is unit-tested without touching the network; the two `async`
//! functions are thin `reqwest` wrappers.

use std::collections::HashMap;

use serde::Deserialize;
use sha2::{Digest, Sha256};

/// A plugin release channel. `Nightly` is the rolling `<plugin>-latest`
/// prerelease (version not in the tag); `Stable` is an immutable
/// `<plugin>-v<semver>` release (version is in the tag).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Nightly,
    Stable,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Nightly => "nightly",
            Channel::Stable => "stable",
        }
    }

    /// Parse a channel string; anything that isn't `stable` is treated as
    /// `nightly` (the default for local/dev builds).
    pub fn parse(s: &str) -> Channel {
        if s.eq_ignore_ascii_case("stable") {
            Channel::Stable
        } else {
            Channel::Nightly
        }
    }
}

/// The Rust target triple this host was built for, used to pick the matching
/// release asset. `None` on platforms we don't have a mapping for.
pub fn target_triple() -> Option<&'static str> {
    Some(match (std::env::consts::ARCH, std::env::consts::OS) {
        ("aarch64", "macos") => "aarch64-apple-darwin",
        ("x86_64", "macos") => "x86_64-apple-darwin",
        ("x86_64", "linux") => "x86_64-unknown-linux-gnu",
        ("aarch64", "linux") => "aarch64-unknown-linux-gnu",
        ("x86_64", "windows") => "x86_64-pc-windows-msvc",
        ("aarch64", "windows") => "aarch64-pc-windows-msvc",
        _ => return None,
    })
}

/// A GitHub release (only the fields we use).
#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub tag_name: String,
    /// ISO-8601 UTC timestamp (e.g. `2026-06-01T12:00:00Z`). `None` for drafts.
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub assets: Vec<Asset>,
}

/// A downloadable file attached to a release.
#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default)]
    pub size: u64,
}

fn is_aux(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".sha256") || n.ends_with(".json") || n.ends_with(".txt") || n.ends_with(".sig")
}

/// Pick the single binary asset whose name contains the target `triple`.
/// Checksum/manifest/signature files are ignored. Ambiguous or missing matches
/// produce a descriptive error listing the available asset names.
pub fn select_binary_asset<'a>(release: &'a Release, triple: &str) -> Result<&'a Asset, String> {
    let matches: Vec<&Asset> = release
        .assets
        .iter()
        .filter(|a| !is_aux(&a.name) && a.name.contains(triple))
        .collect();
    match matches.as_slice() {
        [one] => Ok(one),
        [] => Err(format!(
            "no asset matching target '{triple}' in release {}. assets: [{}]",
            release.tag_name,
            asset_names(release)
        )),
        many => Err(format!(
            "{} assets match target '{triple}'; expected exactly one: [{}]",
            many.len(),
            many.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")
        )),
    }
}

/// Suffix marking a release as a rolling per-plugin "latest" prerelease
/// (`<plugin>-latest`), as published by `publish-plugins.yml`.
pub const PLUGIN_TAG_SUFFIX: &str = "-latest";

/// A plugin release selected for a given platform + channel, with the metadata
/// the installer needs to decide install/update status without downloading.
#[derive(Debug, Clone)]
pub struct PluginRelease<'a> {
    /// Plugin id, derived from the tag (e.g. `postgres-latest` -> `postgres`).
    pub id: String,
    pub tag: &'a str,
    pub channel: Channel,
    /// Stable version (from the `-v<semver>` tag); `None` for nightly, whose
    /// version is only known after `--describe`.
    pub version: Option<String>,
    pub published_at: Option<&'a str>,
    pub asset: &'a Asset,
}

/// Parse a per-plugin release `tag` into `(id, channel, version)`:
/// `<id>-latest` -> nightly (no version); `<id>-v<maj.min.patch>` -> stable.
/// Returns `None` for anything else (e.g. the app's own `latest`/`vX.Y.Z`).
pub fn plugin_tag_parts(tag: &str) -> Option<(String, Channel, Option<String>)> {
    if let Some(id) = tag.strip_suffix(PLUGIN_TAG_SUFFIX) {
        if id.is_empty() {
            return None; // the app's own `latest` tag
        }
        return Some((id.to_string(), Channel::Nightly, None));
    }
    if let Some(idx) = tag.rfind("-v") {
        let (id, rest) = tag.split_at(idx);
        let ver = &rest[2..]; // drop the "-v"
        if !id.is_empty() && parse_semver(ver).is_some() {
            return Some((id.to_string(), Channel::Stable, Some(ver.to_string())));
        }
    }
    None
}

/// Parse a strict `major.minor.patch` version into a comparable tuple.
pub fn parse_semver(s: &str) -> Option<(u64, u64, u64)> {
    let mut parts = s.split('.');
    let maj = parts.next()?.parse().ok()?;
    let min = parts.next()?.parse().ok()?;
    let pat = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((maj, min, pat))
}

/// From all `releases`, pick the per-plugin ones for `channel` that have exactly
/// one binary asset for `triple`. For `Stable`, only the highest-semver release
/// per plugin id is kept; for `Nightly`, every matching `<plugin>-latest` is
/// returned. Releases without a matching asset (wrong platform, or the app's own
/// release) are skipped. Pure — no network.
pub fn select_plugin_releases<'a>(
    releases: &'a [Release],
    triple: &str,
    channel: Channel,
) -> Vec<PluginRelease<'a>> {
    let mut nightly: Vec<PluginRelease<'a>> = Vec::new();
    let mut stable: HashMap<String, PluginRelease<'a>> = HashMap::new();
    for r in releases {
        let Some((id, ch, version)) = plugin_tag_parts(&r.tag_name) else {
            continue;
        };
        if ch != channel {
            continue;
        }
        let Ok(asset) = select_binary_asset(r, triple) else {
            continue;
        };
        let pr = PluginRelease {
            id: id.clone(),
            tag: &r.tag_name,
            channel: ch,
            version,
            published_at: r.published_at.as_deref(),
            asset,
        };
        match channel {
            Channel::Nightly => nightly.push(pr),
            Channel::Stable => {
                let keep = match stable.get(&id) {
                    Some(existing) => {
                        pr.version.as_deref().and_then(parse_semver)
                            > existing.version.as_deref().and_then(parse_semver)
                    }
                    None => true,
                };
                if keep {
                    stable.insert(id, pr);
                }
            }
        }
    }
    match channel {
        Channel::Nightly => nightly,
        Channel::Stable => stable.into_values().collect(),
    }
}

fn asset_names(release: &Release) -> String {
    release
        .assets
        .iter()
        .map(|a| a.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Find the checksum asset that covers `binary_name`: either a per-asset
/// `<binary_name>.sha256`, or an aggregate `SHA256SUMS` / `checksums.txt`.
pub fn find_checksum<'a>(release: &'a Release, binary_name: &str) -> Option<&'a Asset> {
    let per_asset = format!("{binary_name}.sha256").to_ascii_lowercase();
    release.assets.iter().find(|a| {
        let n = a.name.to_ascii_lowercase();
        n == per_asset || n == "sha256sums" || n == "sha256sums.txt" || n == "checksums.txt"
    })
}

/// Extract the hex SHA-256 for `binary_name` from checksum-file `text`.
///
/// Handles both the aggregate `<hash>  <name>` format (coreutils `sha256sum`,
/// where `name` may carry a `*` binary-mode marker) and a bare-hash file
/// (a lone `<hash>`, as produced by `shasum -a256 file | cut`).
pub fn parse_sha256sums(text: &str, binary_name: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    // Bare single-hash file.
    if let [only] = lines.as_slice() {
        let tok = only.split_whitespace().next().unwrap_or("");
        if is_hex_sha256(tok) {
            return Some(tok.to_ascii_lowercase());
        }
    }
    for line in lines {
        let mut parts = line.split_whitespace();
        let hash = parts.next().unwrap_or("");
        let name = parts.next().unwrap_or("").trim_start_matches('*');
        if is_hex_sha256(hash) && name == binary_name {
            return Some(hash.to_ascii_lowercase());
        }
    }
    None
}

fn is_hex_sha256(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// A `reqwest` client configured for the GitHub API (required User-Agent,
/// optional `GITHUB_TOKEN` auth to lift the unauthenticated rate limit).
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("rdb-plugin-installer")
        .build()
        .map_err(|e| e.to_string())
}

fn auth(req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match std::env::var("GITHUB_TOKEN") {
        Ok(t) if !t.is_empty() => req.bearer_auth(t),
        _ => req,
    }
}

/// Normalise and validate a `owner/name` repo string (tolerating a pasted
/// `https://github.com/owner/name` URL and surrounding slashes).
fn normalize_repo(repo: &str) -> Result<String, String> {
    let repo = repo.trim().trim_start_matches("https://github.com/").trim_matches('/');
    if repo.split('/').filter(|s| !s.is_empty()).count() != 2 {
        return Err(format!("expected repo as 'owner/name', got '{repo}'"));
    }
    Ok(repo.to_string())
}

/// Fetch a release by `tag`, or the latest release when `tag` is `None`.
/// `repo` is `owner/name`.
pub async fn fetch_release(repo: &str, tag: Option<&str>) -> Result<Release, String> {
    let repo = normalize_repo(repo)?;
    let url = match tag {
        Some(t) => format!("https://api.github.com/repos/{repo}/releases/tags/{t}"),
        None => format!("https://api.github.com/repos/{repo}/releases/latest"),
    };
    let resp = auth(client()?.get(&url))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub returned {} for {url}", resp.status()));
    }
    resp.json::<Release>()
        .await
        .map_err(|e| format!("failed to parse release: {e}"))
}

/// Fetch all releases for `repo` (`owner/name`), most-recent first.
pub async fn fetch_releases(repo: &str) -> Result<Vec<Release>, String> {
    let repo = normalize_repo(repo)?;
    let url = format!("https://api.github.com/repos/{repo}/releases?per_page=100");
    let resp = auth(client()?.get(&url))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub returned {} for {url}", resp.status()));
    }
    resp.json::<Vec<Release>>()
        .await
        .map_err(|e| format!("failed to parse releases: {e}"))
}

/// Download an asset's bytes.
pub async fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    let resp = auth(client()?.get(url))
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download returned {} for {url}", resp.status()));
    }
    Ok(resp
        .bytes()
        .await
        .map_err(|e| format!("download read failed: {e}"))?
        .to_vec())
}

/// Download an asset's body as UTF-8 text (for checksum files).
pub async fn download_text(url: &str) -> Result<String, String> {
    let bytes = download_bytes(url).await?;
    String::from_utf8(bytes).map_err(|e| format!("checksum file not UTF-8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release_with(names: &[&str]) -> Release {
        Release {
            tag_name: "v1.0.0".into(),
            published_at: Some("2026-01-01T00:00:00Z".into()),
            assets: names
                .iter()
                .map(|n| Asset {
                    name: (*n).into(),
                    browser_download_url: format!("https://example/{n}"),
                    size: 10,
                })
                .collect(),
        }
    }

    #[test]
    fn target_triple_is_known_on_this_host() {
        assert!(target_triple().is_some());
    }

    #[test]
    fn selects_unique_binary_ignoring_aux_files() {
        let r = release_with(&[
            "rdb-plugin-mysql-aarch64-apple-darwin",
            "rdb-plugin-mysql-aarch64-apple-darwin.sha256",
            "rdb-plugin-mysql-x86_64-apple-darwin",
            "SHA256SUMS",
        ]);
        let a = select_binary_asset(&r, "aarch64-apple-darwin").unwrap();
        assert_eq!(a.name, "rdb-plugin-mysql-aarch64-apple-darwin");
    }

    #[test]
    fn errors_when_no_asset_matches() {
        let r = release_with(&["rdb-plugin-mysql-x86_64-apple-darwin"]);
        let e = select_binary_asset(&r, "aarch64-unknown-linux-gnu").unwrap_err();
        assert!(e.contains("no asset matching"), "{e}");
    }

    #[test]
    fn errors_when_ambiguous() {
        let r = release_with(&["plugin-linux-extra", "other-plugin-linux"]);
        let e = select_binary_asset(&r, "linux").unwrap_err();
        assert!(e.contains("expected exactly one"), "{e}");
    }

    #[test]
    fn finds_aggregate_and_per_asset_checksums() {
        let bin = "rdb-plugin-mysql-aarch64-apple-darwin";
        let agg = release_with(&[bin, "SHA256SUMS"]);
        assert_eq!(find_checksum(&agg, bin).unwrap().name, "SHA256SUMS");
        let per = release_with(&[bin, &format!("{bin}.sha256")]);
        assert_eq!(find_checksum(&per, bin).unwrap().name, format!("{bin}.sha256"));
    }

    #[test]
    fn parses_aggregate_sha256sums() {
        let hash = "a".repeat(64);
        let text = format!("{hash}  rdb-plugin-mysql-aarch64-apple-darwin\n{}  other\n", "b".repeat(64));
        let got = parse_sha256sums(&text, "rdb-plugin-mysql-aarch64-apple-darwin").unwrap();
        assert_eq!(got, hash);
    }

    #[test]
    fn parses_binary_mode_marker_and_bare_hash() {
        let hash = "c".repeat(64);
        let text = format!("{hash} *the-binary\n");
        assert_eq!(parse_sha256sums(&text, "the-binary").unwrap(), hash);
        let bare = format!("{}\n", "d".repeat(64));
        assert_eq!(parse_sha256sums(&bare, "anything").unwrap(), "d".repeat(64));
    }

    #[test]
    fn parses_plugin_tag_parts() {
        let (id, ch, ver) = plugin_tag_parts("postgres-latest").unwrap();
        assert_eq!((id.as_str(), ch, ver), ("postgres", Channel::Nightly, None));

        let (id, ch, ver) = plugin_tag_parts("postgres-v0.2.0").unwrap();
        assert_eq!(id, "postgres");
        assert_eq!(ch, Channel::Stable);
        assert_eq!(ver.as_deref(), Some("0.2.0"));

        // Hyphenated id is preserved.
        let (id, ch, _) = plugin_tag_parts("my-plugin-v1.0.0").unwrap();
        assert_eq!((id.as_str(), ch), ("my-plugin", Channel::Stable));

        // The app's own tags are not plugin tags.
        assert!(plugin_tag_parts("latest").is_none());
        assert!(plugin_tag_parts("v0.2.0").is_none());
        // Non-semver after -v is rejected.
        assert!(plugin_tag_parts("postgres-vnightly").is_none());
    }

    #[test]
    fn parse_semver_orders_versions() {
        assert_eq!(parse_semver("0.2.10"), Some((0, 2, 10)));
        assert!(parse_semver("1.0.0") > parse_semver("0.9.9"));
        assert!(parse_semver("0.2.10") > parse_semver("0.2.9"));
        assert!(parse_semver("1.2").is_none());
        assert!(parse_semver("1.2.3.4").is_none());
        assert!(parse_semver("1.2.x").is_none());
    }

    #[test]
    fn selects_nightly_plugin_releases_with_matching_asset() {
        let triple = "aarch64-apple-darwin";
        let releases = vec![
            // App release: not a `<plugin>-latest` tag -> skipped.
            Release {
                tag_name: "latest".into(),
                published_at: Some("2026-01-01T00:00:00Z".into()),
                assets: vec![Asset {
                    name: format!("rdb-{triple}.dmg"),
                    browser_download_url: "https://example/app".into(),
                    size: 1,
                }],
            },
            // Plugin built for this platform -> kept.
            Release {
                tag_name: "postgres-latest".into(),
                published_at: Some("2026-02-01T00:00:00Z".into()),
                assets: vec![
                    Asset {
                        name: format!("rdb-plugin-postgres-{triple}"),
                        browser_download_url: "https://example/pg".into(),
                        size: 2,
                    },
                    Asset {
                        name: format!("rdb-plugin-postgres-{triple}.sha256"),
                        browser_download_url: "https://example/pg.sha256".into(),
                        size: 1,
                    },
                ],
            },
            // Plugin tag but no asset for this triple -> skipped.
            Release {
                tag_name: "mongodb-latest".into(),
                published_at: Some("2026-02-01T00:00:00Z".into()),
                assets: vec![Asset {
                    name: "rdb-plugin-mongodb-x86_64-pc-windows-msvc.exe".into(),
                    browser_download_url: "https://example/mongo".into(),
                    size: 3,
                }],
            },
        ];
        let got = select_plugin_releases(&releases, triple, Channel::Nightly);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "postgres");
        assert_eq!(got[0].tag, "postgres-latest");
        assert_eq!(got[0].channel, Channel::Nightly);
        assert_eq!(got[0].published_at, Some("2026-02-01T00:00:00Z"));
        assert_eq!(got[0].asset.name, format!("rdb-plugin-postgres-{triple}"));
    }

    #[test]
    fn selects_highest_stable_version_per_plugin() {
        let triple = "aarch64-apple-darwin";
        let mk = |tag: &str| Release {
            tag_name: tag.into(),
            published_at: Some("2026-01-01T00:00:00Z".into()),
            assets: vec![Asset {
                name: format!("rdb-plugin-postgres-{triple}"),
                browser_download_url: "https://example/pg".into(),
                size: 2,
            }],
        };
        let releases = vec![
            mk("postgres-v0.1.0"),
            mk("postgres-v0.2.0"),
            mk("postgres-v0.1.9"),
        ];
        let got = select_plugin_releases(&releases, triple, Channel::Stable);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].version.as_deref(), Some("0.2.0"));
        assert_eq!(got[0].channel, Channel::Stable);
        // Nightly selection ignores stable releases.
        assert!(select_plugin_releases(&releases, triple, Channel::Nightly).is_empty());
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        // SHA-256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
