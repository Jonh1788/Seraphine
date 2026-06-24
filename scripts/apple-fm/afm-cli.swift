// afm-cli — wraps Apple's on-device FoundationModels for Seraphine (OpenJarvis #4).
// Requires macOS 26+ (Apple Intelligence). Build:
//   swiftc afm-cli.swift -o ~/.seraphine/bin/afm-cli
// Reads one JSON line {"messages":[{role,content}...],"temperature":0.7} on stdin,
// streams response token chunks to stdout (one chunk per line).
import Foundation
#if canImport(FoundationModels)
import FoundationModels

struct In: Codable { let messages: [Msg]; let temperature: Double? }
struct Msg: Codable { let role: String; let content: String }

let data = FileHandle.standardInput.availableData
guard let input = try? JSONDecoder().decode(In.self, from: data) else { exit(1) }
let prompt = input.messages.map { "\($0.role): \($0.content)" }.joined(separator: "\n")
let session = LanguageModelSession()
Task {
    do {
        let stream = session.streamResponse(to: prompt)
        for try await partial in stream {
            FileHandle.standardOutput.write((partial + "\n").data(using: .utf8)!)
        }
    } catch { FileHandle.standardError.write("\(error)\n".data(using: .utf8)!) }
    exit(0)
}
RunLoop.main.run()
#else
FileHandle.standardError.write("FoundationModels unavailable (needs macOS 26+).\n".data(using: .utf8)!)
exit(2)
#endif
