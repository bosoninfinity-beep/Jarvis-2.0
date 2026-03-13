import Cocoa
import WebKit

// ─── Service Manager ──────────────────────────────────────────

class ServiceManager {
    private var natsProcess: Process?
    private var redisProcess: Process?
    private var gatewayProcess: Process?
    private var orchestratorProcess: Process?
    private var agentProcesses: [String: Process] = [:]   // "agent-smith", "agent-johny"
    private var remoteProcesses: [String: Process] = [:]  // "smith-vnc", "johny-vnc"

    private let bundleBin: String
    private let bundleRes: String
    private let dataDir: String
    private var thunderboltIPs: [String] = [] // All TB interface IPs (bridge0, en6, en7)

    init() {
        let bundle = Bundle.main.bundlePath
        bundleBin = "\(bundle)/Contents/MacOS"
        bundleRes = "\(bundle)/Contents/Resources"
        // App data in ~/Library/Application Support/Jarvis
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        dataDir = appSupport.appendingPathComponent("Jarvis").path
    }

    // QNAP NAS configuration
    private let qnapHost = "192.168.1.64"
    private let qnapUser = "Iron"
    private let qnapPass = "_u342jmwYGp9-S-"
    private let qnapShare = "Public"
    private let qnapNasSubdir = "jarvis-nas"
    private var qnapMountPath: String { "/Volumes/\(qnapShare)" }
    private var qnapNasPath: String { "\(qnapMountPath)/\(qnapNasSubdir)" }

