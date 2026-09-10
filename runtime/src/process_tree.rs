//! Process-tree ownership and teardown.
//!
//! On Windows, every owned process tree is assigned to a per-run Job Object
//! created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; teardown terminates the
//! whole job and its active-process count is verified to reach zero before
//! success is claimed. On POSIX (Unix), the leader owns a process group and
//! cancellation signals the whole group (TERM then KILL) with existence
//! verification before success is claimed.
//!
//! The run owns one run ID, deadline, abort signal, and bounded outputs (see
//! `executor.rs`). Detached descendants are an explicit unsupported/error case,
//! not a silent success. Any wait/query/kill/assignment failure is fail-closed
//! and never reported as `teardown_confirmed:true`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum TreeError {
    #[error("failed to create job object: {0}")]
    JobCreate(String),
    #[error("failed to assign process {pid} to job: {details}")]
    Assign { pid: u32, details: String },
    #[error("failed to establish process-group ownership for {pid}: {details}")]
    GroupSetup { pid: u32, details: String },
    #[error("failed to terminate process tree: {0}")]
    Teardown(String),
    #[error("process-tree teardown NOT confirmed: owned processes may remain")]
    Unconfirmed,
}

/// A shared, cancellation-capable ownership token created before spawn. The
/// user may request cancellation at any time; the executor polls it.
#[derive(Clone, Default)]
pub struct CancelToken {
    cancelled: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

pub struct ProcessTreeGuard {
    #[cfg(windows)]
    job: Option<windows_job::JobHandle>,
    #[cfg(unix)]
    pgid: i32,
    #[allow(dead_code)]
    pid: u32,
    confirmed: Arc<std::sync::atomic::AtomicBool>,
}

impl ProcessTreeGuard {
    /// Create supervision for an already-spawned leader process identified by
    /// `pid`.
    ///
    /// Windows: creates an unnamed per-run Job Object and assigns the leader.
    /// Unnamed avoids global-namespace collisions and the NUL-termination
    /// failure that broke `CreateJobObjectW` (Win32 error 3).
    ///
    /// Unix: places the leader in its own process group (`setpgid`) so later
    /// `kill(-pgid)` signals the whole owned tree. `portable-pty` already
    /// fork+setsids the PTY child into its own session on most Unix targets,
    /// in which case `setpgid` fails with EACCES/EPERM because the child is a
    /// session leader; that is already isolated, so we fall back to the
    /// leader's current pgid discovered via `getpgid`. If `getpgid` also
    /// fails (leader already reaped), supervision fails closed.
    pub fn supervise(pid: u32) -> Result<Self, TreeError> {
        #[cfg(windows)]
        {
            let job = windows_job::create_kill_on_close_job().map_err(TreeError::JobCreate)?;
            windows_job::assign_process(&job, pid)
                .map_err(|details| TreeError::Assign { pid, details })?;
            return Ok(Self {
                job: Some(job),
                pid,
                confirmed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });
        }
        #[cfg(unix)]
        {
            let pid_i = pid as i32;
            unsafe {
                let _ = libc::setpgid(pid_i, pid_i);
            }
            let pgid = unsafe { libc::getpgid(pid_i) };
            if pgid < 0 {
                let err = std::io::Error::last_os_error();
                return Err(TreeError::GroupSetup {
                    pid,
                    details: format!("getpgid({}) failed: {}", pid, err),
                });
            }
            return Ok(Self {
                pgid,
                pid,
                confirmed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = pid;
            return Err(TreeError::Teardown(
                "process-tree supervision unsupported on this platform".into(),
            ));
        }
    }

    /// Cancel the whole process tree and verify teardown. Returns distinct
    /// errors when the owned tree cannot be confirmed dead (fail-closed).
    pub fn cancel_tree(&mut self) -> Result<(), TreeError> {
        #[cfg(windows)]
        {
            let job = match &self.job {
                Some(j) => j,
                None => {
                    return Err(TreeError::Unconfirmed);
                }
            };
            windows_job::terminate_job(job)
                .map_err(|source| TreeError::Teardown(format!("terminate job: {}", source)))?;
            for _ in 0..100 {
                match windows_job::active_process_count(job) {
                    Ok(0) => {
                        self.confirmed.store(true, Ordering::SeqCst);
                        return Ok(());
                    }
                    Ok(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
                    Err(details) => {
                        return Err(TreeError::Teardown(format!(
                            "query job active count: {}",
                            details
                        )));
                    }
                }
            }
            return Err(TreeError::Unconfirmed);
        }
        #[cfg(unix)]
        {
            unix_tree::terminate_group(self.pgid)?;
            for _ in 0..100 {
                if unix_tree::group_is_empty(self.pgid) {
                    self.confirmed.store(true, Ordering::SeqCst);
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            return Err(TreeError::Unconfirmed);
        }
        #[cfg(not(any(windows, unix)))]
        {
            return Err(TreeError::Unconfirmed);
        }
    }

    /// Verify a normally-exited leader left no owned descendants. Must be
    /// called on the `try_wait()==Some` path before claiming
    /// `teardown_confirmed:true`. If descendants linger, they are terminated
    /// and re-verified; any query/kill failure is fail-closed.
    pub fn confirm_clean_exit(&mut self) -> Result<(), TreeError> {
        if self.is_confirmed() {
            return Ok(());
        }
        #[cfg(windows)]
        {
            let job = match &self.job {
                Some(j) => j,
                None => return Err(TreeError::Unconfirmed),
            };
            match windows_job::active_process_count(job) {
                Ok(0) => {
                    self.confirmed.store(true, Ordering::SeqCst);
                    return Ok(());
                }
                Ok(_) => {
                    windows_job::terminate_job(job)
                        .map_err(|s| TreeError::Teardown(format!("terminate lingering job: {}", s)))?;
                    for _ in 0..100 {
                        match windows_job::active_process_count(job) {
                            Ok(0) => {
                                self.confirmed.store(true, Ordering::SeqCst);
                                return Ok(());
                            }
                            Ok(_) => std::thread::sleep(std::time::Duration::from_millis(50)),
                            Err(d) => {
                                return Err(TreeError::Teardown(format!(
                                    "query lingering job: {}",
                                    d
                                )))
                            }
                        }
                    }
                    return Err(TreeError::Unconfirmed);
                }
                Err(d) => {
                    return Err(TreeError::Teardown(format!("query job: {}", d)));
                }
            }
        }
        #[cfg(unix)]
        {
            if unix_tree::group_is_empty(self.pgid) {
                self.confirmed.store(true, Ordering::SeqCst);
                return Ok(());
            }
            unix_tree::terminate_group(self.pgid)?;
            for _ in 0..100 {
                if unix_tree::group_is_empty(self.pgid) {
                    self.confirmed.store(true, Ordering::SeqCst);
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            return Err(TreeError::Unconfirmed);
        }
        #[cfg(not(any(windows, unix)))]
        {
            return Err(TreeError::Unconfirmed);
        }
    }

    pub fn is_confirmed(&self) -> bool {
        self.confirmed.load(Ordering::SeqCst)
    }

    /// Test-only introspection: number of live processes owned by the tree.
    /// Used by P1B3 A/B/C diagnostics and teardown tests to prove a descendant
    /// exists and is later gone. Never used to claim success unless confirming
    /// zero.
    #[doc(hidden)]
    pub fn live_process_count(&self) -> u64 {
        #[cfg(windows)]
        {
            match &self.job {
                Some(j) => crate::process_tree::windows_job::active_process_count(j).unwrap_or(u64::MAX),
                None => u64::MAX,
            }
        }
        #[cfg(unix)]
        {
            if crate::process_tree::unix_tree::group_is_empty(self.pgid) { 0 } else { 1 }
        }
        #[cfg(not(any(windows, unix)))]
        {
            0
        }
    }
}

#[cfg(unix)]
pub(crate) mod unix_tree {
    use super::TreeError;

    pub fn group_is_empty(pgid: i32) -> bool {
        if pgid <= 0 {
            return false;
        }
        let r = unsafe { libc::kill(-pgid, 0) };
        if r == 0 {
            return false;
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(e) if e == libc::ESRCH => true,
            _ => false,
        }
    }

    fn kill_group(pgid: i32, sig: i32) -> Result<bool, TreeError> {
        if pgid <= 0 {
            return Err(TreeError::Teardown(format!("invalid pgid {}", pgid)));
        }
        let r = unsafe { libc::kill(-pgid, sig) };
        if r == 0 {
            return Ok(true);
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(e) if e == libc::ESRCH => Ok(false),
            Some(e) => Err(TreeError::Teardown(format!(
                "kill(-{}, {}) failed: errno {}",
                pgid, sig, e
            ))),
            None => Err(TreeError::Teardown(format!(
                "kill(-{}, {}) failed: unknown error",
                pgid, sig
            ))),
        }
    }

    pub fn terminate_group(pgid: i32) -> Result<(), TreeError> {
        if group_is_empty(pgid) {
            return Ok(());
        }
        match kill_group(pgid, libc::SIGTERM)? {
            false => return Ok(()),
            true => {}
        }
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if group_is_empty(pgid) {
                return Ok(());
            }
        }
        match kill_group(pgid, libc::SIGKILL)? {
            false => Ok(()),
            true => Ok(()),
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use winapi::shared::minwindef::{DWORD, FALSE};
    use winapi::shared::ntdef::HANDLE;
    use winapi::um::errhandlingapi::GetLastError;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::jobapi2::{
        AssignProcessToJobObject, CreateJobObjectW, QueryInformationJobObject,
        SetInformationJobObject, TerminateJobObject,
    };
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::{
        JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SET_QUOTA, PROCESS_TERMINATE, SYNCHRONIZE,
    };
    use std::ptr;

    #[derive(Debug)]
    pub struct JobHandle(HANDLE);

    impl Drop for JobHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    unsafe impl Send for JobHandle {}

    const PROCESS_ACCESS: DWORD = PROCESS_QUERY_LIMITED_INFORMATION
        | PROCESS_SET_QUOTA
        | PROCESS_TERMINATE
        | SYNCHRONIZE;

    pub fn create_kill_on_close_job() -> Result<JobHandle, String> {
        let handle = unsafe { CreateJobObjectW(ptr::null_mut(), ptr::null()) };
        if handle.is_null() {
            return Err(format!("CreateJobObjectW failed: {}", last_error()));
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let result = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut winapi::ctypes::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if result == 0 {
            let err = last_error();
            unsafe {
                CloseHandle(handle);
            }
            return Err(format!("SetInformationJobObject failed: {}", err));
        }
        Ok(JobHandle(handle))
    }

    pub fn assign_process(job: &JobHandle, pid: u32) -> Result<(), String> {
        let process = unsafe { OpenProcess(PROCESS_ACCESS, FALSE, pid) };
        if process.is_null() {
            return Err(format!("OpenProcess({}) failed: {}", pid, last_error()));
        }
        let result = unsafe { AssignProcessToJobObject(job.0, process) };
        let close_result = unsafe { CloseHandle(process) };
        if result == 0 {
            let err = last_error();
            return Err(format!(
                "AssignProcessToJobObject({}) failed: {}",
                pid, err
            ));
        }
        let _ = close_result;
        Ok(())
    }

    pub fn terminate_job(job: &JobHandle) -> Result<(), String> {
        let result = unsafe { TerminateJobObject(job.0, 1) };
        if result == 0 {
            return Err(format!("TerminateJobObject failed: {}", last_error()));
        }
        Ok(())
    }

    pub fn active_process_count(job: &JobHandle) -> Result<u64, String> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let result = unsafe {
            QueryInformationJobObject(
                job.0,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                ptr::null_mut(),
            )
        };
        if result == 0 {
            return Err(format!("QueryInformationJobObject failed: {}", last_error()));
        }
        Ok(info.ActiveProcesses.into())
    }

    fn last_error() -> String {
        let code = unsafe { GetLastError() };
        format!("Win32 error {}", code)
    }
}
