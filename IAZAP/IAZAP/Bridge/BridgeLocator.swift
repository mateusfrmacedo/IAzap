import Foundation

/// Resolves the on-disk `bridge/` package (Node + Baileys) for the macOS app to spawn.
enum BridgeLocator {
    private static let defaultsKey = "iazap.bridgeDirectory"

    /// Prefer env → UserDefaults → build-phase tip file → bundled Resources/bridge → common clone paths.
    static func resolve() -> URL? {
        let fm = FileManager.default

        if let env = ProcessInfo.processInfo.environment["IAZAP_BRIDGE_DIR"], !env.isEmpty {
            let url = URL(fileURLWithPath: env, isDirectory: true)
            if isBridgePackage(url) { return url }
        }

        if let saved = UserDefaults.standard.string(forKey: defaultsKey), !saved.isEmpty {
            let url = URL(fileURLWithPath: saved, isDirectory: true)
            if isBridgePackage(url) { return url }
        }

        if let tip = tipFileURL(), isBridgePackage(tip) {
            return tip
        }

        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("bridge", isDirectory: true),
           isBridgePackage(bundled) {
            return bundled
        }

        for candidate in candidatePaths() where isBridgePackage(candidate) {
            return candidate
        }

        // Last resort: walk up from the executable looking for …/bridge/package.json
        var dir = Bundle.main.bundleURL.deletingLastPathComponent()
        for _ in 0..<8 {
            let bridge = dir.appendingPathComponent("bridge", isDirectory: true)
            if isBridgePackage(bridge) { return bridge }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }

        _ = fm
        return nil
    }

    static func remember(_ url: URL) {
        UserDefaults.standard.set(url.path, forKey: defaultsKey)
    }

    static func isBridgePackage(_ url: URL) -> Bool {
        let pkg = url.appendingPathComponent("package.json")
        let entry = url.appendingPathComponent("src/index.ts")
        return FileManager.default.fileExists(atPath: pkg.path)
            && FileManager.default.fileExists(atPath: entry.path)
    }

    private static func tipFileURL() -> URL? {
        guard let resourceURL = Bundle.main.resourceURL else { return nil }
        let tip = resourceURL.appendingPathComponent("bridge-root.txt")
        guard let raw = try? String(contentsOf: tip, encoding: .utf8) else { return nil }
        let path = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    private static func candidatePaths() -> [URL] {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        return [
            cwd.appendingPathComponent("bridge", isDirectory: true),
            cwd.appendingPathComponent("../bridge", isDirectory: true).standardizedFileURL,
            home.appendingPathComponent("Developer/IAzap/bridge", isDirectory: true),
            home.appendingPathComponent("Developer/iazap/bridge", isDirectory: true),
            home.appendingPathComponent("Projects/IAzap/bridge", isDirectory: true),
            home.appendingPathComponent("src/IAzap/bridge", isDirectory: true),
            home.appendingPathComponent("IAzap/bridge", isDirectory: true),
            home.appendingPathComponent("Documents/IAzap/bridge", isDirectory: true),
            home.appendingPathComponent("Desktop/IAzap/bridge", isDirectory: true),
        ]
    }
}
