import Foundation

@main
struct PairingLinks {
    static func main() {
        let trusted = "https://yinniora.github.io/"
        let ticket = "eyJ2ZXJzaW9uIjoxfQ"
        let navigation = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
        let valid = TrustedClient.pairingURL(trusted + "#pair=" + ticket, navigationID: navigation)
        precondition(valid?.fragment == "pair=" + ticket)
        precondition(valid?.query == "nativeScan=" + navigation.uuidString)
        precondition(TrustedClient.pairingURL(" \n" + trusted + "#pair=" + ticket + " \n") != nil)
        precondition(TrustedClient.containsBlob(URL(string: "blob:" + trusted + "abc")))
        for fake in [
            "http://yinniora.github.io/#pair=" + ticket,
            "https://yinniora.github.io.attacker.example/#pair=" + ticket,
            "https://yinniora.github.io:8443/#pair=" + ticket,
            "https://alice@yinniora.github.io/#pair=" + ticket,
            trusted + "other/path#pair=" + ticket,
            trusted + "?in=body#pair=" + ticket,
            trusted + "#pair=",
            trusted + "#pair=ab%2Fcd",
            trusted + "#pair=" + String(repeating: "a", count: 8192),
            "yugopi-relay:" + ticket,
        ] {
            precondition(TrustedClient.pairingURL(fake) == nil)
        }
        precondition(!TrustedClient.containsBlob(URL(string: "blob:https://other.example/abc")))
        print("Native pairing origin, fragment and navigation tests passed.")
    }
}
