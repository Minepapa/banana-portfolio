import Foundation
import Vision
import AVFoundation
import ImageIO

typealias JSON = [String: Any]

func analyze(_ image: CGImage, orientation: CGImagePropertyOrientation, printPath: String?) throws -> JSON {
    let classify = VNClassifyImageRequest()
    let recognize = VNRecognizeTextRequest()
    recognize.recognitionLevel = .accurate
    recognize.recognitionLanguages = ["ko-KR", "en-US"]
    recognize.usesLanguageCorrection = true
    let faces = VNDetectFaceRectanglesRequest()
    let feature = VNGenerateImageFeaturePrintRequest()
    let handler = VNImageRequestHandler(cgImage: image, orientation: orientation)
    try handler.perform([classify, recognize, faces, feature])

    let labels = (classify.results ?? [])
        .filter { $0.confidence >= 0.1 }
        .sorted { $0.confidence == $1.confidence ? $0.identifier < $1.identifier : $0.confidence > $1.confidence }
        .prefix(20)
        .map { ["name": $0.identifier, "confidence": Double($0.confidence)] as JSON }
    let fullText = (recognize.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    var result: JSON = ["labels": labels, "text": String(fullText.prefix(300)),
                        "textLength": fullText.count, "faces": faces.results?.count ?? 0,
                        "aesthetic": NSNull(), "isUtility": NSNull(), "printDims": NSNull()]
    if #available(macOS 15.0, *) {
        let aesthetics = VNCalculateImageAestheticsScoresRequest()
        if (try? handler.perform([aesthetics])) != nil, let score = aesthetics.results?.first {
            result["aesthetic"] = Double(score.overallScore)
            result["isUtility"] = score.isUtility
        }
    }
    if let printPath, let observation = feature.results?.first {
        let stride = observation.elementType == .double ? MemoryLayout<Double>.size : MemoryLayout<Float>.size
        guard (observation.elementType == .float || observation.elementType == .double),
              observation.data.count == observation.elementCount * stride else {
            throw NSError(domain: "media-vision", code: 1, userInfo: [NSLocalizedDescriptionKey: "지원하지 않는 지문 형식"])
        }
        // Vision may return Float or Double elements. Persist either as little-endian Float32.
        var bytes = Data(capacity: observation.elementCount * 4)
        observation.data.withUnsafeBytes { source in
            for index in 0..<observation.elementCount {
                let value: Float = observation.elementType == .double
                    ? Float(source.loadUnaligned(fromByteOffset: index * stride, as: Double.self))
                    : source.loadUnaligned(fromByteOffset: index * stride, as: Float.self)
                var encoded = value.bitPattern.littleEndian
                withUnsafeBytes(of: &encoded) { bytes.append(contentsOf: $0) }
            }
        }
        try bytes.write(to: URL(fileURLWithPath: printPath), options: .atomic)
        result["printDims"] = observation.elementCount
    }
    return result
}

func process(_ input: JSON) throws -> JSON {
    guard let id = input["id"] as? String, let path = input["path"] as? String,
          let kind = input["kind"] as? String, let printPath = input["printPath"] as? String else {
        throw NSError(domain: "media-vision", code: 2, userInfo: [NSLocalizedDescriptionKey: "입력 필드 누락"])
    }
    if kind == "image" {
        let url = URL(fileURLWithPath: path) as CFURL
        guard let source = CGImageSourceCreateWithURL(url, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw NSError(domain: "media-vision", code: 3, userInfo: [NSLocalizedDescriptionKey: "이미지 읽기 실패"])
        }
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? JSON
        let rawOrientation = (properties?[kCGImagePropertyOrientation as String] as? NSNumber)?.uint32Value ?? 1
        let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up
        var result = try analyze(image, orientation: orientation, printPath: printPath)
        result["id"] = id
        return result
    }
    guard kind == "video" else {
        throw NSError(domain: "media-vision", code: 4, userInfo: [NSLocalizedDescriptionKey: "지원하지 않는 kind"])
    }
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let duration = CMTimeGetSeconds(asset.duration)
    guard duration.isFinite, duration > 0 else {
        throw NSError(domain: "media-vision", code: 5, userInfo: [NSLocalizedDescriptionKey: "영상 길이 없음"])
    }
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = CMTime(seconds: 0.3, preferredTimescale: 600)
    generator.requestedTimeToleranceAfter = CMTime(seconds: 0.3, preferredTimescale: 600)
    let start = min(0.5, duration / 2)
    let times = [start, duration / 2]
    var frames: [JSON] = []
    for (index, seconds) in times.enumerated() {
        let image = try generator.copyCGImage(at: CMTime(seconds: seconds, preferredTimescale: 600), actualTime: nil)
        frames.append(try analyze(image, orientation: .up, printPath: index == 1 ? printPath : nil))
    }
    var labelScores: [String: Double] = [:]
    for frame in frames {
        for label in frame["labels"] as? [JSON] ?? [] {
            guard let name = label["name"] as? String, let confidence = label["confidence"] as? Double else { continue }
            labelScores[name] = max(labelScores[name] ?? 0, confidence)
        }
    }
    let labels: [JSON] = labelScores.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
        .prefix(20).map { ["name": $0.key, "confidence": $0.value] }
    let fullText = frames.compactMap { $0["text"] as? String }.filter { !$0.isEmpty }.joined(separator: "\n")
    return ["id": id, "labels": labels, "text": String(fullText.prefix(300)),
            "textLength": frames.reduce(0) { $0 + ($1["textLength"] as? Int ?? 0) },
            "faces": frames.map { $0["faces"] as? Int ?? 0 }.max() ?? 0,
            "aesthetic": frames[1]["aesthetic"] ?? NSNull(),
            "isUtility": frames[1]["isUtility"] ?? NSNull(),
            "printDims": frames[1]["printDims"] ?? NSNull(), "frames": 2]
}

while let line = readLine() {
    autoreleasepool {
    var id = ""
    var output: JSON
    do {
        guard let data = line.data(using: .utf8), let input = try JSONSerialization.jsonObject(with: data) as? JSON else {
            throw NSError(domain: "media-vision", code: 6, userInfo: [NSLocalizedDescriptionKey: "JSON 입력 오류"])
        }
        id = input["id"] as? String ?? ""
        output = try process(input)
    } catch {
        output = ["id": id, "error": error.localizedDescription]
    }
    let data = (try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])) ?? Data("{}".utf8)
    print(String(decoding: data, as: UTF8.self))
    }
}
