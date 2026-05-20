import AppKit
import Foundation
import LinkPresentation
import UniformTypeIdentifiers

struct AssetInfo: Encodable {
    let filePath: String
    let fileName: String
    let mimeType: String
    let typeIdentifier: String
}

struct MetadataOutput: Encodable {
    let ok: Bool
    let url: String
    let resolvedUrl: String?
    let originalUrl: String?
    let title: String?
    let icon: AssetInfo?
    let image: AssetInfo?
    let error: String?
}

func fail(_ message: String, url: String = "") -> Never {
    let output = MetadataOutput(
        ok: false,
        url: url,
        resolvedUrl: nil,
        originalUrl: nil,
        title: nil,
        icon: nil,
        image: nil,
        error: message
    )
    let data = try! JSONEncoder().encode(output)
    FileHandle.standardOutput.write(data)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
    fail("usage: linkpresentation-metadata <url> <output-dir> [timeout-seconds]")
}

let urlString = args[1]
guard let url = URL(string: urlString) else {
    fail("invalid url", url: urlString)
}

let outputDir = URL(fileURLWithPath: args[2], isDirectory: true)
let timeoutSeconds = args.count >= 4 ? Double(args[3]) ?? 12.0 : 12.0
try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

let provider = LPMetadataProvider()
provider.timeout = timeoutSeconds
var metadataResult: LPLinkMetadata?
var metadataError: Error?
var metadataDone = false
provider.startFetchingMetadata(for: url) { metadata, error in
    metadataResult = metadata
    metadataError = error
    metadataDone = true
}

func runLoopUntil(_ done: @autoclosure () -> Bool, timeout: TimeInterval) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !done() && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
    }
    return done()
}

if !runLoopUntil(metadataDone, timeout: timeoutSeconds + 2.0) {
    provider.cancel()
    fail("LPMetadataProvider timed out", url: urlString)
}

guard let metadata = metadataResult else {
    fail(metadataError?.localizedDescription ?? "LPMetadataProvider returned no metadata", url: urlString)
}

func preferredTypeIdentifier(from provider: NSItemProvider) -> String? {
    let identifiers = provider.registeredTypeIdentifiers
    let preferred = [
        "com.microsoft.ico",
        "public.ico",
        "public.png",
        "public.jpeg",
        "public.jpg",
        "public.tiff",
        "com.compuserve.gif",
        "public.gif",
    ]
    for item in preferred where identifiers.contains(item) {
        return item
    }
    return identifiers.first { identifier in
        UTType(identifier)?.conforms(to: .image) ?? false
    } ?? identifiers.first
}

func mimeType(for typeIdentifier: String, data: Data) -> String {
    if let type = UTType(typeIdentifier), let mime = type.preferredMIMEType {
        return mime
    }
    let bytes = [UInt8](data.prefix(8))
    if bytes.starts(with: [0x00, 0x00, 0x01, 0x00]) {
        return "image/x-icon"
    }
    if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47]) {
        return "image/png"
    }
    if bytes.starts(with: [0xff, 0xd8, 0xff]) {
        return "image/jpeg"
    }
    if data.prefix(6) == Data("GIF87a".utf8) || data.prefix(6) == Data("GIF89a".utf8) {
        return "image/gif"
    }
    return "application/octet-stream"
}

func pngData(from image: NSImage) -> Data? {
    guard let tiff = image.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff)
    else {
        return nil
    }
    return bitmap.representation(using: .png, properties: [:])
}

func writeAsset(data: Data, role: String, typeIdentifier: String) -> AssetInfo? {
    guard !data.isEmpty else {
        return nil
    }
    let fileName = "\(role)-\(UUID().uuidString).pluginPayloadAttachment"
    let fileURL = outputDir.appendingPathComponent(fileName)
    do {
        try data.write(to: fileURL, options: [.atomic])
        return AssetInfo(
            filePath: fileURL.path,
            fileName: fileName,
            mimeType: mimeType(for: typeIdentifier, data: data),
            typeIdentifier: typeIdentifier
        )
    } catch {
        return nil
    }
}

func loadAsset(from provider: NSItemProvider?, role: String) -> AssetInfo? {
    guard let provider else {
        return nil
    }
    if let typeIdentifier = preferredTypeIdentifier(from: provider) {
        var loadedData: Data?
        var loadedDataDone = false
        provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
            loadedData = data
            loadedDataDone = true
        }
        if runLoopUntil(loadedDataDone, timeout: 8.0), let data = loadedData {
            return writeAsset(data: data, role: role, typeIdentifier: typeIdentifier)
        }
    }

    if provider.canLoadObject(ofClass: NSImage.self) {
        var loadedImage: NSImage?
        var loadedImageDone = false
        _ = provider.loadObject(ofClass: NSImage.self) { object, _ in
            loadedImage = object as? NSImage
            loadedImageDone = true
        }
        if runLoopUntil(loadedImageDone, timeout: 8.0),
           let image = loadedImage,
           let data = pngData(from: image)
        {
            return writeAsset(data: data, role: role, typeIdentifier: "public.png")
        }
    }
    return nil
}

let icon = loadAsset(from: metadata.iconProvider, role: "icon")
let image = loadAsset(from: metadata.imageProvider, role: "image")

let output = MetadataOutput(
    ok: true,
    url: urlString,
    resolvedUrl: metadata.url?.absoluteString,
    originalUrl: metadata.originalURL?.absoluteString,
    title: metadata.title,
    icon: icon,
    image: image,
    error: nil
)
let data = try JSONEncoder().encode(output)
FileHandle.standardOutput.write(data)
