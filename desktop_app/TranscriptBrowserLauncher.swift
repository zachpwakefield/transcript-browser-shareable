import AppKit
import Foundation

private enum LauncherRuntimeError: LocalizedError {
    case missingEmbeddedRuntime
    case invalidRuntimeManifest(URL)
    case runtimeExtractionFailed(Int32)
    case missingVerifiedDatabase

    var errorDescription: String? {
        switch self {
        case .missingEmbeddedRuntime:
            return "The application does not contain its private Python runtime."
        case .invalidRuntimeManifest(let url):
            return "The runtime manifest is missing or invalid at \(url.path)."
        case .runtimeExtractionFailed(let status):
            return "The private Python runtime could not be unpacked (exit code \(status))."
        case .missingVerifiedDatabase:
            return "The private verified data clone is missing. Re-run desktop_app/install_macos_app.sh once."
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let port = 8765
    private let expectedBuildHash = "f0f2071044f7d662c02212348f0ad6d93aef37e6460e29bf64e034ca77437dac"
    private var window: NSWindow!
    private var statusLabel: NSTextField!
    private var detailLabel: NSTextField!
    private var openButton: NSButton!
    private var retryButton: NSButton!
    private var quitButton: NSButton!
    private var progress: NSProgressIndicator!
    private var serverProcess: Process?
    private var serverLogHandle: FileHandle?
    private var projectURL: URL?
    private var runtimeURL: URL?
    private var ownsServer = false
    private var serverIsReady = false
    private var didOpenBrowser = false
    private var isTerminating = false
    private var launchGeneration = 0

    private var serverURL: URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    private var manifestURL: URL {
        serverURL.appendingPathComponent("api/v1/manifest")
    }

    private var logURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Transcript Browser/server.log")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        configureMenu()
        configureWindow()
        NSApp.activate(ignoringOtherApps: true)
        beginLaunch()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        if !flag {
            window.makeKeyAndOrderFront(nil)
        }
        NSApp.activate(ignoringOtherApps: true)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        isTerminating = true
        launchGeneration += 1
        if ownsServer, let process = serverProcess, process.isRunning {
            process.terminate()
        }
        try? serverLogHandle?.close()
    }

    private func configureMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)

        let appMenu = NSMenu()
        let openItem = NSMenuItem(
            title: "Open Transcript Browser",
            action: #selector(openBrowser(_:)),
            keyEquivalent: "o"
        )
        openItem.target = self
        appMenu.addItem(openItem)
        appMenu.addItem(.separator())
        let quitItem = NSMenuItem(
            title: "Stop & Quit Transcript Browser",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appMenu.addItem(quitItem)
        appMenuItem.submenu = appMenu
        NSApp.mainMenu = mainMenu
    }

