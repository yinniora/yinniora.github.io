import CryptoKit
import Foundation
import Security
import WebKit

struct LANEndpoint {
    let url: URL
    let ip: String
    let port: Int
    let fingerprint: Data

    init?(_ address: String, _ fingerprintString: String) {
        guard address.utf8.count <= 80, fingerprintString.utf8.count == 95,
              let parts = URLComponents(string: address),
              parts.scheme == "wss", let ip = parts.host, let port = parts.port,
              (1...65535).contains(port), address == "wss://\(ip):\(port)/remote-signal",
              let url = parts.url else { return nil }
        let octets = ip.split(separator: ".", omittingEmptySubsequences: false)
        let addressBytes = octets.compactMap { UInt8($0, radix: 10) }
        guard octets.count == 4, addressBytes.count == 4,
              addressBytes.map(String.init).joined(separator: ".") == ip,
              addressBytes[0] == 10 ||
                (addressBytes[0] == 172 && (16...31).contains(addressBytes[1])) ||
                (addressBytes[0] == 192 && addressBytes[1] == 168) else { return nil }
        let digestParts = fingerprintString.split(separator: ":", omittingEmptySubsequences: false)
        let bytes = digestParts.compactMap { UInt8($0, radix: 16) }
        guard digestParts.count == 32, bytes.count == 32,
              bytes.map({ String(format: "%02x", $0) }).joined(separator: ":") == fingerprintString
        else { return nil }
        self.url = url
        self.ip = ip
        self.port = port
        self.fingerprint = Data(bytes)
    }
}

final class LANSignaling: NSObject, WKScriptMessageHandler {
    static let messageName = "yugoLANSignal"
    private let limit = 70 * 1024
    private var sockets = [String: PinnedLANSocket]()
    weak var webView: WKWebView?

    func stop() {
        let previous = Array(sockets.values)
        sockets.removeAll()
        previous.forEach { $0.close() }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.name == Self.messageName, message.frameInfo.isMainFrame,
              origin.protocol == "https", origin.host == TrustedClient.host,
              origin.port == 0 || origin.port == 443,
              TrustedClient.contains(message.frameInfo.request.url),
              TrustedClient.contains(webView?.url),
              let body = message.body as? [String: Any], let action = body["action"] as? String,
              let id = body["id"] as? String, UUID(uuidString: id) != nil else { return }
        switch action {
        case "open":
            guard sockets[id] == nil else { return }
            guard sockets.count < 3, let url = body["url"] as? String, let pin = body["pin"] as? String,
                  let endpoint = LANEndpoint(url, pin) else {
                emit(id, "error")
                emit(id, "close")
                return
            }
            let socket = PinnedLANSocket(endpoint: endpoint, limit: limit) { [weak self] type, content in
                guard let self, self.sockets[id] != nil else { return }
                if type == "close" { self.sockets.removeValue(forKey: id) }
                self.emit(id, type, content)
            }
            sockets[id] = socket
            socket.start()
        case "send":
            guard let content = body["content"] as? String else { return }
            sockets[id]?.send(content)
        case "close":
            sockets[id]?.close()
        default:
            break
        }
    }

    private func emit(_ id: String, _ type: String, _ content: String = "") {
        guard let webView, TrustedClient.contains(webView.url) else { return }
        webView.callAsyncJavaScript(
            "window.__YUGOPI_LAN_EVENT__?.(id, kind, content)",
            arguments: ["id": id, "kind": type, "content": content],
            in: nil, in: .page, completionHandler: nil
        )
    }

