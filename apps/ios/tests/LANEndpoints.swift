import Foundation

@main
struct LANEndpoints {
    static func main() {
        let pin = Array(repeating: "b3", count: 32).joined(separator: ":")
        for privateIP in ["10.0.0.2", "172.16.254.1", "172.31.1.20", "192.168.1.2"] {
            let endpoint = LANEndpoint("wss://\(privateIP):43124/remote-signal", pin)
            precondition(endpoint?.ip == privateIP)
            precondition(endpoint?.port == 43124)
            precondition(endpoint?.fingerprint == Data(repeating: 0xb3, count: 32))
        }

        for invalid in [
            "wss://127.0.0.1:43124/remote-signal",
            "wss://100.64.0.2:43124/remote-signal",
            "wss://169.254.0.2:43124/remote-signal",
            "wss://172.15.0.2:43124/remote-signal",
            "wss://172.32.0.2:43124/remote-signal",
            "wss://192.168.001.2:43124/remote-signal",
            "wss://192.168.1.2:65536/remote-signal",
            "wss://192.168.1.2:0/remote-signal",
            "wss://192.168.1.2/remote-signal",
            "wss://192.168.1.2:43124/api/session",
            "wss://192.168.1.2:43124/%72emote-signal",
            "wss://192.168.1.2:43124/remote-signal?",
            "wss://192.168.1.2:43124/remote-signal#",
            "wss://user@192.168.1.2:43124/remote-signal",
            "wss://192.168.1.2.attacker.invalid:43124/remote-signal",
            "wss://[fd00::1]:43124/remote-signal",
            "ws://192.168.1.2:43124/remote-signal",
        ] {
            precondition(LANEndpoint(invalid, pin) == nil, invalid)
        }
        let address = "wss://192.168.1.2:43124/remote-signal"
        for malformed in [pin.uppercased(), String(pin.dropLast()), pin + ":b3", pin.replacingOccurrences(of: "b3", with: "yz")] {
            precondition(LANEndpoint(address, malformed) == nil)
        }
        print("Native LAN address, port, scope and fingerprint checks passed.")
    }
}
