//! Milestone 6 spike: run several WASAPI process-loopback captures at the same time.
//!
//!   cargo run --example loopback_probe -- <pid>:<include|exclude> [<pid>:<include|exclude> ...] [--secs N]
//!
//! Prints peak/RMS per stream, which shows whether INCLUDE captures real audio and whether
//! multiple concurrent streams (needed to mix "everything except X and Y") work.

#[cfg(windows)]
fn main() {
    use std::collections::VecDeque;
    use std::time::{Duration, Instant};
    use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};

    let mut secs = 3.0f32;
    let mut targets = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--secs" {
            secs = args.next().and_then(|s| s.parse().ok()).unwrap_or(secs);
        } else if let Some((pid, mode)) = arg.split_once(':') {
            targets.push((pid.parse::<u32>().expect("pid"), mode == "include"));
        }
    }

    let handles: Vec<_> = targets
        .into_iter()
        .map(|(pid, include)| {
            std::thread::spawn(move || -> Result<String, String> {
                initialize_mta().ok().map_err(|e| e.to_string())?;
                let format = WaveFormat::new(32, 32, &SampleType::Float, 48_000, 2, None);
                let mut client = AudioClient::new_application_loopback_client(pid, include).map_err(|e| e.to_string())?;
                client
                    .initialize_client(&format, &Direction::Capture, &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 })
                    .map_err(|e| e.to_string())?;
                let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
                let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
                client.start_stream().map_err(|e| e.to_string())?;
                let started = Instant::now();
                let mut queue = VecDeque::new();
                let (mut peak, mut sum_sq, mut n) = (0f32, 0f64, 0u64);
                while started.elapsed() < Duration::from_secs_f32(secs) {
                    if event.wait_for_event(200).is_err() {
                        continue;
                    }
                    while capture.get_next_packet_size().map_err(|e| e.to_string())?.unwrap_or(0) > 0 {
                        capture.read_from_device_to_deque(&mut queue).map_err(|e| e.to_string())?;
                    }
                    let bytes: Vec<u8> = queue.drain(..queue.len() / 4 * 4).collect();
                    for chunk in bytes.chunks_exact(4) {
                        let s = f32::from_le_bytes(chunk.try_into().unwrap());
                        peak = peak.max(s.abs());
                        sum_sq += (s as f64).powi(2);
                        n += 1;
                    }
                }
                let _ = client.stop_stream();
                let rms = if n > 0 { (sum_sq / n as f64).sqrt() } else { 0.0 };
                Ok(format!(
                    "pid {pid} {}: {} frames, peak {peak:.3}, rms {rms:.4}",
                    if include { "INCLUDE" } else { "EXCLUDE" },
                    n / 2
                ))
            })
        })
        .collect();

    for handle in handles {
        match handle.join().unwrap() {
            Ok(line) => println!("[probe] {line}"),
            Err(err) => println!("[probe] error: {err}"),
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows only");
}
