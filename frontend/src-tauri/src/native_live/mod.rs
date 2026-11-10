//! Native screen share (Windows): a monitor or window captured with Windows Graphics Capture,
//! encoded to H.264 on the GPU (encoder.rs) and sent over WebRTC (str0m, webrtc.rs) to the call's
//! SFU, on the same media port as the app. Resolution and frame rate follow the bandwidth
//! (ladder.rs). The page does the signaling (core/native-live.js). Measurements and limits:
//! docs/spikes/10-live-nativa.md.

// Almost every line here is a COM/D3D/Media Foundation call: `unsafe fn` bodies stay one unsafe block.
#![allow(unsafe_op_in_unsafe_fn)]

mod encoder;
mod ladder;
mod sources;
mod webrtc;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use windows::core::Interface;
use windows::Graphics::Capture::Direct3D11CaptureFramePool;
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::{MFShutdown, MFStartup, MFSTARTUP_FULL, MF_VERSION};
use windows::Win32::System::Threading::{AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use encoder::Encoder;
use ladder::{loss_limit, step_size, steps, Ladder, Optimize, Step};
use sources::{Kind, SourceId};

/// The encoder spends this share of the bandwidth estimate (the rest: RTX, RTCP, headroom).
const BUDGET_SHARE: f64 = 0.85;
/// The slowest viewer's bandwidth as the server estimates it towards them (a report every 2 s),
/// read every VIEWER_EVERY: the live keeps under VIEWER_SHARE of the median of the last 3 reads
/// (the higher one of 2), following it down at once and up by VIEWER_RISE per read at most. That
/// estimate is no capacity (measured): it stays put while the live sends less (3954 kbps for 40 s),
/// creeps 15-30% above the link before falling back (4.6-5.2 Mbps on a 4 Mbps one: at 85% that
/// lost up to 722 packets in 5 s and froze 33 s out of 170), and once read 100 kbps for a viewer
/// who had just joined. So 70%: on a fast link the live may stay a step lower than it could, which
/// the detail steps take out of the frame rate, not the resolution.
/// While the live sends under VIEWER_IDLE of that part (a still picture costs ~10 kbps), the
/// estimate only follows what it sends: a viewer on 1.5 Mbps read ~330 kbps with the live at
/// ~17 kbps, which kept a chat window at 720p for minutes (measured). Then a lower read is left
/// out and a higher one (mediasoup's probes) still counts. Following the highest recent read
/// instead fed on itself through the pace: the live sent less, read less, and stopped (measured).
/// Keyframes don't count as sending: a new encoder's keyframe made a single low read count.
const VIEWER_SHARE: f64 = 0.7;
const VIEWER_IDLE: f64 = 0.5;
/// str0m sends no faster than the highest viewer read of the last PACE_READS (~the slowest viewer's
/// link: mediasoup's probes read 1.4-1.9 Mbps on a 1.5 Mbps one, measured), and never under
/// PACE_MIN_KBPS. The server forwards each packet as it comes, and a chat scroll or keyframe sent at
/// our own link's speed overflowed a viewer's router queue (1.5 Mbps, 200 ms: ~19 packets lost per
/// message). Pacing by the viewers' part of the budget instead fed on itself (sending less, the
/// reads fell, and the live stopped, measured); the floor keeps low reads from doing that.
const PACE_READS: usize = 15; // 30 s
const PACE_MIN_KBPS: u32 = 1000;
const VIEWER_RISE: f64 = 0.15;
const VIEWER_EVERY: Duration = Duration::from_secs(2);
/// Nobody watching (or no estimate yet): no need to fill the uplink. A first viewer starts from
/// here instead of from 1080p60 at 7.5 Mbps, which froze a 4 Mbps viewer for 8.8 s (measured).
const IDLE_KBPS: u32 = 2000;
/// The send queue: written to str0m, not yet out on the network. str0m sends at 1.1x its estimate
/// and only forces the queue out past 2 s: when the encoder made more than that (1080p60 of a busy
/// picture on a 4 Mbps uplink, measured), the delay grew to 1.5 s and the picture froze for 1.4 s.
/// - From PUSHBACK_FROM_MS the encoder gets less bitrate, down to half at PUSHBACK_FULL_MS.
/// - Above QUEUE_DROP_MS every other frame is left out, and above twice that all of them, until
///   the queue is back under QUEUE_RESUME_MS. Leaving out every frame at 150 ms meant a ~230 ms
///   hitch each time (every ~10 s with the estimate swinging around a 4 Mbps link, measured).
const PUSHBACK_FROM_MS: u64 = 40;
const PUSHBACK_FULL_MS: u64 = 120;
const QUEUE_DROP_MS: u64 = 150;
const QUEUE_RESUME_MS: u64 = 80;
/// Skipping frames about a fifth of the time (decayed over ~3 s) while the budget says the step
/// fits means the encoder makes more than it's asked for: one step down. Not in the first seconds
/// of a step, while its first keyframe is still going out.
const SKIP_DECAY: f64 = 3.0;
const SKIP_STEP_DOWN: f64 = 0.6;
const SKIP_SETTLE: Duration = Duration::from_secs(3);
/// The picture waits for the share's sound (`native_live_audio_lead`): it reaches WebRTC later,
/// through the native capture and the page's player worklet. Never more than HOLD_MAX, and the wait
/// moves by HOLD_RATE (seconds per second) at most, so the picture never jumps.
const HOLD_MAX: Duration = Duration::from_millis(400);
const HOLD_RATE: f64 = 0.05;
/// Forced keyframes at most this often: under congestion every PLI's keyframe makes it worse.
const KEYFRAME_GAP: Duration = Duration::from_secs(1);
const START_KBPS: u32 = 1500;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// The capture only delivers frames when the picture changes: on a still screen the last frame is
/// sent again this often, so a viewer who starts watching gets a picture (and its keyframe).
const REFRESH_EVERY: Duration = Duration::from_secs(1);
/// ICE "disconnected" can come back by itself (a VPN hiccup); only this long without the server
/// ends the live. Meanwhile a signaling reconnect may restart it on a new transport.
const DISCONNECT_GRACE: Duration = Duration::from_secs(20);
/// Capture buffers: one stays held as the frame to resend while the screen is still.
const POOL_BUFFERS: i32 = 3;
/// The page's previews of the live (core/screen-preview.js) are about this wide.
const PREVIEW_WIDTH: u32 = 384;

/// What the page reaches in a running live, besides its quality and stopping it.
#[derive(Clone, Default)]
struct Taps {
    /// A preview the page asked for (for the room), answered from the last frame.
    preview: Arc<Mutex<Option<mpsc::Sender<Result<Vec<u8>, String>>>>>,
    /// Our own tile: gets every encoded frame (see `native_live_watch`).
    watcher: Arc<Mutex<Option<Channel<InvokeResponseBody>>>>,
    /// A new watcher's decoder needs a keyframe to start.
    keyframe: Arc<AtomicBool>,
    /// The slowest viewer's bandwidth (kbps) as the server sees it; 0 = nobody watching, u32::MAX =
    /// no report yet.
    viewer_kbps: Arc<AtomicU32>,
    /// The worst share of packets a viewer lost, per thousand (the server's report); u32::MAX =
    /// not told (an older server).
    viewer_loss: Arc<AtomicU32>,
    /// How much later the share's sound reaches WebRTC (ms): the picture waits that long.
    audio_lead_ms: Arc<AtomicU32>,
}

impl Taps {
    /// Hands one frame (from `Sender::complete`) to the watcher, if any: time in µs (u64 LE),
    /// keyframe (u8), Annex B data.
    fn show(&self, frame: &[u8], key: bool, time_100ns: i64) {
        if let Some(watcher) = self.watcher.lock().unwrap().as_ref() {
            let mut message = Vec::with_capacity(9 + frame.len());
            message.extend_from_slice(&((time_100ns / 10) as u64).to_le_bytes());
            message.push(key as u8);
            message.extend_from_slice(frame);
            let _ = watcher.send(InvokeResponseBody::Raw(message));
        }
    }
}

/// The quality picked in Settings › Streaming: the top of the ladder.
#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Quality {
    /// None = the monitor's own height.
    pub max_height: Option<u32>,
    pub max_fps: u32,
    pub max_kbps: u32,
    /// "Optimize for": what to give up first when the bandwidth falls short (the default is detail: text).
    #[serde(default)]
    pub optimize: Optimize,
}

