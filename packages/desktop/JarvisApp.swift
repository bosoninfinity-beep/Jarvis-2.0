import Cocoa
import WebKit

// ─── Service Manager ──────────────────────────────────────────

class ServiceManager {
    private var natsProcess: Process?
    private var redisProcess: Process?
    private var gatewayProcess: Process?
    private var orchestratorProcess: Process?
    private var sshAgentProcesses: [Process] = []

    private let bundleBin: String
    private let bundleRes: String
    private let dataDir: String

    init() {
        let bundle = Bundle.main.bundlePath
        bundleBin = "\(bundle)/Contents/MacOS"
        bundleRes = "\(bundle)/Contents/Resources"
        // App data in ~/Library/Application Support/Jarvis
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        dataDir = appSupport.appendingPathComponent("Jarvis").path
    }

    func startAll(onReady: @escaping (Int) -> Void) {
        // Create data dirs
        let dirs = [dataDir, "\(dataDir)/nats", "\(dataDir)/redis", "\(dataDir)/logs", "\(dataDir)/nas",
                    "\(dataDir)/nas/config", "\(dataDir)/nas/logs", "\(dataDir)/nas/workspace",
                    "\(dataDir)/nas/workspace/artifacts", "\(dataDir)/nas/workspace/artifacts/reports"]
        for dir in dirs {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }

        // Generate tokens if not exist — but prefer project .env if available
        let envPath = "\(dataDir)/jarvis.env"
        let projectEnvPath = "\(bundleRes)/app/.env.project"

        // Try to find existing project .env with real tokens
        let possibleProjectEnvs = [
            NSHomeDirectory() + "/Documents/Jarvis-2.0/jarvis/.env",
            NSHomeDirectory() + "/jarvis/.env",
        ]
        var projectEnv: String? = nil
        for path in possibleProjectEnvs {
            if FileManager.default.fileExists(atPath: path) {
                projectEnv = path
                break
            }
        }

        if !FileManager.default.fileExists(atPath: envPath) {
            if let projPath = projectEnv, let projContent = try? String(contentsOfFile: projPath, encoding: .utf8) {
                // Use project .env (has real tokens, API keys, etc.)
                var content = projContent
                // Override NAS mount to app data dir
                let nasRegex = try? NSRegularExpression(pattern: "^JARVIS_NAS_MOUNT=.*$", options: .anchorsMatchLines)
                content = nasRegex?.stringByReplacingMatches(in: content, range: NSRange(content.startIndex..., in: content), withTemplate: "JARVIS_NAS_MOUNT=\(dataDir)/nas") ?? content
                try? content.write(toFile: envPath, atomically: true, encoding: .utf8)
                NSLog("Using project .env from \(projPath)")
            } else {
                // Generate fresh tokens
                let authToken = randomHex(32)
                let natsToken = randomHex(16)
                let envContent = """
                JARVIS_PORT=18900
                JARVIS_HOST=127.0.0.1
                JARVIS_AUTH_TOKEN=\(authToken)
                NATS_URL=nats://127.0.0.1:4222
                NATS_TOKEN=\(natsToken)
                REDIS_URL=redis://127.0.0.1:6379
                JARVIS_NAS_MOUNT=\(dataDir)/nas
                JARVIS_MACHINE_ID=jarvis-desktop
                ANTHROPIC_AUTH_MODE=claude-cli
                """
                try? envContent.write(toFile: envPath, atomically: true, encoding: .utf8)
            }
        }

        // Read NATS token from env
        let envContent = (try? String(contentsOfFile: envPath, encoding: .utf8)) ?? ""
        let natsToken = envContent.components(separatedBy: "\n")
            .first(where: { $0.hasPrefix("NATS_TOKEN=") })?
            .replacingOccurrences(of: "NATS_TOKEN=", with: "") ?? ""
        let port = envContent.components(separatedBy: "\n")
            .first(where: { $0.hasPrefix("JARVIS_PORT=") })?
            .replacingOccurrences(of: "JARVIS_PORT=", with: "") ?? "18900"

        DispatchQueue.global(qos: .userInitiated).async { [self] in
            // 1. Start NATS (skip if already running)
            if !self.isPortInUse(4222) {
                NSLog("Starting NATS...")
                natsProcess = launchProcess(
                    "\(bundleBin)/nats-server",
                    args: [
                        "--port", "4222",
                        "--store_dir", "\(dataDir)/nats",
                        "--auth", natsToken
                    ]
                )
                Thread.sleep(forTimeInterval: 0.5)
            } else {
                NSLog("NATS already running on :4222, skipping.")
            }

            // 2. Start Redis (skip if already running)
            if !self.isPortInUse(6379) {
                NSLog("Starting Redis...")
                redisProcess = launchProcess(
                    "\(bundleBin)/redis-server",
                    args: [
                        "--port", "6379",
                        "--dir", "\(dataDir)/redis",
                        "--appendonly", "yes",
                        "--maxmemory", "256mb",
                        "--maxmemory-policy", "allkeys-lru",
                        "--daemonize", "no"
                    ]
                )
                Thread.sleep(forTimeInterval: 0.5)
            } else {
                NSLog("Redis already running on :6379, skipping.")
            }

            // 3. Start Gateway
            NSLog("Starting Gateway...")

            // Symlink .env to where gateway expects it (3 dirs above dist/index.js)
            let gwEnvPath = "\(bundleRes)/app/.env"
            try? FileManager.default.removeItem(atPath: gwEnvPath)
            try? FileManager.default.createSymbolicLink(atPath: gwEnvPath, withDestinationPath: envPath)

            // Parse env file into dict so gateway gets all vars
            var gwEnv: [String: String] = [
                "NODE_ENV": "production",
                "HOME": NSHomeDirectory(),
                "PATH": "\(bundleBin):/usr/bin:/bin:/usr/sbin:/sbin",
                "NODE_PATH": "\(bundleRes)/app/node_modules",
            ]
            for line in envContent.components(separatedBy: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
                if let eqIdx = trimmed.firstIndex(of: "=") {
                    let key = String(trimmed[trimmed.startIndex..<eqIdx])
                    let val = String(trimmed[trimmed.index(after: eqIdx)...])
                    gwEnv[key] = val
                }
            }

            gatewayProcess = launchProcess(
                "\(bundleBin)/node",
                args: ["\(bundleRes)/app/packages/gateway/dist/index.js"],
                env: gwEnv,
                cwd: "\(bundleRes)/app/packages/gateway"
            )

            Thread.sleep(forTimeInterval: 2.0)
            NSLog("All services started. Gateway on port \(port)")

            DispatchQueue.main.async {
                onReady(Int(port) ?? 18900)
            }

            // Start agents in background (don't block dashboard load)
            DispatchQueue.global(qos: .utility).async {
                self.startAgents()
            }
        }
    }

