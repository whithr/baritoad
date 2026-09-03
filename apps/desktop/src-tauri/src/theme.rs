//! Player-theme background images — the only part of the theme system that
//! touches disk. Themes themselves are webview-side data (src/themes.ts);
//! the webview's CSP allows images as `data:` URLs only, so a user-picked
//! background is IMPORTED (copied) into our own themes dir and read back as
//! a data URL guarded to that dir (the `read_cover` pattern — the webview
//! never gets arbitrary-file read through this).

use std::path::PathBuf;

/// `%LOCALAPPDATA%\karaoke\themes` — imported background images, beside the
/// covers dir under the same per-user data root.
fn themes_dir() -> PathBuf {
    karaoke_core::library::default_covers_dir()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
        .join("themes")
}

/// A backdrop should never be a memory event: reading it base64-inflates by
/// 4/3 into the webview, so cap the source file.
const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

fn image_mime(ext: Option<&str>) -> Option<&'static str> {
    match ext {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("bmp") => Some("image/bmp"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

/// Copy a user-picked image into the themes dir; returns the stored path
/// (what a `ThemeSpec` background records).
#[tauri::command]
pub async fn theme_import_image(src_path: String) -> Result<String, String> {
    let src = PathBuf::from(&src_path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if image_mime(Some(ext.as_str())).is_none() {
        return Err(format!("not a supported image type: .{ext}"));
    }
    let meta = std::fs::metadata(&src).map_err(|e| format!("image not readable: {e}"))?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("image is larger than 25 MB — pick a smaller one".into());
    }
    let dir = themes_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("background");
    let safe: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(40)
        .collect();
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dir.join(format!("{safe}-{millis}.{ext}"));
    std::fs::copy(&src, &dest).map_err(|e| format!("copy failed: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Read an imported theme image as a data URL. Restricted to the themes dir.
#[tauri::command]
pub async fn read_theme_image(path: String) -> Result<String, String> {
    let canon = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("image not found: {e}"))?;
    let dir_canon = themes_dir()
        .canonicalize()
        .map_err(|e| format!("themes dir missing: {e}"))?;
    if !canon.starts_with(&dir_canon) {
        return Err("image path outside the themes directory".into());
    }
    let bytes = std::fs::read(&canon).map_err(|e| e.to_string())?;
    let mime = image_mime(canon.extension().and_then(|e| e.to_str()));
    Ok(crate::library::data_url(&bytes, mime))
}