    static let script = """
    (() => {
      if (window.top !== window || location.origin !== 'https://yinniora.github.io') return;
      const native = window.webkit?.messageHandlers?.yugoLANSignal;
      if (!native) return;
      const pending = new Map();
      const post = (action, id, extra) => native.postMessage({action, id, ...extra});
      const factory = (url, pin) => {
        const id = crypto.randomUUID();
        const socket = new EventTarget();
        let state = 0;
        Object.defineProperties(socket, {
          url: {value: url},
          readyState: {get: () => state},
          send: {value: (content) => {
            if (state !== 1) throw new DOMException('Socket is not open', 'InvalidStateError');
            if (typeof content !== 'string' || content.length > 71680) throw new TypeError('Invalid signal');
            post('send', id, {content});
          }},
          close: {value: () => {
            if (state >= 2) return;
            state = 2;
            post('close', id);
          }}
        });
        pending.set(id, (kind, content) => {
          if (kind === 'open') {
            if (state !== 0) return;
            state = 1;
          } else if (kind === 'close') {
            state = 3;
            pending.delete(id);
          } else if (kind === 'message' && state !== 1) return;
          const event = kind === 'message' ? new MessageEvent(kind, {data: content}) : new Event(kind);
          socket.dispatchEvent(event);
          socket['on' + kind]?.(event);
        });
        post('open', id, {url, pin});
        return socket;
      };
      Object.defineProperties(window, {
        __YUGOPI_LAN_SOCKET__: {value: factory},
        __YUGOPI_LAN_EVENT__: {value: (id, kind, content) => pending.get(id)?.(kind, content)}
      });
    })();
    """
}

// Each socket owns an ephemeral session. Only its exact TLS leaf and numeric
// address can pass the private LAN check. The rest of the app uses system trust.
private final class PinnedLANSocket: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let endpoint: LANEndpoint
    private let limit: Int
    private let event: (String, String) -> Void
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var pinVerified = false
    private var sentOffer = false
    private var receivedAnswer = false

    init(endpoint: LANEndpoint, limit: Int, event: @escaping (String, String) -> Void) {
        self.endpoint = endpoint
        self.limit = limit
        self.event = event
    }

    func start() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
        var request = URLRequest(url: endpoint.url)
        request.setValue("https://" + TrustedClient.host, forHTTPHeaderField: "Origin")
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = limit
        self.session = session
        self.task = task
        task.resume()
    }

    func send(_ content: String) {
        guard let task, pinVerified, !sentOffer, validSignal(content, kind: "offer") else {
            finish(failed: true)
            return
        }
        sentOffer = true
        task.send(.string(content)) { [weak self] error in
            if error != nil { DispatchQueue.main.async { self?.finish(failed: true) } }
        }
    }

    private func validSignal(_ content: String, kind: String) -> Bool {
        guard content.utf8.count <= limit,
              let body = try? JSONSerialization.jsonObject(with: Data(content.utf8)) as? [String: Any],
              body["type"] as? String == kind, let sdp = body["sdp"] as? String, !sdp.isEmpty else {
            return false
        }
        return true
    }

    private func receive() {
        task?.receive { [weak self] response in
            DispatchQueue.main.async {
                guard let self, self.task != nil else { return }
                let valid: String
                switch response {
                case let .success(.string(content))
                    where self.sentOffer && !self.receivedAnswer && self.validSignal(content, kind: "answer"):
                    valid = content
                default:
                    self.finish(failed: true)
                    return
                }
                self.receivedAnswer = true
                self.event("message", valid)
                self.receive()
            }
        }
    }

    func close() { finish(failed: false) }

    private func finish(failed: Bool) {
        guard let task else { return }
        self.task = nil
        if failed { event("error", "") }
        event("close", "")
        task.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
        session = nil
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let peer = challenge.protectionSpace
        guard task === self.task, task.currentRequest?.url == endpoint.url,
              peer.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              peer.host == endpoint.ip, peer.port == endpoint.port,
              let trust = peer.serverTrust,
              let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first,
              SHA256.hash(data: SecCertificateCopyData(leaf) as Data).elementsEqual(endpoint.fingerprint)
        else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        pinVerified = true
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol proto: String?) {
        guard webSocketTask === task, pinVerified else {
            finish(failed: true)
            return
        }
        event("open", "")
        receive()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        close()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(failed: error != nil)
    }
}
