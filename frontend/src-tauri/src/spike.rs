//! Milestone 6 feasibility spike for screen-share audio (debug builds on Windows only).
//!
//! Answers three questions before building plugins/tauri-plugin-system-audio:
//!   1. Which window did getDisplayMedia pick?  (HWND from the track label -> process)
//!   2. Can we list the apps that are playing audio, with their process trees?
//!   3. Does WASAPI process loopback (include / exclude a process tree) work from here?
//!
//! Everything prints to stdout with a `[spike]` prefix so the results show in the dev terminal.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use serde::Serialize;
use wasapi::{
    initialize_mta, AudioClient, DeviceEnumerator, Direction, SampleType, SessionState, StreamMode, WaveFormat,
};
use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pid: u32,
    exe: Option<String>,
    /// Executable names from the parent up to the root (stops at 16 levels or a missing parent).
    ancestors: Vec<String>,
    /// True if this process is Jay-C itself or one of its children (e.g. the WebView2 processes).
    is_self_tree: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    hwnd: i64,
    title: String,
    process: ProcessInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSession {
    state: String,
    display_name: String,
    peak: f32,
    process: ProcessInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureReport {
    pid: u32,
    include_tree: bool,
    seconds: f32,
    frames: u64,
    packets: u32,
    peak: f32,
    rms: f32,
}

/// pid -> (parent pid, exe name)
fn process_table() -> HashMap<u32, (u32, String)> {
    let mut table = HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return table;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                let exe = String::from_utf16_lossy(&entry.szExeFile[..len]);
                table.insert(entry.th32ProcessID, (entry.th32ParentProcessID, exe));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    table
}

fn process_info(pid: u32, table: &HashMap<u32, (u32, String)>) -> ProcessInfo {
    let me = std::process::id();
    let mut ancestors = Vec::new();
    let mut is_self_tree = pid == me;
    let mut current = pid;
    for _ in 0..16 {
        let Some(&(parent, _)) = table.get(&current) else { break };
        if parent == 0 || parent == current {
            break;
        }
        if parent == me {
            is_self_tree = true;
        }
        match table.get(&parent) {
            Some((_, exe)) => ancestors.push(exe.clone()),
            None => break, // parent exited (or pid reused): stop here
        }
        current = parent;
    }
    ProcessInfo { pid, exe: table.get(&pid).map(|(_, exe)| exe.clone()), ancestors, is_self_tree }
}

fn window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buf);
        String::from_utf16_lossy(&buf[..copied as usize])
    }
}

fn window_info(hwnd: HWND, table: &HashMap<u32, (u32, String)>) -> Option<WindowInfo> {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    (pid != 0).then(|| WindowInfo {
        hwnd: hwnd.0 as i64,
        title: window_title(hwnd),
        process: process_info(pid, table),
    })
}

#[tauri::command]
pub fn spike_log(message: String) {
    println!("[spike] {message}");
}

/// Resolves a window handle (e.g. parsed from a getDisplayMedia track label) to its process.
#[tauri::command]
pub fn spike_window_info(hwnd: i64) -> Result<WindowInfo, String> {
    let info = window_info(HWND(hwnd as *mut _), &process_table())
        .ok_or_else(|| format!("0x{hwnd:x} is not a window"))?;
    println!("[spike] window 0x{hwnd:x}: {:?} -> pid {} {:?} ancestors {:?}", info.title, info.process.pid, info.process.exe, info.process.ancestors);
    Ok(info)
}

/// Plan B for "which window was picked": visible top-level windows whose title contains `query`.
#[tauri::command]
pub fn spike_find_windows(query: String) -> Vec<WindowInfo> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let handles = unsafe { &mut *(lparam.0 as *mut Vec<HWND>) };
        if unsafe { IsWindowVisible(hwnd) }.as_bool() {
            handles.push(hwnd);
        }
        BOOL(1)
    }
    let mut handles: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut handles as *mut _ as isize));
    }
    let table = process_table();
    let query = query.to_lowercase();
    handles
        .into_iter()
        .filter_map(|hwnd| window_info(hwnd, &table))
        .filter(|w| !w.title.is_empty() && w.title.to_lowercase().contains(&query))
        .collect()
}

