//! CV Triage — Task 15.
//!
//! Tauri command invoked by the TriageWizard (Task 17) to bundle a folder
//! of PDF résumés into an in-memory zip before uploading it to the
//! Seraphine backend's `/cv_triage/jobs` endpoint.
//!
//! Behavior:
//! - Reads the top level of `folder_path` (no recursion — the wizard's
//!   `@tauri-apps/plugin-dialog` directory picker constrains the user to
//!   pick one CV folder).
//! - Filters to files whose extension is `.pdf` (case-insensitive: both
//!   `.pdf` and `.PDF` qualify).
//! - Skips macOS Finder noise: `.DS_Store` and `._*` AppleDouble files.
//! - Writes a flat zip (no nested dirs) — this matches the backend's
//!   `zip_utils.extract_pdfs_safely`, which flattens via `os.path.basename`.
//! - Returns the zip bytes as `Vec<u8>` so the frontend can hand them to
//!   `fetch()` as a `Blob` or `FormData` field.
//!
//! Sized for the CV use case: ≤87 PDFs, ~19MB total. Synchronous; the
//! zip completes in <1s on M-series Macs.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

#[tauri::command]
pub fn zip_folder_pdfs(folder_path: String) -> Result<Vec<u8>, String> {
    let folder = PathBuf::from(&folder_path);
    if !folder.is_dir() {
        return Err(format!("not a directory: {folder_path}"));
    }
    let mut buf: Vec<u8> = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut buf);
        let mut zw = zip::ZipWriter::new(cursor);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for entry in walk_pdfs(&folder).map_err(|e| e.to_string())? {
            let rel = entry.file_name().to_string_lossy().to_string();
            zw.start_file(&rel, opts).map_err(|e| e.to_string())?;
            let mut f = File::open(entry.path()).map_err(|e| e.to_string())?;
            let mut bytes = Vec::new();
            f.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            zw.write_all(&bytes).map_err(|e| e.to_string())?;
        }
        zw.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

fn walk_pdfs(dir: &Path) -> std::io::Result<Vec<std::fs::DirEntry>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy();
        if name.starts_with("._") || name == ".DS_Store" {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if !lower.ends_with(".pdf") {
            continue;
        }
        out.push(entry);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;
    use zip::ZipArchive;

    #[test]
    fn zips_only_pdfs() {
        let d = tempdir().unwrap();
        fs::write(d.path().join("a.pdf"), b"%PDF-1.4 a").unwrap();
        fs::write(d.path().join("b.PDF"), b"%PDF-1.4 b").unwrap();
        fs::write(d.path().join("notes.txt"), b"x").unwrap();
        fs::write(d.path().join(".DS_Store"), b"x").unwrap();
        fs::write(d.path().join("._hidden.pdf"), b"x").unwrap();

        let bytes = zip_folder_pdfs(d.path().to_string_lossy().to_string()).unwrap();
        let cursor = std::io::Cursor::new(bytes);
        let mut zip = ZipArchive::new(cursor).unwrap();
        let mut names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.pdf", "b.PDF"]);
    }

    #[test]
    fn errors_on_missing_folder() {
        let r = zip_folder_pdfs("/nonexistent/path/that/cannot/exist".to_string());
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("not a directory"));
    }

    #[test]
    fn empty_folder_returns_empty_zip() {
        let d = tempdir().unwrap();
        let bytes = zip_folder_pdfs(d.path().to_string_lossy().to_string()).unwrap();
        // A valid empty zip has the EOCD marker (22 bytes).
        assert!(bytes.len() >= 22);
        let cursor = std::io::Cursor::new(bytes);
        let zip = ZipArchive::new(cursor).unwrap();
        assert_eq!(zip.len(), 0);
    }
}
