import AppKit
import WebKit

final class PiWindow: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    enum Mode: String { case local, remote }
    private let modeKey = "YuGoPiWorkspaceMode"
    private let viewerStoreID = UUID(uuidString: "4A4B48A6-1849-42C4-AB5C-9482723D2558")!
    private var mode: Mode?
    private let lanSignaling = LANSignaling()
    private let chinese = Locale.preferredLanguages.first?.hasPrefix("zh") == true
    private var picker: URL? { Bundle.main.url(forResource: "workspace-mode", withExtension: "html") }
    private var offline: URL? { Bundle.main.url(forResource: "offline", withExtension: "html") }
    private var legacyAgent: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/com.pi-web.plist")
    }
    var window: NSWindow!
    var web: WKWebView!
    let origin = "http://127.0.0.1:31415"
    var packagedHost: HostRuntime? {
        guard let resources = Bundle.main.resourceURL else { return nil }
        let host = HostRuntime(resources: resources)
        return host.installed ? host : nil
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 850)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: min(1220, screen.width - 60), height: min(820, screen.height - 60)), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "YuGo Pi"
        window.minSize = NSSize(width: 640, height: 480)
        window.center()
        installMenu()
        let saved = UserDefaults.standard.string(forKey: modeKey).flatMap(Mode.init(rawValue:))
        let migrated: Mode? = FileManager.default.fileExists(atPath: legacyAgent.path) ? .local : nil
        showWorkspace(saved ?? migrated)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func showWorkspace(_ next: Mode?) {
        mode = next
        lanSignaling.stop()
        lanSignaling.webView = nil
        popups.removeAll()
        web?.stopLoading()
        let configuration = WKWebViewConfiguration()
        configuration.limitsNavigationsToAppBoundDomains = true
        let content = configuration.userContentController
        let bridge = WorkspaceBridge(self)
        if next == nil {
            content.add(bridge, name: "yugoChooseMode")
        } else {
            content.add(bridge, name: "yugoModeSettings")
            let label = chinese ? "桌面模式" : "Desktop mode"
            content.addUserScript(WKUserScript(source: """
                if (location.origin === 'http://127.0.0.1:31415' || location.origin === 'https://yinniora.github.io') {
                    Object.defineProperty(window, '__YUGOPI_WORKSPACE_MODE__', {
                        value: Object.freeze({ label: '\(label)', open: () => window.webkit.messageHandlers.yugoModeSettings.postMessage(null) })
                    });
                }
                """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        if next == .remote {
            if #available(macOS 14.0, *) {
                configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: viewerStoreID)
            }
            configuration.applicationNameForUserAgent = "YuGoPi-Desktop"
            content.add(lanSignaling, name: LANSignaling.messageName)
            content.addUserScript(WKUserScript(source: LANSignaling.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // Let script-opened windows (window.open after an await) reach
        // createWebViewWith instead of being silently blocked.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        window.contentView = web
        switch next {
        case .none:
            if let picker { web.loadFileURL(picker, allowingReadAccessTo: picker) }
        case .local:
            if let host = packagedHost { startHost(host) }
            else { signIn() }
        case .remote:
            lanSignaling.webView = web
            web.load(URLRequest(url: TrustedClient.site))
        }
    }

    func receiveWorkspaceMessage(_ message: WKScriptMessage) {
        guard message.webView === web, message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url else { return }
        if message.name == "yugoChooseMode", mode == nil,
           url.isFileURL, url.standardizedFileURL == picker?.standardizedFileURL,
           let value = message.body as? String, let selected = Mode(rawValue: value) {
            selectMode(selected)
        } else if message.name == "yugoModeSettings", mode != nil,
                  allowsWorkspaceURL(url), allowsWorkspaceURL(web.url) {
            showModeSettings()
        }
    }

    private func selectMode(_ next: Mode) {
        guard next != mode else { return }
        UserDefaults.standard.set(next.rawValue, forKey: modeKey)
        showWorkspace(next)
    }

    @objc func showModeSettings() {
        guard window.attachedSheet == nil else { return }
        let local = chinese ? "在这台电脑运行 Pi" : "Run Pi on this computer"
        let remote = chinese ? "连接另一台电脑" : "Connect to another computer"
        let alert = NSAlert()
        alert.messageText = chinese ? "桌面模式" : "Desktop mode"
        if let mode {
            alert.informativeText = (chinese ? "当前使用：" : "Current mode: ") + (mode == .local ? local : remote)
        }
        alert.addButton(withTitle: local)
        alert.addButton(withTitle: remote)
        alert.addButton(withTitle: chinese ? "取消" : "Cancel").keyEquivalent = "\u{1b}"
        alert.buttons[0].keyEquivalent = mode == .local ? "\r" : ""
        alert.buttons[1].keyEquivalent = mode == .remote ? "\r" : ""
        alert.beginSheetModal(for: window) { [weak self] result in
            if result == .alertFirstButtonReturn { self?.selectMode(.local) }
            if result == .alertSecondButtonReturn { self?.selectMode(.remote) }
        }
    }

    func installMenu() {
        let menu = NSMenu()
        let app = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 YuGo Pi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenu.insertItem(withTitle: "查看 YuGo Pi 更新", action: #selector(checkForRelease), keyEquivalent: "", at: 0)
        let settings = NSMenuItem(title: chinese ? "桌面模式…" : "Desktop Mode…", action: #selector(showModeSettings), keyEquivalent: ",")
        settings.target = self
        appMenu.insertItem(settings, at: 0)
        app.submenu = appMenu; menu.addItem(app)
        let edit = NSMenuItem(); let editMenu = NSMenu(title: "编辑")
        for (title, selector, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(selector), keyEquivalent: key)
        }
        edit.submenu = editMenu; menu.addItem(edit)
        let view = NSMenuItem(); let viewMenu = NSMenu(title: "显示")
        let reload = NSMenuItem(title: "刷新", action: #selector(refresh), keyEquivalent: "r")
        reload.target = self; viewMenu.addItem(reload); view.submenu = viewMenu; menu.addItem(view)
        NSApplication.shared.mainMenu = menu
    }
    @objc func refresh() { web.reload() }
    @objc func checkForRelease() {
        NSWorkspace.shared.open(URL(string: "https://github.com/yinniora/yugo-pi/releases")!)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard mode == .remote, webView === web, (error as NSError).code != NSURLErrorCancelled,
              let offline, webView.url?.standardizedFileURL != offline.standardizedFileURL else { return }
        webView.loadFileURL(offline, allowingReadAccessTo: offline)
    }

    func startHost(_ host: HostRuntime) {
        let target = web!
        web.loadHTMLString("""
            <!doctype html><meta charset="utf-8">
            <style>
            :root { color-scheme: light dark; font: 15px -apple-system, sans-serif }
            body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: Canvas; color: CanvasText }
            p { opacity: .72 }
            </style><p>正在启动 YuGo Pi…</p>
            """, baseURL: nil)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 1
        configuration.connectionProxyDictionary = [:]
        let session = URLSession(configuration: configuration, delegate: LocalHostRequests(), delegateQueue: nil)
        Task { @MainActor in
            defer { session.invalidateAndCancel() }
            do {
                let token = try await Task.detached {
                    let token = try host.accessToken()
                    try host.ensureRunning()
                    return token
                }.value
                guard target === web else { return }
                var request = URLRequest(url: URL(string: origin + "/api/version")!)
                request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
                for _ in 0..<35 {
                    guard target === web else { return }
                    if let (data, response) = try? await session.data(for: request),
                       (response as? HTTPURLResponse)?.statusCode == 200,
                       let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       body["current"] is String,
                       let cookie = HTTPCookie(properties: [
                        .name: "pi_token", .value: token, .domain: "127.0.0.1",
                        .path: "/", .discard: "TRUE", .version: "0",
                        HTTPCookiePropertyKey("HttpOnly"): "TRUE",
                        .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict
                       ]) {
                        guard target === web else { return }
                        await target.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
                        guard target === web else { return }
                        target.load(URLRequest(url: URL(string: origin)!))
                        return
                    }
                    try await Task.sleep(nanoseconds: 250_000_000)
                }
                throw HostError.cannotStart
            } catch {
                guard target === web else { return }
                let alert = NSAlert()
                alert.messageText = "无法打开 YuGo Pi"
                alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: "重试")
                alert.addButton(withTitle: "桌面模式…")
                alert.beginSheetModal(for: window) { [weak self] result in
                    if result == .alertFirstButtonReturn { self?.startHost(host) }
                    else if result == .alertSecondButtonReturn { self?.showModeSettings() }
                }
            }
        }
    }

    func signIn() {
        let target = web!
        guard let data = try? Data(contentsOf: legacyAgent),
              let config = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
              let env = config["EnvironmentVariables"] as? [String: String],
              let token = env["PI_WEB_TOKEN"] else { web.load(URLRequest(url: URL(string: origin)!)); return }
        var recent = URLRequest(url: URL(string: origin + "/api/sessions?limit=1")!)
        recent.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let session = URLSession(configuration: .ephemeral, delegate: LocalHostRequests(), delegateQueue: nil)
        session.dataTask(with: recent) { [weak self] data, _, _ in
            guard let self else { return }
            var recentID = ""
            if let data, let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let rows = json["sessions"] as? [[String: Any]], let first = rows.first {
                recentID = (first["id"] as? String) ?? (first["ID"] as? String) ?? ""
            }
            var request = URLRequest(url: URL(string: self.origin + "/api/connect")!)
            request.httpMethod = "POST"
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["target": "local", "session": recentID])
            session.dataTask(with: request) { [weak self] data, _, _ in
                guard let self else { return }
                var destination = self.origin
                if let data, let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let url = json["url"] as? String, url.hasPrefix(self.origin + "/") { destination = url }
                DispatchQueue.main.async {
                    if target === self.web { target.load(URLRequest(url: URL(string: destination)!)) }
                }
            }.resume()
            session.finishTasksAndInvalidate()
        }.resume()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func allowsWorkspaceURL(_ url: URL?) -> Bool {
        guard let url else { return false }
        switch mode {
        case .none: return url.isFileURL && url.standardizedFileURL == picker?.standardizedFileURL
        case .local:
            return url.scheme == "http" && url.host == "127.0.0.1" && url.port == 31415 &&
                url.user == nil && url.password == nil
        case .remote:
            return TrustedClient.contains(url)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard webView === web else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload { decisionHandler(.download); return }
        if let url = action.request.url, action.targetFrame?.isMainFrame == true,
           !allowsNavigation(url) {
            if action.navigationType == .linkActivated { openInBrowser(url) }
            decisionHandler(.cancel)
            return
        }
        if mode == .remote, action.targetFrame?.isMainFrame == false,
           action.request.url?.host == "127.0.0.1" {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard webView === web else { decisionHandler(.cancel); return }
        if response.isForMainFrame, let url = response.response.url,
           !allowsNavigation(url) {
            if mode == .remote && TrustedClient.containsBlob(url) { decisionHandler(.download) }
            else { decisionHandler(.cancel) }
            return
        }
        let attachment = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") ?? false
        decisionHandler(attachment || !response.canShowMIMEType ? .download : .allow)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = suggestedFilename
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard webView === web, frame.isMainFrame, allowsWorkspaceURL(frame.request.url) else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let trusted = webView === web && frame.isMainFrame && allowsWorkspaceURL(frame.request.url)
        decisionHandler(trusted && type == .camera ? .prompt : .deny)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.absoluteString != "about:blank", !url.absoluteString.isEmpty {
            openRequested(url)
            return nil
        }
        // window.open() with no URL, navigated afterwards: hand back an
        // offscreen view and forward its first real navigation.
        let catcher = PopupCatcher { [weak self, weak webView] url in
            guard let self, webView === self.web else { return }
            self.openRequested(url)
        }
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.navigationDelegate = catcher
        catcher.view = popup
        popups.append(catcher)
        catcher.onDone = { [weak self, weak catcher] in self?.popups.removeAll { $0 === catcher } }
        return popup
    }
    var popups: [PopupCatcher] = []

    private func allowsNavigation(_ url: URL) -> Bool {
        if allowsWorkspaceURL(url) || url.absoluteString == "about:blank" { return true }
        return mode == .remote && url.isFileURL && url.standardizedFileURL == offline?.standardizedFileURL
    }

    func openRequested(_ url: URL) {
        if allowsWorkspaceURL(url) { web.load(URLRequest(url: url)) }
        else { openInBrowser(url) }
    }

    private func openInBrowser(_ url: URL) {
        if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
    }
}

private final class WorkspaceBridge: NSObject, WKScriptMessageHandler {
    weak var window: PiWindow?
    init(_ window: PiWindow) { self.window = window }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        window?.receiveWorkspaceMessage(message)
    }
}

private final class LocalHostRequests: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class PopupCatcher: NSObject, WKNavigationDelegate {
    let open: (URL) -> Void
    var view: WKWebView?
    var onDone: (() -> Void)?
    init(open: @escaping (URL) -> Void) { self.open = open }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, url.absoluteString != "about:blank" else { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        open(url)
        view = nil
        onDone?()
    }
}

@main
enum YuGoPiApplication {
    static func main() {
        let application = NSApplication.shared
        let delegate = PiWindow()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
    }
}