    func stopAll() {
        NSLog("Stopping services...")
        stopAgents()
        terminateProcess(gatewayProcess, name: "Gateway")
        terminateProcess(redisProcess, name: "Redis")
        terminateProcess(natsProcess, name: "NATS")
        NSLog("All services stopped.")
    }

    // ─── Agent Auto-Start ──────────────────────────────────────

    func startAgents() {
        let envPath = "\(dataDir)/jarvis.env"
        let envContent = (try? String(contentsOfFile: envPath, encoding: .utf8)) ?? ""

        NSLog("Starting agents...")

        // Start orchestrator locally (from monorepo if available)
        startOrchestrator(envContent: envContent)

        // Start remote agents via SSH → launchctl (LaunchAgents with KeepAlive=true)
        let smithHost = envValue("SMITH_IP", from: envContent).isEmpty ? envValue("ALPHA_IP", from: envContent) : envValue("SMITH_IP", from: envContent)
        let smithUser = envValue("SMITH_USER", from: envContent).isEmpty ? envValue("ALPHA_USER", from: envContent) : envValue("SMITH_USER", from: envContent)
        let johnyHost = envValue("JOHNY_IP", from: envContent).isEmpty ? envValue("BETA_IP", from: envContent) : envValue("JOHNY_IP", from: envContent)
        let johnyUser = envValue("JOHNY_USER", from: envContent).isEmpty ? envValue("BETA_USER", from: envContent) : envValue("JOHNY_USER", from: envContent)

        startRemoteAgent(name: "smith", host: smithHost, user: smithUser, agentId: "agent-smith")
        startRemoteAgent(name: "johny", host: johnyHost, user: johnyUser, agentId: "agent-johny")

        NSLog("Agent startup sequence complete")
    }

