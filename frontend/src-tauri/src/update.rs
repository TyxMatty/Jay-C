//! Updates through the Jay line's shared updater (`jay-i`, pinned commit): the latest published
//! release of TyxMatty/Jay-C, its `_x64-setup.exe` only from this repository's release downloads,
//! run only if its size and SHA-256 match GitHub's digest. The asset is the Jay-I setup, run with
//! `/P /UPDATE /R`: a progress window, the NSIS installer silently updates in place keeping
//! settings and shortcuts, and Jay-C opens again. Jay-C exits right after starting it so the files
//! can be replaced. The crate downloads with WinHTTP: the proxy and certificates of Windows.

use jay_i::Release;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

const REPO: &str = "TyxMatty/Jay-C";
const AGENT: &str = concat!("Jay-C/", env!("CARGO_PKG_VERSION"));

/// The latest release, for the page to compare with its own version.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    version: String,
    url: String,
    /// It has a Windows installer that can be checked (otherwise there's nothing to install).
    installable: bool,
}

fn to_latest(release: &Release) -> Latest {
    Latest {
        version: release.tag_name.trim_start_matches(['v', 'V']).to_owned(),
        url: release.html_url.clone(),
        installable: jay_i::pick_installer(REPO, release).is_ok(),
    }
}

/// The latest release of Jay-C on GitHub, or None when there is none yet.
#[tauri::command]
pub async fn update_latest() -> Result<Option<Latest>, String> {
    tauri::async_runtime::spawn_blocking(|| Ok(jay_i::latest(REPO, AGENT)?.as_ref().map(to_latest)))
        .await
        .map_err(|e| e.to_string())?
}

static BUSY: AtomicBool = AtomicBool::new(false);

/// Downloads the latest installer, checks it and runs it, then closes Jay-C. The release is fetched
/// again here: the page only says "update", never what to download.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("an update is already downloading".into());
    }
    let result = tauri::async_runtime::spawn_blocking(|| {
        let release = jay_i::latest(REPO, AGENT)?.ok_or("there is no release")?;
        // The installer downgrades silently, so never install an older or the same version.
        if !jay_i::newer(&release.tag_name, env!("CARGO_PKG_VERSION")) {
            return Err("the latest release is not newer than this Jay-C".to_string());
        }
        let installer = jay_i::pick_installer(REPO, &release)?;
        let path = jay_i::download(&installer, AGENT, |_, _| {})?;
        jay_i::run(&path, jay_i::Mode::Update { relaunch: true }).spawn().map(drop).map_err(|e| {
            let _ = std::fs::remove_dir_all(path.parent().unwrap_or(&path));
            e.to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    BUSY.store(false, Ordering::SeqCst);
    result?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use jay_i::ReleaseAsset;

    const URL: &str = "https://github.com/TyxMatty/Jay-C/releases/download/v0.5.4/Jay-C_0.5.4_x64-setup.exe";
    const DIGEST: &str = "sha256:848005e8a2f42200b36f5553fd144a9d8aefdcbddbbf1ad49b56c65f473d63de";

    fn release(tag: &str, url: &str, digest: Option<&str>) -> Release {
        Release {
            tag_name: tag.into(),
            html_url: "https://github.com/TyxMatty/Jay-C/releases/tag/v0.5.4".into(),
            assets: vec![ReleaseAsset {
                name: "Jay-C_0.5.4_x64-setup.exe".into(),
                size: 5_000_000,
                browser_download_url: url.into(),
                digest: digest.map(Into::into),
            }],
        }
    }

    #[test]
    fn maps_a_release_for_the_page() {
        let ok = to_latest(&release("v0.5.4", URL, Some(DIGEST)));
        assert_eq!((ok.version.as_str(), ok.installable), ("0.5.4", true));
        assert_eq!(ok.url, "https://github.com/TyxMatty/Jay-C/releases/tag/v0.5.4");
        assert_eq!(to_latest(&release("V0.5.4", URL, Some(DIGEST))).version, "0.5.4");
        assert!(!to_latest(&release("v0.5.4", URL, None)).installable);
        assert!(!to_latest(&release("v0.5.4", &URL.replace("Jay-C/", "Jay-E/"), Some(DIGEST))).installable);
    }
}
