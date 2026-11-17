import Foundation

// A filesystem operation, with no scripting or UI automation. Foundation
// selects the proper Trash on the folder's volume and records Put Back data.
guard CommandLine.arguments.count == 2 else { exit(64) }
let url = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
var destination: NSURL?
do {
    try FileManager.default.trashItem(at: url, resultingItemURL: &destination)
    guard let path = destination?.path else { exit(1) }
    let data = try JSONSerialization.data(withJSONObject: ["path": path])
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardError.write(Data("Could not move the project folder to Mac Trash.\n".utf8))
    exit(1)
}