/// Audio sessions on the default playback device, i.e. "apps that are (or were) playing sound".
#[tauri::command]
pub async fn spike_list_audio_sessions() -> Result<Vec<AudioSession>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<AudioSession>, String> {
        initialize_mta().ok().map_err(|e| e.to_string())?;
        let device = DeviceEnumerator::new()
            .and_then(|e| e.get_default_device(&Direction::Render))
            .map_err(|e| e.to_string())?;
        let sessions = device
            .get_iaudiosessionmanager()
            .and_then(|m| m.get_audiosessionenumerator())
            .map_err(|e| e.to_string())?;
        let table = process_table();
        let mut out = Vec::new();
        for i in 0..sessions.get_count().map_err(|e| e.to_string())? {
            let control = sessions.get_session(i).map_err(|e| e.to_string())?;
            let state = match control.get_state().map_err(|e| e.to_string())? {
                SessionState::Active => "active",
                SessionState::Inactive => "inactive",
                SessionState::Expired => continue,
            };
            let pid = control.get_process_id().unwrap_or(0);
            let peak = control
                .get_audiometerinformation()
                .and_then(|m| m.get_peak_value())
                .unwrap_or(0.0);
            let session = AudioSession {
                state: state.to_string(),
                display_name: control.get_display_name().unwrap_or_default(),
                peak,
                process: process_info(pid, &table),
            };
            println!(
                "[spike] session pid {} {:?} {} peak {:.3} self_tree={} ancestors {:?}",
                pid, session.process.exe, state, peak, session.process.is_self_tree, session.process.ancestors
            );
            out.push(session);
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Captures `seconds` of audio with WASAPI process loopback and reports levels.
/// include_tree=true: only that process tree. include_tree=false: everything except it.
/// `pid = 0` means Jay-C itself (useful with include_tree=false: "all audio except the call").
#[tauri::command]
pub async fn spike_capture(pid: u32, include_tree: bool, seconds: f32) -> Result<CaptureReport, String> {
    let pid = if pid == 0 { std::process::id() } else { pid };
    tauri::async_runtime::spawn_blocking(move || -> Result<CaptureReport, String> {
        initialize_mta().ok().map_err(|e| e.to_string())?;
        let format = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None);
        let mut client =
            AudioClient::new_application_loopback_client(pid, include_tree).map_err(|e| e.to_string())?;
        client
            .initialize_client(
                &format,
                &Direction::Capture,
                &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 },
            )
            .map_err(|e| e.to_string())?;
        let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
        let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
        client.start_stream().map_err(|e| e.to_string())?;

        let started = Instant::now();
        let mut queue: VecDeque<u8> = VecDeque::new();
        let (mut frames, mut packets, mut peak, mut sum_sq, mut samples) = (0u64, 0u32, 0f32, 0f64, 0u64);
        while started.elapsed() < Duration::from_secs_f32(seconds) {
            if event.wait_for_event(200).is_err() {
                continue; // no audio this period
            }
            while capture.get_next_packet_size().map_err(|e| e.to_string())?.unwrap_or(0) > 0 {
                capture.read_from_device_to_deque(&mut queue).map_err(|e| e.to_string())?;
                packets += 1;
            }
            while queue.len() >= 4 {
                let bytes = [queue.pop_front().unwrap(), queue.pop_front().unwrap(), queue.pop_front().unwrap(), queue.pop_front().unwrap()];
                let s = f32::from_le_bytes(bytes);
                peak = peak.max(s.abs());
                sum_sq += (s as f64) * (s as f64);
                samples += 1;
            }
        }
        frames += samples / 2;
        let _ = client.stop_stream();

        let report = CaptureReport {
            pid,
            include_tree,
            seconds: started.elapsed().as_secs_f32(),
            frames,
            packets,
            peak,
            rms: if samples > 0 { (sum_sq / samples as f64).sqrt() as f32 } else { 0.0 },
        };
        println!(
            "[spike] capture pid {} include_tree={} -> {:.1}s, {} frames, {} packets, peak {:.3}, rms {:.4}",
            report.pid, report.include_tree, report.seconds, report.frames, report.packets, report.peak, report.rms
        );
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}