/// The server's `createTransport` answer, trimmed to what the sender needs.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteArgs {
    ufrag: String,
    pwd: String,
    ip: String,
    port: u16,
    /// "sha-256 AB:CD:..."
    fingerprint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalParams {
    fingerprint: String,
    ssrc: u32,
    rtx_ssrc: u32,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum LiveEvent {
    Connected,
    Step { width: u32, height: u32, fps: u32 },
    /// Every 2 s: what the capture delivered and what went out (call.screenStats()). `skipped_fps`:
    /// frames left out while the send queue was too long (`queue_ms`); `loop_max_ms`: the longest
    /// pass of the send loop; `frame_gap_max_ms`: the longest wait between sent frames.
    Stats {
        captured_fps: f64,
        encoded_fps: f64,
        skipped_fps: f64,
        queue_ms: u32,
        kbps: u32,
        estimate_kbps: u32,
        budget_kbps: u32,
        width: u32,
        height: u32,
        fps: u32,
        loop_max_ms: u32,
        frame_gap_max_ms: u32,
        /// How long the picture waits for the share's sound (`native_live_audio_lead`).
        hold_ms: u32,
    },
    /// The share ended on its own (`error`), or after `native_live_stop` (no error).
    Ended { error: Option<String> },
}

struct Running {
    stop: Arc<AtomicBool>,
    quality: Arc<Mutex<Quality>>,
    taps: Taps,
    thread: JoinHandle<()>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

fn stop_running() {
    let running = RUNNING.lock().unwrap().take();
    if let Some(r) = running {
        r.stop.store(true, Ordering::Relaxed);
        let _ = r.thread.join();
    }
}

/// Stops the live whose stop flag is `stop`, if it's still the registered one.
fn stop_if_current(stop: &Arc<AtomicBool>) {
    let mut running = RUNNING.lock().unwrap();
    if running.as_ref().is_some_and(|r| Arc::ptr_eq(&r.stop, stop)) {
        let r = running.take().unwrap();
        drop(running);
        r.stop.store(true, Ordering::Relaxed);
        let _ = r.thread.join();
    }
}

/// Starts capturing and connecting; resolves once capture and encoder work (so the page can fall
/// back to getDisplayMedia otherwise), with what goes into `connectTransport` and `produce`.
#[tauri::command]
pub async fn native_live_start(source: SourceId, remote: RemoteArgs, quality: Quality, on_event: Channel<LiveEvent>) -> Result<LocalParams, String> {
    stop_running();
    let stop = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(Mutex::new(quality));
    let taps = Taps { viewer_kbps: Arc::new(AtomicU32::new(u32::MAX)), viewer_loss: Arc::new(AtomicU32::new(u32::MAX)), ..Default::default() };
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("native-live".into())
        .spawn({
            let (stop, shared, taps) = (stop.clone(), shared.clone(), taps.clone());
            move || {
                let result = unsafe { run(source, remote, shared, stop, taps, &ready_tx, &on_event) };
                if let Err(error) = &result {
                    log::warn!("native live: {error}");
                    let _ = ready_tx.send(Err(error.clone())); // ignored if already started
                }
                let _ = on_event.send(LiveEvent::Ended { error: result.err() });
            }
        })
        .map_err(|e| e.to_string())?;
    // Registered before it's ready, so a stop (or another start) during startup reaches it.
    *RUNNING.lock().unwrap() = Some(Running { stop: stop.clone(), quality: shared, taps, thread });
    let ready = ready_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "the native capture did not start".to_string());
    match ready {
        Ok(Ok(_)) if stop.load(Ordering::Relaxed) => Err("the share was stopped".into()),
        Ok(Ok(local)) => Ok(local),
        Ok(Err(error)) | Err(error) => {
            stop_if_current(&stop);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn native_live_stop() {
    stop_running();
}

/// Monitors and windows for the picker (no thumbnails: those come one by one, see below).
#[tauri::command]
pub async fn native_live_sources() -> Result<Vec<sources::Source>, String> {
    tauri::async_runtime::spawn_blocking(sources::list).await.map_err(|e| e.to_string())
}

/// One source's thumbnail, as JPEG bytes (an ArrayBuffer on the page).
#[tauri::command]
pub async fn native_live_thumbnail(source: SourceId) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || unsafe {
        RoInitialize(RO_INIT_MULTITHREADED).map_err(err("WinRT"))?;
        sources::thumbnail(source, 384)
    })
    .await
    .map_err(|e| e.to_string())?
    .map(tauri::ipc::Response::new)
}

/// A small JPEG of what the running live sends (its last frame, scaled on the GPU): the page shows
/// it on our own tile and sends it to the room. Far cheaper than a new capture (a thumbnail).
#[tauri::command]
pub async fn native_live_preview() -> Result<tauri::ipc::Response, String> {
    let (tx, rx) = mpsc::channel();
    match RUNNING.lock().unwrap().as_ref() {
        Some(r) => *r.taps.preview.lock().unwrap() = Some(tx),
        None => return Err("no live".into()),
    }
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(2)).map_err(|_| "no frame yet".to_string())?)
        .await
        .map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

/// Our own live as it's sent, for our tile (core/native-live.js decodes it with WebCodecs): every
/// encoded frame goes to `on_frame`, starting at a keyframe.
#[tauri::command]
pub fn native_live_watch(on_frame: Channel<InvokeResponseBody>) {
    if let Some(r) = RUNNING.lock().unwrap().as_ref() {
        r.taps.keyframe.store(true, Ordering::Relaxed);
        *r.taps.watcher.lock().unwrap() = Some(on_frame);
    }
}

#[tauri::command]
pub fn native_live_unwatch() {
    if let Some(r) = RUNNING.lock().unwrap().as_ref() {
        *r.taps.watcher.lock().unwrap() = None;
    }
}

/// The server's estimate of the slowest viewer's bandwidth (kbps), or None when nobody watches.
/// The live has one layer, so it has to fit the slowest viewer. `loss`: the worst share of packets
/// a viewer lost (0-1), when the server tells.
#[tauri::command]
pub fn native_live_viewer_kbps(kbps: Option<u32>, loss: Option<f32>) {
    if let Some(r) = RUNNING.lock().unwrap().as_ref() {
        r.taps.viewer_kbps.store(kbps.unwrap_or(0), Ordering::Relaxed);
        r.taps.viewer_loss.store(loss.map_or(u32::MAX, |l| (l.clamp(0.0, 1.0) * 1000.0) as u32), Ordering::Relaxed);
    }
}

/// How much later than the picture the share's sound reaches WebRTC (ms; 0 = no sound): the
/// picture waits that long before going out, so viewers get both together (core/screen-audio.js).
#[tauri::command]
pub fn native_live_audio_lead(ms: u32) {
    if let Some(r) = RUNNING.lock().unwrap().as_ref() {
        r.taps.audio_lead_ms.store(ms, Ordering::Relaxed);
    }
}

/// Settings changed during the share: the new top of the ladder applies right away.
#[tauri::command]
pub fn native_live_set_quality(quality: Quality) {
    if let Some(r) = RUNNING.lock().unwrap().as_ref() {
        *r.quality.lock().unwrap() = quality;
    }
}

/// The viewers' part of the budget after a read: down to `wanted` at once and up by VIEWER_RISE at
/// most, except that while the live sends under VIEWER_IDLE of it a lower read is left out.
fn next_viewer_budget(budget: u32, wanted: u32, sent_kbps: u32) -> u32 {
    let next = wanted.min((budget as f64 * (1.0 + VIEWER_RISE)) as u32);
    if (sent_kbps as f64) < budget as f64 * VIEWER_IDLE {
        budget.max(next)
    } else {
        next
    }
}

/// The quality ladder for the picked quality (its top step) and capture size.
fn ladder_steps(q: &Quality, capture: (u32, u32)) -> Vec<Step> {
    steps(q.max_height.unwrap_or(capture.1), q.max_fps.max(1), q.max_kbps, capture, q.optimize)
}

/// Error text for a failed Windows call, naming the part that failed.
fn err(what: &'static str) -> impl Fn(windows::core::Error) -> String {
    move |e| format!("{what}: {e}")
}

/// A hardware D3D11 device usable from several threads, and its WinRT twin for the capture.
unsafe fn create_device() -> Result<(ID3D11Device, IDirect3DDevice), String> {
    let mut device = None;
    D3D11CreateDevice(
        None,
        D3D_DRIVER_TYPE_HARDWARE,
        HMODULE::default(),
        D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
        None,
        D3D11_SDK_VERSION,
        Some(&mut device),
        None,
        None,
    )
    .map_err(err("Direct3D"))?;
    let device: ID3D11Device = device.unwrap();
    let _ = device.cast::<ID3D11Multithread>().map_err(err("Direct3D"))?.SetMultithreadProtected(true);
    let winrt: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>().map_err(err("Direct3D"))?)
        .and_then(|d| d.cast())
        .map_err(err("Direct3D"))?;
    Ok((device, winrt))
}

