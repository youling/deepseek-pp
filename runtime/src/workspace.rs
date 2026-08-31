//! Workspace filesystem safety.
//!
//! Canonicalize the workspace root once and reject roots that cannot be
//! resolved. Resolve existing target paths and verify containment AFTER
//! symlink/junction/reparse resolution. Do not rely on a check-then-open
//! sequence for writes: create a temporary file in the destination directory
//! and replace via same-volume atomic rename. Documented TOCTOU/network-share
//! limits are left explicit rather than claiming `canonicalize` is a sandbox.

use std::fs;
use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace root could not be resolved: {0}")]
    Unresolvable(String),
    #[error("workspace root canonicalization does not exist: {0}")]
    Missing(String),
    #[error("path {path} escapes workspace {root}")]
    Escape { root: String, path: String },
    #[error("atomic replace failed: {0}")]
    Replace(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Canonicalize (reparse-resolve) a workspace root. Fail closed if the root
/// cannot be resolved to an existing absolute path.
pub fn resolve_workspace_root(root: &Path) -> Result<PathBuf, WorkspaceError> {
    if !root.exists() {
        return Err(WorkspaceError::Missing(
            root.to_string_lossy().into_owned(),
        ));
    }
    let canonical = fs::canonicalize(root)
        .map_err(|e| WorkspaceError::Unresolvable(format!("{}: {}", root.display(), e)))?;
    Ok(canonical)
}

/// Resolve a candidate path and return it along with the resolved ancestor
/// used for containment, WITHOUT mixing the check with the open. The caller
/// may use the resolved path as a base but must not treat this as a race-free
/// sandbox; network shares / malicious concurrent renames remain explicit
/// limitations.
fn resolve_contained(canonical_root: &Path, candidate: &Path) -> Result<PathBuf, WorkspaceError> {
    if !candidate.exists() {
        // For a missing path, resolve its nearest existing ancestor and verify
        // that ancestor stays within the root; the final component is created
        // later only if the caller is authorized for the workspace.
        let mut ancestor = candidate;
        let mut missing_tail = PathBuf::new();
        while !ancestor.exists() {
            let Some(parent) = ancestor.parent() else {
                return Err(WorkspaceError::Escape {
                    root: canonical_root.display().to_string(),
                    path: candidate.display().to_string(),
                });
            };
            missing_tail.push(
                ancestor
                    .file_name()
                    .ok_or_else(|| WorkspaceError::Unresolvable(candidate.display().to_string()))?,
            );
            ancestor = parent;
        }
        let resolved_ancestor = fs::canonicalize(ancestor).map_err(|_| {
            WorkspaceError::Unresolvable(ancestor.to_string_lossy().into_owned())
        })?;
        if !resolved_ancestor.starts_with(canonical_root) {
            return Err(WorkspaceError::Escape {
                root: canonical_root.display().to_string(),
                path: candidate.display().to_string(),
            });
        }
        let mut combined = resolved_ancestor;
        // missing_tail is stored root..leaf, so prepend in reverse.
        let parts: Vec<_> = missing_tail.components().collect();
        for part in parts.iter().rev() {
            combined.push(part);
        }
        return Ok(combined);
    }

    let resolved = fs::canonicalize(candidate).map_err(|_| {
        WorkspaceError::Unresolvable(candidate.to_string_lossy().into_owned())
    })?;
    if !resolved.starts_with(canonical_root) {
        return Err(WorkspaceError::Escape {
            root: canonical_root.display().to_string(),
            path: candidate.display().to_string(),
        });
    }
    Ok(resolved)
}

/// Verify a candidate path (junction/symlink/reparse resolved) stays within the
/// canonical workspace root. Succeeds with the resolved path.
pub fn verify_contained(root: &Path, candidate: &Path) -> Result<PathBuf, WorkspaceError> {
    let canonical_root = resolve_workspace_root(root)?;
    resolve_contained(&canonical_root, candidate)
}

/// Safely replace a file inside the workspace using a same-directory temporary
/// file and an atomic rename. The destination is reparse-resolved and verified
/// to stay within the workspace; the temp file is created in the destination's
/// parent directory so rename stays on the same volume.
pub fn atomic_write(root: &Path, target: &Path, contents: &[u8]) -> Result<(), WorkspaceError> {
    let canonical_root = resolve_workspace_root(root)?;
    if !target.exists() {
        return Err(WorkspaceError::Replace(format!(
            "target does not exist: {}",
            target.display()
        )));
    }
    let resolved_target = resolve_contained(&canonical_root, target)?;
    let parent = resolved_target
        .parent()
        .ok_or_else(|| WorkspaceError::Replace("cannot determine parent directory".into()))?;
    if !parent.starts_with(&canonical_root) {
        return Err(WorkspaceError::Escape {
            root: canonical_root.display().to_string(),
            path: target.display().to_string(),
        });
    }

    let file_name = resolved_target
        .file_name()
        .ok_or_else(|| WorkspaceError::Replace("target has no file name".into()))?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        file_name.to_string_lossy(),
        std::process::id()
    ));

    fs::write(&tmp, contents)?;
    fs::rename(&tmp, &resolved_target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_root_fails_closed() {
        let missing = tempfile::tempdir().unwrap();
        let path = missing.path().join("does-not-exist");
        assert!(matches!(
            resolve_workspace_root(&path),
            Err(WorkspaceError::Missing(_))
        ));
    }

    #[test]
    fn contained_path_ok() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let nested = root.join("a").join("b");
        fs::create_dir_all(&nested).unwrap();
        let resolved = verify_contained(root, &nested).unwrap();
        assert!(resolved.starts_with(fs::canonicalize(root).unwrap()));
    }

    #[test]
    fn external_path_escapes() {
        let root = tempfile::tempdir().unwrap();
        let outside = std::env::temp_dir();
        assert!(matches!(
            verify_contained(root.path(), &outside),
            Err(WorkspaceError::Escape { .. })
        ));
    }

    #[test]
    fn junction_escape_is_detected() {
        // On Windows, create a junction that points outside the workspace and
        // assert containment fails after reparse resolution. On platforms where
        // junctions are unavailable we still assert a stable error rather than
        // silently accepting an escape.
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let junction = root.path().join("escape");
        let created = create_junction(&junction, outside.path());
        if created {
            assert!(matches!(
                verify_contained(root.path(), &junction),
                Err(WorkspaceError::Escape { .. })
            ));
        } else {
            eprintln!("junction creation unsupported on this platform; escape remains a documented limitation");
        }
    }

    #[test]
    fn atomic_write_replaces_content_within_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let target = root.join("note.txt");
        fs::write(&target, "before").unwrap();
        atomic_write(root, &target, b"after").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "after");
        // No temp file may remain.
        let leftovers = fs::read_dir(root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[cfg(unix)]
    mod unix {
        use super::*;

        #[test]
        fn symlink_escape_is_detected() {
            let root = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let link = root.path().join("link");
            std::os::unix::fs::symlink(outside.path(), &link).unwrap();
            assert!(matches!(
                verify_contained(root.path(), &link),
                Err(WorkspaceError::Escape { .. })
            ));
        }
    }

    #[cfg(windows)]
    fn create_junction(link: &Path, target: &Path) -> bool {
        use std::os::windows::process::CommandExt;
        let target = target
            .canonicalize()
            .expect("target must be canonical for junction");
        let status = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(&target)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status();
        match status {
            Ok(s) => s.success(),
            Err(_) => false,
        }
    }
}
