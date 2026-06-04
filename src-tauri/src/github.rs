//! GitHub release helpers for installing plugins from prebuilt assets.
//!
//! Pure, network-isolated logic (asset selection, checksum parsing, target
//! triple) is unit-tested without touching the network; the two `async`
//! functions are thin `reqwest` wrappers.

use serde::Deserialize;
use sha2::{Digest, Sha256};

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

/// Fetch a release by `tag`, or the latest release when `tag` is `None`.
/// `repo` is `owner/name`.
pub async fn fetch_release(repo: &str, tag: Option<&str>) -> Result<Release, String> {
    let repo = repo.trim().trim_start_matches("https://github.com/").trim_matches('/');
    if repo.split('/').filter(|s| !s.is_empty()).count() != 2 {
        return Err(format!("expected repo as 'owner/name', got '{repo}'"));
    }
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
    fn sha256_hex_matches_known_vector() {
        // SHA-256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