    func stopAgents() {
        NSLog("Stopping agents...")

        // Stop remote agents via SSH → launchctl bootout
        let envPath = "\(dataDir)/jarvis.env"
        let envContent = (try? String(contentsOfFile: envPath, encoding: .utf8)) ?? ""
        let smithHost = envValue("SMITH_IP", from: envContent).isEmpty ? envValue("ALPHA_IP", from: envContent) : envValue("SMITH_IP", from: envContent)
        let smithUser = envValue("SMITH_USER", from: envContent).isEmpty ? envValue("ALPHA_USER", from: envContent) : envValue("SMITH_USER", from: envContent)
        let johnyHost = envValue("JOHNY_IP", from: envContent).isEmpty ? envValue("BETA_IP", from: envContent) : envValue("JOHNY_IP", from: envContent)
        let johnyUser = envValue("JOHNY_USER", from: envContent).isEmpty ? envValue("BETA_USER", from: envContent) : envValue("JOHNY_USER", from: envContent)

        if !smithHost.isEmpty && !smithUser.isEmpty {
            runSSHCommand(host: smithHost, user: smithUser, command:
                "launchctl bootout gui/$(id -u)/com.jarvis.agent-smith 2>/dev/null; true")
        }
        if !johnyHost.isEmpty && !johnyUser.isEmpty {
            runSSHCommand(host: johnyHost, user: johnyUser, command:
                "launchctl bootout gui/$(id -u)/com.jarvis.agent-johny 2>/dev/null; true")
        }

        // Terminate any leftover persistent SSH sessions
        for process in sshAgentProcesses where process.isRunning {
            process.terminate()
        }
        sshAgentProcesses.removeAll()

        // Terminate orchestrator
        terminateProcess(orchestratorProcess, name: "Orchestrator")
        orchestratorProcess = nil
    }

