#!/bin/bash
set -e
cd "$(dirname "$0")"

if ! command -v swiftc &>/dev/null; then
    echo "Error: swiftc not found. Install Xcode Command Line Tools: xcode-select --install" >&2
    exit 1
fi

FRAMEWORKS="-framework ScreenCaptureKit -framework CoreMedia -framework Foundation"

# Build universal binary (arm64 + x86_64) for distribution
swiftc capture-audio.swift $FRAMEWORKS -target arm64-apple-macos13.0 -o capture-audio-arm64
swiftc capture-audio.swift $FRAMEWORKS -target x86_64-apple-macos13.0 -o capture-audio-x86_64
lipo -create capture-audio-arm64 capture-audio-x86_64 -output capture-audio
rm capture-audio-arm64 capture-audio-x86_64
chmod +x capture-audio

echo "Built native/capture-audio (universal)"

# ── Now Playing (MediaRemote, loaded via dlopen — only needs Foundation) ──
swiftc now-playing.swift -framework Foundation -target arm64-apple-macos13.0 -o now-playing-arm64
swiftc now-playing.swift -framework Foundation -target x86_64-apple-macos13.0 -o now-playing-x86_64
lipo -create now-playing-arm64 now-playing-x86_64 -output now-playing
rm now-playing-arm64 now-playing-x86_64
chmod +x now-playing

echo "Built native/now-playing (universal)"
