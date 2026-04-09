import Foundation
import ScreenCaptureKit
import CoreMedia

// ── ScreenCaptureKit system audio capture ──────────────────
// Streams raw Float32 mono PCM at 44100 Hz to stdout.
// Electron spawns this, reads the pipe, forwards to renderer.

@available(macOS 13.0, *)
class AudioCapture: NSObject, SCStreamDelegate, SCStreamOutput {
    var stream: SCStream?

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: false
        )
        guard let display = content.displays.first else {
            FileHandle.standardError.write("No display found\n".data(using: .utf8)!)
            exit(1)
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = 44100
        config.channelCount = 1

        config.excludesCurrentProcessAudio = true

        // Minimal video — required by API but unused
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let s = SCStream(filter: filter, configuration: config, delegate: self)
        stream = s
        try s.addStreamOutput(
            self, type: .audio,
            sampleHandlerQueue: DispatchQueue(label: "audio-capture")
        )
        try await s.startCapture()
        FileHandle.standardError.write("capturing\n".data(using: .utf8)!)
    }

    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        let length = CMBlockBufferGetDataLength(block)
        guard length > 0 else { return }

        // Use CopyDataBytes for safety — handles discontiguous CMBlockBuffers
        var buffer = [UInt8](repeating: 0, count: length)
        let status = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &buffer)
        guard status == kCMBlockBufferNoErr else { return }

        _ = buffer.withUnsafeBufferPointer { ptr in
            fwrite(ptr.baseAddress, 1, length, stdout)
        }
        fflush(stdout)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write("stopped: \(error)\n".data(using: .utf8)!)
        exit(1)
    }

    func stop() {
        Task {
            try? await stream?.stopCapture()
            exit(0)
        }
    }
}

// ── Entry point ────────────────────────────────────────────

guard #available(macOS 13.0, *) else {
    FileHandle.standardError.write("requires macOS 13.0+\n".data(using: .utf8)!)
    exit(1)
}

let capture = AudioCapture()

// Clean shutdown: stop SCStream before exit so macOS releases the audio session
signal(SIGTERM) { _ in
    DispatchQueue.main.async { capture.stop() }
}
signal(SIGINT) { _ in
    DispatchQueue.main.async { capture.stop() }
}

Task {
    do {
        try await capture.start()
    } catch {
        FileHandle.standardError.write("error: \(error)\n".data(using: .utf8)!)
        exit(1)
    }
}

RunLoop.main.run()