    private func envValue(_ key: String, from envContent: String, fallback: String = "") -> String {
        for line in envContent.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            if trimmed.hasPrefix("\(key)=") {
                return String(trimmed.dropFirst(key.count + 1))
            }
        }
        return fallback
    }

    private func startOrchestrator(envContent: String) {
        let jarvisDir = NSHomeDirectory() + "/Documents/Jarvis-2.0/jarvis"
        guard FileManager.default.fileExists(atPath: jarvisDir + "/packages/agent-runtime/src/cli.ts") else {
            NSLog("Orchestrator: agent-runtime not found at \(jarvisDir), skipping")
            return
        }

        // Find node binary — check nvm versions first, then common paths
        let nvmDir = NSHomeDirectory() + "/.nvm/versions/node"
        var nodeBin = "/usr/local/bin/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmDir) {
            let sorted = versions.sorted().reversed()
            for v in sorted {
                let candidate = "\(nvmDir)/\(v)/bin/node"
                if FileManager.default.fileExists(atPath: candidate) {
                    nodeBin = candidate
                    break
                }
            }
        } else if FileManager.default.fileExists(atPath: "/opt/homebrew/bin/node") {
            nodeBin = "/opt/homebrew/bin/node"
        }

        let nodePath = (nodeBin as NSString).deletingLastPathComponent

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = ["-c", """
            export PATH="\(nodePath):\(NSHomeDirectory())/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH" && \
            cd "\(jarvisDir)" && \
            set -a && source .env 2>/dev/null && set +a && \
            export JARVIS_AGENT_ID=jarvis && \
            export JARVIS_AGENT_ROLE=orchestrator && \
            export ANTHROPIC_AUTH_MODE=claude-cli && \
            exec ./node_modules/.bin/tsx packages/agent-runtime/src/cli.ts
            """]

        let logFile = "\(dataDir)/logs/orchestrator.log"
        try? "".write(toFile: logFile, atomically: true, encoding: .utf8)
        if let fh = FileHandle(forWritingAtPath: logFile) {
            process.standardOutput = fh
            process.standardError = fh
        }

        do {
            try process.run()
            orchestratorProcess = process
            NSLog("Orchestrator started (PID: \(process.processIdentifier))")
        } catch {
            NSLog("Failed to start orchestrator: \(error)")
        }
    }

    private func startRemoteAgent(name: String, host: String, user: String, agentId: String) {
        guard !host.isEmpty, !user.isEmpty else {
            NSLog("\(name): no host/user configured, skipping")
            return
        }

        NSLog("Starting remote agent: \(name) (\(user)@\(host))")

        // 1. Bootstrap websockify LaunchAgent (KeepAlive=true, survives SSH disconnect)
        runSSHCommand(host: host, user: user, command:
            "launchctl bootout gui/$(id -u)/com.jarvis.websockify 2>/dev/null; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.websockify.plist 2>/dev/null || true")

        // 2. Bootstrap agent LaunchAgent (KeepAlive=true, runs under launchd)
        runSSHCommand(host: host, user: user, command:
            "launchctl bootout gui/$(id -u)/com.jarvis.\(agentId) 2>/dev/null; sleep 1; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jarvis.\(agentId).plist 2>/dev/null || true")

        NSLog("Remote agent \(name) started via launchctl")
    }

    private func runSSHCommand(host: String, user: String, command: String) {
        let sshKeyPath = NSHomeDirectory() + "/.ssh/id_ed25519_jarvis"
        let sshKeyArgs: [String] = FileManager.default.fileExists(atPath: sshKeyPath)
            ? ["-i", sshKeyPath] : []

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = sshKeyArgs + [
            "-o", "ConnectTimeout=5",
            "-o", "StrictHostKeyChecking=accept-new",
            "\(user)@\(host)",
            command
        ]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            NSLog("SSH command failed on \(host): \(error)")
        }
    }

    private func launchProcess(_ path: String, args: [String] = [], env: [String: String]? = nil, cwd: String? = nil) -> Process? {
        guard FileManager.default.fileExists(atPath: path) else {
            NSLog("Binary not found: \(path)")
            return nil
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args

        if let cwd = cwd {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        }

        if let env = env {
            var fullEnv = ProcessInfo.processInfo.environment
            for (k, v) in env { fullEnv[k] = v }
            process.environment = fullEnv
        }

        // Log output to file
        let logFile = "\(dataDir)/logs/\(URL(fileURLWithPath: path).lastPathComponent).log"
        try? "".write(toFile: logFile, atomically: true, encoding: .utf8)
        let fileHandle = FileHandle(forWritingAtPath: logFile)
        process.standardOutput = fileHandle
        process.standardError = fileHandle

        do {
            try process.run()
            NSLog("Started \(path) (PID: \(process.processIdentifier))")
            return process
        } catch {
            NSLog("Failed to start \(path): \(error)")
            return nil
        }
    }

    private func terminateProcess(_ process: Process?, name: String) {
        guard let p = process, p.isRunning else { return }
        p.interrupt() // SIGINT for graceful shutdown
        // Give it 3 seconds, then force kill
        DispatchQueue.global().asyncAfter(deadline: .now() + 3.0) {
            if p.isRunning {
                p.terminate()
                NSLog("\(name) force-killed")
            }
        }
        p.waitUntilExit()
        NSLog("\(name) stopped (exit: \(p.terminationStatus))")
    }

    private func isPortInUse(_ port: Int) -> Bool {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { return false }
        defer { close(sock) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    private func randomHex(_ bytes: Int) -> String {
        var data = Data(count: bytes)
        _ = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, bytes, $0.baseAddress!) }
        return data.map { String(format: "%02x", $0) }.joined()
    }
}

