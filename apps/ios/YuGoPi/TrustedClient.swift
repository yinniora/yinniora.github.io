import Foundation

// A pairing code only chooses a host inside the encrypted workspace protocol.
// It cannot choose the web origin that runs the client or access its storage.
struct TrustedClient {
    static let site = URL(string: "https://yinniora.github.io/")!
    static let host = "yinniora.github.io"

    static func contains(_ url: URL?) -> Bool {
        guard let url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return false
        }
        return parts.scheme?.lowercased() == "https" && parts.host?.lowercased() == host &&
            (parts.port == nil || parts.port == 443) && parts.user == nil && parts.password == nil
    }

    static func pairingURL(_ raw: String, navigationID: UUID = UUID()) -> URL? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.utf8.count <= 8192,
              let scanned = URL(string: text), contains(scanned),
              let parts = URLComponents(url: scanned, resolvingAgainstBaseURL: false),
              parts.path == "/" || parts.path.isEmpty,
              parts.query == nil, let fragment = parts.percentEncodedFragment,
              fragment.hasPrefix("pair=") else { return nil }
        let content = fragment.dropFirst("pair=".count)
        guard !content.isEmpty, content.utf8.allSatisfy({
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }) else { return nil }
        var destination = URLComponents(url: site, resolvingAgainstBaseURL: false)!
        // Force a new document load even if the connected page was already at /.
        // The pairing ticket stays in the fragment, which the static host never receives.
        destination.queryItems = [URLQueryItem(name: "nativeScan", value: navigationID.uuidString)]
        destination.percentEncodedFragment = fragment
        return destination.url
    }

    static func containsBlob(_ url: URL?) -> Bool {
        guard let raw = url?.absoluteString, raw.hasPrefix("blob:") else { return false }
        return contains(URL(string: String(raw.dropFirst("blob:".count))))
    }
}
