import Foundation
import LocalAuthentication

let context = LAContext()
context.touchIDAuthenticationAllowableReuseDuration = 0
context.localizedCancelTitle = "取消"
var failure: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &failure) else { exit(1) }
let rawName = CommandLine.arguments.dropFirst().first ?? "iPhone"
let name = String(rawName.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ").prefix(50))
context.evaluatePolicy(.deviceOwnerAuthentication,
    localizedReason: "认证后为「\(name)」显示 Pi 一次性配对码。只有你批准的设备可以操作此 Mac。") { approved, _ in
    if approved {
        FileHandle.standardOutput.write(Data("approved\n".utf8))
        exit(0)
    }
    exit(1)
}
RunLoop.main.run(until: Date().addingTimeInterval(85))
context.invalidate()
exit(1)
