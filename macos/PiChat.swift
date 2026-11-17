import AppKit
import WebKit

final class PiWindow: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    let origin = "http://127.0.0.1:31415"

    func applicationDidFinishLaunching(_ notification: Notification) {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1280, height: 850)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: min(1220, screen.width - 60), height: min(820, screen.height - 60)), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Pi Workspace"
        window.minSize = NSSize(width: 640, height: 480)
        window.center()
        web = WKWebView(frame: .zero)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        window.contentView = web
        installMenu()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        signIn()
    }

    func installMenu() {
        let menu = NSMenu()
        let app = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 Pi", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
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
        if action.targetFrame?.isMainFrame == true, let url = action.request.url, !["127.0.0.1", "localhost"].contains(url.host ?? ""), ["http", "https"].contains(url.scheme ?? "") {
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
        if let url = action.request.url {
            if ["127.0.0.1", "localhost"].contains(url.host ?? "") { webView.load(action.request) }
            else if ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        }
        return nil
    }
}

let application = NSApplication.shared
let delegate = PiWindow()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