/// The D3D texture behind a capture frame.
fn frame_texture(frame: &windows::Graphics::Capture::Direct3D11CaptureFrame) -> Result<ID3D11Texture2D, String> {
    frame
        .Surface()
        .and_then(|s| s.cast::<IDirect3DDxgiInterfaceAccess>())
        .and_then(|a| unsafe { a.GetInterface() })
        .map_err(err("capture"))
}

unsafe fn run(
    source: SourceId,
    remote: RemoteArgs,
    shared: Arc<Mutex<Quality>>,
    stop: Arc<AtomicBool>,
    taps: Taps,
    ready: &mpsc::Sender<Result<LocalParams, String>>,
    events: &Channel<LiveEvent>,
) -> Result<(), String> {
    RoInitialize(RO_INIT_MULTITHREADED).map_err(err("WinRT"))?;
    MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(err("Media Foundation"))?;
    // The loop below wakes every ~1 ms. At normal priority a busy PC kept it waiting: 1 ms sleeps
    // took up to 27 ms (p99) and 97 ms (max) with this PC busy, measured; registered with MMCSS
    // ("Capture"), 2 ms at most. A game in front makes it worse.
    let mut task = 0u32;
    let mmcss = AvSetMmThreadCharacteristicsW(windows::core::w!("Capture"), &mut task);
    if let Err(e) = &mmcss {
        log::warn!("native live: MMCSS: {e}");
    }
    let result = (|| {
        let (device, winrt_device) = create_device()?;
        let item = sources::capture_item(source)?;
        let mut size = item.Size().map_err(err("capture"))?;
        let mut capture = (size.Width as u32, size.Height as u32);
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, POOL_BUFFERS, size)
            .map_err(err("capture"))?;
        let session = pool.CreateCaptureSession(&item).map_err(err("capture"))?;
        let _ = session.SetIsBorderRequired(false); // no yellow frame, where Windows allows it

        let mut quality = *shared.lock().unwrap();
        let mut budget = (START_KBPS as f64 * BUDGET_SHARE) as u32;
        let mut ladder = Ladder::new(ladder_steps(&quality, capture), budget, Instant::now());
        // Made for the most frames a second any step at this size has: going between those steps
        // then keeps the encoder (Encoder::set_fps) and sends no keyframe.
        let make = |s: Step, steps: &[Step], budget: u32, capture: (u32, u32)| {
            let (w, h) = step_size(capture, s.height);
            let kbps = budget.min(s.max_kbps);
            let rate = steps.iter().filter(|x| x.height == s.height).map(|x| x.fps).max().unwrap_or(s.fps);
            let began = Instant::now();
            let enc = Encoder::new(&device, capture, w, h, rate, s.fps, kbps).map_err(err("H.264 encoder"))?;
            log::info!("native live: encoder {}x{} -> {w}x{h}@{}, {kbps} kbps ({} ms)", capture.0, capture.1, s.fps, began.elapsed().as_millis());
            let _ = events.send(LiveEvent::Step { width: w, height: h, fps: s.fps });
            Ok::<_, String>(enc)
        };
        let mut enc = make(ladder.step(), &ladder.steps, budget, capture)?;
        log::info!("native live: {} {}x{} -> {}x{}@{}", enc.name, capture.0, capture.1, enc.width, enc.height, enc.fps);

        let addr = format!("{}:{}", remote.ip, remote.port).parse().map_err(|e| format!("server address: {e}"))?;
        let remote = webrtc::Remote { ufrag: remote.ufrag, pwd: remote.pwd, addr, fingerprint: remote.fingerprint };
        let (mut net, local) = webrtc::Sender::new(&remote, START_KBPS as u64, quality.max_kbps as u64).map_err(|e| format!("WebRTC: {e}"))?;
        let _ = ready.send(Ok(LocalParams { fingerprint: local.fingerprint, ssrc: local.ssrc, rtx_ssrc: local.rtx_ssrc }));

        session.StartCapture().map_err(err("capture"))?;
        let start = Instant::now();
        let mut next_due = start;
        let mut latest = None;
        // The last frame encoded, kept to resend while the screen is still.
        let mut last_frame: Option<windows::Graphics::Capture::Direct3D11CaptureFrame> = None;
        let mut last_encode = start;
        // Encode `last_frame` on the next chance (a forced keyframe or a new encoder needs a frame).
        let mut refresh_now = false;
        let mut keyframe_pending = false;
        let mut disconnected_since: Option<Instant> = None;
        let mut last_forced: Option<Instant> = None;
        let mut ever_connected = false;
        let mut estimate_budget = budget;
        // The viewers' part of the budget, their last reads (VIEWER_EVERY) and when.
        let (mut viewer_budget, mut viewer_reads, mut viewer_read_at) = (IDLE_KBPS, Vec::new(), start);
        let mut viewer_bytes = 0u64; // encoded since the last read
        let mut pace_reads = VecDeque::new(); // the last PACE_READS reads
        let mut limit: Option<u32> = None;
        // The same limit for loss on the viewers' side (the server's report). Their estimate stays at
        // the link's speed while retransmissions fill the link: a viewer on 1.3 Mbps got ~830 kbps
        // of them and not one frame for minutes, with the live sending ~900 kbps (measured).
        let mut viewer_limit: Option<u32> = None;
        // The encoder's bitrate: the budget under the step's cap, less while the send queue grows.
        let target = |budget: u32, s: Step, queue_ms: u64| {
            let room = PUSHBACK_FULL_MS - PUSHBACK_FROM_MS;
            let pushback = 1.0 - 0.5 * queue_ms.saturating_sub(PUSHBACK_FROM_MS).min(room) as f64 / room as f64;
            (budget.min(s.max_kbps) as f64 * pushback) as u32
        };
        let mut asked = budget.min(ladder.step().max_kbps); // the bitrate the encoder has now
        let mut window_checked = start;
        let (mut captured, mut encoded, mut skipped, mut bytes, mut stats_at) = (0u32, 0u32, 0u32, 0u64, start);
        // Skipping frames while the send queue is too long (QUEUE_DROP_MS), and how much of the
        // recent past it did (seconds, decayed over SKIP_DECAY s).
        let (mut skipping, mut skip_score, mut queue_ms, mut stepped_at) = (false, 0.0f64, 0u64, start);
        let (mut last_pass, mut loop_max, mut last_sent, mut frame_gap_max) = (start, Duration::ZERO, None::<Instant>, Duration::ZERO);
        // Encoded frames waiting for the sound (HOLD_MAX): when each goes out, data, RTP time.
        let (mut hold, mut held) = (Duration::ZERO, VecDeque::<(Instant, Vec<u8>, u64)>::new());

        while !stop.load(Ordering::Relaxed) {
            let pass = Instant::now();
            let dt = (pass - last_pass).as_secs_f64();
            loop_max = loop_max.max(pass - last_pass);
            last_pass = pass;
            skip_score = skip_score * (-dt / SKIP_DECAY).exp() + if skipping { dt } else { 0.0 };
            let wanted = Duration::from_millis(taps.audio_lead_ms.load(Ordering::Relaxed) as u64).min(HOLD_MAX);
            let step = Duration::from_secs_f64(dt * HOLD_RATE);
            hold = if wanted > hold { (hold + step).min(wanted) } else { hold.saturating_sub(step).max(wanted) };
            let mut resized = false;
            while let Ok(frame) = pool.TryGetNextFrame() {
                let content = frame.ContentSize().map_err(err("capture"))?;
                if (content.Width as u32) < sources::MIN_SIDE || (content.Height as u32) < sources::MIN_SIDE {
                    continue; // minimized: the last frame keeps going out until the window is back
                }
                if (content.Width, content.Height) != (size.Width, size.Height) {
                    // The window changed size: new buffers and a new encoder at the new size.
                    drop(frame);
                    (latest, last_frame) = (None, None); // old-size frames, back to the old pool
                    size = content;
                    capture = (size.Width as u32, size.Height as u32);
                    pool.Recreate(&winrt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, POOL_BUFFERS, size).map_err(err("capture"))?;
                    resized = true;
                    break;
                }
                captured += 1;
                latest = Some(frame); // older ones are dropped, like a live does
            }
            if resized {
                ladder.set_steps(ladder_steps(&quality, capture));
                enc = make(ladder.step(), &ladder.steps, budget, capture)?;
                (last_forced, keyframe_pending) = (Some(Instant::now()), false);
                asked = budget.min(ladder.step().max_kbps);
            }
            for frame in enc.poll().map_err(err("H.264 encoder"))? {
                encoded += 1;
                bytes += frame.data.len() as u64;
                let (data, key) = net.complete(&frame.data);
                if !key {
                    viewer_bytes += frame.data.len() as u64;
                }
                taps.show(&data, key, frame.time); // our own tile doesn't wait for the sound
                held.push_back((Instant::now() + hold, data, (frame.time * 9 / 1000) as u64));
            }
            while held.front().is_some_and(|(due, ..)| *due <= Instant::now()) {
                let (_, data, rtp_time) = held.pop_front().unwrap();
                net.send_frame(data, rtp_time).map_err(|e| format!("WebRTC: {e}"))?;
                let sent = Instant::now();
                frame_gap_max = frame_gap_max.max(last_sent.map_or(Duration::ZERO, |t| sent - t));
                last_sent = Some(sent);
            }
            let now = Instant::now();
            // The send queue is too long: every frame stays out past twice the limit (below it, every
            // other one: see where the next frame gets due).
            let skip_all = skipping && queue_ms > 2 * QUEUE_DROP_MS;
            if skip_all && now >= next_due && latest.take().is_some() {
                skipped += 1;
                next_due = (next_due + Duration::from_secs_f64(1.0 / enc.fps as f64)).max(now);
            }
            if !skip_all && enc.wants_input() && now >= next_due {
                let fresh = latest.take();
                let got_fresh = fresh.is_some();
                let resend = !got_fresh && (refresh_now || now - last_encode >= REFRESH_EVERY);
                if let Some(frame) = fresh {
                    last_frame = Some(frame); // the one it replaces goes back to the pool
                }
                if let Some(frame) = last_frame.as_ref().filter(|_| got_fresh || resend) {
                    let tex = frame_texture(frame)?;
                    enc.encode(&tex, (now - start).as_nanos() as i64 / 100).map_err(err("H.264 encoder"))?;
                    (last_encode, refresh_now) = (now, false);
                    let frames = if skipping { 2.0 } else { 1.0 }; // skipping: the next one stays out
                    next_due = (next_due + Duration::from_secs_f64(frames / enc.fps as f64)).max(now);
                    skipped += skipping as u32;
                }
            }
            if let Some(frame) = last_frame.as_ref() {
                if let Some(reply) = taps.preview.lock().unwrap().take() {
                    let _ = reply.send(frame_texture(frame).and_then(|tex| sources::frame_jpeg(&device, &tex, PREVIEW_WIDTH)));
                }
            }
            std::thread::sleep(Duration::from_millis(1));

            let signals = net.drive().map_err(|e| format!("WebRTC: {e}"))?;
            let now = Instant::now();
            let span = (now - stats_at).as_secs_f64();
            if span >= 2.0 {
                let _ = events.send(LiveEvent::Stats {
                    captured_fps: captured as f64 / span,
                    encoded_fps: encoded as f64 / span,
                    skipped_fps: skipped as f64 / span,
                    queue_ms: queue_ms as u32,
                    kbps: (bytes as f64 * 8.0 / span / 1000.0) as u32,
                    estimate_kbps: (estimate_budget as f64 / BUDGET_SHARE) as u32,
                    budget_kbps: budget,
                    width: enc.width,
                    height: enc.height,
                    fps: enc.fps,
                    loop_max_ms: loop_max.as_millis() as u32,
                    frame_gap_max_ms: frame_gap_max.as_millis() as u32,
                    hold_ms: hold.as_millis() as u32,
                });
                (captured, encoded, skipped, bytes, stats_at) = (0, 0, 0, 0, now);
                (loop_max, frame_gap_max) = (Duration::ZERO, Duration::ZERO);
            }
            if signals.connected {
                ever_connected = true;
                let _ = events.send(LiveEvent::Connected);
            }
            if signals.disconnected {
                disconnected_since.get_or_insert(now);
            }
            if signals.reconnected {
                disconnected_since = None;
            }
            if disconnected_since.is_some_and(|t| now - t > DISCONNECT_GRACE) {
                return Err("lost the connection to the server".into());
            }
            if source.kind == Kind::Window && now - window_checked > Duration::from_millis(500) {
                window_checked = now;
                if !windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(windows::Win32::Foundation::HWND(source.id as _))).as_bool() {
                    return Err("the window was closed".into());
                }
            }
            if !ever_connected && now - start > CONNECT_TIMEOUT {
                return Err("could not reach the server's media port".into());
            }
            let picked = *shared.lock().unwrap();
            let quality_changed = picked != quality;
            if quality_changed {
                quality = picked;
                net.set_max_kbps(quality.max_kbps as u64);
                ladder.set_steps(ladder_steps(&quality, capture));
            }
            if let Some(bps) = signals.estimate {
                estimate_budget = ((bps / 1000) as f64 * BUDGET_SHARE) as u32;
            }
            if let Some(loss) = signals.loss {
                limit = loss_limit(limit, budget.min(ladder.step().max_kbps), estimate_budget, loss);
            }
            // The send queue in time at str0m's pace (1.1x the estimate, or the viewers' cap), with
            // hysteresis.
            let drain_kbps = (estimate_budget as f64 / BUDGET_SHARE * 1.1).min(net.pace_kbps().map_or(f64::INFINITY, |p| p as f64));
            queue_ms = net.queued_bytes() * 8 / (drain_kbps as u64).max(1);
            skipping = if skipping { queue_ms > QUEUE_RESUME_MS } else { queue_ms > QUEUE_DROP_MS };
            // u32::MAX: no report from the server yet (an old one never sends them); 0: nobody watching.
            let viewers = taps.viewer_kbps.load(Ordering::Relaxed);
            if viewers == 0 {
                viewer_budget = IDLE_KBPS;
                viewer_limit = None;
                viewer_reads.clear();
                viewer_bytes = 0;
                pace_reads.clear();
            } else if now - viewer_read_at >= VIEWER_EVERY {
                viewer_read_at = now;
                let wanted = if viewers == u32::MAX {
                    u32::MAX
                } else {
                    viewer_reads.push(viewers);
                    if viewer_reads.len() > 3 {
                        viewer_reads.remove(0);
                    }
                    pace_reads.push_back(viewers);
                    if pace_reads.len() > PACE_READS {
                        pace_reads.pop_front();
                    }
                    let mut sorted = viewer_reads.clone();
                    sorted.sort_unstable();
                    (sorted[sorted.len() / 2] as f64 * VIEWER_SHARE) as u32
                };
                let sent_kbps = (viewer_bytes * 8 / VIEWER_EVERY.as_millis() as u64) as u32;
                viewer_bytes = 0;
                viewer_budget = next_viewer_budget(viewer_budget, wanted, sent_kbps);
                let lost = taps.viewer_loss.load(Ordering::Relaxed);
                if lost != u32::MAX {
                    viewer_limit = loss_limit(viewer_limit, budget.min(ladder.step().max_kbps), viewer_budget, lost as f32 / 1000.0);
                }
            }
            // No report yet, or nobody watching: nobody's link to pace for.
            let pace = pace_reads.iter().max().map(|&r: &u32| r.max(PACE_MIN_KBPS));
            net.set_pace_kbps(pace);
            // The encoder never makes more than the pace lets out (with the usual headroom).
            let pace_budget = pace.map_or(u32::MAX, |p| (p as f64 * BUDGET_SHARE) as u32);
            budget = limit.map_or(estimate_budget, |l| l.min(estimate_budget)).min(viewer_budget).min(pace_budget).min(viewer_limit.unwrap_or(u32::MAX));
            // Under the step's minimum, the budget steps down by itself (ladder.update).
            let too_big = skip_score > SKIP_STEP_DOWN && budget >= ladder.step().min_kbps && now - stepped_at >= SKIP_SETTLE;
            let changed = if too_big { ladder.too_big(now) } else { ladder.update(budget, now) };
            if let Some(tier) = changed.or(quality_changed.then_some(ladder.tier)) {
                // Which part held the budget, for logs from the field.
                log::info!(
                    "native live: step {tier}, budget {budget} kbps (estimate {estimate_budget}, viewers {}, pace {}, loss limit {}, viewer loss limit {}){}",
                    match viewers {
                        u32::MAX => "?".to_string(),
                        0 => format!("none, {viewer_budget}"),
                        _ => viewer_budget.to_string(),
                    },
                    pace.map_or("-".into(), |p| p.to_string()),
                    limit.map_or("-".into(), |l| l.to_string()),
                    viewer_limit.map_or("-".into(), |l| l.to_string()),
                    if too_big { ", the send queue kept growing" } else { "" }
                );
                let s = ladder.step();
                if step_size(capture, s.height) == (enc.width, enc.height) && s.fps <= enc.rate_fps() {
                    // Only the frame rate: same encoder, no keyframe.
                    enc.set_fps(s.fps, budget.min(s.max_kbps));
                    log::info!("native live: same encoder -> {}x{}@{}, {} kbps", enc.width, enc.height, s.fps, budget.min(s.max_kbps));
                    let _ = events.send(LiveEvent::Step { width: enc.width, height: enc.height, fps: s.fps });
                } else {
                    // New size: a new encoder, whose first frame is a keyframe at the new size.
                    enc = make(s, &ladder.steps, budget, capture)?;
                    (last_forced, keyframe_pending, refresh_now) = (Some(now), false, true);
                }
                (skip_score, stepped_at) = (0.0, now);
                asked = budget.min(s.max_kbps);
            } else {
                if too_big {
                    skip_score = 0.0; // already at the bottom step
                }
                // A new bitrate when it moved by 5% or more (the send queue changes every 100 ms).
                let wanted = target(budget, ladder.step(), queue_ms);
                if wanted.abs_diff(asked) * 20 >= asked.max(1) {
                    enc.set_bitrate(wanted);
                    asked = wanted;
                }
            }
            // A keyframe asked for too soon after the last one waits its turn instead of being dropped.
            keyframe_pending |= signals.keyframe || taps.keyframe.swap(false, Ordering::Relaxed);
            if keyframe_pending && last_forced.is_none_or(|t| now - t >= KEYFRAME_GAP) {
                enc.force_keyframe();
                (last_forced, keyframe_pending, refresh_now) = (Some(now), false, true);
            }
        }
        let _ = session.Close();
        let _ = pool.Close();
        Ok(())
    })();
    let _ = MFShutdown();
    if let Ok(handle) = mmcss {
        let _ = AvRevertMmThreadCharacteristics(handle);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_live_sending_little_keeps_its_viewer_budget_when_reads_drop() {
        // Sending near the budget: a lower read applies at once, a higher one rises 15% at most.
        assert_eq!(next_viewer_budget(1000, 600, 900), 600);
        assert_eq!(next_viewer_budget(1000, 3000, 900), 1150);
        // A still picture (17 kbps): the read only follows what it sends, so it's left out...
        assert_eq!(next_viewer_budget(1000, 230, 17), 1000);
        // ...but a higher one (a probe) still counts.
        assert_eq!(next_viewer_budget(1000, 3000, 17), 1150);
    }

    #[test]
    fn the_top_step_is_the_picked_quality() {
        let q = |h: Option<u32>, fps: u32, motion: bool| Quality { max_height: h, max_fps: fps, max_kbps: 5000, optimize: if motion { Optimize::Motion } else { Optimize::Detail } };
        let capture = (2560, 1440);
        let top = |q: Quality| ladder_steps(&q, capture)[0];
        assert_eq!((top(q(None, 60, false)).height, top(q(None, 60, false)).fps), (1440, 60)); // "Source"
        assert_eq!((top(q(Some(1080), 30, true)).height, top(q(Some(1080), 30, true)).fps), (1080, 30));
        assert_eq!(top(q(Some(1080), 30, true)).max_kbps, 5000);
        // Detail gives up frame rate first, motion resolution.
        assert_eq!(ladder_steps(&q(Some(1080), 60, false), capture)[1].height, 1080);
        assert_eq!(ladder_steps(&q(Some(1080), 60, true), capture)[1].height, 720);
        // What the page sends: "optimize" by name, and nothing at all from an older page.
        let parsed: Quality = serde_json::from_str(r#"{"maxHeight":1080,"maxFps":60,"maxKbps":5000,"optimize":"balanced"}"#).unwrap();
        assert_eq!(parsed.optimize, Optimize::Balanced);
        let old: Quality = serde_json::from_str(r#"{"maxHeight":null,"maxFps":30,"maxKbps":5000}"#).unwrap();
        assert_eq!(old.optimize, Optimize::Detail);
    }

    /// Diagnostic for PCs with two GPUs: which GPU the capture device lands on, which hardware
    /// H.264 encoders there are (and on which GPU), and whether each takes that device.
    /// `cargo test --lib -- --ignored --nocapture gpu_of_device_and_encoders`
    #[test]
    #[ignore]
    fn gpu_of_device_and_encoders() {
        use windows::Win32::Graphics::Dxgi::IDXGIAdapter;
        use windows::Win32::Media::MediaFoundation::*;
        unsafe {
            MFStartup(MF_VERSION, MFSTARTUP_FULL).unwrap();
            let (device, _) = create_device().unwrap();
            let adapter: IDXGIAdapter = device.cast::<IDXGIDevice>().unwrap().GetAdapter().unwrap();
            let desc = adapter.GetDesc().unwrap();
            let name = String::from_utf16_lossy(&desc.Description).trim_end_matches('\0').to_string();
            let luid = ((desc.AdapterLuid.HighPart as u64) << 32) | desc.AdapterLuid.LowPart as u64;
            println!("capture device: {name} (luid {luid:#x})");

            let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
            let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
            let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
            let mut count = 0u32;
            MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, Some(&input), Some(&output), &mut activates, &mut count).unwrap();
            for (i, slot) in std::slice::from_raw_parts_mut(activates, count as usize).iter_mut().enumerate() {
                let activate = slot.take().unwrap();
                let mut text = windows::core::PWSTR::null();
                let mut len = 0;
                let _ = activate.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut text, &mut len);
                let encoder_luid = activate.GetUINT64(&MFT_ENUM_ADAPTER_LUID).ok();
                let label = format!("encoder {i}: {} (luid {})", text.to_string().unwrap_or_default(), encoder_luid.map_or("?".into(), |l| format!("{l:#x}")));
                let transform: IMFTransform = match activate.ActivateObject() {
                    Ok(t) => t,
                    Err(e) => {
                        println!("{label} -> ActivateObject {:?}", e.code());
                        continue;
                    }
                };
                let _ = transform.GetAttributes().unwrap().SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1);
                let mut token = 0u32;
                let mut manager = None;
                MFCreateDXGIDeviceManager(&mut token, &mut manager).unwrap();
                let manager = manager.unwrap();
                manager.ResetDevice(&device, token).unwrap();
                let takes = transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize);
                println!("{label} -> SET_D3D_MANAGER {:?}", takes.map_err(|e| e.code()));
                let _ = activate.ShutdownObject();
            }

            // The same encoders with a device made on each GPU.
            use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
            use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
            let factory: IDXGIFactory1 = CreateDXGIFactory1().unwrap();
            let mut a = 0;
            while let Ok(adapter) = factory.EnumAdapters1(a) {
                a += 1;
                let desc = adapter.GetDesc1().unwrap();
                let name = String::from_utf16_lossy(&desc.Description).trim_end_matches('\0').to_string();
                let mut dev = None;
                let made = D3D11CreateDevice(&adapter, D3D_DRIVER_TYPE_UNKNOWN, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut dev), None, None);
                let Some(dev) = dev.filter(|_| made.is_ok()) else {
                    println!("adapter {name}: no device ({:?})", made.map_err(|e| e.code()));
                    continue;
                };
                let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
                let mut count = 0u32;
                MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, Some(&input), Some(&output), &mut activates, &mut count).unwrap();
                for (i, slot) in std::slice::from_raw_parts_mut(activates, count as usize).iter_mut().enumerate() {
                    let activate = slot.take().unwrap();
                    let result = activate.ActivateObject::<IMFTransform>().and_then(|transform| {
                        transform.GetAttributes()?.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                        let mut token = 0u32;
                        let mut manager = None;
                        MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
                        let manager = manager.unwrap();
                        manager.ResetDevice(&dev, token)?;
                        transform.ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)
                    });
                    println!("adapter {name}: encoder {i} -> {:?}", result.map_err(|e| e.code()));
                    let _ = activate.ShutdownObject();
                }
            }
        }
    }
}
