import AppKit
import WebKit

final class PiWindow: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
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
        let configuration = WKWebViewConfiguration()
        // Let script-opened windows (window.open after an await) reach
        // createWebViewWith instead of being silently blocked.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        window.contentView = web
        installMenu()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        if let host = packagedHost {
            startHost(host)
        } else {
            signIn()
        }
    }

    func installMenu() {
        let menu = NSMenu()
        let app = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 YuGo Pi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenu.insertItem(withTitle: "查看 YuGo Pi 更新", action: #selector(checkForRelease), keyEquivalent: "", at: 0)
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

    func startHost(_ host: HostRuntime) {
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
        let session = URLSession(configuration: configuration)
        Task { @MainActor in
            defer { session.invalidateAndCancel() }
            do {
                let token = try await Task.detached {
                    let token = try host.accessToken()
                    try host.ensureRunning()
                    return token
                }.value
                var request = URLRequest(url: URL(string: origin + "/api/version")!)
                request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
                for _ in 0..<35 {
                    if let (data, response) = try? await session.data(for: request),
                       (response as? HTTPURLResponse)?.statusCode == 200,
                       let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       body["current"] is String,
                       let cookie = HTTPCookie(properties: [
                        .name: "pi_token", .value: token, .domain: "127.0.0.1",
                        .path: "/", .discard: "TRUE", .version: "0",
                        HTTPCookiePropertyKey("HttpOnly"): "TRUE"
                       ]) {
                        await web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
                        web.load(URLRequest(url: URL(string: origin)!))
                        return
                    }
                    try await Task.sleep(nanoseconds: 250_000_000)
                }
                throw HostError.cannotStart
            } catch {
                let alert = NSAlert()
                alert.messageText = "无法打开 YuGo Pi"
                alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: "重试")
                alert.addButton(withTitle: "关闭")
                alert.beginSheetModal(for: window) { [weak self] result in
                    if result == .alertFirstButtonReturn { self?.startHost(host) }
                    else { self?.window.close() }
                }
            }
        }
    }

    func signIn() {
        let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/com.pi-web.plist")
        guard let data = try? Data(contentsOf: path),
              let config = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
              let env = config["EnvironmentVariables"] as? [String: String],
              let token = env["PI_WEB_TOKEN"] else { web.load(URLRequest(url: URL(string: origin)!)); return }
        var recent = URLRequest(url: URL(string: origin + "/api/sessions?limit=1")!)
        recent.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        URLSession.shared.dataTask(with: recent) { [weak self] data, _, _ in
            guard let self else { return }
            var session = ""
            if let data, let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let rows = json["sessions"] as? [[String: Any]], let first = rows.first {
                session = (first["id"] as? String) ?? (first["ID"] as? String) ?? ""
            }
            var request = URLRequest(url: URL(string: self.origin + "/api/connect")!)
            request.httpMethod = "POST"
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["target": "local", "session": session])
            URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
                guard let self else { return }
                var destination = self.origin
                if let data, let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let url = json["url"] as? String, url.hasPrefix(self.origin + "/") { destination = url }
                DispatchQueue.main.async { self.web.load(URLRequest(url: URL(string: destination)!)) }
            }.resume()
        }.resume()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        if action.targetFrame?.isMainFrame == true, let url = action.request.url, !(["127.0.0.1", "localhost"].contains(url.host ?? "") && url.port == 31415), ["http", "https", "mailto"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
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
        let panel = NSOpenPanel(); panel.allowsMultipleSelection = parameters.allowsMultipleSelection; panel.canChooseDirectories = parameters.allowsDirectories
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.absoluteString != "about:blank", !url.absoluteString.isEmpty {
            openRequested(url)
            return nil
        }
        // window.open() with no URL, navigated afterwards: hand back an
        // offscreen view and forward its first real navigation.
        let catcher = PopupCatcher { [weak self] url in self?.openRequested(url) }
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.navigationDelegate = catcher
        catcher.view = popup
        popups.append(catcher)
        catcher.onDone = { [weak self, weak catcher] in self?.popups.removeAll { $0 === catcher } }
        return popup
    }
    var popups: [PopupCatcher] = []

    func openRequested(_ url: URL) {
        if ["127.0.0.1", "localhost"].contains(url.host ?? "") && url.port == 31415 { web.load(URLRequest(url: url)) }
        else if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
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