    /// Mount QNAP NAS via SMB if not already mounted
    private func mountQnapNas() {
        // Check if already mounted
        if FileManager.default.fileExists(atPath: qnapNasPath) {
            NSLog("QNAP NAS already mounted at \(qnapNasPath)")
            return
        }
        NSLog("Mounting QNAP NAS: \(qnapHost)/\(qnapShare)...")
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-e", "mount volume \"smb://\(qnapUser):\(qnapPass)@\(qnapHost)/\(qnapShare)\""]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            // Wait for mount with 10s timeout
            let mountDone = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                proc.waitUntilExit()
                mountDone.signal()
            }
            let timedOut = mountDone.wait(timeout: .now() + 10) == .timedOut
            if timedOut {
                proc.terminate()
                NSLog("QNAP NAS mount timed out after 10s — falling back to local NAS")
                return
            }
            // Verify mount
            Thread.sleep(forTimeInterval: 1.0)
            if FileManager.default.fileExists(atPath: qnapMountPath) {
                NSLog("QNAP NAS mounted successfully at \(qnapMountPath)")
                // Ensure jarvis-nas subdir exists
                try? FileManager.default.createDirectory(atPath: qnapNasPath, withIntermediateDirectories: true)
            } else {
                NSLog("QNAP NAS mount failed — falling back to local NAS")
            }
        } catch {
            NSLog("QNAP NAS mount error: \(error) — falling back to local NAS")
        }
    }

    func startAll(onReady: @escaping (Int) -> Void) {
        // Mount QNAP NAS first
        mountQnapNas()

        // Determine NAS path: prefer QNAP, fallback to local
        let nasPath = FileManager.default.fileExists(atPath: qnapNasPath) ? qnapNasPath : "\(dataDir)/nas"
        NSLog("Using NAS path: \(nasPath)")

        // Create data dirs
        let dirs = [dataDir, "\(dataDir)/nats", "\(dataDir)/redis", "\(dataDir)/logs",
                    nasPath, "\(nasPath)/config", "\(nasPath)/logs", "\(nasPath)/workspace",
                    "\(nasPath)/workspace/artifacts", "\(nasPath)/workspace/artifacts/reports"]
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
                // Override NAS mount to QNAP (or fallback local)
                let nasRegex = try? NSRegularExpression(pattern: "^JARVIS_NAS_MOUNT=.*$", options: .anchorsMatchLines)
                content = nasRegex?.stringByReplacingMatches(in: content, range: NSRange(content.startIndex..., in: content), withTemplate: "JARVIS_NAS_MOUNT=\(nasPath)") ?? content
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

            // 3. Start Gateway (using system node — bundled node has dylib issues)
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

            // Detect and fix Thunderbolt IPs (local + remote agents)
            self.thunderboltIPs = self.detectThunderboltIPs()
            if let firstIP = self.thunderboltIPs.first {
                gwEnv["MASTER_IP_THUNDERBOLT"] = firstIP
                NSLog("Gateway MASTER_IP_THUNDERBOLT=\(firstIP)")
            }
            self.fixThunderboltNetmask()

            // Dynamically detect remote agent TB IPs (via SSH on LAN)
            // This replaces stale VNC_*_HOST_THUNDERBOLT values from jarvis.env
            let smithHost = self.envValue("SMITH_IP", from: envContent)
            let smithUser = self.envValue("SMITH_USER", from: envContent)
            let smithPass = self.envValue("SMITH_PASS", from: envContent)
            let johnyHost = self.envValue("JOHNY_IP", from: envContent)
            let johnyUser = self.envValue("JOHNY_USER", from: envContent)
            let johnyPass = self.envValue("JOHNY_PASS", from: envContent)

            if !smithHost.isEmpty && !smithUser.isEmpty {
                if let smithTB = self.detectRemoteThunderboltIP(host: smithHost, user: smithUser, password: smithPass) {
                    gwEnv["VNC_ALPHA_HOST_THUNDERBOLT"] = smithTB
                    NSLog("Smith TB IP (live): \(smithTB)")
                    self.fixRemoteThunderboltNetmask(host: smithHost, user: smithUser, password: smithPass, tbIP: smithTB)
                }
            }
            if !johnyHost.isEmpty && !johnyUser.isEmpty {
                if let johnyTB = self.detectRemoteThunderboltIP(host: johnyHost, user: johnyUser, password: johnyPass) {
                    gwEnv["VNC_BETA_HOST_THUNDERBOLT"] = johnyTB
                    NSLog("Johny TB IP (live): \(johnyTB)")
                    self.fixRemoteThunderboltNetmask(host: johnyHost, user: johnyUser, password: johnyPass, tbIP: johnyTB)
                }
            }

            let nodeBin = self.findSystemNode()
            let nodeDir = (nodeBin as NSString).deletingLastPathComponent
            gwEnv["PATH"] = "\(nodeDir):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
            gatewayProcess = launchProcess(
                nodeBin,
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

    /// Read Claude CLI OAuth credentials from macOS Keychain (Mac Studio only)
    private func readClaudeOAuthCredentials() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-s", "Claude Code-credentials", "-a", NSUserName(), "-w"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus == 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                if let creds = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !creds.isEmpty {
                    NSLog("Claude OAuth credentials read from Keychain (\(creds.count) chars)")
                    return creds
                }
            }
        } catch {
            NSLog("Failed to read Claude OAuth from Keychain: \(error)")
        }
        return nil
    }

    func startAgents() {
        let envPath = "\(dataDir)/jarvis.env"
        let envContent = (try? String(contentsOfFile: envPath, encoding: .utf8)) ?? ""

        // LLM: Claude CLI only (Max subscription) — no API keys or OAuth needed
        NSLog("Starting agents (LLM: Claude CLI)...")

        // Start orchestrator locally (from monorepo if available)
        startOrchestrator(envContent: envContent)

        // Start remote agents via SSH + expect (keyboard-interactive auth)
        let smithHost = envValue("SMITH_IP", from: envContent)
        let smithUser = envValue("SMITH_USER", from: envContent)
        let smithPass = envValue("SMITH_PASS", from: envContent)
        let johnyHost = envValue("JOHNY_IP", from: envContent)
        let johnyUser = envValue("JOHNY_USER", from: envContent)
        let johnyPass = envValue("JOHNY_PASS", from: envContent)

        startRemoteAgent(name: "smith", host: smithHost, user: smithUser, password: smithPass, agentId: "agent-smith")
        startRemoteAgent(name: "johny", host: johnyHost, user: johnyUser, password: johnyPass, agentId: "agent-johny")

        NSLog("Agent startup sequence complete")
    }

    func stopAgents() {
        NSLog("Stopping agents...")

        let envPath = "\(dataDir)/jarvis.env"
        let envContent = (try? String(contentsOfFile: envPath, encoding: .utf8)) ?? ""

        let smithHost = envValue("SMITH_IP", from: envContent)
        let smithUser = envValue("SMITH_USER", from: envContent)
        let smithPass = envValue("SMITH_PASS", from: envContent)
        let johnyHost = envValue("JOHNY_IP", from: envContent)
        let johnyUser = envValue("JOHNY_USER", from: envContent)
        let johnyPass = envValue("JOHNY_PASS", from: envContent)

        // Kill remote processes (fire-and-forget)
        if !smithHost.isEmpty && !smithUser.isEmpty {
            runSSHCommand(host: smithHost, user: smithUser, password: smithPass, command:
                "pkill -f 'tsx.*cli.ts'; pkill -f vnc-proxy; true")
        }
        if !johnyHost.isEmpty && !johnyUser.isEmpty {
            runSSHCommand(host: johnyHost, user: johnyUser, password: johnyPass, command:
                "pkill -f 'tsx.*cli.ts'; pkill -f vnc-proxy; true")
        }

        // Terminate all persistent SSH processes
        for (name, process) in remoteProcesses {
            if process.isRunning {
                process.interrupt()
                DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) {
                    if process.isRunning { process.terminate() }
                }
                NSLog("Terminated persistent SSH [\(name)]")
            }
        }
        remoteProcesses.removeAll()

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

        // Kill any stale orchestrator/agent processes from previous app launches
        let killProcess = Process()
        killProcess.executableURL = URL(fileURLWithPath: "/bin/bash")
        killProcess.arguments = ["-c", "pkill -f 'tsx.*cli.ts' 2>/dev/null; pkill -f 'claude -p' 2>/dev/null; sleep 1; true"]
        killProcess.standardOutput = FileHandle.nullDevice
        killProcess.standardError = FileHandle.nullDevice
        try? killProcess.run()
        killProcess.waitUntilExit()
        NSLog("Killed stale orchestrator/claude processes")

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

    private func startRemoteAgent(name: String, host: String, user: String, password: String, agentId: String) {
        guard !host.isEmpty, !user.isEmpty else {
            NSLog("\(name): no host/user configured, skipping")
            return
        }

        NSLog("Starting remote agent: \(name) (\(user)@\(host))")

        // 1. Kill stale processes (agent-runtime, vnc-proxy, old websockify)
        runSSHCommand(host: host, user: user, password: password, command:
            "pkill -f agent-runtime; pkill -f vnc-proxy; lsof -ti:6080 | xargs kill -9 2>/dev/null; sleep 1; true")

        // 2. Mount QNAP NAS on remote machine via SMB (to ~/qnap — /Volumes needs root)
        // Always unmount first to ensure clean mount with correct permissions
        let mountCmd = """
            mkdir -p $HOME/qnap 2>/dev/null; \
            umount $HOME/qnap 2>/dev/null; sleep 0.5; \
            mount_smbfs -f 0777 -d 0777 //\(qnapUser):\(qnapPass)@\(qnapHost)/\(qnapShare) $HOME/qnap 2>/dev/null; \
            sleep 1; \
            [ -d $HOME/qnap/\(qnapNasSubdir) ] && echo 'QNAP mounted' || echo 'QNAP mount failed — using local NAS'
            """
        runSSHCommand(host: host, user: user, password: password, command: mountCmd)

        // 3. Deploy agent code to ~/.jarvis on remote machine (auto-sync from bundled app)
        let jarvisDir = NSHomeDirectory() + "/Documents/Jarvis-2.0/jarvis"
        deployAgentCode(host: host, user: user, password: password, sourceDir: jarvisDir)

        // 4. Start agent-runtime via persistent SSH
        let agentRole = name == "johny" ? "marketing" : "dev"
        let natsToken = envValue("NATS_TOKEN", from: (try? String(contentsOfFile: "\(dataDir)/jarvis.env", encoding: .utf8)) ?? "")
        // Remote machines mount QNAP to ~/qnap (mount_smbfs can't write to /Volumes without root)
        // Fallback to local NAS (~/.jarvis/nas) if QNAP is inaccessible (macOS TCC/FDA restrictions)
        let agentCmd = """
            export PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH && \
            source ~/.nvm/nvm.sh 2>/dev/null && nvm use 22 2>/dev/null; \
            cd ~/.jarvis && \
            QNAP_NAS=$HOME/qnap/\(qnapNasSubdir) && \
            LOCAL_NAS=$HOME/.jarvis/nas && \
            if [ -d $QNAP_NAS ] && ls $QNAP_NAS/ >/dev/null 2>&1; then \
              REMOTE_NAS=$QNAP_NAS; echo 'NAS: QNAP'; \
            else \
              mkdir -p $LOCAL_NAS/config $LOCAL_NAS/sessions $LOCAL_NAS/logs $LOCAL_NAS/workspace 2>/dev/null; \
              REMOTE_NAS=$LOCAL_NAS; echo 'NAS: local fallback'; \
            fi && \
            set -a; [ -f .env ] && source .env; [ -f $REMOTE_NAS/config/api-keys.env ] && source $REMOTE_NAS/config/api-keys.env; set +a; \
            export JARVIS_AGENT_ID=\(agentId) && \
            export JARVIS_AGENT_ROLE=\(agentRole) && \
            export NATS_URL=nats://192.168.1.33:4222 && \
            export NATS_TOKEN=\(natsToken) && \
            export JARVIS_NAS_MOUNT=$REMOTE_NAS && \
            security unlock-keychain -p \(password) ~/Library/Keychains/login.keychain-db 2>/dev/null; \
            exec ./node_modules/.bin/tsx packages/agent-runtime/src/cli.ts
            """
        launchPersistentSSH(name: "\(name)-agent", host: host, user: user, password: password, command: agentCmd)

        // 4. Start VNC proxy via persistent SSH
        let vncCmd = """
            export PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH && \
            cd ~/.jarvis && \
            export VNC_USERNAME=\(user) && \
            export VNC_PASSWORD='\(password)' && \
            exec ./node_modules/.bin/tsx scripts/vnc-proxy.ts
            """
        launchPersistentSSH(name: "\(name)-vnc", host: host, user: user, password: password, command: vncCmd)

        NSLog("Remote agent \(name) started via persistent SSH (QNAP NAS: ~/qnap/\(qnapNasSubdir))")
    }

    /// Launches a persistent SSH session via expect (does NOT wait for exit).
    /// The SSH connection stays alive with ServerAliveInterval, keeping the remote
    /// process parented to an active session so macOS doesn't revoke its network.
    private func launchPersistentSSH(name: String, host: String, user: String, password: String, command: String) {
        // Tcl escape: $ [ ] \ "
        let escapedPassword = password
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "$", with: "\\$")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")

        let escapedCommand = command
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "$", with: "\\$")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")

        let expectScript = """
            set timeout -1
            spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
                -o ServerAliveInterval=10 -o ServerAliveCountMax=30 \
                \(user)@\(host) "\(escapedCommand)"
            expect {
                "*assword*" { send "\(escapedPassword)\\r"; exp_continue }
                eof {}
            }
            """

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/expect")
        process.arguments = ["-c", expectScript]
        process.standardInput = FileHandle.nullDevice

        let logFile = "\(dataDir)/logs/\(name).log"
        try? "".write(toFile: logFile, atomically: true, encoding: .utf8)
        if let fh = FileHandle(forWritingAtPath: logFile) {
            process.standardOutput = fh
            process.standardError = fh
        }

        do {
            try process.run()
            remoteProcesses[name] = process
            NSLog("Persistent SSH [\(name)] started (PID: \(process.processIdentifier))")
        } catch {
            NSLog("Failed to start persistent SSH [\(name)]: \(error)")
        }
    }

    /// Deploy agent code to ~/.jarvis on a remote machine via rsync
    private func deployAgentCode(host: String, user: String, password: String, sourceDir: String) {
        NSLog("Deploying agent code to \(user)@\(host):~/.jarvis ...")

        // Create ~/.jarvis and nas dirs
        runSSHCommand(host: host, user: user, password: password, command:
            "mkdir -p ~/.jarvis/nas/config ~/.jarvis/nas/sessions ~/.jarvis/nas/logs ~/.jarvis/nas/workspace")

        // Rsync only the needed packages (exclude .env, .git, heavy stuff)
        let escapedPassword = password
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "$", with: "\\$")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")

        let expectScript = """
            set timeout 120
            spawn rsync -az --delete \
                --exclude .git --exclude .turbo --exclude .env \
                --exclude "packages/desktop" \
                "\(sourceDir)/" "\(user)@\(host):~/.jarvis/"
            expect {
                "*assword*" { send "\(escapedPassword)\\r"; exp_continue }
                eof {}
            }
            catch wait result
            exit [lindex $result 3]
            """

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/expect")
        process.arguments = ["-c", expectScript]
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            process.waitUntilExit()
            let output = String(data: pipe.fileHandleForReading.availableData, encoding: .utf8) ?? ""
            if process.terminationStatus == 0 {
                NSLog("Agent code deployed to \(host):~/.jarvis")
            } else {
                NSLog("Rsync to \(host) failed (exit \(process.terminationStatus)): \(output.prefix(200))")
            }
        } catch {
            NSLog("Deploy failed to \(host): \(error)")
        }

        // Fix pnpm symlinks that rsync may not preserve correctly
        // ws is needed by scripts/vnc-proxy.ts
        runSSHCommand(host: host, user: user, password: password, command:
            "cd ~/.jarvis/node_modules && [ ! -e ws ] && ln -sf .pnpm/ws@8.19.0/node_modules/ws ws; true")
    }

    /// Run SSH command and return stdout (for reading remote values like TB IP)
    private func runSSHCommandWithOutput(host: String, user: String, password: String, command: String) -> String {
        let escapedPassword = password
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "$", with: "\\$")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
        let escapedCommand = command
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "$", with: "\\$")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
        let expectScript = """
            log_user 0
            set timeout 10
            spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 \(user)@\(host) "\(escapedCommand)"
            expect {
                "*assword*" { send "\(escapedPassword)\\r"; exp_continue }
                eof {}
            }
            """
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/expect")
        process.arguments = ["-c", expectScript]
        process.standardInput = FileHandle.nullDevice
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.availableData
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        } catch {
            return ""
        }
    }

    /// Detect Thunderbolt IP of a remote agent via SSH (reads bridge0 inet address)
    private func detectRemoteThunderboltIP(host: String, user: String, password: String) -> String? {
        let output = runSSHCommandWithOutput(host: host, user: user, password: password,
            command: "ifconfig bridge0 2>/dev/null | grep 'inet ' | awk '{print $2}'")
        // Output may contain "spawn ssh..." noise — extract just the IP
        for line in output.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("169.254.") {
                return trimmed
            }
        }
        return nil
    }

    /// Fix bridge0 netmask on a remote machine from /32 to /16 via SSH
    private func fixRemoteThunderboltNetmask(host: String, user: String, password: String, tbIP: String) {
        runSSHCommand(host: host, user: user, password: password,
            command: "echo '\(password)' | sudo -S ifconfig bridge0 \(tbIP) netmask 255.255.0.0 2>/dev/null; true")
    }

    private func runSSHCommand(host: String, user: String, password: String, command: String) {
        // Escape special characters for Tcl/expect script
        // Password: escape Tcl specials inside double quotes ($, [, ], \, ")
        let escapedPassword = password
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "$", with: "\\$")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")

        // Command: escape all Tcl specials so $PATH, $(cmd) etc. pass through to remote shell
        let escapedCommand = command
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "$", with: "\\$")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")

        let expectScript = """
            set timeout 30
            spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 \(user)@\(host) "\(escapedCommand)"
            expect {
                "*assword*" { send "\(escapedPassword)\\r"; exp_continue }
                eof {}
            }
            catch wait result
            exit [lindex $result 3]
            """

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/expect")
        process.arguments = ["-c", expectScript]
        process.standardInput = FileHandle.nullDevice

        // Log output for debugging
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            process.waitUntilExit()
            let output = String(data: pipe.fileHandleForReading.availableData, encoding: .utf8) ?? ""
            if process.terminationStatus != 0 {
                NSLog("SSH to \(host) exit \(process.terminationStatus): \(output.prefix(200))")
            }
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

    /// Fix bridge0 netmask from /32 to /16 so Thunderbolt link-local IPs can communicate
    private func fixThunderboltNetmask() {
        guard let firstIP = self.thunderboltIPs.first else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/sbin/ifconfig")
        process.arguments = ["bridge0", firstIP, "netmask", "255.255.0.0"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus == 0 {
                NSLog("Fixed bridge0 netmask to /16 for \(firstIP)")
            } else {
                NSLog("bridge0 netmask fix failed (status \(process.terminationStatus)) — may need sudo")
            }
        } catch {
            NSLog("Failed to fix bridge0 netmask: \(error)")
        }
    }

    /// Detect all Thunderbolt link-local IPs (bridge0, en6, en7, etc.)
    private func detectThunderboltIPs() -> [String] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/sbin/ifconfig")
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            let output = String(data: pipe.fileHandleForReading.availableData, encoding: .utf8) ?? ""
            var ips: [String] = []
            var currentIface = ""
            for line in output.components(separatedBy: "\n") {
                if !line.hasPrefix("\t") && !line.hasPrefix(" ") && line.contains(":") {
                    currentIface = String(line.prefix(while: { $0 != ":" }))
                }
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("inet ") && trimmed.contains("169.254.") {
                    let parts = trimmed.components(separatedBy: " ")
                    if parts.count >= 2 {
                        let ip = parts[1]
                        ips.append(ip)
                        NSLog("Thunderbolt IP detected: \(ip) (on \(currentIface))")
                    }
                }
            }
            return ips
        } catch {
            NSLog("Failed to detect Thunderbolt IPs: \(error)")
        }
        return []
    }

    private func findSystemNode() -> String {
        // Check common locations
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            NSHomeDirectory() + "/.nvm/versions/node/v22.22.0/bin/node",
        ]
        for c in candidates {
            if FileManager.default.fileExists(atPath: c) { return c }
        }
        // Try NVM versions
        let nvmDir = NSHomeDirectory() + "/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvmDir) {
            for v in versions.sorted().reversed() {
                let p = "\(nvmDir)/\(v)/bin/node"
                if FileManager.default.fileExists(atPath: p) { return p }
            }
        }
        return "/opt/homebrew/bin/node"
    }

    private func randomHex(_ bytes: Int) -> String {
        var data = Data(count: bytes)
        _ = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, bytes, $0.baseAddress!) }
        return data.map { String(format: "%02x", $0) }.joined()
    }
}