// ─── App Delegate ──────────────────────────────────────────

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var services: ServiceManager!
    var statusLabel: NSTextField!

    func applicationDidFinishLaunching(_ notification: Notification) {
        services = ServiceManager()

        // Window setup
        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let windowWidth: CGFloat = min(1440, screenFrame.width * 0.88)
        let windowHeight: CGFloat = min(960, screenFrame.height * 0.88)
        let windowX = screenFrame.origin.x + (screenFrame.width - windowWidth) / 2
        let windowY = screenFrame.origin.y + (screenFrame.height - windowHeight) / 2

        window = NSWindow(
            contentRect: NSRect(x: windowX, y: windowY, width: windowWidth, height: windowHeight),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Jarvis 2.0"
        window.backgroundColor = NSColor(red: 0.06, green: 0.06, blue: 0.09, alpha: 1.0)
        window.minSize = NSSize(width: 900, height: 600)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .visible
        if let appearance = NSAppearance(named: .darkAqua) {
            window.appearance = appearance
        }

        // Container view
        let container = NSView(frame: window.contentView!.bounds)
        container.autoresizingMask = [.width, .height]
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(red: 0.06, green: 0.06, blue: 0.09, alpha: 1.0).cgColor
        window.contentView = container

        // Loading label
        statusLabel = NSTextField(labelWithString: "Starting Jarvis 2.0...")
        statusLabel.font = NSFont.monospacedSystemFont(ofSize: 14, weight: .medium)
        statusLabel.textColor = NSColor(red: 0.96, green: 0.45, blue: 0.71, alpha: 1.0)
        statusLabel.alignment = .center
        statusLabel.frame = NSRect(x: 0, y: (container.bounds.height / 2) - 10, width: container.bounds.width, height: 24)
        statusLabel.autoresizingMask = [.width, .minYMargin, .maxYMargin]
        container.addSubview(statusLabel)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Start services, then load dashboard
        updateStatus("Starting NATS...")
        services.startAll { [weak self] port in
            self?.loadDashboard(port: port)
        }
    }

    private func updateStatus(_ text: String) {
        DispatchQueue.main.async { [weak self] in
            self?.statusLabel.stringValue = text
        }
    }

    private func loadDashboard(port: Int) {
        // Remove loading label
        statusLabel.removeFromSuperview()

        // Create WebView
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.websiteDataStore = WKWebsiteDataStore.default()

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.allowsBackForwardNavigationGestures = true
        webView.customUserAgent = "JarvisDashboard/1.0 Safari/605"
        window.contentView?.addSubview(webView)

        // First-run detection: if SSH key doesn't exist, load wizard directly
        let sshKeyExists = FileManager.default.fileExists(atPath: NSHomeDirectory() + "/.ssh/id_ed25519_jarvis")
        let initialPath = sshKeyExists ? "/" : "/setup"

        if let url = URL(string: "http://localhost:\(port)\(initialPath)") {
            webView.load(URLRequest(url: url))
        }

        // Auto-reload on wake
        NSWorkspace.shared.notificationCenter.addObserver(
            self,
            selector: #selector(handleWake),
            name: NSWorkspace.didWakeNotification,
            object: nil
        )
    }

    @objc func handleWake() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.webView?.reload()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        services.stopAll()
    }
}

// ─── Entry ──────────────────────────────────────────

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
