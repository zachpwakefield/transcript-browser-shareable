# macOS desktop launcher

`Transcript Browser.app` is a small native AppKit launcher for the local browser. It starts the pinned private runtime without Terminal, waits for the verified manifest, and opens the loopback workspace in the default browser. The launcher remains open with **Open Browser** and **Stop & Quit** controls; quitting it terminates only the server process it started.

The installed app expects the active project at `~/Desktop/transcript_browser`, or in a sibling `transcript_browser` directory. `TRANSCRIPT_BROWSER_PROJECT` may override that location for development.

Build, ad-hoc sign, install, and prepare its private runtime once:

```bash
./desktop_app/install_macos_app.sh
```

The installer keeps the signed application at `~/Applications/Transcript Browser.app`, creates the clickable `Transcript Browser.app` link on the Desktop, and places the versioned runtime under `~/Library/Application Support/Transcript Browser/Runtime`. Keeping the signed bundle outside Desktop/FileProvider prevents Finder metadata from invalidating strict signature verification. Python packages, backend code, production frontend assets, and portable package metadata are stored in the private runtime. The immutable SQLite and whole-genome FASTA/FAI use APFS copy-on-write clones, so the private paths initially share storage blocks with the verified source files. Runtime-specific symlinks and identity receipts preserve the same pinned reference sizes and SHA-256 values while avoiding Finder-launched Python access through Desktop/FileProvider.

For a bundle-only build, run `./desktop_app/build_macos_app.sh`; its default output is `desktop_app/dist/Transcript Browser.app`. Server logs are written to `~/Library/Logs/Transcript Browser/server.log` and rotate when they exceed 5 MB.
