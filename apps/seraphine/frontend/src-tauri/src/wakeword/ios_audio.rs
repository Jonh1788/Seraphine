//! Rust side of the iOS wake-word microphone bridge.
//!
//! The Swift half lives in `swift/WakeWordAudio.swift` and is compiled into
//! the same static library by `build.rs`. It pushes 16 kHz mono Int16 frames
//! back through [`super::seraphine_wakeword_push_pcm`].

extern "C" {
    fn seraphine_wakeword_audio_start() -> i32;
    fn seraphine_wakeword_audio_stop();
}

/// Error codes mirrored from `WakeWordAudio.swift`.
fn describe(code: i32) -> String {
    match code {
        -1 => "microfone negado — autorize o acesso nos Ajustes do iPhone".into(),
        -2 => "nao foi possivel ativar a sessao de audio".into(),
        -3 => "AVAudioEngine nao iniciou".into(),
        -4 => "formato de audio de entrada nao suportado".into(),
        other => format!("erro desconhecido do bridge de audio ({other})"),
    }
}

pub fn start() -> Result<(), String> {
    // Safety: the Swift side is linked into this binary and hops to the
    // main queue itself; it takes no arguments and returns a plain i32.
    let code = unsafe { seraphine_wakeword_audio_start() };
    if code == 0 {
        Ok(())
    } else {
        Err(format!("wakeword: {}", describe(code)))
    }
}

pub fn stop() {
    // Safety: same contract as `start`.
    unsafe { seraphine_wakeword_audio_stop() }
}
