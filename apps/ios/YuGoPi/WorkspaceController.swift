import AVFoundation
import UIKit
import VisionKit
import WebKit

final class WorkspaceController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    private let scanMessage = "yugoNativeScanner"
    private let lanSignaling = LANSignaling()
    private lazy var web = makeWebView()
    private var loadError: UIStackView?
    private var cameraPending = false
    private var files = [ObjectIdentifier: URL]()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        view.addSubview(web)
        web.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        openWorkspace()
    }

    private func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "YuGoPi-iOS"
        configuration.allowsInlineMediaPlayback = true
        configuration.limitsNavigationsToAppBoundDomains = true
        configuration.userContentController.add(WeakMessageHandler(self), name: scanMessage)
        configuration.userContentController.add(WeakMessageHandler(lanSignaling), name: LANSignaling.messageName)
        configuration.userContentController.addUserScript(WKUserScript(
            source: LANSignaling.script, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page
        ))
        let result = WKWebView(frame: .zero, configuration: configuration)
        lanSignaling.webView = result
        result.navigationDelegate = self
        result.uiDelegate = self
        result.backgroundColor = .systemBackground
        return result
    }

    private func openWorkspace() {
        lanSignaling.stop()
        loadError?.removeFromSuperview()
        loadError = nil
        web.load(URLRequest(url: TrustedClient.site))
    }

    private func showLoadError(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled, loadError == nil else { return }
        let title = UILabel()
        title.text = NSLocalizedString("Unable to open YuGo Pi", comment: "")
        title.textAlignment = .center
        title.font = .preferredFont(forTextStyle: .headline)
        title.numberOfLines = 0
        title.adjustsFontForContentSizeCategory = true
        let retry = UIButton(type: .system)
        retry.configuration = .filled()
        retry.setTitle(NSLocalizedString("Try Again", comment: ""), for: .normal)
        retry.addAction(UIAction { [weak self] _ in self?.openWorkspace() }, for: .touchUpInside)
        let panel = UIStackView(arrangedSubviews: [title, retry])
        panel.axis = .vertical
        panel.spacing = 14
        panel.alignment = .center
        panel.isLayoutMarginsRelativeArrangement = true
        panel.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 16, leading: 18, bottom: 16, trailing: 18)
        panel.backgroundColor = .secondarySystemBackground
        panel.layer.cornerRadius = 14
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(panel)
        NSLayoutConstraint.activate([
            panel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            panel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            panel.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            panel.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
        ])
        loadError = panel
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        lanSignaling.stop()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        openWorkspace()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let inlinePreview = navigationAction.targetFrame?.isMainFrame == false && isInlinePreview(url)
        if TrustedClient.contains(url) || TrustedClient.containsBlob(url) || inlinePreview {
            decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow)
            return
        }
        decisionHandler(.cancel)
        if navigationAction.navigationType == .linkActivated {
            openExternal(url)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let response = navigationResponse.response
        let inlinePreview = !navigationResponse.isForMainFrame && isInlinePreview(response.url)
        guard TrustedClient.contains(response.url) || TrustedClient.containsBlob(response.url) || inlinePreview else {
            decisionHandler(.cancel)
            return
        }
        let disposition = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")
        let attachment = disposition?.lowercased().hasPrefix("attachment") == true
        decisionHandler(navigationResponse.canShowMIMEType && !attachment ? .allow : .download)
    }

    private func isInlinePreview(_ url: URL?) -> Bool {
        guard let address = url?.absoluteString else { return false }
        return address == "about:srcdoc" || address == "about:blank"
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let url = navigationAction.request.url
        if TrustedClient.contains(url) {
            webView.load(navigationAction.request)
        } else if navigationAction.navigationType == .linkActivated {
            openExternal(url)
        }
        return nil
    }

    private func openExternal(_ url: URL?) {
        guard let url, let scheme = url.scheme?.lowercased(), ["https", "http", "mailto"].contains(scheme) else { return }
        UIApplication.shared.open(url)
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(frame.isMainFrame && TrustedClient.contains(frame.request.url) && type == .camera ? .prompt : .deny)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == scanMessage, message.body as? String == "scan", message.frameInfo.isMainFrame,
              TrustedClient.contains(message.frameInfo.request.url), TrustedClient.contains(web.url),
              view.window != nil, presentedViewController == nil, !cameraPending else { return }
        guard DataScannerViewController.isSupported else {
            showCameraHelp(canOpenSettings: false)
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            showScanner()
        case .notDetermined:
            cameraPending = true
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.cameraPending = false
                    if granted {
                        self.showScanner()
                    } else {
                        self.showCameraHelp(canOpenSettings: true)
                    }
                }
            }
        case .denied:
            showCameraHelp(canOpenSettings: true)
        default:
            showCameraHelp(canOpenSettings: false)
        }
    }

    private func showScanner() {
        guard view.window != nil, presentedViewController == nil else { return }
        guard DataScannerViewController.isAvailable else {
            showCameraHelp(canOpenSettings: false)
            return
        }
        let controller = PairingScanner(onPair: { [weak self] url in
            self?.dismiss(animated: true) { self?.web.load(URLRequest(url: url)) }
        }, onUnavailable: { [weak self] in
            self?.dismiss(animated: true) { self?.showCameraHelp(canOpenSettings: false) }
        })
        let navigation = UINavigationController(rootViewController: controller)
        navigation.modalPresentationStyle = .fullScreen
        present(navigation, animated: true)
    }

    private func showCameraHelp(canOpenSettings: Bool) {
        guard view.window != nil, presentedViewController == nil else { return }
        let alert = UIAlertController(
            title: NSLocalizedString("Camera unavailable", comment: ""),
            message: NSLocalizedString("Copy the pairing link on your computer and paste it into YuGo Pi.", comment: ""),
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: NSLocalizedString("OK", comment: ""), style: .cancel))
        if canOpenSettings, let url = URL(string: UIApplication.openSettingsURLString) {
            alert.addAction(UIAlertAction(title: NSLocalizedString("Settings", comment: ""), style: .default) { _ in
                UIApplication.shared.open(url)
            })
        }
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            let name = (suggestedFilename as NSString).lastPathComponent
            let file = directory.appendingPathComponent(["", ".", ".."].contains(name) ? "download" : name)
            files[ObjectIdentifier(download)] = file
            completionHandler(file)
        } catch {
            completionHandler(nil)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = files.removeValue(forKey: ObjectIdentifier(download)) else { return }
        if presentedViewController != nil {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
            return
        }
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        present(share, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = files.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
    }
}

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
