import Foundation
import Security

struct HostRuntime {
    let resources: URL
    let servicePort = 31415

    var installed: Bool {
        FileManager.default.isExecutableFile(atPath: bundledExecutable.path)
    }

    private var bundledExecutable: URL { resources.appendingPathComponent("host/pi-web") }
    private var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    private var runtime: URL { home.appendingPathComponent(".local/share/pi-hub") }
    private var executable: URL { runtime.appendingPathComponent("pi-web") }
    private var plist: URL { home.appendingPathComponent("Library/LaunchAgents/com.pi-web.plist") }
    private var service: String { "gui/\(getuid())" }

    func accessToken() throws -> String {
        if FileManager.default.fileExists(atPath: plist.path) {
            let existing = try PropertyListSerialization.propertyList(
                from: Data(contentsOf: plist), format: nil
            ) as? [String: Any]
            if let environment = existing?["EnvironmentVariables"] as? [String: String],
               let token = environment["PI_WEB_TOKEN"], !token.isEmpty {
                if let arguments = existing?["ProgramArguments"] as? [String],
                   arguments.first == executable.path,
                   try launchctl(["print", service + "/com.pi-web"]) != 0 {
                    try stageBackend()
                }
                return token
            }
            throw HostError.incompatibleInstallation
        }

        var rawToken = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, rawToken.count, &rawToken) == errSecSuccess else {
            throw HostError.tokenUnavailable
        }
        let token = rawToken.map { String(format: "%02x", $0) }.joined()
        let environment = ProcessInfo.processInfo.environment
        let agent: URL
        if let configured = environment["PI_CODING_AGENT_DIR"], configured.hasPrefix("/") {
            agent = URL(fileURLWithPath: configured)
        } else {
            agent = home.appendingPathComponent(".pi/agent")
        }
        let workspace = home.appendingPathComponent("Pi Projects")
        let logDir = agent.appendingPathComponent("remote/logs")
        for directory in [agent.appendingPathComponent("sessions"), workspace, logDir, plist.deletingLastPathComponent()] {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
            )
        }
        let approval = Bundle.main.bundleURL.appendingPathComponent(
            "Contents/Helpers/YuGo Pi Approval.app/Contents/MacOS/YuGo Pi Approval"
        )
        guard FileManager.default.isExecutableFile(atPath: approval.path) else {
            throw HostError.incompleteInstallation
        }
        let bundled = resources.appendingPathComponent("host")
        let bundledBin = bundled.appendingPathComponent("bin")
        try stageBackend()
        let variables = [
            "PATH": bundledBin.path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "PI_CODING_AGENT_DIR": agent.path,
            "PI_WEB_TOKEN": token,
            "PI_WEB_PI_NODE": bundledBin.appendingPathComponent("node").path,
            "PI_WEB_PI_SCRIPT": bundled.appendingPathComponent("node_modules/@earendil-works/pi-coding-agent/dist/cli.js").path,
            "PI_WEB_DEVICE_AUTH": "1",
            "PI_WEB_PAIR_APPROVER": approval.path,
            "PI_WEB_DEFAULT_WORKSPACE": workspace.path,
            "PI_WEB_PROJECT_TRASH_HELPER": Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/project-trash").path,
            "PI_WEB_PROTECTED_PATHS": Bundle.main.bundlePath + ":" + runtime.path
        ]
        let job: [String: Any] = [
            "Label": "com.pi-web",
            "ProgramArguments": [executable.path, "--host", "127.0.0.1"],
            "EnvironmentVariables": variables,
            "WorkingDirectory": workspace.path,
            "RunAtLoad": true,
            "KeepAlive": true,
            "StandardOutPath": logDir.appendingPathComponent("stdout.log").path,
            "StandardErrorPath": logDir.appendingPathComponent("stderr.log").path
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: job, format: .xml, options: 0)
        let temporary = plist.deletingLastPathComponent().appendingPathComponent(".pi-host-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard FileManager.default.createFile(atPath: temporary.path, contents: data,
                                             attributes: [.posixPermissions: 0o600]) else {
            throw HostError.tokenUnavailable
        }
        // Moving to a new filename preserves the mode and refuses to replace an
        // existing user's LaunchAgent if another process just created it.
        try FileManager.default.moveItem(at: temporary, to: plist)
        return token
    }

    func ensureRunning() throws {
        if try launchctl(["print", service + "/com.pi-web"]) == 0 { return }
        guard try launchctl(["bootstrap", service, plist.path]) == 0 else {
            throw HostError.cannotStart
        }
    }

    private func stageBackend() throws {
        let files = FileManager.default
        try files.createDirectory(at: runtime, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if files.fileExists(atPath: executable.path) {
            let attributes = try files.attributesOfItem(atPath: executable.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
                  let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue,
                  permissions & 0o022 == 0 else { throw HostError.incompatibleInstallation }
            let current = try backendVersion(executable)
            let packaged = try backendVersion(bundledExecutable)
            guard current.lexicographicallyPrecedes(packaged) else { return }
        }
        let temporary = runtime.appendingPathComponent(".pi-web-" + UUID().uuidString)
        defer { try? files.removeItem(at: temporary) }
        try files.copyItem(at: bundledExecutable, to: temporary)
        try files.setAttributes([.posixPermissions: 0o755], ofItemAtPath: temporary.path)
        guard rename(temporary.path, executable.path) == 0 else {
            throw HostError.incompleteInstallation
        }
    }

    private func backendVersion(_ file: URL) throws -> [Int] {
        let command = Process()
        let output = Pipe()
        command.executableURL = file
        command.arguments = ["-version"]
        command.standardOutput = output
        command.standardError = FileHandle.nullDevice
        try command.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        command.waitUntilExit()
        let version = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = version.replacingOccurrences(of: "-yugo.", with: ".").split(separator: ".")
        let numbers = parts.compactMap { Int($0) }
        guard command.terminationStatus == 0, parts.count == 4, numbers.count == 4 else {
            throw HostError.incompatibleInstallation
        }
        return numbers
    }

    private func launchctl(_ args: [String]) throws -> Int32 {
        let command = Process()
        command.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        command.arguments = args
        command.standardOutput = FileHandle.nullDevice
        command.standardError = FileHandle.nullDevice
        try command.run()
        command.waitUntilExit()
        return command.terminationStatus
    }
}

enum HostError: LocalizedError {
    case tokenUnavailable, incompatibleInstallation, incompleteInstallation, cannotStart

    var errorDescription: String? {
        switch self {
        case .tokenUnavailable: return "无法创建 YuGo Pi 的本机访问凭据。"
        case .incompatibleInstallation: return "检测到已有 YuGo Pi 服务，但无法读取其本机访问凭据。"
        case .incompleteInstallation: return "缺少 YuGo Pi 认证组件，请重新安装主机安装包。"
        case .cannotStart: return "YuGo Pi 的本机服务未能启动。"
        }
    }
}
