import Foundation

// ── Now Playing via private MediaRemote framework ────────────
// Polls MRMediaRemoteGetNowPlayingInfo every 2 seconds,
// outputs one JSON line per track change to stdout.
// Electron spawns this, reads the pipe, forwards to renderer.

guard let handle = dlopen(
    "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote",
    RTLD_NOW
) else {
    fputs("MediaRemote not available\n", stderr)
    exit(1)
}

typealias GetInfoFunc = @convention(c) (DispatchQueue, @escaping ([String: Any]) -> Void) -> Void
guard let sym = dlsym(handle, "MRMediaRemoteGetNowPlayingInfo") else {
    fputs("MRMediaRemoteGetNowPlayingInfo not found\n", stderr)
    exit(1)
}
let getInfo = unsafeBitCast(sym, to: GetInfoFunc.self)

var lastOutput = ""

func fetch() {
    getInfo(DispatchQueue.main) { info in
        let title  = info["kMRMediaRemoteNowPlayingInfoTitle"] as? String ?? ""
        let artist = info["kMRMediaRemoteNowPlayingInfoArtist"] as? String ?? ""
        let album  = info["kMRMediaRemoteNowPlayingInfoAlbum"] as? String ?? ""
        let rate   = info["kMRMediaRemoteNowPlayingInfoPlaybackRate"] as? Double ?? 0

        let result: [String: Any] = [
            "title": title, "artist": artist, "album": album, "rate": rate
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: result),
              let str = String(data: data, encoding: .utf8) else { return }

        // Skip duplicate consecutive outputs
        if str == lastOutput { return }
        lastOutput = str
        print(str)
        fflush(stdout)
    }
}

// Initial fetch + poll every 2 seconds
fetch()
Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in fetch() }

// Clean shutdown
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

RunLoop.main.run()