    private func configureWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 310),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Transcript Browser"
        window.isReleasedWhenClosed = false
        window.center()

        let content = NSView()
        content.translatesAutoresizingMaskIntoConstraints = false
        window.contentView = content

        let symbol = NSImageView()
        symbol.translatesAutoresizingMaskIntoConstraints = false
        symbol.image = NSImage(
            systemSymbolName: "point.3.filled.connected.trianglepath.dotted",
            accessibilityDescription: "Transcript Browser"
        ) ?? NSImage(named: NSImage.applicationIconName)
        symbol.contentTintColor = NSColor(calibratedRed: 0.10, green: 0.36, blue: 0.31, alpha: 1)
        symbol.imageScaling = .scaleProportionallyUpOrDown

        let title = NSTextField(labelWithString: "Transcript Browser")
        title.translatesAutoresizingMaskIntoConstraints = false
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        title.textColor = NSColor(calibratedRed: 0.08, green: 0.24, blue: 0.21, alpha: 1)

        let subtitle = NSTextField(labelWithString: "GENCODE v45 · verified local workspace")
        subtitle.translatesAutoresizingMaskIntoConstraints = false
        subtitle.font = .systemFont(ofSize: 12, weight: .medium)
        subtitle.textColor = .secondaryLabelColor

        progress = NSProgressIndicator()
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.style = .spinning
        progress.controlSize = .small
        progress.startAnimation(nil)

        statusLabel = NSTextField(labelWithString: "Starting the local server…")
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .systemFont(ofSize: 14, weight: .semibold)
        statusLabel.textColor = .labelColor
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 2

        detailLabel = NSTextField(wrappingLabelWithString: "No Terminal window will open. The service is available only on this Mac at 127.0.0.1.")
        detailLabel.translatesAutoresizingMaskIntoConstraints = false
        detailLabel.font = .systemFont(ofSize: 11)
        detailLabel.textColor = .secondaryLabelColor
        detailLabel.maximumNumberOfLines = 4

        openButton = NSButton(title: "Open Browser", target: self, action: #selector(openBrowser(_:)))
        openButton.translatesAutoresizingMaskIntoConstraints = false
        openButton.bezelStyle = .rounded
        openButton.keyEquivalent = "\r"
        openButton.isEnabled = false

        retryButton = NSButton(title: "Retry", target: self, action: #selector(retryLaunch(_:)))
        retryButton.translatesAutoresizingMaskIntoConstraints = false
        retryButton.bezelStyle = .rounded
        retryButton.isHidden = true

        quitButton = NSButton(title: "Stop & Quit", target: NSApp, action: #selector(NSApplication.terminate(_:)))
        quitButton.translatesAutoresizingMaskIntoConstraints = false
        quitButton.bezelStyle = .rounded

        [symbol, title, subtitle, progress, statusLabel, detailLabel, openButton, retryButton, quitButton]
            .forEach(content.addSubview)

        NSLayoutConstraint.activate([
            symbol.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 30),
            symbol.topAnchor.constraint(equalTo: content.topAnchor, constant: 28),
            symbol.widthAnchor.constraint(equalToConstant: 50),
            symbol.heightAnchor.constraint(equalToConstant: 50),

            title.leadingAnchor.constraint(equalTo: symbol.trailingAnchor, constant: 16),
            title.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
            title.topAnchor.constraint(equalTo: content.topAnchor, constant: 27),

            subtitle.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            subtitle.trailingAnchor.constraint(equalTo: title.trailingAnchor),
            subtitle.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 3),

            progress.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 31),
            progress.topAnchor.constraint(equalTo: symbol.bottomAnchor, constant: 37),
            progress.widthAnchor.constraint(equalToConstant: 18),
            progress.heightAnchor.constraint(equalToConstant: 18),

            statusLabel.leadingAnchor.constraint(equalTo: progress.trailingAnchor, constant: 12),
            statusLabel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -30),
            statusLabel.centerYAnchor.constraint(equalTo: progress.centerYAnchor),

            detailLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 31),
            detailLabel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -31),
            detailLabel.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 13),

            quitButton.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 30),
            quitButton.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -27),

            retryButton.trailingAnchor.constraint(equalTo: openButton.leadingAnchor, constant: -9),
            retryButton.centerYAnchor.constraint(equalTo: openButton.centerYAnchor),

            openButton.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -30),
            openButton.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -27),
        ])

        window.makeKeyAndOrderFront(nil)
    }

    private func discoverProject() -> URL? {
        var candidates: [URL] = []
        if let configured = ProcessInfo.processInfo.environment["TRANSCRIPT_BROWSER_PROJECT"],
           !configured.isEmpty {
            candidates.append(URL(fileURLWithPath: configured, isDirectory: true))
        }
        candidates.append(
            Bundle.main.bundleURL
                .deletingLastPathComponent()
                .appendingPathComponent("transcript_browser", isDirectory: true)
        )
        candidates.append(
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Desktop/transcript_browser", isDirectory: true)
        )

        return candidates.first { candidate in
            FileManager.default.isExecutableFile(
                atPath: candidate.appendingPathComponent("run_local.sh").path
            ) && FileManager.default.isExecutableFile(
                atPath: candidate.appendingPathComponent(".venv/bin/python").path
            ) && FileManager.default.fileExists(
                atPath: candidate.appendingPathComponent("frontend/dist/index.html").path
            )
        }
    }

    private func runtimeVersion(manifestURL: URL) throws -> String {
        let data = try Data(contentsOf: manifestURL)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = object["runtimeVersion"] as? String,
              !version.isEmpty else {
            throw LauncherRuntimeError.invalidRuntimeManifest(manifestURL)
        }
        return version
    }

    private func runtimeVersion(at runtimeURL: URL) throws -> String {
        try runtimeVersion(
            manifestURL: runtimeURL.appendingPathComponent("runtime-manifest.json")
        )
    }

    private func ensureDataClones(runtimeURL: URL) throws {
        let manifestURL = runtimeURL.appendingPathComponent("runtime-manifest.json")
        let data = try Data(contentsOf: manifestURL)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let externalFiles = object["externalFiles"] as? [String: Any] else {
            throw LauncherRuntimeError.invalidRuntimeManifest(manifestURL)
        }
        for (relativePath, rawMetadata) in externalFiles {
            guard let metadata = rawMetadata as? [String: Any],
                  let expectedSize = metadata["size"] as? NSNumber else {
                throw LauncherRuntimeError.invalidRuntimeManifest(manifestURL)
            }
            let destination = runtimeURL.appendingPathComponent(relativePath)
            let resolvedDestination = destination.resolvingSymlinksInPath()
            if relativePath.hasSuffix("/genome.fa")
                || relativePath.hasSuffix("/genome.fa.fai") {
                let values = try destination.resourceValues(forKeys: [.isSymbolicLinkKey])
                guard values.isSymbolicLink == true else {
                    throw LauncherRuntimeError.missingVerifiedDatabase
                }
            }
            guard FileManager.default.fileExists(atPath: resolvedDestination.path),
                  let actualSize = try? resolvedDestination
                    .resourceValues(forKeys: [.fileSizeKey]).fileSize,
                  actualSize == expectedSize.intValue else {
                throw LauncherRuntimeError.missingVerifiedDatabase
            }
        }
    }

    private func prepareRuntime() throws -> URL {
        guard let resources = Bundle.main.resourceURL else {
            throw LauncherRuntimeError.missingEmbeddedRuntime
        }
        let archive = resources.appendingPathComponent("Runtime.zip")
        let embeddedManifest = resources.appendingPathComponent("Runtime-manifest.json")
        guard FileManager.default.fileExists(atPath: archive.path) else {
            throw LauncherRuntimeError.missingEmbeddedRuntime
        }
        let version = try runtimeVersion(manifestURL: embeddedManifest)
        let fileManager = FileManager.default
        let applicationSupport = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let runtimeRoot = applicationSupport
            .appendingPathComponent("Transcript Browser", isDirectory: true)
            .appendingPathComponent("Runtime", isDirectory: true)
        try fileManager.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)

        let cached = runtimeRoot.appendingPathComponent(version, isDirectory: true)
        let cachedIsComplete = (try? runtimeVersion(at: cached)) == version
            && fileManager.fileExists(
                atPath: cached.appendingPathComponent("backend/app/cli.py").path
            )
            && fileManager.fileExists(
                atPath: cached.appendingPathComponent("site-packages/uvicorn/__init__.py").path
            )
            && fileManager.fileExists(
                atPath: cached.appendingPathComponent("frontend/dist/index.html").path
            )
            && fileManager.fileExists(
                atPath: cached.appendingPathComponent("data/builds/gencode_v45/manifest.json").path
            )
        if cachedIsComplete {
            try ensureDataClones(runtimeURL: cached)
            return cached
        }

        let staging = runtimeRoot.appendingPathComponent(
            ".install-\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: staging) }
        try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
        let extractor = Process()
        extractor.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        extractor.arguments = ["-x", "-k", archive.path, staging.path]
        extractor.currentDirectoryURL = URL(
            fileURLWithPath: NSTemporaryDirectory(),
            isDirectory: true
        )
        extractor.standardOutput = FileHandle.nullDevice
        extractor.standardError = FileHandle.nullDevice
        try extractor.run()
        extractor.waitUntilExit()
        guard extractor.terminationStatus == 0 else {
            throw LauncherRuntimeError.runtimeExtractionFailed(extractor.terminationStatus)
        }
        guard try runtimeVersion(at: staging) == version else {
            throw LauncherRuntimeError.invalidRuntimeManifest(
                staging.appendingPathComponent("runtime-manifest.json")
            )
        }
        if fileManager.fileExists(atPath: cached.path) {
            try fileManager.removeItem(at: cached)
        }
        try fileManager.moveItem(at: staging, to: cached)
        try ensureDataClones(runtimeURL: cached)
        return cached
    }

    private func beginLaunch() {
        launchGeneration += 1
        let generation = launchGeneration
        serverIsReady = false
        didOpenBrowser = false
        openButton.isEnabled = false
        retryButton.isHidden = true
        progress.isHidden = false
        progress.startAnimation(nil)
        statusLabel.stringValue = "Preparing the verified local service…"
        detailLabel.stringValue = "The first launch prepares a private 40 MB runtime. No Terminal window will open."
        projectURL = nil
        runtimeURL = nil

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            let project = self.discoverProject()
            var preparedRuntime: URL?
            var runtimeError: Error?
            if project != nil {
                do {
                    preparedRuntime = try self.prepareRuntime()
                } catch {
                    runtimeError = error
                }
            }
            DispatchQueue.main.async {
                guard generation == self.launchGeneration, !self.isTerminating else { return }
                guard let project = project else {
                    self.showFailure(
                        "The transcript_browser project could not be found.",
                        detail: "Keep Transcript Browser.app beside the transcript_browser folder on the Desktop."
                    )
                    return
                }
                guard let preparedRuntime = preparedRuntime else {
                    self.showFailure(
                        "The private local runtime could not be prepared.",
                        detail: runtimeError?.localizedDescription ?? "The bundled runtime is unavailable."
                    )
                    return
                }
                self.projectURL = project
                self.runtimeURL = preparedRuntime
                self.statusLabel.stringValue = "Checking the verified local service…"
                self.detailLabel.stringValue = "The service is available only on this Mac at 127.0.0.1."
                self.checkManifest { [weak self] ready, buildHash in
                    guard let self = self, generation == self.launchGeneration else { return }
                    if ready {
                        self.ownsServer = false
                        self.showReady(buildHash: buildHash, reused: true)
                    } else {
                        self.startServer(generation: generation)
                    }
                }
            }
        }
    }

    private func startServer(generation: Int) {
        guard let projectURL = projectURL, let runtimeURL = runtimeURL else { return }
        statusLabel.stringValue = "Starting the verified local server…"
        detailLabel.stringValue = "This usually takes a few seconds while the immutable local package is validated."

        do {
            let logDirectory = logURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: logDirectory,
                withIntermediateDirectories: true
            )
            if let size = try? logURL.resourceValues(forKeys: [.fileSizeKey]).fileSize,
               size > 5_000_000 {
                try Data().write(to: logURL, options: .atomic)
            } else if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: Data())
            }
            let handle = try FileHandle(forWritingTo: logURL)
            try handle.seekToEnd()
            if let marker = "\n\n=== Transcript Browser launch \(Date()) ===\n".data(using: .utf8) {
                try handle.write(contentsOf: marker)
            }
            serverLogHandle = handle

            let process = Process()
            process.executableURL = projectURL
                .appendingPathComponent(".venv/bin/python")
                .resolvingSymlinksInPath()
            // Finder-launched applications inherit a working directory inside the
            // Desktop/FileProvider tree. Python can block while resolving that
            // directory before our module is imported, so give the child a small,
            // stable runtime directory and pass the project path explicitly.
            process.currentDirectoryURL = URL(
                fileURLWithPath: NSTemporaryDirectory(),
                isDirectory: true
            )
            // Do not put the Desktop project on PYTHONPATH before the interpreter
            // has initialized its standard-library codecs. FileProvider can stall
            // that early path scan. Bootstrap from an argument, then add the
            // project only when Python is ready to import the application.
            let sitePackagesURL = runtimeURL
                .appendingPathComponent("site-packages", isDirectory: true)
            let bootstrap = """
            import os,runpy,sys; runtime,site_packages,project,port=sys.argv[1:5]; print(f"Python runtime ready: prefix={sys.prefix} cwd={os.getcwd()}",flush=True); sys.path[0:0]=[runtime,site_packages]; sys.argv=["backend.app.cli","--project-root",project,"--port",port]; runpy.run_module("backend.app.cli",run_name="__main__")
            """
            process.arguments = [
                "-B",
                "-c",
                bootstrap,
                runtimeURL.path,
                sitePackagesURL.path,
                runtimeURL.path,
                String(port),
            ]
            process.standardOutput = handle
            process.standardError = handle
            let inherited = ProcessInfo.processInfo.environment
            var environment: [String: String] = [:]
            for key in ["HOME", "TMPDIR", "USER", "LOGNAME"] {
                if let value = inherited[key] {
                    environment[key] = value
                }
            }
            environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
            environment["LANG"] = inherited["LANG"] ?? "C.UTF-8"
            environment["LC_CTYPE"] = inherited["LC_CTYPE"] ?? "C.UTF-8"
            environment["PYTHONDONTWRITEBYTECODE"] = "1"
            environment["PYTHONUNBUFFERED"] = "1"
            process.environment = environment
            process.terminationHandler = { [weak self] terminated in
                if let message = "Launcher child exited with code \(terminated.terminationStatus).\n".data(using: .utf8) {
                    try? handle.write(contentsOf: message)
                }
                DispatchQueue.main.async {
                    guard let self = self,
                          !self.isTerminating,
                          generation == self.launchGeneration,
                          !self.serverIsReady else { return }
                    self.showFailure(
                        "The local server stopped before it became ready.",
                        detail: "Exit code \(terminated.terminationStatus). Details are in \(self.logURL.path)."
                    )
                }
            }
            try process.run()
            serverProcess = process
            ownsServer = true
            pollUntilReady(generation: generation, attempt: 0)
        } catch {
            if let message = "Launcher failed to start child: \(error)\n".data(using: .utf8) {
                try? serverLogHandle?.write(contentsOf: message)
            }
            showFailure(
                "The local server could not be started.",
                detail: "\(error.localizedDescription) Log: \(logURL.path)"
            )
        }
    }

    private func pollUntilReady(generation: Int, attempt: Int) {
        guard generation == launchGeneration, !isTerminating else { return }
        checkManifest { [weak self] ready, buildHash in
            guard let self = self, generation == self.launchGeneration else { return }
            if ready {
                self.showReady(buildHash: buildHash, reused: false)
                return
            }
            if attempt >= 180 {
                self.showFailure(
                    "The local server did not become ready within 90 seconds.",
                    detail: "Quit and try again. Details are in \(self.logURL.path)."
                )
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.pollUntilReady(generation: generation, attempt: attempt + 1)
            }
        }
    }

    private func checkManifest(completion: @escaping (Bool, String?) -> Void) {
        var request = URLRequest(url: manifestURL)
        request.timeoutInterval = 1.5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let http = response as? HTTPURLResponse
            var valid = false
            var buildHash: String?
            if http?.statusCode == 200,
               let data = data,
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let hash = object["buildHash"] as? String,
               hash == self.expectedBuildHash,
               let capabilities = object["capabilities"] as? [String: Any],
               capabilities["pdfReports"] as? Bool == true {
                valid = true
                buildHash = hash
            }
            DispatchQueue.main.async {
                completion(valid, buildHash)
            }
        }.resume()
    }

    private func showReady(buildHash: String?, reused: Bool) {
        serverIsReady = true
        progress.stopAnimation(nil)
        progress.isHidden = true
        openButton.isEnabled = true
        retryButton.isHidden = true
        statusLabel.stringValue = reused
            ? "The local transcript browser is already running."
            : "The local transcript browser is ready."
        let shortHash = String((buildHash ?? "verified build").prefix(16))
        quitButton.title = ownsServer ? "Stop & Quit" : "Quit Launcher"
        let lifecycle = ownsServer
            ? "Closing this launcher stops the server it started."
            : "This launcher is using an already-running local server and will not stop it."
        detailLabel.stringValue = "Build \(shortHash) · \(serverURL.absoluteString)\n\(lifecycle)"
        if !didOpenBrowser {
            didOpenBrowser = true
            NSWorkspace.shared.open(serverURL)
        }
    }

    private func showFailure(_ message: String, detail: String) {
        serverIsReady = false
        progress.stopAnimation(nil)
        progress.isHidden = true
        openButton.isEnabled = false
        retryButton.isHidden = false
        statusLabel.stringValue = message
        detailLabel.stringValue = detail
    }

    @objc private func openBrowser(_ sender: Any?) {
        guard serverIsReady else { return }
        NSWorkspace.shared.open(serverURL)
    }

    @objc private func retryLaunch(_ sender: Any?) {
        launchGeneration += 1
        if ownsServer, let process = serverProcess, process.isRunning {
            process.terminationHandler = nil
            process.terminate()
        }
        ownsServer = false
        serverProcess = nil
        try? serverLogHandle?.close()
        serverLogHandle = nil
        beginLaunch()
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