// ─── App Delegate ──────────────────────────────────────────

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {

    // WKScriptMessageHandler — catch JS errors
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        NSLog("[WebView] \(message.body)")
    }

    // WKNavigationDelegate — log navigation events
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        NSLog("[WebView] Started loading: \(webView.url?.absoluteString ?? "?")")
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("[WebView] Finished loading: \(webView.url?.absoluteString ?? "?")")
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("[WebView] Navigation FAILED: \(error.localizedDescription)")
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("[WebView] Provisional navigation FAILED: \(error.localizedDescription)")
    }
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
        window.collectionBehavior = [.fullScreenPrimary]
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

        // Clear WKWebView cache to avoid stale data
        let dataStore = WKWebsiteDataStore.default()
        let dataTypes = WKWebsiteDataStore.allWebsiteDataTypes()
        dataStore.fetchDataRecords(ofTypes: dataTypes) { records in
            dataStore.removeData(ofTypes: dataTypes, for: records) {
                NSLog("WebView cache cleared (\(records.count) records)")
            }
        }

        // Create WebView
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.preferences.setValue(true, forKey: "fullScreenEnabled")
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.websiteDataStore = dataStore

        // Inject JS error logger
        let errorScript = WKUserScript(
            source: """
            window.onerror = function(msg, src, line, col, err) {
                window.webkit.messageHandlers.jsError.postMessage(
                    'JS ERROR: ' + msg + ' at ' + src + ':' + line + ':' + col
                );
                return false;
            };
            window.addEventListener('unhandledrejection', function(e) {
                window.webkit.messageHandlers.jsError.postMessage(
                    'UNHANDLED PROMISE: ' + (e.reason?.message || e.reason || 'unknown')
                );
            });
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.add(self, name: "jsError")
        config.userContentController.addUserScript(errorScript)

        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.allowsBackForwardNavigationGestures = true
        webView.customUserAgent = "JarvisDashboard/1.0 Safari/605"
        webView.navigationDelegate = self
        window.contentView?.addSubview(webView)

        if let url = URL(string: "http://localhost:\(port)/") {
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
