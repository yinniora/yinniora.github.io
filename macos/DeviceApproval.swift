import Foundation
import LocalAuthentication

let context = LAContext()
context.touchIDAuthenticationAllowableReuseDuration = 0
context.localizedCancelTitle = "取消"
var failure: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &failure) else { exit(1) }
let args = Array(CommandLine.arguments.dropFirst())
let serverChange = args.first == "--remote-server"
let rawName = serverChange ? (args.dropFirst().first ?? "") : (args.first ?? "iPhone")
let name = String(rawName.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ").prefix(50))
let server = String(rawName.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ").prefix(300))
// Machine translation of the English source below.
let remoteReasonChinese = "验证身份以通过 {server} 连接 Pi。设备审批和 Mac 身份仍保留在此 Mac 上。".replacingOccurrences(of: "{server}", with: server)
let remoteReason = Locale.current.identifier.hasPrefix("zh") ? remoteReasonChinese : "Authenticate to connect Pi through \(server). Device approval and the Mac identity remain on this Mac."
let pairingReason = Locale.current.identifier.hasPrefix("zh") ? "认证后为「\(name)」显示 Pi 一次性配对码。只有你批准的设备可以操作此 Mac。" : "Authenticate to show a single-use Pi pairing code for \(name). Only approved devices may control this Mac."
let reason = serverChange ? remoteReason : pairingReason
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { approved, _ in
    if approved {
        FileHandle.standardOutput.write(Data("approved\n".utf8))
        exit(0)
    }
    exit(1)
}
RunLoop.main.run(until: Date().addingTimeInterval(85))
context.invalidate()
exit(1)
